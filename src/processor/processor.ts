import { eta, formatTimespan, log } from '../log';
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
const PROGRESS_EVERY_MS = 10_000;

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
  private stopping = false;
  private wake: (() => void) | null = null;
  private progress: { block: number; ms: number; lastLog: number } | null = null;

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
      // Each step is idempotent, so a crash in between only repeats them. Stamps that already carry
      // the new id belong to entities that were just dropped: clear them so those events replay.
      await this.store.dropEntities(chainId);
      await this.store.unstampRevision(chainId, revision);
      await this.store.setEntityRevision(chainId, revision);
      this.processBlock = 0;
      log.step(`chain ${chainId}: revision ${revision}, entities dropped, replaying all events`);
      state = { ...state, entityRevisionId: revision, processedBlock: 0 };
    }

    const batch = await this.store.nextUnprocessed(
      chainId, revision, { from: state.processedBlock, to: state.indexedBlock }, this.batchSize,
    );
    if (batch.length === 0) {
      await this.store.setProcessed(chainId, state.indexedBlock);
      this.processBlock = state.indexedBlock;
      return 'idle';
    }

    let last: EventDoc | null = null;
    try {
      for (const doc of batch) {
        if (this.stopping) break; // the event before this one finished; stop between events
        this.failedEvent = doc;
        await this.processEvent(doc);
        await this.store.stampEvent(doc, revision);
        last = doc;
        // real progress: keeps /health green during a long batch (a failing retry makes none)
        this.lastLoop = Date.now();
        log.debug(`chain ${chainId}: processed ${describeEvent(doc)}`);
      }
      this.failedEvent = null;
    } catch (err) {
      await this.recordProgress(last, true);
      throw err;
    }
    await this.recordProgress(last, false);
    this.reportProgress(batch.length === this.batchSize, state.indexedBlock);
    return 'worked';
  }

  /**
   * Runs until `stop()`; a failing callback is logged and the same event is retried after
   * `pollInterval`. A stop lets the current event finish (and be stamped) before run() returns.
   */
  async run(): Promise<void> {
    const { chainId, pollInterval } = this.chain;
    while (!this.stopping) {
      let wait: boolean;
      try {
        wait = (await this.tick()) === 'idle';
        this.lastLoop = Date.now();
      } catch (err) {
        const where = this.failedEvent ? ` at ${describeEvent(this.failedEvent)}` : '';
        log.error(`chain ${chainId}: processing failed${where}, retrying in ${pollInterval} ms`, err);
        wait = true;
      }
      await this.beat();
      if (wait && !this.stopping) await this.pause(pollInterval);
    }
  }

  /** Asks run() to return after the current event; ends a pending sleep at once. */
  stop(): void {
    this.stopping = true;
    this.wake?.();
  }

  private async pause(ms: number): Promise<void> {
    await Promise.race([this.sleep(ms), new Promise<void>((resolve) => { this.wake = resolve; })]);
    this.wake = null;
  }

  /** While more than one batch behind, prints progress with an ETA every 10 s. */
  private reportProgress(behind: boolean, target: number): void {
    if (!behind) {
      this.progress = null;
      return;
    }
    const now = Date.now();
    const current = this.processBlock;
    if (!this.progress) this.progress = { block: current, ms: now, lastLog: 0 };
    if (now - this.progress.lastLog < PROGRESS_EVERY_MS) return;
    this.progress.lastLog = now;
    const e = eta(this.progress.block, this.progress.ms, current, target, now);
    const rest = e ? `, ${e.blocksPerSecond.toFixed(1)} blocks/s, eta ${formatTimespan(e.seconds)}` : '';
    log.task('process', `${this.chain.name}: block ${current} of ${target}${rest}`);
  }

  /**
   * Stores how far the batch got. After a callback error a failure here is only logged, so it
   * never replaces the callback's error.
   */
  private async recordProgress(last: EventDoc | null, swallow: boolean): Promise<void> {
    if (!last) return;
    try {
      await this.store.setProcessed(this.chain.chainId, last.blockNumber);
      this.processBlock = last.blockNumber;
    } catch (err) {
      if (!swallow) throw err;
      log.debug(`chain ${this.chain.chainId}: setProcessed failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Heartbeat on every loop iteration, failed or not; a failure here is only logged at debug level. */
  private async beat(): Promise<void> {
    try {
      await this.store.heartbeat(this.chain.chainId, 'processor');
    } catch (err) {
      log.debug(`chain ${this.chain.chainId}: heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  status(): { chainId: number; name: string; currentBlock: number; indexBlock: number; processBlock: number; revisionId: number } {
    return {
      chainId: this.chain.chainId, name: this.chain.name, currentBlock: this.currentBlock,
      indexBlock: this.indexBlock, processBlock: this.processBlock, revisionId: this.revisionId,
    };
  }

  /** Time (ms) of the last successful loop iteration or processed event; 0 before the first one. */
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
    const callback = handlers.process;
    if (!callback) return; // stamped without loading its transaction
    const t = await this.store.getTransaction(chainId, doc.txHash);
    if (!t) {
      throw new Error(`chain ${chainId}: transaction ${doc.txHash} of event ${describeEvent(doc)} is missing`);
    }
    const event: IndexedEvent = {
      args: deserializeArgs(doc.data), address: doc.address, blockNumber: doc.blockNumber,
      txIndex: doc.txIndex, logIndex: doc.logIndex, txHash: doc.txHash,
    };
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
