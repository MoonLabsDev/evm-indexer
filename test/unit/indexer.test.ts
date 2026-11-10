import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { Interface } from 'ethers';
import type { Db } from 'mongodb';
import { startMongo } from '../helpers/mongo';
import { Indexer, type IndexerDeps } from '../../src/indexer/indexer';
import { sortLogs, type ScanBatch, type Scanner } from '../../src/indexer/scan';
import { SystemStore } from '../../src/store/system';
import { BaseContract } from '../../src/runtime/contract';
import { block, chain, tx } from '../../src/runtime/context';
import { defineIndexer, defineTemplate, type Template } from '../../src/runtime/define';
import { BaseEntity } from '../../src/runtime/entity';
import type { EventDef } from '../../src/runtime/events';
import type { FieldSpec } from '../../src/runtime/fields';
import { AllRpcFailedError } from '../../src/rpc/errors';
import type { ChainConfig, EventDoc, IndexedEvent, RawBlock, RawLog, StaticEntry } from '../../src/types';

// ---- fake contracts with real ABIs, so decodeLog runs for real ----

const FACTORY_ABI = [
  { type: 'event', name: 'Created', anonymous: false, inputs: [{ name: 'pool', type: 'address', indexed: false }] },
] as const;
const POOL_ABI = [
  { type: 'event', name: 'Swap', anonymous: false, inputs: [{ name: 'amount', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'Spawn', anonymous: false, inputs: [{ name: 'child', type: 'address', indexed: false }] },
] as const;
const factoryIface = new Interface(FACTORY_ABI as never);
const poolIface = new Interface(POOL_ABI as never);
const indexedFactoryIface = new Interface([
  { type: 'event', name: 'Created', anonymous: false, inputs: [{ name: 'pool', type: 'address', indexed: true }] },
] as never);
const defOf = (iface: Interface, name: string, signature: string): EventDef => ({
  name, signature, topic0: iface.getEvent(signature)!.topicHash.toLowerCase(),
});

interface FactoryEvents { Created: IndexedEvent<{ pool: string }> }
interface PoolEvents { Swap: IndexedEvent<{ amount: bigint }>; Spawn: IndexedEvent<{ child: string }> }

class FactoryC extends BaseContract {
  static readonly abi = FACTORY_ABI;
  static readonly events: Record<keyof FactoryEvents, EventDef> = { Created: defOf(factoryIface, 'Created', 'Created(address)') };
  static readonly eventTypes = {} as FactoryEvents;
  constructor(address: string) { super(address, FACTORY_ABI as unknown as unknown[]); }
}
class PoolC extends BaseContract {
  static readonly abi = POOL_ABI;
  static readonly events: Record<keyof PoolEvents, EventDef> = {
    Swap: defOf(poolIface, 'Swap', 'Swap(uint256)'),
    Spawn: defOf(poolIface, 'Spawn', 'Spawn(address)'),
  };
  static readonly eventTypes = {} as PoolEvents;
  constructor(address: string) { super(address, POOL_ABI as unknown as unknown[]); }
}

class Thing extends BaseEntity {
  static readonly table = 'Thing';
  static readonly fields: Record<string, FieldSpec> = {};
  static load(id: string): Promise<Thing | null> { return BaseEntity._load(Thing, id); }
}

// ---- indexer config: Factory.Created creates PoolT, PoolT.Spawn creates another PoolT ----

/** Test hooks, reset before every test. */
const hooks: {
  created: ((e: FactoryEvents['Created']) => Promise<void>) | null;
  swaps: string[];
  /** false: the Created callback calls PoolT.create without awaiting it */
  awaitCreate: boolean;
} = { created: null, swaps: [], awaitCreate: true };
const templates: { pool: Template<PoolEvents> | null } = { pool: null };

const PoolT = defineTemplate<PoolEvents>({
  contract: PoolC,
  events: {
    Swap: { index: async (e) => { hooks.swaps.push(`${e.address}:${e.blockNumber}/${e.txIndex}/${e.logIndex}`); } },
    Spawn: { index: async (e) => { await templates.pool!.create(e.args.child); } },
  },
});
templates.pool = PoolT;

const config = defineIndexer({
  contracts: {
    Factory: {
      contract: FactoryC,
      events: {
        Created: {
          index: async (e) => {
            if (hooks.created) await hooks.created(e);
            if (hooks.awaitCreate) await PoolT.create(e.args.pool);
            else void PoolT.create(e.args.pool);
          },
        },
      },
    },
  },
  templates: { PoolT },
});

// ---- fake chain ----

const F = '0x' + 'f1'.repeat(20);
const P = '0x' + 'a1'.repeat(20);
const Q = '0x' + 'b2'.repeat(20);
const S = '0x' + 'c3'.repeat(20);
const CHAIN_ID = 1;

const txHash = (b: number, t: number) => '0x' + b.toString(16).padStart(32, '0') + t.toString(16).padStart(32, '0');
const blockHash = (b: number) => '0x' + 'bb'.repeat(28) + b.toString(16).padStart(8, '0');
const blockTime = (b: number) => 1_700_000_000 + b * 12;
const key = (l: { blockNumber: number; txIndex: number; logIndex: number }) => `${l.blockNumber}/${l.txIndex}/${l.logIndex}`;

class FakeChain {
  logs: RawLog[] = [];
  blocks = new Map<number, RawBlock>();

  private add(address: string, enc: { topics: string[]; data: string }, b: number, t: number, l: number): RawLog {
    let blk = this.blocks.get(b);
    if (!blk) {
      blk = { number: b, hash: blockHash(b), timestamp: blockTime(b), logsBloom: '0x', transactions: [] };
      this.blocks.set(b, blk);
    }
    if (!blk.transactions.some((x) => x.transactionIndex === t)) {
      blk.transactions.push({
        hash: txHash(b, t), from: '0x' + '11'.repeat(20), to: address, value: 10n ** 18n + BigInt(b),
        nonce: b, gasPrice: 7_000_000_000n, input: '0xabcd', transactionIndex: t,
      });
    }
    const log: RawLog = {
      address, topics: enc.topics.map((x) => x.toLowerCase()), data: enc.data.toLowerCase(),
      blockNumber: b, transactionIndex: t, logIndex: l, transactionHash: txHash(b, t),
    };
    this.logs.push(log);
    return log;
  }

  created(pool: string, b: number, t: number, l: number): RawLog {
    return this.add(F, factoryIface.encodeEventLog('Created', [pool]), b, t, l);
  }

  /** Same signature and topic0 as Created(address), but the pool is indexed: data is empty. */
  createdIndexed(pool: string, b: number, t: number, l: number): RawLog {
    return this.add(F, indexedFactoryIface.encodeEventLog('Created', [pool]), b, t, l);
  }

  swap(address: string, amount: bigint, b: number, t: number, l: number): RawLog {
    return this.add(address, poolIface.encodeEventLog('Swap', [amount]), b, t, l);
  }

  spawn(address: string, child: string, b: number, t: number, l: number): RawLog {
    return this.add(address, poolIface.encodeEventLog('Spawn', [child]), b, t, l);
  }
}

/**
 * In-memory scanner. With `known` it behaves like the real scanners: only logs of addresses known
 * at that moment (statics + sys_templates rows), so template logs created in the range arrive only
 * through `logsFor`. Without `known` it returns every log of the range (the indexer re-matches each
 * log), which exercises the de-duplication of catch-up logs against the queue.
 */
class FakeScanner implements Scanner {
  calls: Array<[number, number]> = [];
  logsForCalls: Array<[string, number]> = [];
  constructor(
    private readonly fake: FakeChain,
    public range = 1000,
    private readonly known: (() => Promise<Set<string>>) | null = null,
  ) {}

  async scan(from: number, target: number): Promise<ScanBatch> {
    this.calls.push([from, target]);
    const to = Math.min(from + this.range - 1, target);
    const inRange = (l: RawLog, lo: number) => l.blockNumber >= lo && l.blockNumber <= to;
    const atScan = this.known ? await this.known() : null;
    return {
      from,
      to,
      logs: sortLogs(this.fake.logs.filter((l) => inRange(l, from) && (atScan === null || atScan.has(l.address)))),
      getBlock: async (n) => {
        const b = this.fake.blocks.get(n);
        if (!b) throw new Error(`no block ${n}`);
        return b;
      },
      logsFor: async (address, fromBlock) => {
        this.logsForCalls.push([address, fromBlock]);
        const now = this.known ? await this.known() : null;
        if (now !== null && !now.has(address)) return [];
        return sortLogs(this.fake.logs.filter((l) => l.address === address && inRange(l, Math.max(from, fromBlock))));
      },
    };
  }
}

function chainConfig(over: Partial<ChainConfig> = {}): ChainConfig {
  return {
    chainId: CHAIN_ID, name: 'testnet', rpc: [], confirmations: 0, retryDelays: [100, 500, 2500],
    logRange: { start: 500, min: 1, max: 2000 }, blockBatch: { start: 10, min: 1, max: 100 },
    headThreshold: 64, useBloom: true, pollInterval: 1000, ...over,
  };
}

const notUsed = async (): Promise<never> => { throw new Error('not used by the indexer'); };

// ---- harness ----

let mongo: { db: Db; stop(): Promise<void> };
let db: Db;

beforeAll(async () => { mongo = await startMongo(); });
afterAll(async () => { await mongo.stop(); });
beforeEach(async () => {
  db = mongo.db;
  await db.dropDatabase();
  hooks.created = null;
  hooks.swaps = [];
  hooks.awaitCreate = true;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

interface Setup {
  head?: number;
  statics?: StaticEntry[];
  chainOver?: Partial<ChainConfig>;
  range?: number;
  /** scanner returns every log of the range instead of only known addresses */
  unfiltered?: boolean;
  sleep?: (ms: number) => Promise<void>;
}

function setup(fake: FakeChain, o: Setup = {}) {
  const pool = { head: o.head ?? 20 } as { head: number };
  const poolObj = {
    getBlockNumber: vi.fn(async () => pool.head),
    ethCall: vi.fn(async () => '0x'),
    size: () => 10,
    getLogs: notUsed,
    getBlocks: notUsed,
    getBlockLogs: notUsed,
  };
  const store = new SystemStore(db);
  const statics = o.statics ?? [{ source: 'Factory', address: F, block: 5 }];
  const known = o.unfiltered ? null : async () => new Set([
    ...statics.map((e) => e.address),
    ...(await store.listTemplates(CHAIN_ID)).map((t) => t.address),
  ]);
  const backfill = new FakeScanner(fake, o.range ?? 1000, known);
  const head = new FakeScanner(fake, o.range ?? 1000, known);
  const deps: IndexerDeps = {
    chain: chainConfig(o.chainOver),
    pool: poolObj,
    store,
    config,
    statics,
    scanners: { backfill, head },
    ...(o.sleep ? { sleep: o.sleep } : {}),
  };
  return { pool, poolObj, backfill, head, store, deps, indexer: new Indexer(deps) };
}

const eventsSorted = async (): Promise<EventDoc[]> => (await db.collection('sys_events')
  .find({}, { projection: { _id: 0 } }).sort({ blockNumber: 1, txIndex: 1, logIndex: 1 }).toArray()) as unknown as EventDoc[];

describe('Indexer', () => {
  it('stores events and one tx doc per tx, sets indexedBlock to batch.to', async () => {
    const fake = new FakeChain();
    fake.created(P, 10, 0, 0);
    fake.swap(P, 5n, 10, 0, 1);
    fake.created(Q, 11, 2, 3);
    const { indexer, store } = setup(fake, { head: 20 });
    await indexer.init();

    expect(await indexer.tick()).toBe('worked');

    const events = await eventsSorted();
    expect(events).toHaveLength(3);
    expect(events[0]).toEqual({
      chainId: CHAIN_ID, address: F, eventId: FactoryC.events.Created.topic0, blockNumber: 10, txIndex: 0, logIndex: 0,
      txHash: txHash(10, 0), source: 'Factory', event: 'Created', data: { pool: P }, processRevisionId: -1,
    });
    expect(events[1]).toMatchObject({
      address: P, eventId: PoolC.events.Swap.topic0, source: 'PoolT', event: 'Swap',
      data: { amount: { __bigint: '5' } }, processRevisionId: -1,
    });
    expect(events[2]).toMatchObject({ address: F, blockNumber: 11, txIndex: 2, logIndex: 3, txHash: txHash(11, 2) });

    const txs = await db.collection('sys_transactions').find({}, { projection: { _id: 0 } }).sort({ blockNumber: 1 }).toArray();
    expect(txs).toHaveLength(2);
    expect(txs[0]).toEqual({
      chainId: CHAIN_ID, hash: txHash(10, 0), from: '0x' + '11'.repeat(20), to: F,
      value: (10n ** 18n + 10n).toString(), nonce: 10, gasPrice: '7000000000', input: '0xabcd',
      transactionIndex: 0, blockNumber: 10, blockHash: blockHash(10), blockTimestamp: new Date(blockTime(10) * 1000),
    });
    expect(txs[1]).toMatchObject({ hash: txHash(11, 2), transactionIndex: 2 });

    const state = await store.getChain(CHAIN_ID);
    expect(state.indexedBlock).toBe(20);
    expect(indexer.status()).toEqual({ chainId: CHAIN_ID, name: 'testnet', currentBlock: 20, indexBlock: 20 });
  });

  it('starts a fresh chain at registry.minBlock() and then at indexedBlock + 1', async () => {
    const { indexer, head } = setup(new FakeChain(), { head: 40, range: 10 });
    await indexer.init();
    await indexer.tick();
    await indexer.tick();
    expect(head.calls).toEqual([[5, 40], [15, 40]]);
  });

  it('picks backfill when target - from + 1 > headThreshold, head otherwise', async () => {
    const a = setup(new FakeChain(), { head: 65, statics: [{ source: 'Factory', address: F, block: 1 }] });
    await a.indexer.init();
    await a.indexer.tick();
    // backfill stops headThreshold blocks before the target (see the cap test below)
    expect(a.backfill.calls).toEqual([[1, 1]]);
    expect(a.head.calls).toEqual([]);

    await db.dropDatabase();
    const b = setup(new FakeChain(), { head: 64, statics: [{ source: 'Factory', address: F, block: 1 }] });
    await b.indexer.init();
    await b.indexer.tick();
    expect(b.head.calls).toEqual([[1, 64]]);
    expect(b.backfill.calls).toEqual([]);
  });

  it('caps backfill at target - headThreshold and leaves the last headThreshold blocks to head mode', async () => {
    // eth_getLogs up to the head of a lagging node can return an empty tail without an error
    const fake = new FakeChain();
    fake.created(P, 150, 0, 0);
    fake.swap(P, 7n, 290, 0, 0);
    const { indexer, backfill, head, store } = setup(fake, {
      head: 300, range: 1000, statics: [{ source: 'Factory', address: F, block: 100 }],
    });
    await indexer.init();
    await indexer.tick();
    expect(backfill.calls).toEqual([[100, 236]]);
    expect((await store.getChain(CHAIN_ID)).indexedBlock).toBe(236);
    expect(head.calls).toEqual([]);

    await indexer.tick();
    expect(head.calls).toEqual([[237, 300]]);
    expect(backfill.calls).toHaveLength(1);
    expect((await store.getChain(CHAIN_ID)).indexedBlock).toBe(300);
    expect((await eventsSorted()).map((e) => e.blockNumber)).toEqual([150, 290]);
  });

  it('is idle when from > target: no scan, heartbeat written', async () => {
    const { indexer, head, backfill, store } = setup(new FakeChain(), { head: 4 });
    await indexer.init();
    expect(await indexer.tick()).toBe('idle');
    expect(head.calls).toEqual([]);
    expect(backfill.calls).toEqual([]);
    const state = await store.getChain(CHAIN_ID);
    expect(state.indexerHeartbeat).toBeInstanceOf(Date);
    expect(state.indexedBlock).toBe(0);
  });

  it('is idle when nothing is registered', async () => {
    const { indexer, head } = setup(new FakeChain(), { head: 100, statics: [] });
    await indexer.init();
    expect(await indexer.tick()).toBe('idle');
    expect(head.calls).toEqual([]);
  });

  it('indexes a template created in the range from the creating log on, in order', async () => {
    const fake = new FakeChain();
    fake.swap(P, 1n, 9, 0, 0);
    fake.created(P, 10, 0, 0);
    fake.swap(P, 2n, 10, 0, 1);
    fake.swap(P, 3n, 10, 1, 0);
    fake.swap(P, 4n, 12, 0, 0);
    const { indexer, head } = setup(fake, { head: 20 });
    await indexer.init();
    await indexer.tick();

    expect(hooks.swaps).toEqual([`${P}:10/0/1`, `${P}:10/1/0`, `${P}:12/0/0`]);
    const swaps = (await eventsSorted()).filter((e) => e.event === 'Swap');
    expect(swaps.map((e) => key(e))).toEqual(['10/0/1', '10/1/0', '12/0/0']);
    expect(swaps.map((e) => e.data)).toEqual([{ amount: { __bigint: '2' } }, { amount: { __bigint: '3' } }, { amount: { __bigint: '4' } }]);
    expect(head.logsForCalls).toEqual([[P, 10]]);
    expect(await db.collection('sys_templates').find({}, { projection: { _id: 0 } }).toArray())
      .toEqual([{ chainId: CHAIN_ID, template: 'PoolT', address: P, block: 10, txIndex: 0, logIndex: 0 }]);
  });

  it('de-duplicates catch-up logs against the remaining queue (unfiltered scanner)', async () => {
    const fake = new FakeChain();
    fake.created(P, 10, 0, 0);
    fake.swap(P, 2n, 10, 0, 1);
    fake.swap(P, 3n, 12, 0, 0);
    const { indexer, head } = setup(fake, { unfiltered: true });
    await indexer.init();
    await indexer.tick();
    expect(head.logsForCalls).toEqual([[P, 10]]);
    expect(hooks.swaps).toEqual([`${P}:10/0/1`, `${P}:12/0/0`]); // each once
  });

  it('stores the same events for a template uninterrupted, after an aborted tick, and after a restart', async () => {
    const build = () => {
      const fake = new FakeChain();
      fake.swap(P, 1n, 10, 0, 0); // same block, before the creating log
      fake.created(P, 10, 1, 0);
      fake.swap(P, 2n, 10, 2, 0); // after it
      return fake;
    };
    const stored = async () => (await eventsSorted()).map((e) => `${e.event}@${e.address}@${key(e)}`);
    const expected = [`Created@${F}@10/1/0`, `Swap@${P}@10/2/0`];

    // (a) uninterrupted
    const a = setup(build());
    await a.indexer.init();
    await a.indexer.tick();
    expect(await stored()).toEqual(expected);

    // (b) first tick aborted after the template row was written, then retried
    await db.dropDatabase();
    const b = setup(build());
    await b.indexer.init();
    vi.spyOn(b.store, 'upsertEvents').mockRejectedValueOnce(new Error('write failed'));
    await expect(b.indexer.tick()).rejects.toThrow('write failed');
    expect(await db.collection('sys_templates').countDocuments()).toBe(1);
    await b.indexer.tick();
    expect(await stored()).toEqual(expected);

    // (c) aborted tick, then a fresh Indexer on the same DB
    await db.dropDatabase();
    const c1 = setup(build());
    await c1.indexer.init();
    vi.spyOn(c1.store, 'upsertEvents').mockRejectedValueOnce(new Error('write failed'));
    await expect(c1.indexer.tick()).rejects.toThrow('write failed');
    const c2 = setup(build());
    await c2.indexer.init();
    await c2.indexer.tick();
    expect(await stored()).toEqual(expected);
  });

  it('a failed template write is retried: the next tick writes the row and catches up', async () => {
    const fake = new FakeChain();
    fake.created(P, 10, 0, 0);
    fake.swap(P, 2n, 11, 0, 0);
    const { indexer, store } = setup(fake);
    await indexer.init();
    vi.spyOn(store, 'addTemplate').mockRejectedValueOnce(new Error('template write failed'));
    await expect(indexer.tick()).rejects.toThrow('template write failed');
    expect(await db.collection('sys_templates').countDocuments()).toBe(0);
    expect((await store.getChain(CHAIN_ID)).indexedBlock).toBe(0);

    expect(await indexer.tick()).toBe('worked');
    expect(await db.collection('sys_templates').find({}, { projection: { _id: 0 } }).toArray())
      .toEqual([{ chainId: CHAIN_ID, template: 'PoolT', address: P, block: 10, txIndex: 0, logIndex: 0 }]);
    expect((await eventsSorted()).map((e) => `${e.event}@${key(e)}`)).toEqual(['Created@10/0/0', 'Swap@11/0/0']);
  });

  it('catches up a template whose create is not awaited by the callback', async () => {
    hooks.awaitCreate = false;
    const fake = new FakeChain();
    fake.created(P, 10, 0, 0);
    fake.swap(P, 2n, 10, 0, 1);
    const { indexer } = setup(fake);
    await indexer.init();
    await indexer.tick();
    expect(hooks.swaps).toEqual([`${P}:10/0/1`]);
    expect(await db.collection('sys_templates').countDocuments()).toBe(1);
  });

  it('catches up only logs strictly after the creating log', async () => {
    const fake = new FakeChain();
    fake.swap(P, 1n, 10, 0, 5);
    fake.created(P, 10, 1, 0);
    fake.swap(P, 2n, 10, 1, 1);
    const { indexer } = setup(fake);
    await indexer.init();
    await indexer.tick();
    expect(hooks.swaps).toEqual([`${P}:10/1/1`]);
    expect((await eventsSorted()).map((e) => `${e.event}@${key(e)}`)).toEqual(['Created@10/1/0', 'Swap@10/1/1']);
  });

  it('indexes chained templates', async () => {
    const fake = new FakeChain();
    fake.created(P, 10, 0, 0);
    fake.spawn(P, Q, 11, 0, 0);
    fake.swap(Q, 9n, 11, 0, 1);
    fake.swap(Q, 8n, 13, 0, 0);
    const { indexer } = setup(fake);
    await indexer.init();
    await indexer.tick();
    expect(hooks.swaps).toEqual([`${Q}:11/0/1`, `${Q}:13/0/0`]);
    const templatesRows = await db.collection('sys_templates').find({}, { projection: { _id: 0 } }).sort({ block: 1 }).toArray();
    expect(templatesRows).toEqual([
      { chainId: CHAIN_ID, template: 'PoolT', address: P, block: 10, txIndex: 0, logIndex: 0 },
      { chainId: CHAIN_ID, template: 'PoolT', address: Q, block: 11, txIndex: 0, logIndex: 0 },
    ]);
    expect((await eventsSorted()).map((e) => `${e.event}@${key(e)}`))
      .toEqual(['Created@10/0/0', 'Spawn@11/0/0', 'Swap@11/0/1', 'Swap@13/0/0']);
  });

  it('sets the index context inside the callback', async () => {
    const fake = new FakeChain();
    const created = fake.created(P, 10, 3, 4);
    const seen: Record<string, unknown> = {};
    hooks.created = async () => {
      seen.hash = tx().hash;
      seen.from = tx().from;
      seen.value = tx().value;
      seen.logIndex = tx().logIndex;
      seen.txIndex = tx().transactionIndex;
      seen.block = block().number;
      seen.blockHash = block().hash;
      seen.time = block().timestamp.unix;
      seen.chain = chain();
    };
    const { indexer } = setup(fake);
    await indexer.init();
    await indexer.tick();
    expect(seen).toEqual({
      hash: created.transactionHash, from: '0x' + '11'.repeat(20), value: 10n ** 18n + 10n, logIndex: 4, txIndex: 3,
      block: created.blockNumber, blockHash: blockHash(10), time: blockTime(10), chain: { id: CHAIN_ID, name: 'testnet' },
    });
    expect(() => tx()).toThrow();
  });

  it('hands the decoded event to the index callback', async () => {
    const fake = new FakeChain();
    fake.created(P, 10, 3, 4);
    let ev: unknown;
    hooks.created = async (e) => { ev = e; };
    const { indexer } = setup(fake);
    await indexer.init();
    await indexer.tick();
    expect(ev).toEqual({ args: { pool: P }, address: F, blockNumber: 10, txIndex: 3, logIndex: 4, txHash: txHash(10, 3) });
  });

  it('rejects entity access inside an index callback and stores nothing', async () => {
    const fake = new FakeChain();
    fake.created(P, 10, 0, 0);
    hooks.created = async () => { await Thing.load('x'); };
    const { indexer, store } = setup(fake);
    await indexer.init();
    await expect(indexer.tick()).rejects.toThrow(/index callbacks/);
    expect(await db.collection('sys_events').countDocuments()).toBe(0);
    expect((await store.getChain(CHAIN_ID)).indexedBlock).toBe(0);
  });

  it('Template.create of an address registered statically writes no sys_templates row and does not throw', async () => {
    const fake = new FakeChain();
    fake.created(S, 10, 0, 0); // S is a static PoolT → 'exists'
    fake.created(F, 11, 0, 0); // F is the static Factory → 'conflict', logged
    const { indexer } = setup(fake, {
      statics: [{ source: 'Factory', address: F, block: 5 }, { source: 'PoolT', address: S, block: 5 }],
    });
    await indexer.init();
    expect(await indexer.tick()).toBe('worked');
    expect(await db.collection('sys_templates').countDocuments()).toBe(0);
    expect(await db.collection('sys_events').countDocuments()).toBe(2);
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toMatch(/conflict|belongs|Factory/i);
  });

  it('skips a log it cannot decode, logs it once per address and topic0, and indexes the rest', async () => {
    const fake = new FakeChain();
    const bad = fake.createdIndexed(P, 10, 0, 0);
    expect(bad.topics[0]).toBe(FactoryC.events.Created.topic0);
    expect(bad.data).toBe('0x');
    fake.createdIndexed(Q, 11, 0, 0);
    fake.created(Q, 12, 0, 0);
    const { indexer, store } = setup(fake, { head: 20 });
    await indexer.init();

    expect(await indexer.tick()).toBe('worked');
    const events = await eventsSorted();
    expect(events.map((e) => [e.blockNumber, e.event, e.data])).toEqual([[12, 'Created', { pool: Q }]]);
    expect((await store.getChain(CHAIN_ID)).indexedBlock).toBe(20);
    expect((await store.listTemplates(CHAIN_ID)).map((t) => t.address)).toEqual([Q]);
    const errors = vi.mocked(console.error).mock.calls.map((c) => String(c[0])).filter((m) => m.includes('cannot decode'));
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain(F);
    expect(errors[0]).toContain(FactoryC.events.Created.topic0);
    expect(errors[0]).toContain('10/0/0');
  });

  it('throws when a log has no transaction in its block', async () => {
    const fake = new FakeChain();
    fake.created(P, 10, 0, 0);
    fake.blocks.get(10)!.transactions = [];
    const { indexer, store } = setup(fake);
    await indexer.init();
    await expect(indexer.tick()).rejects.toThrow(/transaction/);
    expect((await store.getChain(CHAIN_ID)).indexedBlock).toBe(0);
  });

  it('is crash safe: a failed store write leaves indexedBlock, the re-run leaves no duplicates', async () => {
    const fake = new FakeChain();
    fake.created(P, 10, 0, 0);
    fake.swap(P, 2n, 10, 0, 1);
    fake.swap(P, 3n, 12, 0, 0);
    const { indexer, store } = setup(fake);
    await indexer.init();
    const spy = vi.spyOn(store, 'upsertEvents').mockRejectedValueOnce(new Error('write failed'));
    await expect(indexer.tick()).rejects.toThrow('write failed');
    expect((await store.getChain(CHAIN_ID)).indexedBlock).toBe(0);
    expect(spy).toHaveBeenCalledTimes(1);

    expect(await indexer.tick()).toBe('worked');
    expect((await store.getChain(CHAIN_ID)).indexedBlock).toBe(20);
    expect((await eventsSorted()).map((e) => `${e.event}@${key(e)}`)).toEqual(['Created@10/0/0', 'Swap@10/0/1', 'Swap@12/0/0']);
    expect(await db.collection('sys_transactions').countDocuments()).toBe(2);
    expect(await db.collection('sys_templates').countDocuments()).toBe(1);
  });

  it('loads templates from sys_templates on restart', async () => {
    const fake = new FakeChain();
    fake.created(P, 10, 0, 0);
    fake.swap(P, 7n, 25, 0, 0);
    const first = setup(fake, { head: 15 });
    await first.indexer.init();
    await first.indexer.tick();
    expect((await first.store.getChain(CHAIN_ID)).indexedBlock).toBe(15);

    const second = setup(fake, { head: 30 });
    await second.indexer.init();
    expect(second.indexer.status().indexBlock).toBe(15);
    await second.indexer.tick();
    expect(second.head.calls).toEqual([[16, 30]]);
    const swaps = (await eventsSorted()).filter((e) => e.event === 'Swap');
    expect(swaps.map((e) => key(e))).toEqual(['25/0/0']);
  });

  it('uses target = head - confirmations', async () => {
    const { indexer, backfill, head } = setup(new FakeChain(), {
      head: 100, chainOver: { confirmations: 5 }, statics: [{ source: 'Factory', address: F, block: 50 }],
    });
    await indexer.init();
    await indexer.tick();
    expect(head.calls).toEqual([[50, 95]]);
    expect(backfill.calls).toEqual([]);
    expect(indexer.status().currentBlock).toBe(100);
  });

  it('run() logs a failure, sleeps pollInterval, retries, and only stamps lastLoopAt on success', async () => {
    class Stop extends Error {}
    const sleeps: number[] = [];
    let atFirstSleep = -1;
    const sleep = vi.fn(async (ms: number) => {
      sleeps.push(ms);
      if (sleeps.length === 1) atFirstSleep = ctx.indexer.lastLoopAt();
      if (sleeps.length === 2) throw new Stop();
    });
    const ctx = setup(new FakeChain(), { head: 4, sleep, chainOver: { pollInterval: 250 } });
    await ctx.indexer.init();
    ctx.poolObj.getBlockNumber.mockRejectedValueOnce(new AllRpcFailedError());
    await expect(ctx.indexer.run()).rejects.toBeInstanceOf(Stop);
    expect(sleeps).toEqual([250, 250]);
    expect(atFirstSleep).toBe(0); // the failed tick did not stamp it
    expect(ctx.indexer.lastLoopAt()).toBeGreaterThan(0); // the idle tick did
    expect(vi.mocked(console.error).mock.calls.flat().join('\n')).toMatch(/all RPC endpoints failed/);
  });

  it('run() keeps the heartbeat fresh while the tick keeps failing, without touching lastLoopAt', async () => {
    class Stop extends Error {}
    let sleeps = 0;
    const sleep = vi.fn(async () => {
      sleeps += 1;
      if (sleeps === 3) throw new Stop();
    });
    const ctx = setup(new FakeChain(), { head: 4, sleep });
    await ctx.indexer.init();
    ctx.poolObj.getBlockNumber.mockRejectedValue(new AllRpcFailedError());
    expect((await ctx.store.getChain(CHAIN_ID)).indexerHeartbeat).toBeNull();
    await expect(ctx.indexer.run()).rejects.toBeInstanceOf(Stop);
    expect(ctx.indexer.lastLoopAt()).toBe(0);
    expect(await ctx.store.isAlive(CHAIN_ID, 'indexer')).toBe(true);
  });

  it('run() logs a failing heartbeat at debug level only and still reports the tick error', async () => {
    class Stop extends Error {}
    let sleeps = 0;
    const sleep = vi.fn(async () => {
      sleeps += 1;
      if (sleeps === 1) throw new Stop();
    });
    const ctx = setup(new FakeChain(), { head: 4, sleep });
    await ctx.indexer.init();
    ctx.poolObj.getBlockNumber.mockRejectedValue(new AllRpcFailedError());
    vi.spyOn(ctx.store, 'heartbeat').mockRejectedValue(new Error('mongo down'));
    await expect(ctx.indexer.run()).rejects.toBeInstanceOf(Stop);
    const errors = vi.mocked(console.error).mock.calls.flat().join('\n');
    expect(errors).toMatch(/all RPC endpoints failed/);
    expect(errors).not.toMatch(/mongo down/);
  });
});
