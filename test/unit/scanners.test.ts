import { describe, it, expect } from 'vitest';
import { BackfillScanner } from '../../src/indexer/backfill';
import { HeadScanner } from '../../src/indexer/head';
import { sortLogs, type ScanPool } from '../../src/indexer/scan';
import { Registry } from '../../src/indexer/registry';
import { ResizeError } from '../../src/rpc/errors';
import type { NormalizedSource } from '../../src/runtime/define';
import type { EventDef } from '../../src/runtime/events';
import type { RawBlock, RawLog } from '../../src/types';
import { makeBloom } from '../helpers/bloom';

const TRANSFER = '0x' + 'aa'.repeat(32);
const SWAP = '0x' + 'cc'.repeat(32);
const NOISE_TOPIC = '0x' + 'ee'.repeat(32);
const TOKEN = '0x' + 'a1'.repeat(20);
const NEW = '0x' + 'd4'.repeat(20);
const NOISE = '0x' + '99'.repeat(20);

function contractOf(events: Record<string, EventDef>): NormalizedSource['contract'] {
  return class { static readonly abi = []; static readonly events = events; static readonly eventTypes = {}; } as unknown as NormalizedSource['contract'];
}
const sources: Record<string, NormalizedSource> = {
  Token: {
    name: 'Token', kind: 'contract',
    contract: contractOf({ Transfer: { name: 'Transfer', topic0: TRANSFER, signature: 'Transfer()' } }),
    events: { Transfer: {} },
  },
  PoolT: {
    name: 'PoolT', kind: 'template',
    contract: contractOf({ Swap: { name: 'Swap', topic0: SWAP, signature: 'Swap()' } }),
    events: { Swap: {} },
  },
};
function makeRegistry(): Registry {
  const reg = new Registry(sources);
  reg.addStatic([{ source: 'Token', address: TOKEN, block: 0 }]);
  return reg;
}

const mkLog = (address: string, topic0: string, blockNumber: number, transactionIndex = 0, logIndex = 0): RawLog => ({
  address, topics: [topic0], data: '0x', blockNumber, transactionIndex, logIndex,
  transactionHash: '0x' + blockNumber.toString(16).padStart(4, '0') + transactionIndex.toString(16).padStart(60, '0'),
});
const key = (l: RawLog) => `${l.blockNumber}:${l.transactionIndex}:${l.logIndex}`;

type Filter = { fromBlock: number; toBlock: number; address?: string[]; topics: string[] };

class FakeChain implements ScanPool {
  logRange = 500;
  blockBatch = 10;
  getLogsCalls: Filter[] = [];
  getBlocksCalls: number[][] = [];
  getBlockLogsCalls: number[] = [];
  failGetLogsOnce = false;
  /** blocks whose bloom is forced to zero although they hold logs */
  zeroBloom = new Set<number>();
  constructor(public logs: RawLog[]) {}

  size(kind: 'logRange' | 'blockBatch'): number {
    return kind === 'logRange' ? this.logRange : this.blockBatch;
  }
  async getLogs(f: Filter): Promise<RawLog[]> {
    this.getLogsCalls.push(f);
    if (this.failGetLogsOnce) {
      this.failGetLogsOnce = false;
      this.logRange = Math.floor(this.logRange / 2);
      throw new ResizeError();
    }
    const addrs = f.address?.map((a) => a.toLowerCase());
    return this.logs.filter(
      (l) => l.blockNumber >= f.fromBlock && l.blockNumber <= f.toBlock
        && (!addrs || addrs.includes(l.address)) && f.topics.includes(l.topics[0]),
    );
  }
  blockOf(n: number): RawBlock {
    const logs = this.logs.filter((l) => l.blockNumber === n);
    const txIdx = [...new Set(logs.map((l) => l.transactionIndex))];
    return {
      number: n, hash: '0x' + n.toString(16).padStart(64, '0'), timestamp: 1000 + n,
      logsBloom: this.zeroBloom.has(n) ? '0x' + '00'.repeat(256) : makeBloom(logs.flatMap((l) => [l.address, ...l.topics])),
      transactions: txIdx.map((i) => ({
        hash: '0x' + i.toString(16).padStart(64, '0'), from: NOISE, to: null, value: 0n, nonce: 0,
        gasPrice: 0n, input: '0x', transactionIndex: i,
      })),
    };
  }
  async getBlocks(numbers: number[]): Promise<RawBlock[]> {
    this.getBlocksCalls.push(numbers);
    return numbers.map((n) => this.blockOf(n));
  }
  async getBlockLogs(n: number): Promise<RawLog[]> {
    this.getBlockLogsCalls.push(n);
    return this.logs.filter((l) => l.blockNumber === n);
  }
}

/** a sparse chain over 100..5000 */
function wideLogs(): RawLog[] {
  return [
    mkLog(TOKEN, TRANSFER, 150, 1, 0),
    mkLog(TOKEN, TRANSFER, 150, 0, 3),
    mkLog(NOISE, TRANSFER, 160, 0, 0), // unregistered address
    mkLog(TOKEN, NOISE_TOPIC, 170, 0, 0), // unconfigured topic0
    mkLog(TOKEN, TRANSFER, 400, 0, 0),
    mkLog(TOKEN, TRANSFER, 700, 0, 0),
  ];
}

/** head chain 100..104 */
function headLogs(): RawLog[] {
  return [
    mkLog(NOISE, NOISE_TOPIC, 100, 0, 0), // bloom cannot match
    mkLog(TOKEN, TRANSFER, 102, 2, 5),
    mkLog(TOKEN, TRANSFER, 102, 1, 4),
    mkLog(NEW, SWAP, 102, 1, 6),
    mkLog(NEW, SWAP, 103, 0, 0),
  ];
}

describe('sortLogs', () => {
  it('sorts by block, tx index and log index without mutating the input', () => {
    const input = [mkLog(TOKEN, TRANSFER, 5, 1, 0), mkLog(TOKEN, TRANSFER, 4, 9, 9), mkLog(TOKEN, TRANSFER, 5, 0, 7), mkLog(TOKEN, TRANSFER, 5, 0, 2)];
    expect(sortLogs(input).map(key)).toEqual(['4:9:9', '5:0:2', '5:0:7', '5:1:0']);
    expect(key(input[0])).toBe('5:1:0');
  });
});

describe('BackfillScanner', () => {
  it('scans one range of logRange blocks and returns sorted registry matches', async () => {
    const pool = new FakeChain(wideLogs());
    const b = await new BackfillScanner(pool, makeRegistry()).scan(100, 5000);
    expect([b.from, b.to]).toEqual([100, 599]);
    expect(b.logs.map(key)).toEqual(['150:0:3', '150:1:0', '400:0:0']);
    expect((await b.getBlock(b.logs[0].blockNumber)).number).toBe(150);
    expect(pool.getLogsCalls[0]).toEqual({ fromBlock: 100, toBlock: 599, address: [TOKEN], topics: [TRANSFER] });
  });

  it('fetches the blocks of matched logs eagerly, once each, in blockBatch chunks', async () => {
    const pool = new FakeChain(wideLogs());
    pool.blockBatch = 2;
    pool.logRange = 1000;
    const b = await new BackfillScanner(pool, makeRegistry()).scan(100, 5000);
    expect(pool.getBlocksCalls).toEqual([[150, 400], [700]]);
    await b.getBlock(150);
    expect(pool.getBlocksCalls).toHaveLength(2);
  });

  it('retries a block chunk with a smaller size after a ResizeError', async () => {
    const pool = new FakeChain(wideLogs());
    pool.blockBatch = 4;
    pool.logRange = 1000;
    const orig = pool.getBlocks.bind(pool);
    let failed = false;
    pool.getBlocks = async (numbers: number[]) => {
      if (!failed) {
        failed = true;
        pool.blockBatch = 2;
        throw new ResizeError();
      }
      return orig(numbers);
    };
    await new BackfillScanner(pool, makeRegistry()).scan(100, 5000);
    expect(pool.getBlocksCalls).toEqual([[150, 400], [700]]);
  });

  it('fetches a block that was not prefetched on demand and caches it', async () => {
    const pool = new FakeChain(wideLogs());
    const b = await new BackfillScanner(pool, makeRegistry()).scan(100, 5000);
    expect((await b.getBlock(300)).number).toBe(300);
    await b.getBlock(300);
    expect(pool.getBlocksCalls.filter((c) => c.includes(300))).toEqual([[300]]);
  });

  it('clamps to the target', async () => {
    const b = await new BackfillScanner(new FakeChain(wideLogs()), makeRegistry()).scan(100, 120);
    expect([b.from, b.to]).toEqual([100, 120]);
  });

  it('recomputes the range after a ResizeError', async () => {
    const pool = new FakeChain(wideLogs());
    pool.failGetLogsOnce = true;
    const b = await new BackfillScanner(pool, makeRegistry()).scan(100, 5000);
    expect(b.to).toBe(349);
    expect(pool.getLogsCalls.map((c) => c.toBlock)).toEqual([599, 349]);
  });

  it('omits the address filter above 100 registry addresses and still returns only matches', async () => {
    const reg = makeRegistry();
    for (let i = 0; i < 100; i++) reg.add('Token', '0x' + (i + 0x1000).toString(16).padStart(40, '0'), 0);
    expect(reg.size()).toBe(101);
    const pool = new FakeChain(wideLogs());
    const b = await new BackfillScanner(pool, reg).scan(100, 5000);
    expect(pool.getLogsCalls[0].address).toBeUndefined();
    expect(b.logs.map(key)).toEqual(['150:0:3', '150:1:0', '400:0:0']);
  });

  it('returns an empty batch without calling the pool when the registry is empty', async () => {
    const pool = new FakeChain(wideLogs());
    const b = await new BackfillScanner(pool, new Registry(sources)).scan(100, 5000);
    expect({ from: b.from, to: b.to, logs: b.logs }).toEqual({ from: 100, to: 599, logs: [] });
    expect(pool.getLogsCalls).toHaveLength(0);
  });

  it('logsFor returns only that address, registry matched, within fromBlock..to', async () => {
    const reg = makeRegistry();
    const logs = [
      ...wideLogs(), mkLog(NEW, SWAP, 120, 0, 0), mkLog(NEW, SWAP, 300, 0, 0),
      mkLog(NEW, SWAP, 450, 1, 0), mkLog(NEW, SWAP, 450, 0, 1), mkLog(NEW, SWAP, 900, 0, 0),
    ];
    const pool = new FakeChain(logs);
    const b = await new BackfillScanner(pool, reg).scan(100, 5000);
    expect(b.logs.map(key)).toEqual(['150:0:3', '150:1:0', '400:0:0']);
    reg.add('PoolT', NEW, 300); // registered from block 300; block 120 is dropped by the registry
    const res = await b.logsFor(NEW, 300);
    expect(res.map(key)).toEqual(['300:0:0', '450:0:1', '450:1:0']);
    expect((await b.getBlock(450)).number).toBe(450);
  });
});

describe('HeadScanner', () => {
  it('reads receipts only for blocks whose bloom may match', async () => {
    const pool = new FakeChain(headLogs());
    const h = await new HeadScanner(pool, makeRegistry(), true).scan(100, 104);
    expect(h.to).toBe(104);
    expect(pool.getBlockLogsCalls).toEqual([102]);
    expect(h.logs.map(key)).toEqual(['102:1:4', '102:2:5']);
    expect((await h.getBlock(102)).number).toBe(102);
    expect(pool.getBlocksCalls).toEqual([[100, 101, 102, 103, 104]]);
  });

  it('limits the batch to blockBatch', async () => {
    const pool = new FakeChain(headLogs());
    pool.blockBatch = 3;
    const h = await new HeadScanner(pool, makeRegistry(), true).scan(100, 104);
    expect([h.from, h.to]).toEqual([100, 102]);
  });

  it('retries with a smaller batch after a ResizeError', async () => {
    const pool = new FakeChain(headLogs());
    const orig = pool.getBlocks.bind(pool);
    let failed = false;
    pool.getBlocks = async (numbers: number[]) => {
      if (!failed) {
        failed = true;
        pool.blockBatch = 2;
        throw new ResizeError();
      }
      return orig(numbers);
    };
    const h = await new HeadScanner(pool, makeRegistry(), true).scan(100, 104);
    expect([h.from, h.to]).toEqual([100, 101]);
  });

  it('logsFor re-filters loaded blocks and loads skipped blocks whose bloom may contain the address', async () => {
    const reg = makeRegistry();
    const pool = new FakeChain(headLogs());
    const h = await new HeadScanner(pool, reg, true).scan(100, 104);
    reg.add('PoolT', NEW, 102);
    expect((await h.logsFor(NEW, 102)).map((l) => l.blockNumber)).toEqual([102, 103]);
    expect(pool.getBlockLogsCalls).toEqual([102, 103]);
    await h.logsFor(NEW, 102);
    expect(pool.getBlockLogsCalls).toEqual([102, 103]); // 103 is cached now, 100/104 never loaded
  });

  it('logsFor ignores blocks before fromBlock', async () => {
    const reg = makeRegistry();
    const pool = new FakeChain(headLogs());
    const h = await new HeadScanner(pool, reg, true).scan(100, 104);
    reg.add('PoolT', NEW, 103);
    expect((await h.logsFor(NEW, 103)).map(key)).toEqual(['103:0:0']);
    expect(pool.getBlockLogsCalls).toEqual([102, 103]);
  });

  it('reads every block when useBloom is off', async () => {
    const pool = new FakeChain(headLogs());
    const h = await new HeadScanner(pool, makeRegistry(), false).scan(100, 104);
    expect(pool.getBlockLogsCalls).toEqual([100, 101, 102, 103, 104]);
    expect(h.logs.map(key)).toEqual(['102:1:4', '102:2:5']);
  });

  it('treats a zero bloom of a block with transactions as may-match, but skips an empty zero-bloom block', async () => {
    const pool = new FakeChain(headLogs());
    pool.zeroBloom.add(100);
    const h = await new HeadScanner(pool, makeRegistry(), true).scan(100, 104);
    // 100 has a transaction and a zero bloom -> fetched; 101/104 have no txs and a zero bloom -> skipped
    expect(pool.getBlockLogsCalls).toEqual([100, 102]);
    expect(h.logs.map(key)).toEqual(['102:1:4', '102:2:5']);
  });

  it('returns an empty batch without calling getBlockLogs when the registry is empty', async () => {
    const pool = new FakeChain(headLogs());
    const h = await new HeadScanner(pool, new Registry(sources), true).scan(100, 104);
    expect({ from: h.from, to: h.to, logs: h.logs }).toEqual({ from: 100, to: 104, logs: [] });
    expect(pool.getBlockLogsCalls).toHaveLength(0);
  });
});

describe('backfill and head equality', () => {
  it('return identical logs for the same blocks', async () => {
    const chain = headLogs();
    const b = await new BackfillScanner(new FakeChain(chain), makeRegistry()).scan(100, 104);
    const h = await new HeadScanner(new FakeChain(chain), makeRegistry(), true).scan(100, 104);
    expect([b.from, b.to]).toEqual([h.from, h.to]);
    expect(h.logs).toEqual(b.logs);
    expect(b.logs.length).toBeGreaterThan(0);
  });
});
