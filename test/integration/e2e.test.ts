import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { writeFileSync } from 'fs';
import { join } from 'path';
import { Contract, ContractFactory, JsonRpcProvider, type JsonRpcSigner, type TransactionReceipt } from 'ethers';
import type { Db } from 'mongodb';
import { startMongo } from '../helpers/mongo';
import { artifact, CHAIN_ID, PROJECT, RPC_URL } from './fixture';
import {
  cmdReset, cmdSetRevision, EntityStore, HttpTransport, Indexer, loadAddresses, loadChain, loadIndexerConfig,
  loadProjectModule, Processor, RpcPool, SystemStore,
} from './runtime';
import type { ChainConfig, EventDoc } from '../../src/types';
import type { NormalizedConfig } from '../../src/runtime/define';

// One sequential scenario against the hardhat node from globalSetup: deploy, index (backfill, then
// head mode), process, replay, restart, reset, re-index.

const MAX_TICKS = 200;

type Loop = { tick(): Promise<'worked' | 'idle'> };
type IndexerT = InstanceType<typeof Indexer>;
type ScanSpies = { backfill: ReturnType<typeof vi.fn>; head: ReturnType<typeof vi.fn> };

/** Ticks until 'idle'; returns how many ticks did work. */
async function drain(what: string, loop: Loop): Promise<number> {
  for (let i = 0; i < MAX_TICKS; i++) {
    if ((await loop.tick()) === 'idle') return i;
  }
  throw new Error(`${what} did not reach 'idle' within ${MAX_TICKS} ticks`);
}

/** Wraps the indexer's real scanners so the test sees which mode each tick used. */
function spyScanners(indexer: IndexerT): ScanSpies {
  const scanners = (indexer as unknown as { scanners: Record<'backfill' | 'head', { scan: (...a: never[]) => unknown }> }).scanners;
  return {
    backfill: vi.spyOn(scanners.backfill, 'scan') as never,
    head: vi.spyOn(scanners.head, 'scan') as never,
  };
}

/** Several backfill ranges first, then head mode once at most `headThreshold` blocks are left. */
function expectBackfillThenHead(spies: ScanSpies): void {
  const backfill = spies.backfill.mock.invocationCallOrder;
  const head = spies.head.mock.invocationCallOrder;
  expect(backfill.length).toBeGreaterThan(1);
  expect(head.length).toBeGreaterThan(0);
  expect(Math.max(...backfill)).toBeLessThan(Math.min(...head));
}

let provider: JsonRpcProvider;
let signer: JsonRpcSigner;
let deployer: string;
let factoryAddress: string;
let deployBlock: number;
let poolA: string;
let poolB: string;
/** created in head mode (step 3b) */
let poolC: string;
/** create transactions of pool A and B */
const createTx: Record<'A' | 'B', string> = { A: '', B: '' };

let mongo: Awaited<ReturnType<typeof startMongo>>;
let db: Db;
let chain: ChainConfig;
let config: NormalizedConfig;
let pool: InstanceType<typeof RpcPool>;
let store: InstanceType<typeof SystemStore>;
let indexer: IndexerT;
let processor: InstanceType<typeof Processor>;
let poolCountReads: number[];

const events = () => db.collection<EventDoc>('sys_events');
const entities = (table: string) => db.collection(`ent_${CHAIN_ID}_${table}`);
const entityDocs = async () => ({
  pools: await entities('PoolEntity').find({}).sort({ _id: 1 }).toArray(),
  stats: await entities('Stats').find({}).toArray(),
});
const sortedEvents = () => events().find({ chainId: CHAIN_ID }, { projection: { _id: 0 } }).sort({ blockNumber: 1, txIndex: 1, logIndex: 1 }).toArray();

/** The pool address from the PoolCreated log of a createPool() receipt. */
function createdPool(factory: Contract, receipt: TransactionReceipt): string {
  for (const l of receipt.logs) {
    const parsed = factory.interface.parseLog(l);
    if (parsed?.name === 'PoolCreated') return String(parsed.args.pool).toLowerCase();
  }
  throw new Error(`no PoolCreated log in ${receipt.hash}`);
}

async function ping(address: string): Promise<void> {
  const c = new Contract(address, artifact('Pool').abi as never, signer);
  await (await c.ping()).wait();
}

function newIndexer(): IndexerT {
  const contractNames = Object.values(config.sources).filter((s) => s.kind === 'contract').map((s) => s.name);
  const statics = loadAddresses(join(PROJECT, 'addresses.json'), CHAIN_ID, contractNames);
  return new Indexer({ chain, pool, store, config, statics });
}

function newProcessor(): InstanceType<typeof Processor> {
  return new Processor({ chain, pool, store, entities: new EntityStore(db, CHAIN_ID), config });
}

beforeAll(async () => {
  provider = new JsonRpcProvider(RPC_URL, CHAIN_ID, { staticNetwork: true, polling: false, cacheTimeout: -1 });
  signer = await provider.getSigner(0);
  deployer = (await signer.getAddress()).toLowerCase();

  // arrange: Factory, two pools (each creation pings its pool in the same transaction), pings, empty blocks
  const { abi, bytecode } = artifact('Factory');
  const factory = (await new ContractFactory(abi as never, bytecode, signer).deploy()) as Contract;
  const deployReceipt = await factory.deploymentTransaction()!.wait();
  deployBlock = deployReceipt!.blockNumber;
  factoryAddress = (await factory.getAddress()).toLowerCase();

  const created: string[] = [];
  for (const key of ['A', 'B'] as const) {
    const receipt = await (await factory.createPool()).wait();
    created.push(createdPool(factory, receipt!));
    createTx[key] = receipt!.hash.toLowerCase();
  }
  [poolA, poolB] = created;
  for (let i = 0; i < 3; i++) await ping(poolA);
  await ping(poolB);
  for (let i = 0; i < 5; i++) await provider.send('evm_mine', []);

  writeFileSync(
    join(PROJECT, 'addresses.json'),
    JSON.stringify({ [CHAIN_ID]: { Factory: { address: factoryAddress, block: deployBlock } } }, null, 2) + '\n',
  );

  mongo = await startMongo();
  db = mongo.db;
  chain = loadChain(join(PROJECT, 'chains.json'), CHAIN_ID);
  config = loadIndexerConfig(join(PROJECT, 'indexer.config.ts'));
  pool = new RpcPool([new HttpTransport(chain.rpc[0])], {
    retryDelays: chain.retryDelays, logRange: chain.logRange, blockBatch: chain.blockBatch,
  });
  store = new SystemStore(db);
  poolCountReads = loadProjectModule<{ poolCountReads: number[] }>('handlers.ts').poolCountReads;
});

afterAll(async () => {
  provider?.destroy();
  await mongo?.stop();
});

describe('end-to-end against a hardhat node', () => {
  let head: number;
  let eventCountAfterHead: number;
  let eventsAfterHead: EventDoc[];
  let entitiesAfterHead: Awaited<ReturnType<typeof entityDocs>>;

  it('1: indexes the history in backfill mode, then head mode, including the templates created by the index callback', async () => {
    head = await provider.getBlockNumber();
    expect(head - deployBlock).toBeGreaterThan(chain.headThreshold);
    // logRange max 2 splits the history into several backfill ranges before head mode takes over
    expect(chain.logRange.max).toBe(2);

    indexer = newIndexer();
    await indexer.init();
    const spies = spyScanners(indexer);
    expect(await drain('indexer', indexer)).toBeGreaterThan(2);
    expectBackfillThenHead(spies);

    const templates = await db.collection('sys_templates').find({ chainId: CHAIN_ID }).sort({ block: 1 }).toArray();
    expect(templates.map((t) => [t.template, t.address])).toEqual([['PoolTemplate', poolA], ['PoolTemplate', poolB]]);

    const all = await sortedEvents();
    expect(all.filter((e) => e.event === 'PoolCreated')).toHaveLength(2);
    expect(all.filter((e) => e.event === 'Ping')).toHaveLength(6);
    expect(all.every((e) => e.processRevisionId === -1)).toBe(true);

    // The same-transaction Ping right after each PoolCreated is indexed, at the next log position.
    for (const [key, address] of [['A', poolA], ['B', poolB]] as const) {
      const createdEv = all.find((e) => e.event === 'PoolCreated' && e.txHash === createTx[key])!;
      expect(createdEv).toMatchObject({ source: 'Factory', address: factoryAddress });
      expect((createdEv.data as { pool: string }).pool).toBe(address);
      const template = templates.find((t) => t.address === address)!;
      expect([template.block, template.txIndex, template.logIndex]).toEqual([createdEv.blockNumber, createdEv.txIndex, createdEv.logIndex]);

      const sameTx = all.filter((e) => e.event === 'Ping' && e.txHash === createTx[key]);
      expect(sameTx).toHaveLength(1);
      expect(sameTx[0]).toMatchObject({
        source: 'PoolTemplate', address, blockNumber: createdEv.blockNumber, txIndex: createdEv.txIndex,
        logIndex: createdEv.logIndex + 1, data: { sender: factoryAddress, n: { __bigint: '1' } },
      });
    }
    const pingsA = all.filter((e) => e.event === 'Ping' && e.address === poolA).map((e) => (e.data as { n: { __bigint: string } }).n.__bigint);
    expect(pingsA).toEqual(['1', '2', '3', '4']);

    const txs = db.collection('sys_transactions');
    for (const e of all) expect(await txs.countDocuments({ chainId: CHAIN_ID, hash: e.txHash })).toBe(1);
    expect(await txs.findOne({ chainId: CHAIN_ID, hash: createTx.A })).toMatchObject({ from: deployer, to: factoryAddress });

    expect((await store.getChain(CHAIN_ID)).indexedBlock).toBe(head);
  });

  it('2: processes the events into entities, contract reads run at the event block', async () => {
    processor = newProcessor();
    await processor.init();
    await drain('processor', processor);

    const a = await entities('PoolEntity').findOne({ _id: poolA as never });
    const b = await entities('PoolEntity').findOne({ _id: poolB as never });
    expect(a).toMatchObject({ pings: 4, lastPing: '4', creator: deployer });
    expect(b).toMatchObject({ pings: 2, lastPing: '2', creator: deployer });
    const createdBlock = await provider.getBlock((await provider.getTransactionReceipt(createTx.A))!.blockNumber);
    expect((a!.createdAt as Date).getTime()).toBe(createdBlock!.timestamp * 1000);

    expect(await entities('Stats').findOne({ _id: 'global' as never })).toMatchObject({ poolCount: 2 });
    // poolCount() was read at each PoolCreated block: 1 after the first pool, 2 after the second.
    expect(poolCountReads).toEqual([1, 2]);

    const state = await store.getChain(CHAIN_ID);
    expect(state.processedBlock).toBe(head);
    expect(await events().countDocuments({ chainId: CHAIN_ID, processRevisionId: { $ne: 0 } })).toBe(0);
  });

  it('3: picks up a new event in head mode', async () => {
    await ping(poolA);
    const spies = spyScanners(indexer);
    expect(await drain('indexer', indexer)).toBe(1);
    expect(spies.head).toHaveBeenCalledTimes(1);
    expect(spies.backfill).not.toHaveBeenCalled();
    head = await provider.getBlockNumber();
    expect((await store.getChain(CHAIN_ID)).indexedBlock).toBe(head);

    expect(indexer.status()).toMatchObject({ chainId: CHAIN_ID, currentBlock: head, indexBlock: head });

    await drain('processor', processor);
    expect(await entities('PoolEntity').findOne({ _id: poolA as never })).toMatchObject({ pings: 5, lastPing: '5' });
    expect(processor.status()).toMatchObject({ chainId: CHAIN_ID, indexBlock: head, processBlock: head, revisionId: 0 });
  });

  it('3b: head mode creates a template and catches up its logs in the same and in a later block', async () => {
    // Block N: createPool (PoolCreated + same-tx Ping of C); block N+1: only a Ping of C, which the
    // bloom check skips until the template exists. Both blocks fall into one head-mode batch.
    const factory = new Contract(factoryAddress, artifact('Factory').abi as never, signer);
    const receipt = await (await factory.createPool()).wait();
    poolC = createdPool(factory, receipt!);
    await ping(poolC);
    head = await provider.getBlockNumber();
    expect(head - (await store.getChain(CHAIN_ID)).indexedBlock).toBe(2);

    const spies = spyScanners(indexer);
    expect(await drain('indexer', indexer)).toBe(1);
    expect(spies.head).toHaveBeenCalledTimes(1);
    expect(spies.backfill).not.toHaveBeenCalled();

    const ofC = (await sortedEvents()).filter((e) => e.address === poolC || e.txHash === receipt!.hash.toLowerCase());
    expect(ofC.map((e) => [e.event, e.blockNumber, e.txIndex, e.logIndex])).toEqual([
      ['PoolCreated', receipt!.blockNumber, 0, 0],
      ['Ping', receipt!.blockNumber, 0, 1],
      ['Ping', head, 0, 0],
    ]);
    expect(await db.collection('sys_templates').findOne({ chainId: CHAIN_ID, address: poolC })).toMatchObject({
      template: 'PoolTemplate', block: receipt!.blockNumber, txIndex: 0, logIndex: 0,
    });

    await drain('processor', processor);
    expect(await entities('PoolEntity').findOne({ _id: poolC as never })).toMatchObject({ pings: 2, lastPing: '2' });
    expect(await entities('Stats').findOne({ _id: 'global' as never })).toMatchObject({ poolCount: 3 });
    expect(poolCountReads).toEqual([1, 2, 3]);

    eventCountAfterHead = await events().countDocuments({ chainId: CHAIN_ID });
    expect(eventCountAfterHead).toBe(12);
    eventsAfterHead = await sortedEvents();
    entitiesAfterHead = await entityDocs();
  });

  it('4: set-revision wipes the entities and replays to the same values', async () => {
    expect(await cmdSetRevision(db, CHAIN_ID)).toBe(1);
    poolCountReads.length = 0;
    await drain('processor', processor);

    expect(await entityDocs()).toEqual(entitiesAfterHead);
    expect(await entities('PoolEntity').findOne({ _id: poolA as never })).toMatchObject({ pings: 5 });
    expect(poolCountReads).toEqual([1, 2, 3]);
    const state = await store.getChain(CHAIN_ID);
    expect([state.currentRevisionId, state.entityRevisionId, state.processedBlock]).toEqual([1, 1, head]);
    expect(await events().countDocuments({ chainId: CHAIN_ID, processRevisionId: 1 })).toBe(eventCountAfterHead);
  });

  it('5: a restarted indexer neither duplicates events nor resets their revision', async () => {
    const restarted = newIndexer();
    await restarted.init();
    expect(await restarted.tick()).toBe('idle');
    expect(await events().countDocuments({ chainId: CHAIN_ID })).toBe(eventCountAfterHead);

    // A crash before indexedBlock was written makes the next run scan the range again.
    await store.setIndexed(CHAIN_ID, deployBlock);
    const again = newIndexer();
    await again.init();
    await drain('indexer', again);
    expect(await events().countDocuments({ chainId: CHAIN_ID })).toBe(eventCountAfterHead);
    expect(await events().countDocuments({ chainId: CHAIN_ID, processRevisionId: 1 })).toBe(eventCountAfterHead);
    expect(await db.collection('sys_templates').countDocuments({ chainId: CHAIN_ID })).toBe(3);
    expect((await store.getChain(CHAIN_ID)).indexedBlock).toBe(head);

    const p = newProcessor();
    await p.init();
    expect(await p.tick()).toBe('idle');
    expect(await entityDocs()).toEqual(entitiesAfterHead);
  });

  it('6: reset --chain returns the chain to the empty state', async () => {
    expect(await cmdReset(db, { chainId: CHAIN_ID, yes: true })).toBe(true);
    expect(await events().countDocuments({ chainId: CHAIN_ID })).toBe(0);
    expect(await db.collection('sys_transactions').countDocuments({ chainId: CHAIN_ID })).toBe(0);
    expect(await db.collection('sys_templates').countDocuments({ chainId: CHAIN_ID })).toBe(0);
    const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
    expect(names.filter((n) => n.startsWith(`ent_${CHAIN_ID}_`))).toEqual([]);
    const state = await store.getChain(CHAIN_ID);
    expect([state.indexedBlock, state.processedBlock, state.currentRevisionId, state.entityRevisionId]).toEqual([0, 0, 0, 0]);
  });

  it('7: re-indexing and processing from scratch yields the same events and entities', async () => {
    const fresh = newIndexer();
    await fresh.init();
    const spies = spyScanners(fresh);
    await drain('indexer', fresh);
    expectBackfillThenHead(spies);
    expect(await events().countDocuments({ chainId: CHAIN_ID })).toBe(eventCountAfterHead);
    // Same stored events whatever mode or range split found them (the revision stamp aside).
    const strip = (list: EventDoc[]) => list.map(({ processRevisionId: _, ...rest }) => rest);
    expect(strip(await sortedEvents())).toEqual(strip(eventsAfterHead));
    expect(await db.collection('sys_templates').countDocuments({ chainId: CHAIN_ID })).toBe(3);

    poolCountReads.length = 0;
    const p = newProcessor();
    await p.init();
    await drain('processor', p);
    expect(await entityDocs()).toEqual(entitiesAfterHead);
    expect(poolCountReads).toEqual([1, 2, 3]);
  });

  it('8: reset without --chain drops every sys_* and ent_* collection', async () => {
    expect(await cmdReset(db, { yes: true })).toBe(true);
    const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
    expect(names.filter((n) => n.startsWith('sys_') || n.startsWith('ent_'))).toEqual([]);
  });
});
