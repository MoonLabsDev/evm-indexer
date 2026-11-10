import { log } from '../log';
import { clearContext, setContext } from '../runtime/context';
import { setRpc } from '../runtime/contract';
import type { NormalizedConfig } from '../runtime/define';
import { setEntityStore } from '../runtime/entity';
import { deserializeArgs } from '../runtime/events';
import { Timestamp } from '../runtime/timestamp';
import type { EntityStore } from '../store/entities';
import type { SystemStore } from '../store/system';
import type { ChainConfig, EventDoc, IndexedEvent } from '../types';

/** The part of the RPC pool the processor uses (head for status, eth_call for contract reads). */
export interface ProcessorPool {
  getBlockNumber(): Promise<number>;
  ethCall(to: string, data: string, blockNumber: number): Promise<string>;
}

export interface ProcessorDeps {
  chain: ChainConfig;
  pool: ProcessorPool;
  store: SystemStore;
  entities: EntityStore;
  config: NormalizedConfig;
  batchSize?: number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_BATCH_SIZE = 500;
const HEAD_REFRESH_MS = 5_000;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const describeEvent = (e: EventDoc) =>
  `${e.source}.${e.event} at ${e.address} ${e.blockNumber}/${e.txIndex}/${e.logIndex}`;

/** Runs the process callbacks for stored events in (block, tx, log) order and stamps each with the revision. */
export class Processor {
  private readonly chain: ChainConfig;
  private readonly pool: ProcessorPool;
  private readonly store: SystemStore;
  private readonly entities: EntityStore;
  private readonly config: NormalizedConfig;
  private readonly batchSize: number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** "source.event" pairs already warned about as unknown. */
  private readonly warned = new Set<string>();

  /** The event being handled when the last tick failed; null when it failed outside an event. */
  private failedEvent: EventDoc | null = null;
  private currentBlock = 0;
  private headAt = 0;
  private indexBlock = 0;
  private processBlock = 0;
  private revisionId = 0;
  private lastLoop = 0;

  constructor(deps: ProcessorDeps) {
    this.chain = deps.chain;
    this.pool = deps.pool;
    this.store = deps.store;
    this.entities = deps.entities;
    this.config = deps.config;
    this.batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
    this.sleep = deps.sleep ?? defaultSleep;
  }

  async init(): Promise<void> {
    await this.store.init();
    setRpc(this.pool);
    setEntityStore(this.entities);
  }

  /** Processes one batch; 'idle' when every event up to indexedBlock carries the current revision. */
  async tick(): Promise<'worked' | 'idle'> {
    const { chainId } = this.chain;
    this.failedEvent = null;
    await this.refreshHead();

    let state = await this.store.getChain(chainId);
    const revision = state.currentRevisionId;
    this.revisionId = revision;
    this.indexBlock = state.indexedBlock;
    this.processBlock = state.processedBlock;
    if (state.entityRevisionId !== revision) {
      await this.store.dropEntities(chainId);
      await this.store.setEntityRevision(chainId, revision);
      this.processBlock = 0;
      log.step(`chain ${chainId}: revision ${revision}, entities dropped, replaying all events`);
      state = { ...state, entityRevisionId: revision, processedBlock: 0 };
    }

    const batch = await this.store.nextUnprocessed(chainId, revision, state.indexedBlock, this.batchSize);
    if (batch.length === 0) {
      await this.store.setProcessed(chainId, state.indexedBlock);
      this.processBlock = state.indexedBlock;
      return 'idle';
    }

    let last: EventDoc | null = null;
    try {
      for (const doc of batch) {
        this.failedEvent = doc;
        await this.processEvent(doc);
        await this.store.stampEvent(doc, revision);
        last = doc;
      }
      this.failedEvent = null;
    } finally {
      if (last) {
        await this.store.setProcessed(chainId, last.blockNumber);
        this.processBlock = last.blockNumber;
      }
    }
    return 'worked';
  }

  /** Runs forever; a failing callback is logged and the same event is retried after `pollInterval`. */
  async run(): Promise<never> {
    const { chainId, pollInterval } = this.chain;
    for (;;) {
      let wait: boolean;
      try {
        wait = (await this.tick()) === 'idle';
        this.lastLoop = Date.now();
      } catch (err) {
        const where = this.failedEvent ? ` at ${describeEvent(this.failedEvent)}` : '';
        log.error(`chain ${chainId}: processing failed${where}, retrying in ${pollInterval} ms`, err);
        wait = true;
      }
      if (wait) await this.sleep(pollInterval);
    }
  }

  status(): { chainId: number; name: string; currentBlock: number; indexBlock: number; processBlock: number; revisionId: number } {
    return {
      chainId: this.chain.chainId, name: this.chain.name, currentBlock: this.currentBlock,
      indexBlock: this.indexBlock, processBlock: this.processBlock, revisionId: this.revisionId,
    };
  }

  /** Time (ms) of the last successful loop iteration; 0 before the first one. */
  lastLoopAt(): number {
    return this.lastLoop;
  }

  /** Updates `currentBlock` at most every 5 s; an RPC failure keeps the previous value. */
  private async refreshHead(): Promise<void> {
    const now = Date.now();
    if (this.headAt !== 0 && now - this.headAt < HEAD_REFRESH_MS) return;
    this.headAt = now;
    try {
      this.currentBlock = await this.pool.getBlockNumber();
    } catch (err) {
      log.debug(`chain ${this.chain.chainId}: head refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async processEvent(doc: EventDoc): Promise<void> {
    const { chainId, name } = this.chain;
    const handlers = this.config.sources[doc.source]?.events[doc.event];
    if (!handlers) {
      const pair = `${doc.source}.${doc.event}`;
      if (!this.warned.has(pair)) {
        this.warned.add(pair);
        log.result(`warning: chain ${chainId}: ${pair} is not in the indexer config, its events are skipped`);
      }
      return;
    }
    const t = await this.store.getTransaction(chainId, doc.txHash);
    if (!t) {
      throw new Error(`chain ${chainId}: transaction ${doc.txHash} of event ${describeEvent(doc)} is missing`);
    }
    const event: IndexedEvent = {
      args: deserializeArgs(doc.data), address: doc.address, blockNumber: doc.blockNumber,
      txIndex: doc.txIndex, logIndex: doc.logIndex, txHash: doc.txHash,
    };
    const callback = handlers.process;
    if (!callback) return;
    setContext({
      mode: 'process',
      chain: { id: chainId, name },
      block: { number: t.blockNumber, hash: t.blockHash, timestamp: Timestamp.from(t.blockTimestamp) },
      tx: {
        hash: t.hash, transactionIndex: t.transactionIndex, logIndex: doc.logIndex, from: t.from, to: t.to,
        value: BigInt(t.value), nonce: t.nonce, gasPrice: BigInt(t.gasPrice), input: t.input,
      },
    });
    try {
      await callback(event);
    } finally {
      clearContext();
    }
  }
}
