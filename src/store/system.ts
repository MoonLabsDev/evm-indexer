import { Db, Collection, Document } from 'mongodb';
import { ChainState, EventDoc, EventKey, TemplateDoc, TxDoc } from '../types';

const HEARTBEAT_FRESH_MS = 60_000;

function eventKey(k: EventKey): EventKey {
  return {
    chainId: k.chainId, address: k.address, eventId: k.eventId,
    blockNumber: k.blockNumber, txIndex: k.txIndex, logIndex: k.logIndex,
  };
}

function chainDefaults(chainId: number): ChainState {
  return {
    chainId, indexedBlock: 0, processedBlock: 0, currentRevisionId: 0, entityRevisionId: 0,
    indexerHeartbeat: null, processorHeartbeat: null,
  };
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** All access to the `sys_*` collections, plus the cross-collection resets. */
export class SystemStore {
  private readonly events: Collection<Document>;
  private readonly txs: Collection<Document>;
  private readonly chains: Collection<Document>;
  private readonly templates: Collection<Document>;

  constructor(private readonly db: Db) {
    this.events = db.collection('sys_events');
    this.txs = db.collection('sys_transactions');
    this.chains = db.collection('sys_chains');
    this.templates = db.collection('sys_templates');
  }

  async init(): Promise<void> {
    await this.events.createIndex(
      { chainId: 1, address: 1, eventId: 1, blockNumber: 1, txIndex: 1, logIndex: 1 }, { unique: true },
    );
    await this.events.createIndex({ chainId: 1, blockNumber: 1, txIndex: 1, logIndex: 1 });
    await this.events.createIndex(
      { chainId: 1, processRevisionId: 1, blockNumber: 1, txIndex: 1, logIndex: 1 },
    );
    await this.txs.createIndex({ chainId: 1, hash: 1 }, { unique: true });
    await this.chains.createIndex({ chainId: 1 }, { unique: true });
    await this.templates.createIndex({ chainId: 1, template: 1, address: 1 }, { unique: true });
  }

  /** Makes sure the chain row exists, without touching an existing one. */
  private async ensureChain(chainId: number): Promise<void> {
    await this.chains.updateOne({ chainId }, { $setOnInsert: chainDefaults(chainId) }, { upsert: true });
  }

  async getChain(chainId: number): Promise<ChainState> {
    await this.ensureChain(chainId);
    const doc = await this.chains.findOne({ chainId }, { projection: { _id: 0 } });
    return doc as unknown as ChainState;
  }

  /** Chain ids that have a `sys_chains` row, ascending. */
  async listChains(): Promise<number[]> {
    const docs = await this.chains.find({}, { projection: { _id: 0, chainId: 1 } }).sort({ chainId: 1 }).toArray();
    return docs.map((d) => d.chainId as number);
  }

  private async setFields(chainId: number, fields: Document): Promise<void> {
    await this.ensureChain(chainId);
    await this.chains.updateOne({ chainId }, { $set: fields });
  }

  async setIndexed(chainId: number, block: number): Promise<void> {
    await this.setFields(chainId, { indexedBlock: block, indexerHeartbeat: new Date() });
  }

  async setProcessed(chainId: number, block: number): Promise<void> {
    await this.setFields(chainId, { processedBlock: block, processorHeartbeat: new Date() });
  }

  async heartbeat(chainId: number, kind: 'indexer' | 'processor'): Promise<void> {
    await this.setFields(chainId, { [`${kind}Heartbeat`]: new Date() });
  }

  /** Marks that kind of process of the chain as stopped (a clean shutdown), so a restart or reset is not refused. */
  async clearHeartbeat(chainId: number, kind: 'indexer' | 'processor'): Promise<void> {
    await this.setFields(chainId, { [`${kind}Heartbeat`]: null });
  }

  async isAlive(chainId: number, kind: 'indexer' | 'processor', nowMs: number = Date.now()): Promise<boolean> {
    const chain = await this.getChain(chainId);
    const beat = kind === 'indexer' ? chain.indexerHeartbeat : chain.processorHeartbeat;
    return beat !== null && nowMs - beat.getTime() < HEARTBEAT_FRESH_MS;
  }

  async setRevision(chainId: number, revisionId: number): Promise<void> {
    await this.setFields(chainId, { currentRevisionId: revisionId });
  }

  async setEntityRevision(chainId: number, revisionId: number): Promise<void> {
    await this.setFields(chainId, { entityRevisionId: revisionId, processedBlock: 0 });
  }

  async upsertTransactions(docs: TxDoc[]): Promise<void> {
    if (docs.length === 0) return;
    await this.txs.bulkWrite(
      docs.map(d => ({
        updateOne: { filter: { chainId: d.chainId, hash: d.hash }, update: { $set: { ...d } }, upsert: true },
      })),
      { ordered: false },
    );
  }

  async upsertEvents(docs: EventDoc[]): Promise<void> {
    if (docs.length === 0) return;
    await this.events.bulkWrite(
      docs.map(d => {
        const { processRevisionId, ...rest } = d;
        return {
          updateOne: {
            filter: eventKey(d),
            update: { $set: rest, $setOnInsert: { processRevisionId } },
            upsert: true,
          },
        };
      }),
      { ordered: false },
    );
  }

  async getTransaction(chainId: number, hash: string): Promise<TxDoc | null> {
    const doc = await this.txs.findOne({ chainId, hash }, { projection: { _id: 0 } });
    return doc as unknown as TxDoc | null;
  }

  /**
   * The next `limit` events in `blocks` (inclusive) not stamped with `revisionId`, in block/tx/log
   * order. The lower bound lets the {chainId, blockNumber, txIndex, logIndex} index skip the
   * processed keys; the caller passes processedBlock, which never passes an unprocessed event.
   */
  async nextUnprocessed(
    chainId: number, revisionId: number, blocks: { from: number; to: number }, limit: number,
  ): Promise<EventDoc[]> {
    const docs = await this.events
      .find(
        { chainId, processRevisionId: { $ne: revisionId }, blockNumber: { $gte: blocks.from, $lte: blocks.to } },
        { projection: { _id: 0 } },
      )
      .sort({ blockNumber: 1, txIndex: 1, logIndex: 1 })
      .limit(limit)
      .toArray();
    return docs as unknown as EventDoc[];
  }

  async stampEvent(key: EventKey, revisionId: number): Promise<void> {
    await this.events.updateOne(eventKey(key), { $set: { processRevisionId: revisionId } });
  }

  /** Marks the chain's events stamped with `revisionId` as unprocessed again. */
  async unstampRevision(chainId: number, revisionId: number): Promise<void> {
    await this.events.updateMany({ chainId, processRevisionId: revisionId }, { $set: { processRevisionId: -1 } });
  }

  async listTemplates(chainId: number): Promise<TemplateDoc[]> {
    const docs = await this.templates.find({ chainId }, { projection: { _id: 0 } }).toArray();
    return docs as unknown as TemplateDoc[];
  }

  async addTemplate(doc: TemplateDoc): Promise<boolean> {
    const res = await this.templates.updateOne(
      { chainId: doc.chainId, template: doc.template, address: doc.address },
      { $setOnInsert: { block: doc.block, txIndex: doc.txIndex, logIndex: doc.logIndex } },
      { upsert: true },
    );
    return res.upsertedCount === 1;
  }

  private async collectionsWithPrefix(prefix: string): Promise<string[]> {
    const cols = await this.db
      .listCollections({ name: { $regex: `^${escapeRegex(prefix)}` } }, { nameOnly: true })
      .toArray();
    return cols.map(c => c.name);
  }

  async dropEntities(chainId: number): Promise<void> {
    for (const name of await this.collectionsWithPrefix(`ent_${chainId}_`)) {
      await this.db.dropCollection(name);
    }
  }

  async resetChain(chainId: number): Promise<void> {
    await this.events.deleteMany({ chainId });
    await this.txs.deleteMany({ chainId });
    await this.templates.deleteMany({ chainId });
    await this.dropEntities(chainId);
    await this.chains.updateOne({ chainId }, { $set: chainDefaults(chainId) }, { upsert: true });
  }

  async resetAll(): Promise<void> {
    for (const prefix of ['sys_', 'ent_']) {
      for (const name of await this.collectionsWithPrefix(prefix)) {
        await this.db.dropCollection(name);
      }
    }
  }
}
