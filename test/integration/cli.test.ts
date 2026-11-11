import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import {
  copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, readFileSync, rmSync, rmdirSync, symlinkSync, unlinkSync,
  writeFileSync,
} from 'fs';
import { createServer } from 'net';
import { join } from 'path';
import { Contract, ContractFactory, JsonRpcProvider, type JsonRpcSigner } from 'ethers';
import type { Db } from 'mongodb';
import { startMongo } from '../helpers/mongo';
import { artifact, CHAIN_ID, FIXTURE, ROOT, RPC_URL } from './fixture';

// The real CLI path: the BUILT dist/cli/index.js runs as a child process against a client project
// that imports the runtime by package name ('evm-indexer' -> node_modules junction -> repo root),
// with generated code from `evm-indexer codegen` (default runtimeImport). Callbacks only work here
// when the project's config and the CLI share one runtime copy.

const PROJECT = join(FIXTURE, 'cli-project');
const LINK_DIR = join(PROJECT, 'node_modules');
const LINK = join(LINK_DIR, 'evm-indexer');
const CLI = join(ROOT, 'dist', 'cli', 'index.js');
const TSC_BIN = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const ESM_PROJECT = join(ROOT, 'test', '.tmp', 'esm-project');
const SIGNAL_PRELOAD = join(ROOT, 'test', 'helpers', 'signalOnStdin.cjs');
const WAIT_MS = 60_000;

interface Cli { child: ChildProcess; out: () => string; exited: Promise<number | null> }

const children: ChildProcess[] = [];
let provider: JsonRpcProvider;
let signer: JsonRpcSigner;
let factoryAddress: string;
let pools: string[] = [];
let head: number;
let mongo: Awaited<ReturnType<typeof startMongo>>;
let db: Db;

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill('SIGKILL');
}

function removeLink(link: string): void {
  try {
    lstatSync(link);
  } catch {
    return;
  }
  unlinkSync(link); // the junction only, never its target
}

function linkPackage(projectDir: string): void {
  mkdirSync(join(projectDir, 'node_modules'), { recursive: true });
  removeLink(join(projectDir, 'node_modules', 'evm-indexer'));
  symlinkSync(ROOT, join(projectDir, 'node_modules', 'evm-indexer'), 'junction');
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const address = srv.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

function cliEnv(port: number): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, MONGO_URI: mongo.uri, MONGO_DB: mongo.dbName, PORT: String(port) };
  delete env.CHAIN_ID;
  return env;
}

function runCli(args: string[], env: NodeJS.ProcessEnv = process.env): { status: number | null; output: string } {
  const res = spawnSync(process.execPath, [CLI, ...args, '--root', PROJECT], { cwd: PROJECT, env, encoding: 'utf8' });
  return { status: res.status, output: `${res.stdout ?? ''}${res.stderr ?? ''}${res.error ?? ''}` };
}

function startCli(args: string[], env: NodeJS.ProcessEnv): Cli {
  const child = spawn(process.execPath, ['-r', SIGNAL_PRELOAD, CLI, ...args, '--root', PROJECT], {
    cwd: PROJECT, env, stdio: ['pipe', 'pipe', 'pipe'],
  });
  children.push(child);
  let output = '';
  const keep = (d: Buffer) => { output = (output + d.toString()).slice(-50_000); };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);
  const exited = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  return { child, out: () => output, exited };
}

async function waitFor(what: string, cli: Cli, check: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + WAIT_MS;
  while (!(await check())) {
    if (cli.child.exitCode !== null) throw new Error(`${what}: the CLI exited with code ${cli.child.exitCode}:\n${cli.out()}`);
    if (Date.now() > deadline) throw new Error(`${what}: not reached within ${WAIT_MS} ms; CLI output:\n${cli.out()}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function exitOf(cli: Cli, what: string): Promise<number | null> {
  const timeout = new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 40_000));
  const code = await Promise.race([cli.exited, timeout]);
  if (code === 'timeout') throw new Error(`the CLI did not exit after ${what}:\n${cli.out()}`);
  return code;
}

/** A real SIGTERM where the platform can deliver one; on Windows the preload raises it from stdin. */
async function sigterm(cli: Cli): Promise<number | null> {
  if (process.platform === 'win32') cli.child.stdin?.write('SIGTERM\n');
  else cli.child.kill('SIGTERM');
  return exitOf(cli, 'SIGTERM');
}

const chainRow = async () => db.collection('sys_chains').findOne({ chainId: CHAIN_ID });

async function ping(address: string): Promise<void> {
  const c = new Contract(address, artifact('Pool').abi as never, signer);
  await (await c.ping()).wait();
}

beforeAll(async () => {
  const build = spawnSync(process.execPath, [TSC_BIN, '-p', join(ROOT, 'tsconfig.json')], { cwd: ROOT, encoding: 'utf8' });
  if (build.status !== 0) throw new Error(`npm run build (tsc) failed:\n${build.stdout}${build.stderr}`);

  const abiDir = join(PROJECT, 'abis');
  rmSync(abiDir, { recursive: true, force: true });
  rmSync(join(PROJECT, 'generated'), { recursive: true, force: true });
  mkdirSync(abiDir, { recursive: true });
  for (const name of ['Factory', 'Pool']) {
    copyFileSync(join(FIXTURE, 'artifacts', 'contracts', `${name}.sol`, `${name}.json`), join(abiDir, `${name}.json`));
  }
  linkPackage(PROJECT);

  provider = new JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true, polling: false, cacheTimeout: -1 });
  signer = await provider.getSigner(0);
  const { abi, bytecode } = artifact('Factory');
  const factory = (await new ContractFactory(abi as never, bytecode, signer).deploy()) as Contract;
  const deployBlock = (await factory.deploymentTransaction()!.wait())!.blockNumber;
  factoryAddress = (await factory.getAddress()).toLowerCase();
  for (let i = 0; i < 2; i++) {
    const receipt = await (await factory.createPool()).wait();
    for (const l of receipt!.logs) {
      const parsed = factory.interface.parseLog(l);
      if (parsed?.name === 'PoolCreated') pools.push(String(parsed.args.pool).toLowerCase());
    }
  }
  await ping(pools[0]);
  for (let i = 0; i < 5; i++) await provider.send('evm_mine', []);
  head = await provider.getBlockNumber();

  writeFileSync(
    join(PROJECT, 'addresses.ts'),
    [
      `import { defineAddresses } from 'evm-indexer';`,
      `import config from './indexer.config';`,
      `export default defineAddresses(config, { ${CHAIN_ID}: { Factory: { address: '${factoryAddress}', block: ${deployBlock} } } });`,
      '',
    ].join('\n'),
  );
  mongo = await startMongo();
  db = mongo.db;
});

afterAll(async () => {
  for (const c of children) killTree(c);
  provider?.destroy();
  await mongo?.stop();
  removeLink(LINK);
  if (existsSync(LINK_DIR)) rmdirSync(LINK_DIR);
  removeLink(join(ESM_PROJECT, 'node_modules', 'evm-indexer'));
  rmSync(ESM_PROJECT, { recursive: true, force: true });
});

describe('the built CLI against a client project that imports evm-indexer by name', () => {
  it('codegen writes generated/ importing the runtime from the package name', () => {
    const res = runCli(['codegen']);
    expect(res.status, res.output).toBe(0);
    expect(existsSync(join(PROJECT, 'generated', 'index.ts'))).toBe(true);
    expect(readFileSync(join(PROJECT, 'generated', 'contracts', 'Factory.ts'), 'utf8')).toContain("from 'evm-indexer'");
    expect(readFileSync(join(PROJECT, 'generated', 'entities', 'Stats.ts'), 'utf8')).toContain("from 'evm-indexer'");
  });

  it('index stores the events, the index callback creates template rows, /status answers on PORT, SIGTERM ends it', async () => {
    const port = await freePort();
    const cli = startCli(['index', '--chain', String(CHAIN_ID)], cliEnv(port));
    const events = db.collection('sys_events');
    await waitFor('indexer caught up', cli, async () => {
      const state = await db.collection('sys_chains').findOne({ chainId: CHAIN_ID });
      return (state?.indexedBlock ?? 0) >= head;
    });

    const templates = await db.collection('sys_templates').find({ chainId: CHAIN_ID }).sort({ block: 1 }).toArray();
    expect(templates.map((t) => [t.template, t.address])).toEqual(pools.map((p) => ['PoolTemplate', p]));
    expect(await events.countDocuments({ chainId: CHAIN_ID, event: 'PoolCreated', address: factoryAddress })).toBe(2);
    // one same-transaction Ping per created pool, plus one later Ping of the first pool
    expect(await events.countDocuments({ chainId: CHAIN_ID, event: 'Ping' })).toBe(3);

    const status = await fetch(`http://127.0.0.1:${port}/status`);
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({ chainId: CHAIN_ID, name: 'hardhat', indexBlock: head });
    expect((await fetch(`http://127.0.0.1:${port}/health`)).status).toBe(200);

    // a clean stop: the range is finished, the heartbeat cleared, exit code 0
    expect(await sigterm(cli), cli.out()).toBe(0);
    expect(cli.out()).toMatch(/Shut down/);
    expect(cli.out()).not.toMatch(/ERROR/);
    expect((await chainRow())?.indexerHeartbeat).toBeNull();
  });

  it('process runs the process callbacks: entities saved, contract read at the event block, /status answers', async () => {
    const port = await freePort();
    const cli = startCli(['process', '--chain', String(CHAIN_ID)], cliEnv(port));
    const ent = (table: string) => db.collection(`ent_${CHAIN_ID}_${table}`);
    await waitFor('processor caught up', cli, async () => {
      const state = await db.collection('sys_chains').findOne({ chainId: CHAIN_ID });
      return (state?.processedBlock ?? 0) >= head;
    });

    expect(await ent('PoolEntity').findOne({ _id: pools[0] as never })).toMatchObject({ pings: 2, lastPing: '2' });
    expect(await ent('PoolEntity').findOne({ _id: pools[1] as never })).toMatchObject({ pings: 1, lastPing: '1' });
    // poolCount() was 2 at the second PoolCreated block, which ran last
    expect(await ent('Stats').findOne({ _id: 'global' as never })).toMatchObject({ poolCount: 2 });

    const status = await fetch(`http://127.0.0.1:${port}/status`);
    expect(await status.json()).toMatchObject({ chainId: CHAIN_ID, processBlock: head, revisionId: 0 });

    expect(await sigterm(cli), cli.out()).toBe(0);
    expect(cli.out()).not.toMatch(/ERROR/);
    expect((await chainRow())?.processorHeartbeat).toBeNull();
  });

  it('reset --chain right after the clean stops is not refused', async () => {
    const res = runCli(['reset', '--chain', String(CHAIN_ID), '--yes'], cliEnv(await freePort()));
    expect(res.status, res.output).toBe(0);
    expect(res.output).toContain('reset done');
    expect(await db.collection('sys_events').countDocuments({ chainId: CHAIN_ID })).toBe(0);
  });

  it('a restart is not refused, and a kill ends the process', async () => {
    const cli = startCli(['index', '--chain', String(CHAIN_ID)], cliEnv(await freePort()));
    await waitFor('restarted indexer caught up', cli, async () => ((await chainRow())?.indexedBlock ?? 0) >= head);
    killTree(cli.child);
    expect(await exitOf(cli, 'kill')).not.toBe(0);
  });

  it('loads the config of an ESM client project ("type": "module")', () => {
    rmSync(ESM_PROJECT, { recursive: true, force: true });
    mkdirSync(ESM_PROJECT, { recursive: true });
    for (const f of ['indexer.config.ts', 'chains.ts', 'schema.ts', 'abis', 'handlers.ts', 'generated']) {
      cpSync(join(PROJECT, f), join(ESM_PROJECT, f), { recursive: true });
    }
    writeFileSync(join(ESM_PROJECT, 'package.json'), JSON.stringify({ type: 'module' }) + '\n');
    linkPackage(ESM_PROJECT);

    const script = [
      `const { loadIndexerConfig } = require(${JSON.stringify(join(ROOT, 'dist', 'config', 'indexerConfig.js'))});`,
      `const cfg = loadIndexerConfig(${JSON.stringify(join(ESM_PROJECT, 'indexer.config.ts'))});`,
      'console.log(Object.keys(cfg.sources).join(","));',
    ].join('\n');
    const res = spawnSync(process.execPath, ['-e', script], { cwd: ESM_PROJECT, encoding: 'utf8' });
    expect(res.status, `${res.stdout}${res.stderr}`).toBe(0);
    expect(res.stdout.trim()).toBe('Factory,PoolTemplate');

    // codegen loads only schema.ts, through tsx, in an ESM project; start from no generated/ so the
    // entity files below prove it ran
    rmSync(join(ESM_PROJECT, 'generated'), { recursive: true, force: true });
    const codegen = spawnSync(process.execPath, [CLI, 'codegen', '--root', ESM_PROJECT], { cwd: ESM_PROJECT, encoding: 'utf8' });
    expect(codegen.status, `${codegen.stdout}${codegen.stderr}`).toBe(0);
    expect(existsSync(join(ESM_PROJECT, 'generated', 'entities', 'PoolEntity.ts'))).toBe(true);
  });
});
