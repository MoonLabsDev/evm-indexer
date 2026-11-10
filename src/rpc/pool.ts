import type { RawBlock, RawLog, RawTx, SizeBounds } from '../types';
import { AdaptiveSize, RateGap } from './sizer';
import { AllRpcFailedError, ResizeError, RpcError, classifyError } from './errors';
import type { RpcTransport } from './transport';

export interface PoolOptions {
  retryDelays: number[];
  logRange: SizeBounds;
  blockBatch: SizeBounds;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

type SizeKind = 'logRange' | 'blockBatch';

interface TransportState {
  transport: RpcTransport;
  sizes: Record<SizeKind, AdaptiveSize>;
  gap: RateGap;
  lastRequest: number;
  receiptsUnsupported: boolean;
}

interface Sized<T> { kind: SizeKind; logCount: (result: T) => number }

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const hex = (n: number): string => '0x' + n.toString(16);
const num = (v: unknown): number => Number(BigInt(v as string));
const big = (v: unknown): bigint => BigInt(v as string);
const low = (v: unknown): string => String(v).toLowerCase();

type Raw = Record<string, unknown>;

function decodeLog(r: Raw): RawLog {
  return {
    address: low(r.address),
    topics: (r.topics as string[]).map(low),
    data: r.data as string,
    blockNumber: num(r.blockNumber),
    transactionIndex: num(r.transactionIndex),
    logIndex: num(r.logIndex),
    transactionHash: low(r.transactionHash),
  };
}

function decodeTx(r: Raw): RawTx {
  return {
    hash: low(r.hash),
    from: low(r.from),
    to: r.to == null ? null : low(r.to),
    value: big(r.value),
    nonce: num(r.nonce),
    gasPrice: big(r.gasPrice ?? r.maxFeePerGas ?? '0x0'),
    input: r.input as string,
    transactionIndex: num(r.transactionIndex),
  };
}

function decodeBlock(r: Raw): RawBlock {
  return {
    number: num(r.number),
    hash: low(r.hash),
    timestamp: num(r.timestamp),
    logsBloom: r.logsBloom as string,
    transactions: ((r.transactions ?? []) as Raw[]).map(decodeTx),
  };
}

/** The only place that talks to an RPC: retry ladder, failover, adaptive sizes, rate gap. */
export class RpcPool {
  private readonly states: TransportState[];
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private active = 0;

  constructor(transports: RpcTransport[], private readonly opts: PoolOptions) {
    this.sleep = opts.sleep ?? defaultSleep;
    this.now = opts.now ?? Date.now;
    this.states = transports.map((transport) => ({
      transport,
      sizes: { logRange: new AdaptiveSize(opts.logRange), blockBatch: new AdaptiveSize(opts.blockBatch) },
      gap: new RateGap(),
      lastRequest: Number.NEGATIVE_INFINITY,
      receiptsUnsupported: false,
    }));
  }

  /** Learned size of the active RPC. */
  size(kind: SizeKind): number {
    return this.states[this.active].sizes[kind].value;
  }

  async getBlockNumber(): Promise<number> {
    return this.exec(async (s) => num(await s.transport.send('eth_blockNumber', [])));
  }

  async getLogs(f: { fromBlock: number; toBlock: number; address?: string[]; topics: string[] }): Promise<RawLog[]> {
    const filter: Record<string, unknown> = { fromBlock: hex(f.fromBlock), toBlock: hex(f.toBlock) };
    if (f.address) filter.address = f.address;
    filter.topics = [f.topics];
    return this.exec(
      async (s) => ((await s.transport.send('eth_getLogs', [filter])) as Raw[]).map(decodeLog),
      { kind: 'logRange', logCount: (logs) => logs.length },
    );
  }

  async getBlocks(numbers: number[]): Promise<RawBlock[]> {
    return this.exec(
      async (s) => {
        const res = await s.transport.sendBatch(
          numbers.map((n) => ({ method: 'eth_getBlockByNumber', params: [hex(n), true] })),
        );
        return res.map((r, i) => {
          if (r == null) throw new RpcError(`fetch failed: null result for block ${numbers[i]}`, undefined, 502);
          return decodeBlock(r as Raw);
        });
      },
      { kind: 'blockBatch', logCount: () => 0 },
    );
  }

  async getBlockLogs(blockNumber: number): Promise<RawLog[]> {
    return this.exec(async (s) => {
      if (!s.receiptsUnsupported) {
        try {
          const receipts = await s.transport.send('eth_getBlockReceipts', [hex(blockNumber)]);
          if (receipts == null) {
            throw new RpcError(`fetch failed: null receipts for block ${blockNumber}`, undefined, 502);
          }
          return (receipts as { logs: Raw[] }[]).flatMap((r) => r.logs.map(decodeLog));
        } catch (err) {
          if (classifyError(err) !== 'unsupported') throw err;
          s.receiptsUnsupported = true;
        }
      }
      const logs = await s.transport.send('eth_getLogs', [{ fromBlock: hex(blockNumber), toBlock: hex(blockNumber) }]);
      return (logs as Raw[]).map(decodeLog);
    });
  }

  async ethCall(to: string, data: string, blockNumber: number): Promise<string> {
    return this.exec(async (s) => (await s.transport.send('eth_call', [{ to, data }, hex(blockNumber)])) as string);
  }

  /**
   * Runs one request through the ladder. Retryable errors sleep per `retryDelays` on the same RPC,
   * then the pool moves to the next RPC; once every RPC exhausted its ladder in a row it gives up.
   */
  private async exec<T>(op: (s: TransportState) => Promise<T>, sized?: Sized<T>): Promise<T> {
    let exhausted = 0;
    for (;;) {
      const s = this.states[this.active];
      for (let attempt = 0; ; attempt++) {
        try {
          await this.waitGap(s);
          s.lastRequest = this.now();
          const started = s.lastRequest;
          const result = await op(s);
          s.gap.onSuccess();
          if (sized) s.sizes[sized.kind].onSuccess(this.now() - started, sized.logCount(result));
          return result;
        } catch (err) {
          const kind = classifyError(err);
          if (kind === 'fatal' || kind === 'unsupported') throw err;
          if (kind === 'rateLimit') s.gap.on429();
          if (sized && (kind === 'tooLarge' || kind === 'timeout' || kind === 'rateLimit') && s.sizes[sized.kind].halve()) {
            if (kind === 'rateLimit') await this.sleep(this.opts.retryDelays[0] ?? 0);
            throw new ResizeError();
          }
          // a too-large answer will not improve on a retry: go straight to the next RPC
          if (kind === 'tooLarge' || attempt >= this.opts.retryDelays.length) break;
          await this.sleep(this.opts.retryDelays[attempt]);
        }
      }
      if (++exhausted >= this.states.length) throw new AllRpcFailedError();
      this.active = (this.active + 1) % this.states.length;
    }
  }

  private async waitGap(s: TransportState): Promise<void> {
    const remaining = s.lastRequest + s.gap.ms - this.now();
    if (s.gap.ms > 0 && remaining > 0) await this.sleep(remaining);
  }
}
