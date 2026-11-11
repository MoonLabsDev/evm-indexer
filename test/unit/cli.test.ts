import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { PassThrough } from 'stream';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import type { Db } from 'mongodb';
import { startMongo } from '../helpers/mongo';
import { createServer, type Server } from 'net';
import {
  askYesNo, assertNotRunning, cmdCodegen, cmdProcess, cmdReset, cmdSetRevision, connectFromEnv, isStopRequested, onStop,
  requestStop, resolveChainId, resolvePort, serveStatus, startHeartbeat,
} from '../../src/cli/commands';
import { ConfigError } from '../../src/config/chains';
import { SystemStore } from '../../src/store/system';

let mongo: { db: Db; stop(): Promise<void> };
let db: Db;
let store: SystemStore;

beforeAll(async () => { mongo = await startMongo(); });
afterAll(async () => { await mongo.stop(); });
beforeEach(async () => {
  db = mongo.db;
  await db.dropDatabase();
  store = new SystemStore(db);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

/** Fills chains 1 and 2 with one document in each sys_ and ent_ collection; no process is alive afterwards. */
async function seed(): Promise<void> {
  await store.init();
  for (const chainId of [1, 2]) {
    await store.getChain(chainId);
    await store.setIndexed(chainId, 50);
    await store.setRevision(chainId, 3);
    await db.collection('sys_events').insertOne({ chainId, n: 1 });
    await db.collection('sys_transactions').insertOne({ chainId, hash: `0x${chainId}` });
    await db.collection('sys_templates').insertOne({ chainId, template: 'T', address: `0x${chainId}` });
    await db.collection(`ent_${chainId}_Pool`).insertOne({ _id: 'a' as never });
  }
  await db.collection('sys_chains').updateMany({}, { $set: { indexerHeartbeat: null, processorHeartbeat: null } });
}

/** Moves one heartbeat back in time, so it counts as stale. */
async function ageHeartbeat(chainId: number, kind: 'indexer' | 'processor', ms: number): Promise<void> {
  await db.collection('sys_chains').updateOne({ chainId }, { $set: { [`${kind}Heartbeat`]: new Date(Date.now() - ms) } });
}

const count = (name: string, filter: object = {}) => db.collection(name).countDocuments(filter);

describe('resolveChainId', () => {
  it('prefers the flag, falls back to CHAIN_ID', () => {
    expect(resolveChainId('1329', {})).toBe(1329);
    expect(resolveChainId('1329', { CHAIN_ID: '5' })).toBe(1329);
    expect(resolveChainId(undefined, { CHAIN_ID: '5' })).toBe(5);
  });

  it('throws a ConfigError when there is no chain or it is not a positive integer', () => {
    expect(() => resolveChainId(undefined, {})).toThrow(/chain/i);
    expect(() => resolveChainId(undefined, {})).toThrow(ConfigError);
    expect(() => resolveChainId('abc', {})).toThrow(ConfigError);
    expect(() => resolveChainId('0', {})).toThrow(ConfigError);
    expect(() => resolveChainId('-1', {})).toThrow(ConfigError);
    expect(() => resolveChainId('1.5', {})).toThrow(ConfigError);
  });
});

describe('environment', () => {
  it('names the missing variable', async () => {
    await expect(connectFromEnv({ MONGO_DB: 'x' })).rejects.toThrow(/MONGO_URI/);
    await expect(connectFromEnv({ MONGO_URI: 'mongodb://localhost' })).rejects.toThrow(/MONGO_DB/);
    await expect(connectFromEnv({})).rejects.toBeInstanceOf(ConfigError);
  });

  it('PORT defaults to 3000 and rejects garbage', () => {
    expect(resolvePort({})).toBe(3000);
    expect(resolvePort({ PORT: '8080' })).toBe(8080);
    expect(() => resolvePort({ PORT: 'abc' })).toThrow(ConfigError);
    expect(() => resolvePort({ PORT: '70000' })).toThrow(ConfigError);
  });

  it('cmdProcess fails on a project without chains.ts before touching MongoDB', async () => {
    await expect(cmdProcess({ root: 'test/does-not-exist' }, 1)).rejects.toThrow(/chains\.ts/);
  });
});

describe('cmdSetRevision', () => {
  it('defaults to current + 1 and returns the new id', async () => {
    expect(await cmdSetRevision(db, 1)).toBe(1);
    expect(await cmdSetRevision(db, 1)).toBe(2);
    expect((await store.getChain(1)).currentRevisionId).toBe(2);
  });

  it('sets an explicit revision above the current one', async () => {
    expect(await cmdSetRevision(db, 1, 7)).toBe(7);
    expect((await store.getChain(1)).currentRevisionId).toBe(7);
    expect(await cmdSetRevision(db, 1, 8)).toBe(8);
  });

  it('rejects a revision at or below the current one and changes nothing', async () => {
    await cmdSetRevision(db, 1, 5);
    // events still stamped with an old id would never be replayed
    await expect(cmdSetRevision(db, 1, 3)).rejects.toThrow(/revision 3 .*current revision 5.*only move forward/);
    await expect(cmdSetRevision(db, 1, 5)).rejects.toThrow(/current revision 5/);
    await expect(cmdSetRevision(db, 1, 0)).rejects.toThrow(ConfigError);
    expect((await store.getChain(1)).currentRevisionId).toBe(5);
  });

  it('rejects a negative or non-integer revision and changes nothing', async () => {
    await expect(cmdSetRevision(db, 1, -1)).rejects.toThrow();
    await expect(cmdSetRevision(db, 1, 1.5)).rejects.toThrow();
    await expect(cmdSetRevision(db, 1, Number.NaN)).rejects.toThrow();
    expect((await store.getChain(1)).currentRevisionId).toBe(0);
  });

  it('only touches the given chain', async () => {
    await cmdSetRevision(db, 1, 4);
    expect((await store.getChain(2)).currentRevisionId).toBe(0);
  });
});

describe('cmdReset', () => {
  it('does nothing and returns false when the confirmation is declined', async () => {
    await seed();
    const confirm = vi.fn(async () => false);
    expect(await cmdReset(db, { chainId: 1, yes: false, confirm })).toBe(false);
    expect(confirm).toHaveBeenCalledOnce();
    expect(await count('sys_events')).toBe(2);
    expect(await count('ent_1_Pool')).toBe(1);
    expect(await cmdReset(db, { yes: false, confirm })).toBe(false);
    expect(await count('sys_events')).toBe(2);
  });

  it('deletes only that chain with --chain, and resets its counters', async () => {
    await seed();
    expect(await cmdReset(db, { chainId: 1, yes: true })).toBe(true);
    for (const col of ['sys_events', 'sys_transactions', 'sys_templates']) {
      expect(await count(col, { chainId: 1 })).toBe(0);
      expect(await count(col, { chainId: 2 })).toBe(1);
    }
    expect(await count('ent_1_Pool')).toBe(0);
    expect(await count('ent_2_Pool')).toBe(1);
    expect(await store.getChain(1)).toMatchObject({ indexedBlock: 0, processedBlock: 0, currentRevisionId: 0, entityRevisionId: 0 });
    expect(await store.getChain(2)).toMatchObject({ indexedBlock: 50, currentRevisionId: 3 });
  });

  it('asks no confirmation with yes', async () => {
    await seed();
    const confirm = vi.fn(async () => false);
    expect(await cmdReset(db, { chainId: 1, yes: true, confirm })).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('without a chain, leaves no sys_ or ent_ collection', async () => {
    await seed();
    expect(await cmdReset(db, { yes: true })).toBe(true);
    const names = (await db.listCollections().toArray()).map((c) => c.name);
    expect(names.filter((n) => n.startsWith('sys_') || n.startsWith('ent_'))).toEqual([]);
  });

  it('runs after a confirmation that says yes', async () => {
    await seed();
    expect(await cmdReset(db, { chainId: 2, yes: false, confirm: async () => true })).toBe(true);
    expect(await count('sys_events', { chainId: 2 })).toBe(0);
  });
});

describe('cmdReset under a live process', () => {
  it('refuses with a fresh indexer heartbeat, names kind and chain, deletes nothing', async () => {
    await seed();
    await store.heartbeat(1, 'indexer');
    const err = await cmdReset(db, { chainId: 1, yes: true }).then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/still running/);
    expect(err?.message).toContain('indexer of chain 1');
    expect(err?.message).toContain('--force');
    expect(await count('sys_events')).toBe(2);
    expect(await count('sys_templates', { chainId: 1 })).toBe(1);
    expect(await count('ent_1_Pool')).toBe(1);
  });

  it('refuses before asking for confirmation', async () => {
    await seed();
    await store.heartbeat(1, 'processor');
    const confirm = vi.fn(async () => true);
    await expect(cmdReset(db, { chainId: 1, yes: false, confirm })).rejects.toThrow(/processor of chain 1 is still running/);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('resets a live chain with force', async () => {
    await seed();
    await store.heartbeat(1, 'indexer');
    expect(await cmdReset(db, { chainId: 1, yes: true, force: true })).toBe(true);
    expect(await count('sys_events', { chainId: 1 })).toBe(0);
    expect(await count('sys_templates', { chainId: 1 })).toBe(0);
  });

  it('is not blocked by a stale heartbeat', async () => {
    await seed();
    await ageHeartbeat(1, 'indexer', 61_000);
    await ageHeartbeat(1, 'processor', 120_000);
    expect(await cmdReset(db, { chainId: 1, yes: true })).toBe(true);
    expect(await count('sys_events', { chainId: 1 })).toBe(0);
  });

  it('blocks a full reset when a processor on any chain is alive', async () => {
    await seed();
    await store.heartbeat(2, 'processor');
    await expect(cmdReset(db, { yes: true })).rejects.toThrow(/processor of chain 2 is still running/);
    expect(await count('sys_events')).toBe(2);
    expect(await cmdReset(db, { yes: true, force: true })).toBe(true);
    expect(await count('sys_events')).toBe(0);
  });

  it('does not let another chain block reset --chain', async () => {
    await seed();
    await store.heartbeat(1, 'indexer');
    await store.heartbeat(1, 'processor');
    expect(await cmdReset(db, { chainId: 2, yes: true })).toBe(true);
    expect(await count('sys_events', { chainId: 2 })).toBe(0);
    expect(await count('sys_events', { chainId: 1 })).toBe(1);
  });
});

describe('assertNotRunning', () => {
  it('refuses when the same kind has a fresh heartbeat, names kind and chain', async () => {
    await store.heartbeat(1, 'indexer');
    const err = await assertNotRunning(store, 1, 'indexer').then(() => null, (e: Error) => e);
    expect(err?.message).toMatch(/already running/);
    expect(err?.message).toContain('indexer');
    expect(err?.message).toContain('1');
  });

  it('lets the other kind and other chains start', async () => {
    await store.heartbeat(1, 'indexer');
    await expect(assertNotRunning(store, 1, 'processor')).resolves.toBeUndefined();
    await expect(assertNotRunning(store, 2, 'indexer')).resolves.toBeUndefined();
  });

  it('lets a stale heartbeat start', async () => {
    await store.heartbeat(1, 'processor');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 61_000);
    try {
      await expect(assertNotRunning(store, 1, 'processor')).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('cli entry', () => {
  it('importing it runs nothing and exposes the commands', async () => {
    const { buildProgram } = await import('../../src/cli/index');
    const program = buildProgram();
    expect(program.commands.map((c) => c.name()).sort()).toEqual(['codegen', 'index', 'init', 'process', 'reset', 'set-revision']);
    expect(vi.mocked(console.log)).not.toHaveBeenCalled();
  });
});

describe('askYesNo', () => {
  const ask = async (typed: string | null): Promise<{ answer: boolean; prompt: string }> => {
    const input = new PassThrough();
    const output = new PassThrough();
    let prompt = '';
    output.on('data', (c) => { prompt += String(c); });
    const p = askYesNo('Type "yes" to delete: ', input, output);
    if (typed !== null) input.write(typed);
    input.end();
    return { answer: await p, prompt };
  };

  it('confirms a typed yes', async () => {
    const r = await ask('yes\n');
    expect(r.answer).toBe(true);
    expect(r.prompt).toContain('Type "yes" to delete');
  });

  it('declines no and any other answer, exact match only', async () => {
    expect((await ask('no\n')).answer).toBe(false);
    expect((await ask('YES\n')).answer).toBe(false);
    expect((await ask('y\n')).answer).toBe(false);
    expect((await ask('\n')).answer).toBe(false);
  });

  it('declines on immediate end of input', async () => {
    expect((await ask(null)).answer).toBe(false);
  });
});

describe('startHeartbeat', () => {
  it('writes the heartbeat at once and then on its timer, independent of any loop', async () => {
    await store.init();
    const spy = vi.spyOn(store, 'heartbeat');
    const hb = startHeartbeat(store, 1, 'indexer', 20);
    try {
      expect(spy).toHaveBeenCalledTimes(1); // synchronously, before the first tick of the timer
      await vi.waitFor(async () => expect(await store.isAlive(1, 'indexer')).toBe(true));
      await vi.waitFor(() => expect(spy.mock.calls.length).toBeGreaterThanOrEqual(3), { timeout: 2000 });
    } finally {
      await hb.stop();
    }
  });

  it('stop() ends the timer and clears the heartbeat: assertNotRunning and reset no longer refuse', async () => {
    await store.init();
    const hb = startHeartbeat(store, 1, 'processor', 20);
    await vi.waitFor(async () => expect(await store.isAlive(1, 'processor')).toBe(true));
    await expect(assertNotRunning(store, 1, 'processor')).rejects.toThrow(/already running/);
    await hb.stop();
    const spy = vi.spyOn(store, 'heartbeat');
    await new Promise((r) => setTimeout(r, 60));
    expect(spy).not.toHaveBeenCalled();
    expect((await store.getChain(1)).processorHeartbeat).toBeNull();
    await expect(assertNotRunning(store, 1, 'processor')).resolves.toBeUndefined();
    expect(await cmdReset(db, { chainId: 1, yes: true })).toBe(true);
  });

  it('a failing heartbeat write is only logged at debug level and the timer keeps going', async () => {
    await store.init();
    const spy = vi.spyOn(store, 'heartbeat').mockRejectedValue(new Error('mongo down'));
    const hb = startHeartbeat(store, 1, 'indexer', 20);
    await vi.waitFor(() => expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 2000 });
    await hb.stop();
    expect(vi.mocked(console.error)).not.toHaveBeenCalled();
  });
});

describe('serveStatus', () => {
  it('names the port and the PORT rule when the port is in use', async () => {
    const blocker: Server = createServer();
    await new Promise<void>((r) => blocker.listen(0, r));
    const port = (blocker.address() as { port: number }).port;
    try {
      await expect(serveStatus('processor', () => ({}), () => 0, { PORT: String(port) })).rejects.toThrow(
        new RegExp(`port ${port} .*already in use.*index and process need different PORT values`),
      );
    } finally {
      await new Promise<void>((r) => blocker.close(() => r()));
    }
  });
});

// Last in this file: a requested stop stays requested for the rest of the process.
describe('requestStop', () => {
  it('stops every registered loop once, and a loop registered afterwards at once', () => {
    const a = vi.fn();
    onStop(a);
    expect(isStopRequested()).toBe(false);
    expect(requestStop()).toBe(true);
    expect(requestStop()).toBe(false);
    expect(a).toHaveBeenCalledTimes(1);
    const late = vi.fn();
    onStop(late);
    expect(late).toHaveBeenCalledTimes(1);
    expect(isStopRequested()).toBe(true);
  });
});

describe('cmdCodegen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'evm-codegen-'));
  const indexSrc = JSON.stringify(resolve(__dirname, '../../src/index.ts'));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  /** A project folder with an empty abis/ and the given files. */
  function project(name: string, files: Record<string, string>): string {
    const root = join(dir, name);
    mkdirSync(join(root, 'abis'), { recursive: true });
    for (const [file, text] of Object.entries(files)) writeFileSync(join(root, file), text);
    return root;
  }

  it('generates entities from schema.ts', async () => {
    const root = project('ok', {
      'schema.ts': `import { defineSchema } from ${indexSrc};\nexport default defineSchema({ A: { n: 'int' } });\n`,
    });
    await cmdCodegen({ root });
    expect(existsSync(join(root, 'generated', 'entities', 'A.ts'))).toBe(true);
  });

  it('rejects a project that only has schema.json', async () => {
    const root = project('json', { 'schema.json': '{ "A": { "n": "int" } }' });
    await expect(cmdCodegen({ root })).rejects.toThrow(/schema\.json is no longer read/);
  });

  it('generates no entities when there is no schema file', async () => {
    const root = project('none', {});
    await cmdCodegen({ root });
    expect(readFileSync(join(root, 'generated', 'entities', 'index.ts'), 'utf8')).toBe('export {};\n');
  });

  it('explains a schema.ts that imports from generated/', async () => {
    const root = project('gen', {
      'schema.ts': `import './generated';\nimport { defineSchema } from ${indexSrc};\nexport default defineSchema({});\n`,
    });
    await expect(cmdCodegen({ root })).rejects.toThrow(/schema\.ts.*must not import from generated\//);
  });
});
