import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { copyFileSync, mkdirSync, rmSync } from 'fs';
import { createConnection } from 'net';
import { join, relative } from 'path';
import { runCodegen } from '../../src/codegen';
import { loadTsDefault } from '../../src/config/load';
import { FIXTURE, PROJECT, ROOT, RPC_PORT, RPC_URL } from './fixture';

// Builds the fixture project (compile, ABIs, codegen, type-check) and runs a hardhat node on 8546.

const HARDHAT_CONFIG = join(FIXTURE, 'hardhat.config.cjs');
const HARDHAT_BIN = join(ROOT, 'node_modules', 'hardhat', 'internal', 'cli', 'bootstrap.js');
const TSC_BIN = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const CONTRACTS = ['Factory', 'Pool'];
const NODE_START_TIMEOUT_MS = 60_000;

function run(what: string, args: string[]): void {
  const res = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' });
  if (res.status !== 0) {
    throw new Error(`${what} failed (exit ${res.status}):\n${res.stdout ?? ''}${res.stderr ?? ''}${res.error ?? ''}`);
  }
}

function portInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: '127.0.0.1', port });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('error', () => resolve(false));
  });
}

async function chainIdAnswers(): Promise<boolean> {
  try {
    const res = await fetch(RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_chainId', params: [] }),
    });
    const body = (await res.json()) as { result?: string };
    return body.result === '0x7a69';
  } catch {
    return false;
  }
}

function killTree(child: ChildProcess): void {
  if (child.pid === undefined || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGKILL');
  }
}

function buildProject(): void {
  run('hardhat compile', [HARDHAT_BIN, 'compile', '--config', HARDHAT_CONFIG]);

  const abiDir = join(PROJECT, 'abis');
  const outDir = join(PROJECT, 'generated');
  rmSync(abiDir, { recursive: true, force: true });
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(abiDir, { recursive: true });
  for (const name of CONTRACTS) {
    copyFileSync(join(FIXTURE, 'artifacts', 'contracts', `${name}.sol`, `${name}.json`), join(abiDir, `${name}.json`));
  }
  // generated/contracts/* and generated/entities/* sit at the same depth, so one relative path fits both.
  const runtimeImport = relative(join(outDir, 'contracts'), join(ROOT, 'src', 'index')).replace(/\\/g, '/');
  runCodegen({ abiDir, schema: loadTsDefault(join(PROJECT, 'schema.ts'), 'schema'), outDir, runtimeImport });

  // The generated code, the config and the handlers must compile under strict.
  run('type-check of test/fixture/project (tsconfig.fixture.json)', [TSC_BIN, '--noEmit', '-p', join(ROOT, 'tsconfig.fixture.json')]);
}

async function startNode(): Promise<ChildProcess> {
  const child = spawn(process.execPath, [HARDHAT_BIN, 'node', '--config', HARDHAT_CONFIG, '--port', String(RPC_PORT)], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  // hardhat logs every request; keep only the tail for error messages
  let output = '';
  const keep = (d: Buffer) => { output = (output + d.toString()).slice(-20_000); };
  child.stdout?.on('data', keep);
  child.stderr?.on('data', keep);

  const deadline = Date.now() + NODE_START_TIMEOUT_MS;
  while (!(await chainIdAnswers())) {
    if (child.exitCode !== null) throw new Error(`hardhat node exited with code ${child.exitCode}:\n${output}`);
    if (Date.now() > deadline) {
      killTree(child);
      throw new Error(`hardhat node did not answer eth_chainId within ${NODE_START_TIMEOUT_MS} ms:\n${output}`);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return child;
}

export default async function setup(): Promise<() => Promise<void>> {
  if (await portInUse(RPC_PORT)) {
    throw new Error(`port ${RPC_PORT} is already in use; stop whatever listens there before running the integration tests`);
  }
  buildProject();
  const node = await startNode();
  return async () => {
    killTree(node);
  };
}
