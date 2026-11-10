import { Interface } from 'ethers';
import { eta, formatTimespan, log } from '../log';
import { AllRpcFailedError } from '../rpc/errors';
import type { RpcPool } from '../rpc/pool';
import { clearContext, currentContext, setContext } from '../runtime/context';
import { setRpc } from '../runtime/contract';
import { setTemplateSink, type NormalizedConfig, type NormalizedSource } from '../runtime/define';
import { setEntityStore } from '../runtime/entity';
import { decodeLog, serializeArgs } from '../runtime/events';
import { Timestamp } from '../runtime/timestamp';
import type { SystemStore } from '../store/system';
import type { ChainConfig, EventDoc, IndexedEvent, RawLog, StaticEntry, TxDoc } from '../types';
import { BackfillScanner } from './backfill';
import { HeadScanner } from './head';
import { Registry } from './registry';
import { sortLogs, type Scanner } from './scan';

/** The part of the RPC pool the indexer and its scanners use. */
export type IndexerPool = Pick<RpcPool, 'getBlockNumber' | 'ethCall' | 'size' | 'getLogs' | 'getBlocks' | 'getBlockLogs'>;

export interface IndexerDeps {
  chain: ChainConfig;
  pool: IndexerPool;
  store: SystemStore;
  config: NormalizedConfig;
  statics: StaticEntry[];
  scanners?: { backfill: Scanner; head: Scanner };
  sleep?: (ms: number) => Promise<void>;
}

const PROGRESS_EVERY_MS = 10_000;

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const logKey = (l: RawLog) => `${l.blockNumber}/${l.transactionIndex}/${l.logIndex}`;

/** Scans one chain, runs index callbacks (which may add template addresses) and stores events + transactions. */
export class Indexer {
  private readonly chain: ChainConfig;
  private readonly pool: IndexerPool;
  private readonly store: SystemStore;
  private readonly statics: StaticEntry[];
  private readonly registry: Registry;
  private readonly scanners: { backfill: Scanner; head: Scanner };
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly ifaces = new Map<string, Interface>();
  /** "address/topic0" pairs already reported as undecodable. */
  private readonly undecodable = new Set<string>();

  /** Addresses that index callbacks of the current log created (sink result 'added'). */
  private created: string[] = [];
  /** sys_templates writes started by index callbacks of the current log. */
  private templateWrites: Promise<void>[] = [];
  private currentBlock = 0;
  private indexBlock = 0;
  private lastLoop = 0;
  private progress: { block: number; ms: number; lastLog: number } | null = null;

  constructor(deps: IndexerDeps) {
    this.chain = deps.chain;
    this.pool = deps.pool;
    this.store = deps.store;
    this.statics = deps.statics;
    this.registry = new Registry(deps.config.sources);
    this.scanners = deps.scanners ?? {
      backfill: new BackfillScanner(deps.pool, this.registry),
      head: new HeadScanner(deps.pool, this.registry, deps.chain.useBloom),
    };
    this.sleep = deps.sleep ?? defaultSleep;
  }

  async init(): Promise<void> {
    const { chainId } = this.chain;
    await this.store.init();
    this.registry.addStatic(this.statics);
    for (const t of await this.store.listTemplates(chainId)) {
      const after = { txIndex: t.txIndex, logIndex: t.logIndex };
      if (this.registry.add(t.template, t.address, t.block, after) === 'conflict') {
        log.error(`chain ${chainId}: template ${t.template} at ${t.address} conflicts with another source, skipped`);
      }
    }
    this.indexBlock = (await this.store.getChain(chainId)).indexedBlock;
    setEntityStore(null);
    setRpc(this.pool);
    setTemplateSink((template, address) => this.onTemplate(template, address));
  }

  /** Indexes one range; 'idle' when the chain is caught up to head - confirmations. */
  async tick(): Promise<'worked' | 'idle'> {
    const { chainId, name, headThreshold } = this.chain;
    const head = await this.pool.getBlockNumber();
    this.currentBlock = head;
    const target = head - this.chain.confirmations;
    const state = await this.store.getChain(chainId);
    const minBlock = this.registry.minBlock();
    if (minBlock === null) {
      await this.store.heartbeat(chainId, 'indexer');
      return 'idle';
    }
    const from = state.indexedBlock > 0 ? state.indexedBlock + 1 : minBlock;
    if (from > target) {
      await this.store.heartbeat(chainId, 'indexer');
      return 'idle';
    }

    // Backfill stops headThreshold blocks short of the target: eth_getLogs up to the head of a lagging
    // (load-balanced) node can answer an empty tail without an error. Head mode, which checks for
    // missing blocks and receipts, covers the last headThreshold blocks.
    const backfill = target - from + 1 > headThreshold;
    const batch = backfill
      ? await this.scanners.backfill.scan(from, target - headThreshold)
      : await this.scanners.head.scan(from, target);

    let queue = batch.logs;
    let i = 0;
    const events: EventDoc[] = [];
    const txs = new Map<string, TxDoc>();

    while (i < queue.length) {
      const raw = queue[i++];
      const m = this.registry.match(raw);
      if (!m) continue;

      const blk = await batch.getBlock(raw.blockNumber);
      const rawTx = blk.transactions.find((t) => t.hash === raw.transactionHash);
      if (!rawTx) {
        throw new Error(`chain ${chainId}: transaction ${raw.transactionHash} of a log is missing in block ${raw.blockNumber}`);
      }
      const address = raw.address.toLowerCase();
      let args: Record<string, unknown>;
      try {
        args = decodeLog(this.iface(m.source), m.def, raw);
      } catch (err) {
        // e.g. an ERC-721 Transfer at an address configured with the ERC-20 layout (same topic0)
        this.reportUndecodable(raw, `${m.source.name}.${m.eventName}`, err);
        continue;
      }
      const event: IndexedEvent = {
        args, address, blockNumber: raw.blockNumber, txIndex: raw.transactionIndex,
        logIndex: raw.logIndex, txHash: raw.transactionHash,
      };

      this.created = [];
      this.templateWrites = [];
      setContext({
        mode: 'index',
        chain: { id: chainId, name },
        block: { number: blk.number, hash: blk.hash, timestamp: Timestamp.from(blk.timestamp) },
        tx: {
          hash: rawTx.hash, transactionIndex: rawTx.transactionIndex, logIndex: raw.logIndex, from: rawTx.from,
          to: rawTx.to, value: rawTx.value, nonce: rawTx.nonce, gasPrice: rawTx.gasPrice, input: rawTx.input,
        },
      });
      let writes: PromiseSettledResult<void>[] = [];
      try {
        await m.source.events[m.eventName]?.index?.(event);
      } finally {
        clearContext();
        // Also covers Template.create calls the callback did not await.
        writes = await Promise.allSettled(this.templateWrites);
      }
      const failedWrite = writes.find((w): w is PromiseRejectedResult => w.status === 'rejected');
      if (failedWrite) throw failedWrite.reason;
      const created = this.created;
      this.created = [];
      this.templateWrites = [];

      events.push({
        chainId, address, eventId: raw.topics[0].toLowerCase(), blockNumber: raw.blockNumber,
        txIndex: raw.transactionIndex, logIndex: raw.logIndex, txHash: raw.transactionHash,
        source: m.source.name, event: m.eventName, data: serializeArgs(args), processRevisionId: -1,
      });
      txs.set(rawTx.hash, {
        chainId, hash: rawTx.hash, from: rawTx.from, to: rawTx.to, value: rawTx.value.toString(),
        nonce: rawTx.nonce, gasPrice: rawTx.gasPrice.toString(), input: rawTx.input,
        transactionIndex: rawTx.transactionIndex, blockNumber: blk.number, blockHash: blk.hash,
        blockTimestamp: new Date(blk.timestamp * 1000),
      });

      if (created.length > 0) {
        // Catch up the new addresses' logs, without duplicates of the remaining queue. Logs at or
        // before this one need no filter here: the walk's registry.match rejects them, because
        // the new entries start after this log's position.
        const merged = new Map<string, RawLog>();
        for (const l of queue.slice(i)) merged.set(logKey(l), l);
        for (const addr of created) {
          for (const l of await batch.logsFor(addr, raw.blockNumber)) {
            if (!merged.has(logKey(l))) merged.set(logKey(l), l);
          }
        }
        queue = sortLogs([...merged.values()]);
        i = 0;
      }
    }

    await this.store.upsertTransactions([...txs.values()]);
    await this.store.upsertEvents(events);
    await this.store.setIndexed(chainId, batch.to);
    this.indexBlock = batch.to;
    this.reportProgress(batch.to, target);
    return 'worked';
  }

  /** Runs forever; any error is logged and the same range is retried after `pollInterval`. */
  async run(): Promise<never> {
    for (;;) {
      let wait: boolean;
      try {
        wait = (await this.tick()) === 'idle';
        this.lastLoop = Date.now();
      } catch (err) {
        const what = err instanceof AllRpcFailedError ? 'all RPCs failed' : 'indexing failed';
        log.error(`chain ${this.chain.chainId}: ${what}, retrying in ${this.chain.pollInterval} ms`, err);
        wait = true;
      }
      await this.beat();
      if (wait) await this.sleep(this.chain.pollInterval);
    }
  }

  /** Heartbeat on every loop iteration, failed or not; a failure here is only logged at debug level. */
  private async beat(): Promise<void> {
    try {
      await this.store.heartbeat(this.chain.chainId, 'indexer');
    } catch (err) {
      log.debug(`chain ${this.chain.chainId}: heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  status(): { chainId: number; name: string; currentBlock: number; indexBlock: number } {
    return { chainId: this.chain.chainId, name: this.chain.name, currentBlock: this.currentBlock, indexBlock: this.indexBlock };
  }

  /** Time (ms) of the last successful loop iteration; 0 before the first one. */
  lastLoopAt(): number {
    return this.lastLoop;
  }

  private iface(source: NormalizedSource): Interface {
    let iface = this.ifaces.get(source.name);
    if (!iface) {
      iface = new Interface(source.contract.abi as never);
      this.ifaces.set(source.name, iface);
    }
    return iface;
  }

  /**
   * Template sink: called by `Template.create` inside an index callback. The registry entry and the
   * catch-up mark are set synchronously, so a callback that does not await `create` loses nothing.
   * The sys_templates write is awaited by `tick()` after the callback; if it fails, the registry
   * entry is rolled back (so the retry adds and writes it again) and the tick aborts.
   */
  private onTemplate(template: string, address: string): Promise<void> {
    const ctx = currentContext();
    if (!ctx) return Promise.reject(new Error('Template.create is only allowed in index callbacks'));
    const { chainId } = this.chain;
    const block = ctx.block.number;
    const after = { txIndex: ctx.tx.transactionIndex, logIndex: ctx.tx.logIndex };
    const res = this.registry.add(template, address, block, after);
    if (res === 'conflict') {
      log.error(`chain ${chainId}: ${template}.create(${address}) ignored, the address belongs to another source`);
    }
    if (res !== 'added') return Promise.resolve();
    this.created.push(address);
    const write = this.store.addTemplate({ chainId, template, address, block, ...after }).then(
      () => undefined,
      (err: unknown) => {
        this.registry.remove(address);
        throw err;
      },
    );
    this.templateWrites.push(write);
    // A failure surfaces from tick(); the callback's own promise never rejects for it.
    return write.catch(() => undefined);
  }

  /** A log whose layout does not fit the ABI is skipped: red once per address and topic0, debug after that. */
  private reportUndecodable(raw: RawLog, what: string, err: unknown): void {
    const topic0 = raw.topics[0]?.toLowerCase() ?? '';
    const pair = `${raw.address.toLowerCase()}/${topic0}`;
    const msg = `chain ${this.chain.chainId}: cannot decode ${what} log at ${raw.address.toLowerCase()} ` +
      `${logKey(raw)} (topic0 ${topic0}), skipped: ${err instanceof Error ? err.message : String(err)}`;
    if (this.undecodable.has(pair)) {
      log.debug(msg);
      return;
    }
    this.undecodable.add(pair);
    log.error(`${msg}; further logs of this address and topic0 that fail to decode are skipped silently`);
  }

  /** While far behind head, prints progress with an ETA every 10 s. */
  private reportProgress(current: number, target: number): void {
    if (target - current <= this.chain.headThreshold) {
      this.progress = null;
      return;
    }
    const now = Date.now();
    if (!this.progress) this.progress = { block: current, ms: now, lastLog: 0 };
    if (now - this.progress.lastLog < PROGRESS_EVERY_MS) return;
    this.progress.lastLog = now;
    const e = eta(this.progress.block, this.progress.ms, current, target, now);
    const rest = e ? `, ${e.blocksPerSecond.toFixed(1)} blocks/s, eta ${formatTimespan(e.seconds)}` : '';
    log.task('index', `${this.chain.name}: block ${current} of ${target}${rest}`);
  }
}
