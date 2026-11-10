import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from 'vitest';
import { AbiCoder, Interface } from 'ethers';
import type { Db } from 'mongodb';
import { startMongo } from '../helpers/mongo';
import { Processor, type ProcessorDeps } from '../../src/processor/processor';
import { SystemStore } from '../../src/store/system';
import { EntityStore } from '../../src/store/entities';
import { BaseContract } from '../../src/runtime/contract';
import { block, chain, currentContext, tx } from '../../src/runtime/context';
import { defineIndexer, defineTemplate } from '../../src/runtime/define';
import { BaseEntity } from '../../src/runtime/entity';
import { serializeArgs, type EventDef } from '../../src/runtime/events';
import type { FieldSpec } from '../../src/runtime/fields';
import type { ChainConfig, EventDoc, IndexedEvent, TxDoc } from '../../src/types';

// ---- fake contract with a real ABI (events + one view function) ----

const TOKEN_ABI = [
  { type: 'event', name: 'Transfer', anonymous: false, inputs: [{ name: 'amount', type: 'uint256', indexed: false }] },
  { type: 'event', name: 'Mint', anonymous: false, inputs: [] },
  { type: 'function', name: 'total', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint256' }] },
] as const;
const tokenIface = new Interface(TOKEN_ABI as never);
const defOf = (name: string, signature: string): EventDef => ({
  name, signature, topic0: tokenIface.getEvent(signature)!.topicHash.toLowerCase(),
});

interface TokenEvents { Transfer: IndexedEvent<{ amount: bigint }>; Mint: IndexedEvent<{}> }

class TokenC extends BaseContract {
  static readonly abi = TOKEN_ABI;
  static readonly events: Record<keyof TokenEvents, EventDef> = {
    Transfer: defOf('Transfer', 'Transfer(uint256)'),
    Mint: defOf('Mint', 'Mint()'),
  };
  static readonly eventTypes = {} as TokenEvents;
  constructor(address: string) { super(address, TOKEN_ABI as unknown as unknown[]); }
  total(): Promise<bigint> { return this._call('total()', []) as Promise<bigint>; }
}

// ---- hand-written entity ----

const f = (type: FieldSpec['type']): FieldSpec => ({ type, array: false, optional: false });

class Counter extends BaseEntity {
  static readonly table = 'Counter';
  static readonly fields: Record<string, FieldSpec> = { count: f('int') };
  static load(id: string): Promise<Counter | null> { return BaseEntity._load(Counter, id); }
  get count(): number { return this._get('count') as number; }
  set count(v: number) { this._set('count', v); }
}

async function bump(): Promise<void> {
  const c = (await Counter.load('total')) ?? new Counter('total');
  c.count = (c.count ?? 0) + 1;
  await c.save();
}

// ---- config ----

const key = (l: { blockNumber: number; txIndex: number; logIndex: number }) => `${l.blockNumber}/${l.txIndex}/${l.logIndex}`;

const hooks: {
  seen: string[];
  onTransfer: ((e: TokenEvents['Transfer']) => Promise<void>) | null;
} = { seen: [], onTransfer: null };

const PoolT = defineTemplate<TokenEvents>({ contract: TokenC, events: { Transfer: null } });

const config = defineIndexer({
  contracts: {
    Token: {
      contract: TokenC,
      events: {
        Transfer: async (e) => {
          hooks.seen.push(key(e));
          if (hooks.onTransfer) await hooks.onTransfer(e);
          else await bump();
        },
        Mint: null,
      },
    },
  },
  templates: { PoolT },
});

// ---- fixtures ----

const CHAIN_ID = 1;
const T = '0x' + 'a1'.repeat(20);
const FROM = '0x' + '11'.repeat(20);
const txHash = (b: number, t: number) => '0x' + b.toString(16).padStart(32, '0') + t.toString(16).padStart(32, '0');
const blockHash = (b: number) => '0x' + 'bb'.repeat(28) + b.toString(16).padStart(8, '0');
const blockTime = (b: number) => 1_700_000_000 + b * 12;

function chainConfig(over: Partial<ChainConfig> = {}): ChainConfig {
  return {
    chainId: CHAIN_ID, name: 'testnet', rpc: [], confirmations: 0, retryDelays: [100, 500, 2500],
    logRange: { start: 500, min: 1, max: 2000 }, blockBatch: { start: 10, min: 1, max: 100 },
    headThreshold: 64, useBloom: true, pollInterval: 1000, ...over,
  };
}

let mongo: { db: Db; stop(): Promise<void> };
let db: Db;
let store: SystemStore;

beforeAll(async () => { mongo = await startMongo(); });
afterAll(async () => { await mongo.stop(); });
beforeEach(async () => {
  db = mongo.db;
  await db.dropDatabase();
  store = new SystemStore(db);
  hooks.seen = [];
  hooks.onTransfer = null;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); });

function txDoc(b: number, t: number): TxDoc {
  return {
    chainId: CHAIN_ID, hash: txHash(b, t), from: FROM, to: T, value: (10n ** 18n + BigInt(b)).toString(),
    nonce: b, gasPrice: '7000000000', input: '0xabcd', transactionIndex: t,
    blockNumber: b, blockHash: blockHash(b), blockTimestamp: new Date(blockTime(b) * 1000),
  };
}

interface Ev { b: number; t: number; l: number; source?: string; event?: string; amount?: bigint }

/** Inserts events (and their transactions) through the real SystemStore. */
async function insert(evs: Ev[]): Promise<void> {
  const events: EventDoc[] = evs.map((e) => {
    const source = e.source ?? 'Token';
    const event = e.event ?? 'Transfer';
    const args = event === 'Transfer' ? { amount: e.amount ?? BigInt(e.b * 100 + e.l) } : {};
    return {
      chainId: CHAIN_ID, address: T, eventId: (TokenC.events as Record<string, EventDef>)[event]?.topic0 ?? '0xff',
      blockNumber: e.b, txIndex: e.t, logIndex: e.l, txHash: txHash(e.b, e.t),
      source, event, data: serializeArgs(args), processRevisionId: -1,
    };
  });
  await store.upsertTransactions(evs.map((e) => txDoc(e.b, e.t)));
  await store.upsertEvents(events);
}

const eventsSorted = async (): Promise<EventDoc[]> => (await db.collection('sys_events')
  .find({}, { projection: { _id: 0 } }).sort({ blockNumber: 1, txIndex: 1, logIndex: 1 }).toArray()) as unknown as EventDoc[];
const stamps = async () => (await eventsSorted()).map((e) => e.processRevisionId);
const counter = async () => (await db.collection(`ent_${CHAIN_ID}_Counter`).findOne({ _id: 'total' as never }))?.count;

function setup(o: { head?: number; sleep?: (ms: number) => Promise<void>; batchSize?: number; ethCall?: (to: string, data: string, bn: number) => Promise<string> } = {}) {
  const head = { n: o.head ?? 100 };
  const pool = {
    getBlockNumber: vi.fn(async () => head.n),
    ethCall: vi.fn(o.ethCall ?? (async () => '0x')),
  };
  const deps: ProcessorDeps = {
    chain: chainConfig(), pool, store, entities: new EntityStore(db, CHAIN_ID), config,
    ...(o.batchSize ? { batchSize: o.batchSize } : {}),
    ...(o.sleep ? { sleep: o.sleep } : {}),
  };
  return { head, pool, deps, processor: new Processor(deps) };
}

describe('Processor', () => {
  it('runs callbacks in (block, tx, log) order regardless of insert order', async () => {
    await insert([{ b: 12, t: 0, l: 5 }, { b: 10, t: 1, l: 2 }, { b: 10, t: 0, l: 7 }, { b: 12, t: 0, l: 1 }, { b: 11, t: 3, l: 0 }]);
    await store.setIndexed(CHAIN_ID, 20);
    const { processor } = setup({ batchSize: 2 });
    await processor.init();
    while ((await processor.tick()) === 'worked') { /* drain */ }
    expect(hooks.seen).toEqual(['10/0/7', '10/1/2', '11/3/0', '12/0/1', '12/0/5']);
    expect(await counter()).toBe(5);
  });

  it('hands the callback bigint args and a context built from sys_transactions', async () => {
    await insert([{ b: 10, t: 2, l: 3, amount: 2n ** 200n }]);
    await store.setIndexed(CHAIN_ID, 20);
    let got: unknown = null;
    hooks.onTransfer = async (e) => {
      got = {
        event: e, mode: currentContext()?.mode, from: tx().from, txValue: tx().value, gasPrice: tx().gasPrice,
        tx: tx(), unix: block().timestamp.unix, blockHash: block().hash, blockNumber: block().number, chain: chain(),
      };
    };
    const { processor } = setup();
    await processor.init();
    expect(await processor.tick()).toBe('worked');
    expect(got).toEqual({
      event: { args: { amount: 2n ** 200n }, address: T, blockNumber: 10, txIndex: 2, logIndex: 3, txHash: txHash(10, 2) },
      mode: 'process', from: FROM, txValue: 10n ** 18n + 10n, gasPrice: 7_000_000_000n,
      tx: {
        hash: txHash(10, 2), transactionIndex: 2, logIndex: 3, from: FROM, to: T, value: 10n ** 18n + 10n,
        nonce: 10, gasPrice: 7_000_000_000n, input: '0xabcd',
      },
      unix: blockTime(10), blockHash: blockHash(10), blockNumber: 10, chain: { id: CHAIN_ID, name: 'testnet' },
    });
    expect(currentContext()).toBeNull();
  });

  it('stamps every event; the next tick is idle and runs no callback', async () => {
    await insert([{ b: 10, t: 0, l: 0 }, { b: 11, t: 0, l: 0 }, { b: 12, t: 0, l: 0 }]);
    await store.setIndexed(CHAIN_ID, 20);
    const { processor } = setup();
    await processor.init();
    expect(await processor.tick()).toBe('worked');
    expect(await stamps()).toEqual([0, 0, 0]);
    expect((await store.getChain(CHAIN_ID)).processedBlock).toBe(12);
    hooks.seen = [];
    expect(await processor.tick()).toBe('idle');
    expect(hooks.seen).toEqual([]);
  });

  it('stamps an event without a process handler', async () => {
    await insert([{ b: 10, t: 0, l: 0, event: 'Mint' }]);
    await store.setIndexed(CHAIN_ID, 20);
    const { processor } = setup();
    await processor.init();
    expect(await processor.tick()).toBe('worked');
    expect(await stamps()).toEqual([0]);
    expect(hooks.seen).toEqual([]);
  });

  it('only processes events up to indexedBlock', async () => {
    await insert([{ b: 30, t: 0, l: 0 }, { b: 50, t: 0, l: 0 }]);
    await store.setIndexed(CHAIN_ID, 40);
    const { processor } = setup();
    await processor.init();
    expect(await processor.tick()).toBe('worked');
    expect(hooks.seen).toEqual(['30/0/0']);
    expect(await stamps()).toEqual([0, -1]);
    expect(await processor.tick()).toBe('idle');
    expect(await stamps()).toEqual([0, -1]);
  });

  it('stops at a failing callback and resumes at that event once it succeeds', async () => {
    await insert([{ b: 10, t: 0, l: 0 }, { b: 11, t: 0, l: 0 }, { b: 12, t: 0, l: 0 }]);
    await store.setIndexed(CHAIN_ID, 20);
    let broken = true;
    hooks.onTransfer = async (e) => {
      if (broken && e.blockNumber === 11) throw new Error('boom');
      await bump();
    };
    const { processor } = setup();
    await processor.init();
    await expect(processor.tick()).rejects.toThrow('boom');
    expect(await stamps()).toEqual([0, -1, -1]);
    expect((await store.getChain(CHAIN_ID)).processedBlock).toBe(10);
    expect(currentContext()).toBeNull();

    broken = false;
    hooks.seen = [];
    expect(await processor.tick()).toBe('worked');
    expect(hooks.seen).toEqual(['11/0/0', '12/0/0']);
    expect(await stamps()).toEqual([0, 0, 0]);
    expect(await counter()).toBe(3);
  });

  it('a missing transaction fails the tick without stamping', async () => {
    await insert([{ b: 10, t: 0, l: 0 }]);
    await db.collection('sys_transactions').deleteMany({});
    await store.setIndexed(CHAIN_ID, 20);
    const { processor } = setup();
    await processor.init();
    await expect(processor.tick()).rejects.toThrow(/transaction/);
    expect(await stamps()).toEqual([-1]);
  });

  it('replays on a revision bump: entities dropped and rebuilt, not doubled', async () => {
    await insert([{ b: 10, t: 0, l: 0 }, { b: 11, t: 0, l: 0 }, { b: 12, t: 0, l: 0 }]);
    await store.setIndexed(CHAIN_ID, 20);
    const { processor } = setup();
    await processor.init();
    expect(await processor.tick()).toBe('worked');
    expect(await counter()).toBe(3);

    await store.setRevision(CHAIN_ID, 1);
    expect(await processor.tick()).toBe('worked');
    expect(await counter()).toBe(3);
    const state = await store.getChain(CHAIN_ID);
    expect(state.entityRevisionId).toBe(1);
    expect(state.processedBlock).toBe(12);
    expect(await stamps()).toEqual([1, 1, 1]);
    expect(processor.status().revisionId).toBe(1);
  });

  it('picks up a revision change between ticks without a new Processor', async () => {
    await insert([{ b: 10, t: 0, l: 0 }]);
    await store.setIndexed(CHAIN_ID, 20);
    const { processor } = setup();
    await processor.init();
    expect(await processor.tick()).toBe('worked');
    expect(await processor.tick()).toBe('idle');
    await store.setRevision(CHAIN_ID, 7);
    hooks.seen = [];
    expect(await processor.tick()).toBe('worked');
    expect(hooks.seen).toEqual(['10/0/0']);
    expect(await stamps()).toEqual([7]);
    expect(await counter()).toBe(1);
  });

  it('stamps events of an unknown source and warns once per source/event pair', async () => {
    await insert([{ b: 10, t: 0, l: 0, source: 'Gone' }, { b: 11, t: 0, l: 0, source: 'Gone' }]);
    await store.setIndexed(CHAIN_ID, 20);
    const { processor } = setup();
    await processor.init();
    expect(await processor.tick()).toBe('worked');
    expect(await stamps()).toEqual([0, 0]);
    expect(hooks.seen).toEqual([]);
    const out = [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.error).mock.calls].map((c) => String(c[0]));
    expect(out.filter((m) => m.includes('Gone.Transfer'))).toHaveLength(1);
  });

  it('Template.create inside a process callback rejects', async () => {
    await insert([{ b: 10, t: 0, l: 0 }]);
    await store.setIndexed(CHAIN_ID, 20);
    hooks.onTransfer = async () => { await PoolT.create('0x' + 'c3'.repeat(20)); };
    const { processor } = setup();
    await processor.init();
    await expect(processor.tick()).rejects.toThrow(/index callbacks/);
    expect(await stamps()).toEqual([-1]);
  });

  it('contract calls in a callback run at the event block', async () => {
    await insert([{ b: 33, t: 0, l: 0 }]);
    await store.setIndexed(CHAIN_ID, 40);
    let total: bigint | null = null;
    hooks.onTransfer = async (e) => { total = await new TokenC(e.address).total(); };
    const { processor, pool } = setup({ ethCall: async () => AbiCoder.defaultAbiCoder().encode(['uint256'], [42n]) });
    await processor.init();
    expect(await processor.tick()).toBe('worked');
    expect(total).toBe(42n);
    expect(pool.ethCall).toHaveBeenCalledTimes(1);
    expect(pool.ethCall.mock.calls[0][0]).toBe(T);
    expect(pool.ethCall.mock.calls[0][2]).toBe(33);
  });

  it('status(): processBlock === indexedBlock when idle', async () => {
    await insert([{ b: 10, t: 0, l: 0 }]);
    await store.setIndexed(CHAIN_ID, 25);
    const { processor } = setup({ head: 99 });
    await processor.init();
    expect(await processor.tick()).toBe('worked');
    expect(processor.status()).toEqual({ chainId: CHAIN_ID, name: 'testnet', currentBlock: 99, indexBlock: 25, processBlock: 10, revisionId: 0 });
    expect(await processor.tick()).toBe('idle');
    expect(processor.status().processBlock).toBe(25);
    expect((await store.getChain(CHAIN_ID)).processedBlock).toBe(25);
  });

  it('refreshes the head at most every 5 s and keeps it when the RPC fails', async () => {
    await store.setIndexed(CHAIN_ID, 5);
    const realNow = Date.now.bind(Date);
    let offset = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
    const { processor, pool, head } = setup({ head: 50 });
    await processor.init();
    await processor.tick();
    await processor.tick();
    expect(pool.getBlockNumber).toHaveBeenCalledTimes(1);
    expect(processor.status().currentBlock).toBe(50);

    offset += 6000;
    head.n = 60;
    await processor.tick();
    expect(pool.getBlockNumber).toHaveBeenCalledTimes(2);
    expect(processor.status().currentBlock).toBe(60);

    offset += 6000;
    pool.getBlockNumber.mockRejectedValueOnce(new Error('rpc down'));
    expect(await processor.tick()).toBe('idle');
    expect(pool.getBlockNumber).toHaveBeenCalledTimes(3);
    expect(processor.status().currentBlock).toBe(60);
  });

  it('run(): logs the failing event key, sleeps pollInterval, retries; lastLoopAt only on success', async () => {
    await insert([{ b: 10, t: 0, l: 4 }]);
    await store.setIndexed(CHAIN_ID, 20);
    let fails = 2;
    hooks.onTransfer = async () => {
      if (fails > 0) { fails -= 1; throw new Error('kaput'); }
      await bump();
    };
    const sleeps: number[] = [];
    const stop = new Error('stop');
    let lastLoopDuringFailures = -1;
    const { processor } = setup({
      sleep: async (ms) => {
        sleeps.push(ms);
        if (sleeps.length === 2) lastLoopDuringFailures = processor.lastLoopAt();
        if (sleeps.length === 3) throw stop; // the idle sleep after success
      },
    });
    await processor.init();
    expect(processor.lastLoopAt()).toBe(0);
    await expect(processor.run()).rejects.toBe(stop);

    expect(sleeps).toEqual([1000, 1000, 1000]);
    expect(lastLoopDuringFailures).toBe(0);
    expect(processor.lastLoopAt()).toBeGreaterThan(0);
    expect(await counter()).toBe(1);
    expect(await stamps()).toEqual([0]);

    const errors = vi.mocked(console.error).mock.calls.map((c) => String(c[0]));
    const failLines = errors.filter((m) => m.includes('Token.Transfer'));
    expect(failLines).toHaveLength(2);
    expect(failLines[0]).toContain(`chain ${CHAIN_ID}`);
    expect(failLines[0]).toContain(T);
    expect(failLines[0]).toContain('10/0/4');
    expect(errors.some((m) => m.includes('kaput'))).toBe(true);
  });
});
