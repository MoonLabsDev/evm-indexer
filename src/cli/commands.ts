import { join } from 'path';
import { createInterface } from 'readline';
import type { Db, MongoClient } from 'mongodb';
import { runCodegen } from '../codegen';
import { ConfigError, loadChain } from '../config/chains';
import { loadAddresses } from '../config/addresses';
import { loadIndexerConfig } from '../config/indexerConfig';
import { Indexer } from '../indexer/indexer';
import { log } from '../log';
import { Processor } from '../processor/processor';
import { RpcPool } from '../rpc/pool';
import { HttpTransport } from '../rpc/transport';
import { startServer } from '../server';
import { EntityStore } from '../store/entities';
import { connect } from '../store/db';
import { SystemStore } from '../store/system';
import type { ChainConfig } from '../types';

/** The project files the CLI reads and writes, all under `root`. */
export interface ProjectPaths { root: string }

const files = (p: ProjectPaths) => ({
  chains: join(p.root, 'chains.json'),
  addresses: join(p.root, 'addresses.json'),
  schema: join(p.root, 'schema.json'),
  abis: join(p.root, 'abis'),
  generated: join(p.root, 'generated'),
  config: join(p.root, 'indexer.config.ts'),
});

// ---- shutdown ----

const cleanups: Array<() => Promise<void>> = [];
const stoppers: Array<() => void> = [];
let stopRequested = false;

/** Registers how to stop a running loop on SIGINT / SIGTERM; runs at once when a stop was already requested. */
export function onStop(fn: () => void): void {
  stoppers.push(fn);
  if (stopRequested) fn();
}

/**
 * SIGINT / SIGTERM: the loops finish their current event or range and return, so the command ends
 * and main() runs the cleanups. Returns false when a stop was already requested.
 */
export function requestStop(): boolean {
  if (stopRequested) return false;
  stopRequested = true;
  for (const fn of stoppers) fn();
  return true;
}

export function isStopRequested(): boolean {
  return stopRequested;
}

/** Registers something to close on SIGINT / SIGTERM (status server, Mongo client). */
export function onShutdown(fn: () => Promise<void>): void {
  cleanups.push(fn);
}

/** Runs the registered cleanups in reverse order; a failing one is logged and does not stop the others. */
export async function runShutdown(): Promise<void> {
  while (cleanups.length > 0) {
    const fn = cleanups.pop()!;
    try {
      await fn();
    } catch (err) {
      log.error('shutdown step failed', err);
    }
  }
}

// ---- environment ----

/** `--chain` wins over `CHAIN_ID`; anything but a positive integer is a ConfigError. */
export function resolveChainId(flag: string | undefined, env: NodeJS.ProcessEnv): number {
  const raw = flag ?? env.CHAIN_ID;
  if (raw === undefined || raw === '') throw new ConfigError('no chain given: pass --chain <id> or set CHAIN_ID');
  if (!/^[1-9]\d*$/.test(raw.trim())) throw new ConfigError(`invalid chain id "${raw}": expected a positive integer`);
  return Number(raw.trim());
}

function requireEnv(env: NodeJS.ProcessEnv, name: string): string {
  const v = env[name];
  if (v === undefined || v === '') throw new ConfigError(`environment variable ${name} is required`);
  return v;
}

/** `PORT`, default 3000. */
export function resolvePort(env: NodeJS.ProcessEnv): number {
  const raw = env.PORT;
  if (raw === undefined || raw === '') return 3000;
  if (!/^\d+$/.test(raw) || Number(raw) > 65535) throw new ConfigError(`invalid PORT "${raw}"`);
  return Number(raw);
}

/** Connects to MongoDB from `MONGO_URI` and `MONGO_DB`; a missing variable is a ConfigError naming it. */
export async function connectFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<{ client: MongoClient; db: Db }> {
  const uri = requireEnv(env, 'MONGO_URI');
  const dbName = requireEnv(env, 'MONGO_DB');
  log.step('Connect to MongoDB');
  const conn = await connect(uri, dbName);
  log.result('connected');
  return conn;
}

// ---- commands ----

export async function cmdCodegen(p: ProjectPaths): Promise<void> {
  const f = files(p);
  log.step(`Generate code into ${f.generated}`);
  const { files: written, warnings } = runCodegen({ abiDir: f.abis, schemaPath: f.schema, outDir: f.generated });
  for (const w of warnings) log.result(`warning: ${w}`);
  log.result(`${written.length} files written`);
}

const HEARTBEAT_EVERY_MS = 10_000;

/**
 * Writes the single-instance heartbeat now and then every `everyMs` for as long as the process runs,
 * independent of the loop (a long tick does not let it go stale). `stop()` ends the timer and clears
 * the heartbeat, so a restart or reset right after a clean stop is not refused.
 */
export function startHeartbeat(
  store: SystemStore, chainId: number, kind: 'indexer' | 'processor', everyMs = HEARTBEAT_EVERY_MS,
): { stop(): Promise<void> } {
  const report = (err: unknown): void => {
    log.debug(`chain ${chainId}: heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
  };
  // the first write starts right away; later ones wait for the previous write
  let pending: Promise<void> = store.heartbeat(chainId, kind).catch(report);
  const beat = (): void => {
    pending = pending.then(() => store.heartbeat(chainId, kind)).catch(report);
  };
  const timer = setInterval(beat, everyMs);
  timer.unref();
  return {
    async stop() {
      clearInterval(timer);
      await pending;
      await store.clearHeartbeat(chainId, kind);
    },
  };
}

/** Refuses to start when the same kind of process has a fresh heartbeat for the chain. */
export async function assertNotRunning(store: SystemStore, chainId: number, kind: 'indexer' | 'processor'): Promise<void> {
  if (await store.isAlive(chainId, kind)) {
    throw new Error(
      `${kind} for chain ${chainId} is already running (its heartbeat is younger than 60 s); ` +
        'stop it, or wait a minute if it crashed',
    );
  }
}

function buildPool(chain: ChainConfig): RpcPool {
  return new RpcPool(
    chain.rpc.map((u) => new HttpTransport(u)),
    { retryDelays: chain.retryDelays, logRange: chain.logRange, blockBatch: chain.blockBatch },
  );
}

/** Starts the status server; a port in use gets a message naming the port and the PORT rule. */
export async function serveStatus(
  kind: string, status: () => object, lastLoopAt: () => number, env: NodeJS.ProcessEnv = process.env,
): Promise<Awaited<ReturnType<typeof startServer>>> {
  const port = resolvePort(env);
  try {
    return await startServer({ port, status, lastLoopAt });
  } catch (err) {
    if ((err as { code?: unknown }).code === 'EADDRINUSE') {
      throw new ConfigError(
        `status port ${port} of the ${kind} is already in use; set PORT to a free port ` +
          '(index and process need different PORT values when they run on one machine)',
      );
    }
    throw err;
  }
}

/** Runs the indexer until SIGINT / SIGTERM; returns once the current range is stored. */
export async function cmdIndex(p: ProjectPaths, chainId: number): Promise<void> {
  const f = files(p);
  log.step(`Load configuration for chain ${chainId}`);
  const chain = loadChain(f.chains, chainId);
  const config = loadIndexerConfig(f.config);
  const contractNames = Object.values(config.sources).filter((s) => s.kind === 'contract').map((s) => s.name);
  const statics = loadAddresses(f.addresses, chainId, contractNames);
  log.result(`${chain.name}: ${contractNames.length} contracts, ${statics.length} addresses`);

  const { client, db } = await connectFromEnv();
  onShutdown(() => client.close());
  const store = new SystemStore(db);
  await assertNotRunning(store, chainId, 'indexer');
  const heartbeat = startHeartbeat(store, chainId, 'indexer');
  onShutdown(() => heartbeat.stop());

  const indexer = new Indexer({ chain, pool: buildPool(chain), store, config, statics });
  await indexer.init();
  const server = await serveStatus('indexer', () => indexer.status(), () => indexer.lastLoopAt());
  onShutdown(() => server.close());
  log.result(`status server on port ${server.port}`);

  process.title = `evm-indexer [indexer] ${chainId}`;
  log.step(`Index chain ${chainId} (${chain.name})`);
  onStop(() => indexer.stop());
  await indexer.run();
}

/** Runs the processor until SIGINT / SIGTERM; returns once the current event is stamped. */
export async function cmdProcess(p: ProjectPaths, chainId: number): Promise<void> {
  const f = files(p);
  log.step(`Load configuration for chain ${chainId}`);
  const chain = loadChain(f.chains, chainId);
  const config = loadIndexerConfig(f.config);

  const { client, db } = await connectFromEnv();
  onShutdown(() => client.close());
  const store = new SystemStore(db);
  await assertNotRunning(store, chainId, 'processor');
  const heartbeat = startHeartbeat(store, chainId, 'processor');
  onShutdown(() => heartbeat.stop());

  const processor = new Processor({
    chain, pool: buildPool(chain), store, entities: new EntityStore(db, chainId), config,
  });
  await processor.init();
  const server = await serveStatus('processor', () => processor.status(), () => processor.lastLoopAt());
  onShutdown(() => server.close());
  log.result(`status server on port ${server.port}`);

  process.title = `evm-indexer [processor] ${chainId}`;
  log.step(`Process chain ${chainId} (${chain.name})`);
  onStop(() => processor.stop());
  await processor.run();
}

/**
 * Sets `currentRevisionId` (default: current + 1) and returns it. The processor wipes and replays.
 * Revisions only move forward: events still stamped with an older id would never be replayed.
 */
export async function cmdSetRevision(db: Db, chainId: number, revision?: number): Promise<number> {
  if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0)) {
    throw new ConfigError(`invalid revision ${revision}: expected an integer >= 0`);
  }
  const store = new SystemStore(db);
  const current = (await store.getChain(chainId)).currentRevisionId;
  if (revision !== undefined && revision <= current) {
    throw new ConfigError(
      `revision ${revision} is not above the current revision ${current} of chain ${chainId}; ` +
        'revisions only move forward (events stamped with an older id would not be replayed)',
    );
  }
  const next = revision ?? current + 1;
  await store.setRevision(chainId, next);
  return next;
}

/** Asks the question; only the exact answer "yes" confirms. End of input without an answer is a no. */
export function askYesNo(
  question: string,
  input: NodeJS.ReadableStream = process.stdin,
  output: NodeJS.WritableStream = process.stdout,
): Promise<boolean> {
  const rl = createInterface({ input, output });
  return new Promise((resolve) => {
    let answered = false;
    rl.once('close', () => { if (!answered) resolve(false); });
    rl.question(question, (answer) => {
      answered = true;
      resolve(answer.trim() === 'yes');
      rl.close();
    });
  });
}

/**
 * Deletes one chain's data (`chainId`) or everything. Returns false when the confirmation was declined.
 * Throws, deleting nothing, when an indexer or processor of an affected chain has a fresh heartbeat,
 * unless `force` is set: a running indexer keeps its in-memory template registry and would never
 * index the wiped template addresses again.
 */
export async function cmdReset(
  db: Db,
  opts: { chainId?: number; yes: boolean; force?: boolean; confirm?: () => Promise<boolean> },
): Promise<boolean> {
  const store = new SystemStore(db);
  if (opts.force !== true) {
    const chains = opts.chainId === undefined ? await store.listChains() : [opts.chainId];
    for (const chainId of chains) {
      for (const kind of ['indexer', 'processor'] as const) {
        if (await store.isAlive(chainId, kind)) {
          throw new Error(
            `the ${kind} of chain ${chainId} is still running (its heartbeat is younger than 60 s); ` +
              'stop it and the processor before a reset, or pass --force',
          );
        }
      }
    }
  }
  const what = opts.chainId === undefined
    ? 'every sys_* and ent_* collection in this database'
    : `all data of chain ${opts.chainId}`;
  if (!opts.yes) {
    const confirm = opts.confirm ?? (() => askYesNo(`Type "yes" to delete ${what}: `));
    if (!(await confirm())) return false;
  }
  if (opts.chainId === undefined) await store.resetAll();
  else await store.resetChain(opts.chainId);
  return true;
}
