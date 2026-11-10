import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Db, MongoClient } from 'mongodb';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { SystemStore } from '../../src/store/system';
import { EntityStore } from '../../src/store/entities';
import { EventDoc, TxDoc } from '../../src/types';

function ev(block: number, tx: number, log: number, chainId = 1): EventDoc {
  return {
    chainId, address: '0xabc', eventId: '0xtopic', blockNumber: block, txIndex: tx, logIndex: log,
    txHash: `0xtx${block}_${tx}`, source: 'Pool', event: 'Swap', data: { amount: { __bigint: '5' } },
    processRevisionId: -1,
  };
}

function txDoc(chainId = 1, hash = '0xh'): TxDoc {
  return {
    chainId, hash, from: '0xa', to: null, value: '1', nonce: 0, gasPrice: '2', input: '0x',
    transactionIndex: 0, blockNumber: 10, blockHash: '0xb', blockTimestamp: new Date(1000),
  };
}

let server: MongoMemoryServer;
let client: MongoClient;
let db: Db;
let sys: SystemStore;
let n = 0;

beforeAll(async () => {
  server = await MongoMemoryServer.create();
  client = await MongoClient.connect(server.getUri());
}, 120_000);

afterAll(async () => {
  await client?.close();
  await server?.stop();
});

beforeEach(async () => {
  n += 1;
  db = client.db(`store_test_${n}`);
  sys = new SystemStore(db);
  await sys.init();
});

describe('SystemStore', () => {
  it('inserts chain defaults', async () => {
    expect(await sys.getChain(1)).toMatchObject({
      chainId: 1, indexedBlock: 0, processedBlock: 0, currentRevisionId: 0, entityRevisionId: 0,
      indexerHeartbeat: null, processorHeartbeat: null,
    });
    await sys.getChain(1);
    expect(await db.collection('sys_chains').countDocuments({ chainId: 1 })).toBe(1);
  });

  it('setIndexed and setProcessed also set heartbeats', async () => {
    await sys.setIndexed(1, 50);
    await sys.setProcessed(1, 40);
    const c = await sys.getChain(1);
    expect(c.indexedBlock).toBe(50);
    expect(c.processedBlock).toBe(40);
    expect(c.indexerHeartbeat).toBeInstanceOf(Date);
    expect(c.processorHeartbeat).toBeInstanceOf(Date);
  });

  it('keeps the processRevisionId on idempotent upsert', async () => {
    await sys.upsertEvents([ev(10, 0, 0)]);
    await sys.stampEvent(ev(10, 0, 0), 0);
    await sys.upsertEvents([ev(10, 0, 0)]);
    expect(await sys.nextUnprocessed(1, 0, 100, 10)).toHaveLength(0);
    expect(await db.collection('sys_events').countDocuments()).toBe(1);
  });

  it('upsert updates other fields of an existing event', async () => {
    await sys.upsertEvents([ev(10, 0, 0)]);
    await sys.upsertEvents([{ ...ev(10, 0, 0), txHash: '0xnew' }]);
    const [d] = await sys.nextUnprocessed(1, 0, 100, 10);
    expect(d.txHash).toBe('0xnew');
  });

  it('treats empty arrays as no-op', async () => {
    await sys.upsertEvents([]);
    await sys.upsertTransactions([]);
    expect(await db.collection('sys_events').countDocuments()).toBe(0);
    expect(await db.collection('sys_transactions').countDocuments()).toBe(0);
  });

  it('returns unprocessed events ordered and filtered', async () => {
    await sys.upsertEvents([ev(12, 0, 1), ev(10, 2, 0), ev(10, 0, 5), ev(11, 0, 0), ev(10, 0, 0, 2)]);
    const r = await sys.nextUnprocessed(1, 0, 11, 10);
    expect(r.map(e => [e.blockNumber, e.txIndex, e.logIndex])).toEqual([[10, 0, 5], [10, 2, 0], [11, 0, 0]]);
    expect(r[0]).not.toHaveProperty('_id');
    expect(await sys.nextUnprocessed(1, 0, 11, 2)).toHaveLength(2);
  });

  it('a revision bump makes everything unprocessed again', async () => {
    await sys.upsertEvents([ev(12, 0, 1), ev(10, 2, 0), ev(10, 0, 5), ev(11, 0, 0)]);
    for (const e of await sys.nextUnprocessed(1, 0, 100, 10)) await sys.stampEvent(e, 0);
    expect(await sys.nextUnprocessed(1, 0, 100, 10)).toHaveLength(0);
    await sys.setRevision(1, 1);
    expect((await sys.getChain(1)).currentRevisionId).toBe(1);
    expect(await sys.nextUnprocessed(1, 1, 100, 10)).toHaveLength(4);
  });

  it('setEntityRevision also resets processedBlock', async () => {
    await sys.setProcessed(1, 40);
    await sys.setEntityRevision(1, 3);
    expect(await sys.getChain(1)).toMatchObject({ entityRevisionId: 3, processedBlock: 0 });
  });

  it('unstampRevision marks only the stamps of that revision and chain unprocessed', async () => {
    await sys.upsertEvents([ev(10, 0, 0), ev(11, 0, 0), ev(12, 0, 0)]);
    const [a, b, c] = await sys.nextUnprocessed(1, 1, 100, 10);
    await sys.stampEvent(a, 1);
    await sys.stampEvent(b, 0);
    await sys.unstampRevision(1, 1);
    await sys.unstampRevision(2, 0);
    const docs = await db.collection('sys_events').find({}).sort({ blockNumber: 1 }).toArray();
    expect(docs.map((d) => d.processRevisionId)).toEqual([-1, 0, -1]);
    expect(c.blockNumber).toBe(12);
  });

  it('stores and reads transactions', async () => {
    await sys.upsertTransactions([txDoc()]);
    await sys.upsertTransactions([txDoc()]);
    expect(await db.collection('sys_transactions').countDocuments()).toBe(1);
    expect(await sys.getTransaction(1, '0xh')).toEqual(txDoc());
    expect(await sys.getTransaction(1, '0xmissing')).toBeNull();
    expect(await sys.getTransaction(2, '0xh')).toBeNull();
  });

  it('adds templates once', async () => {
    const t = { chainId: 1, template: 'Pool', address: '0xp', block: 5, txIndex: 2, logIndex: 7 };
    expect(await sys.addTemplate(t)).toBe(true);
    expect(await sys.addTemplate({ ...t, block: 9, txIndex: 0, logIndex: 0 })).toBe(false); // keeps the first position
    expect(await sys.addTemplate({ ...t, chainId: 2 })).toBe(true);
    expect(await sys.listTemplates(1)).toEqual([t]);
  });

  it('tracks heartbeats', async () => {
    await sys.heartbeat(1, 'indexer');
    expect(await sys.isAlive(1, 'indexer')).toBe(true);
    expect(await sys.isAlive(1, 'indexer', Date.now() + 61_000)).toBe(false);
    expect(await sys.isAlive(1, 'processor')).toBe(false);
    await sys.heartbeat(1, 'processor');
    expect(await sys.isAlive(1, 'processor')).toBe(true);
  });

  it('lists the chains that have a row', async () => {
    expect(await sys.listChains()).toEqual([]);
    await sys.getChain(5);
    await sys.setIndexed(2, 1);
    expect(await sys.listChains()).toEqual([2, 5]);
  });

  it('resetChain clears one chain only', async () => {
    const e1 = new EntityStore(db, 1);
    const e2 = new EntityStore(db, 2);
    await e1.save('Pool', 'a', { x: 1 });
    await e2.save('Pool', 'a', { x: 2 });
    await sys.upsertEvents([ev(10, 0, 0), ev(10, 0, 0, 2)]);
    await sys.upsertTransactions([txDoc(1)]);
    await sys.addTemplate({ chainId: 1, template: 'Pool', address: '0xp', block: 5, txIndex: 0, logIndex: 0 });
    await sys.setIndexed(1, 99);
    await sys.setRevision(1, 2);
    await sys.setEntityRevision(1, 2);
    await sys.getChain(2);

    await sys.resetChain(1);

    expect(await e1.load('Pool', 'a')).toBeNull();
    expect(await e2.load('Pool', 'a')).toEqual({ x: 2 });
    expect(await sys.nextUnprocessed(1, 0, 100, 10)).toHaveLength(0);
    expect(await sys.nextUnprocessed(2, 0, 100, 10)).toHaveLength(1);
    expect(await sys.getTransaction(1, '0xh')).toBeNull();
    expect(await sys.listTemplates(1)).toEqual([]);
    expect(await sys.getChain(1)).toMatchObject({
      indexedBlock: 0, processedBlock: 0, currentRevisionId: 0, entityRevisionId: 0,
      indexerHeartbeat: null, processorHeartbeat: null,
    });
  });

  it('dropEntities drops only the entity collections of that chain', async () => {
    await new EntityStore(db, 1).save('Pool', 'a', { x: 1 });
    await new EntityStore(db, 11).save('Pool', 'a', { x: 1 });
    await sys.dropEntities(1);
    const names = (await db.listCollections().toArray()).map(c => c.name);
    expect(names).not.toContain('ent_1_Pool');
    expect(names).toContain('ent_11_Pool');
  });

  it('resetAll removes every sys_ and ent_ collection', async () => {
    await new EntityStore(db, 1).save('Pool', 'a', { x: 1 });
    await sys.upsertEvents([ev(10, 0, 0)]);
    await sys.getChain(1);
    await sys.resetAll();
    expect((await db.listCollections().toArray()).filter(c => /^(sys_|ent_)/.test(c.name))).toEqual([]);
  });
});

describe('EntityStore', () => {
  it('saves, loads without _id, overwrites and removes', async () => {
    const e = new EntityStore(db, 1);
    await e.save('Pool', 'a', { x: 1 });
    expect(await e.load('Pool', 'a')).toEqual({ x: 1 });
    await e.save('Pool', 'a', { y: 2 });
    expect(await e.load('Pool', 'a')).toEqual({ y: 2 });
    expect(await e.load('Pool', 'zz')).toBeNull();
    await e.remove('Pool', 'a');
    expect(await e.load('Pool', 'a')).toBeNull();
  });

  it('isolates chains', async () => {
    await new EntityStore(db, 1).save('Pool', 'a', { x: 1 });
    expect(await new EntityStore(db, 2).load('Pool', 'a')).toBeNull();
  });
});
