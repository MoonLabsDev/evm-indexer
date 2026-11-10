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

/** True when `l` comes strictly after `ref` in block, tx, log order. */
function isAfter(l: RawLog, ref: RawLog): boolean {
  const d = l.blockNumber - ref.blockNumber || l.transactionIndex - ref.transactionIndex || l.logIndex - ref.logIndex;
  return d > 0;
}

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

  /** Addresses that index callbacks of the current log created (sink result 'added'). */
  private created: string[] = [];
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
      if (this.registry.add(t.template, t.address, t.block) === 'conflict') {
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

    const scanner = target - from + 1 > headThreshold ? this.scanners.backfill : this.scanners.head;
    const batch = await scanner.scan(from, target);

    let queue = batch.logs;
    let i = 0;
    const walked = new Set<string>();
    const events: EventDoc[] = [];
    const txs = new Map<string, TxDoc>();

    while (i < queue.length) {
      const raw = queue[i++];
      walked.add(logKey(raw));
      const m = this.registry.match(raw);
      if (!m) continue;

      const blk = await batch.getBlock(raw.blockNumber);
      const rawTx = blk.transactions.find((t) => t.hash === raw.transactionHash);
      if (!rawTx) {
        throw new Error(`chain ${chainId}: transaction ${raw.transactionHash} of a log is missing in block ${raw.blockNumber}`);
      }
      const address = raw.address.toLowerCase();
      const args = decodeLog(this.iface(m.source), m.def, raw);
      const event: IndexedEvent = {
        args, address, blockNumber: raw.blockNumber, txIndex: raw.transactionIndex,
        logIndex: raw.logIndex, txHash: raw.transactionHash,
      };

      this.created = [];
      setContext({
        mode: 'index',
        chain: { id: chainId, name },
        block: { number: blk.number, hash: blk.hash, timestamp: Timestamp.from(blk.timestamp) },
        tx: {
          hash: rawTx.hash, transactionIndex: rawTx.transactionIndex, logIndex: raw.logIndex, from: rawTx.from,
          to: rawTx.to, value: rawTx.value, nonce: rawTx.nonce, gasPrice: rawTx.gasPrice, input: rawTx.input,
        },
      });
      try {
        await m.source.events[m.eventName]?.index?.(event);
      } finally {
        clearContext();
      }
      const created = this.created;
      this.created = [];

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
        // Catch up the new addresses' logs after this one, without duplicates.
        const merged = new Map<string, RawLog>();
        for (const l of queue.slice(i)) merged.set(logKey(l), l);
        for (const addr of created) {
          for (const l of await batch.logsFor(addr, raw.blockNumber)) {
            const k = logKey(l);
            if (isAfter(l, raw) && !walked.has(k) && !merged.has(k)) merged.set(k, l);
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
      if (wait) await this.sleep(this.chain.pollInterval);
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

  /** Template sink: called by `Template.create` inside an index callback. */
  private async onTemplate(template: string, address: string): Promise<void> {
    const ctx = currentContext();
    if (!ctx) throw new Error('Template.create is only allowed in index callbacks');
    const { chainId } = this.chain;
    const blockNumber = ctx.block.number;
    const res = this.registry.add(template, address, blockNumber);
    if (res === 'added') {
      await this.store.addTemplate({ chainId, template, address, block: blockNumber });
      this.created.push(address);
    } else if (res === 'conflict') {
      log.error(`chain ${chainId}: ${template}.create(${address}) ignored, the address belongs to another source`);
    }
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
