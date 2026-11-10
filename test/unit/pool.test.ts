import { describe, it, expect, vi, afterEach } from 'vitest';
import { FakeTransport } from '../helpers/fakeTransport';
import { RpcPool } from '../../src/rpc/pool';
import { setDebug } from '../../src/log';
import { RpcError, ResizeError, AllRpcFailedError } from '../../src/rpc/errors';

function setup(overrides: Partial<ConstructorParameters<typeof RpcPool>[1]> = {}) {
  const a = new FakeTransport('a');
  const b = new FakeTransport('b');
  const sleeps: number[] = [];
  const clock = { t: 1000 };
  const pool = new RpcPool([a, b], {
    retryDelays: [100, 500, 2500],
    logRange: { start: 500, min: 1, max: 2000 },
    blockBatch: { start: 10, min: 1, max: 100 },
    sleep: async (ms) => { sleeps.push(ms); },
    now: () => clock.t,
    ...overrides,
  });
  return { a, b, pool, sleeps, clock };
}

const filter = { fromBlock: 1, toBlock: 10, topics: ['0xAA'] };
const rawBlock = (n: number) => ({
  number: '0x' + n.toString(16), hash: '0xABC', timestamp: '0x64', logsBloom: '0x00',
  transactions: [],
});
const rawLog = (over: Record<string, unknown> = {}) => ({
  address: '0xAB', topics: ['0xCD'], data: '0x', blockNumber: '0x5',
  transactionIndex: '0x0', logIndex: '0x0', transactionHash: '0xEF', ...over,
});

describe('RpcPool', () => {
  it('retries on the same RPC and then succeeds', async () => {
    const { a, pool, sleeps } = setup();
    let n = 0;
    a.on('eth_blockNumber', () => { if (n++ < 2) throw new RpcError('bad gateway', undefined, 503); return '0x10'; });
    expect(await pool.getBlockNumber()).toBe(16);
    expect(sleeps).toEqual([100, 500]);
    expect(a.calls.length).toBe(3);
  });

  it('fails over to the next RPC after the ladder is exhausted', async () => {
    const { a, b, pool, sleeps } = setup();
    a.on('eth_blockNumber', () => { throw new RpcError('down', undefined, 503); });
    b.on('eth_blockNumber', () => '0x11');
    expect(await pool.getBlockNumber()).toBe(17);
    expect(sleeps).toEqual([100, 500, 2500]);
    expect(b.calls.length).toBe(1);
  });

  it('stays on the RPC it last succeeded on', async () => {
    const { a, b, pool } = setup();
    a.on('eth_blockNumber', () => { throw new RpcError('down', undefined, 503); });
    b.on('eth_blockNumber', () => '0x11');
    await pool.getBlockNumber();
    await pool.getBlockNumber();
    expect(a.calls.length).toBe(4);
    expect(b.calls.length).toBe(2);
  });

  it('throws AllRpcFailedError when every RPC failed in a row', async () => {
    const { a, b, pool } = setup();
    a.on('eth_blockNumber', () => { throw new RpcError('down', undefined, 503); });
    b.on('eth_blockNumber', () => { throw new RpcError('down', undefined, 503); });
    await expect(pool.getBlockNumber()).rejects.toBeInstanceOf(AllRpcFailedError);
    expect(a.calls.length).toBe(4);
    expect(b.calls.length).toBe(4);
  });

  it('does not retry fatal errors', async () => {
    const { a, pool, sleeps } = setup();
    a.on('eth_call', () => { throw new RpcError('execution reverted', 3); });
    await expect(pool.ethCall('0xTo', '0xdata', 5)).rejects.toThrow('execution reverted');
    expect(a.calls.length).toBe(1);
    expect(sleeps).toEqual([]);
    expect(a.calls[0].params).toEqual([{ to: '0xTo', data: '0xdata' }, '0x5']);
  });

  it('halves the log range on a too-large error and throws ResizeError', async () => {
    const { a, pool } = setup();
    a.on('eth_getLogs', () => { throw new RpcError('query returned more than 10000 results', -32005); });
    await expect(pool.getLogs(filter)).rejects.toBeInstanceOf(ResizeError);
    expect(pool.size('logRange')).toBe(250);
    expect(a.calls.length).toBe(1);
  });

  it('sends eth_getLogs with hex range and the topic0 list nested', async () => {
    const { a, pool } = setup();
    a.on('eth_getLogs', () => []);
    await pool.getLogs({ fromBlock: 1, toBlock: 255, address: ['0xA1'], topics: ['0xaa', '0xbb'] });
    expect(a.calls[0].params).toEqual([
      { fromBlock: '0x1', toBlock: '0xff', address: ['0xA1'], topics: [['0xaa', '0xbb']] },
    ]);
  });

  it('decodes logs and lowercases addresses, hashes and topics', async () => {
    const { a, pool } = setup();
    a.on('eth_getLogs', () => [rawLog({
      address: '0xABCDEF', topics: ['0xAA', '0xBB'], data: '0xDD', blockNumber: '0xa',
      transactionIndex: '0x1', logIndex: '0x2', transactionHash: '0xFF',
    })]);
    const logs = await pool.getLogs(filter);
    expect(logs).toEqual([{
      address: '0xabcdef', topics: ['0xaa', '0xbb'], data: '0xDD', blockNumber: 10,
      transactionIndex: 1, logIndex: 2, transactionHash: '0xff',
    }]);
  });

  it('grows the log range after a fast, small success', async () => {
    const { a, pool } = setup();
    a.on('eth_getLogs', () => []);
    await pool.getLogs(filter);
    expect(pool.size('logRange')).toBe(625);
  });

  it('at min size a too-large error falls to the ladder and the next RPC', async () => {
    const { a, b, pool, sleeps } = setup({ logRange: { start: 1, min: 1, max: 1 } });
    a.on('eth_getLogs', () => { throw new RpcError('response size exceeded', -32005); });
    b.on('eth_getLogs', () => []);
    expect(await pool.getLogs(filter)).toEqual([]);
    expect(a.calls.length).toBe(1);
    expect(b.calls.length).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('does not fail over on a revert whose text contains "exceeds"', async () => {
    const { a, b, pool, sleeps } = setup();
    a.on('eth_call', () => { throw new RpcError('execution reverted: transfer amount exceeds balance', 3); });
    await expect(pool.ethCall('0xTo', '0xdata', 5)).rejects.toThrow('exceeds balance');
    expect(a.calls.length).toBe(1);
    expect(b.calls.length).toBe(0);
    expect(sleeps).toEqual([]);
  });

  it('keeps learned sizes per RPC', async () => {
    const { a, b, pool } = setup();
    a.on('eth_getLogs', () => { throw new RpcError('too many results', -32005); });
    a.on('eth_blockNumber', () => { throw new RpcError('down', undefined, 503); });
    b.on('eth_blockNumber', () => '0x1');
    await expect(pool.getLogs(filter)).rejects.toBeInstanceOf(ResizeError);
    expect(pool.size('logRange')).toBe(250);
    await pool.getBlockNumber(); // forces failover to b
    expect(pool.size('logRange')).toBe(500);
  });

  it('treats a null block in a batch as retryable', async () => {
    const { a, pool, sleeps } = setup();
    let n = 0;
    a.on('eth_getBlockByNumber', () => (n++ === 0 ? null : rawBlock(5)));
    const blocks = await pool.getBlocks([5]);
    expect(blocks.map((x) => x.number)).toEqual([5]);
    expect(sleeps).toEqual([100]);
    expect(a.calls[0].params).toEqual(['0x5', true]);
  });

  it('falls back to eth_getLogs when eth_getBlockReceipts is unsupported and remembers it', async () => {
    const { a, pool } = setup();
    a.on('eth_getBlockReceipts', () => { throw new RpcError('method not found', -32601); });
    a.on('eth_getLogs', () => [rawLog()]);
    const logs = await pool.getBlockLogs(5);
    expect(logs.length).toBe(1);
    expect(logs[0].address).toBe('0xab');
    expect(a.calls.find((c) => c.method === 'eth_getLogs')!.params).toEqual([{ fromBlock: '0x5', toBlock: '0x5' }]);
    await pool.getBlockLogs(6);
    expect(a.calls.filter((c) => c.method === 'eth_getBlockReceipts').length).toBe(1);
  });

  it('flattens logs from eth_getBlockReceipts', async () => {
    const { a, pool } = setup();
    a.on('eth_getBlockReceipts', () => [
      { logs: [rawLog({ logIndex: '0x0' }), rawLog({ logIndex: '0x1' })] },
      { logs: [] },
      { logs: [rawLog({ logIndex: '0x2' })] },
    ]);
    const logs = await pool.getBlockLogs(5);
    expect(logs.map((l) => l.logIndex)).toEqual([0, 1, 2]);
  });

  it('treats null eth_getBlockReceipts as retryable', async () => {
    const { a, pool, sleeps } = setup();
    let n = 0;
    a.on('eth_getBlockReceipts', () => (n++ === 0 ? null : []));
    expect(await pool.getBlockLogs(5)).toEqual([]);
    expect(sleeps).toEqual([100]);
  });

  it('adds a rate gap after a 429 and waits for it before the next request', async () => {
    const { a, pool, sleeps } = setup();
    let n = 0;
    a.on('eth_getLogs', () => { if (n++ === 0) throw new RpcError('Too Many Requests', undefined, 429); return []; });
    await expect(pool.getLogs(filter)).rejects.toBeInstanceOf(ResizeError);
    expect(sleeps).toContain(100);
    const before = sleeps.length;
    await pool.getLogs(filter); // the clock is frozen, so the 100 ms gap is still owed
    expect(sleeps.slice(before)).toEqual([100]);
  });

  it('skips the gap wait once enough time has passed', async () => {
    const { a, pool, sleeps, clock } = setup();
    let n = 0;
    a.on('eth_getLogs', () => { if (n++ === 0) throw new RpcError('rate limit', undefined, 429); return []; });
    await expect(pool.getLogs(filter)).rejects.toBeInstanceOf(ResizeError);
    clock.t += 150;
    const before = sleeps.length;
    await pool.getLogs(filter);
    expect(sleeps.length).toBe(before);
  });

  it('decodes blocks: bigint value, number fields, lowercased addresses and hashes', async () => {
    const { a, pool } = setup();
    a.on('eth_getBlockByNumber', () => ({
      number: '0x5', hash: '0xABC', timestamp: '0x64', logsBloom: '0x0F',
      transactions: [{
        hash: '0xDEF', from: '0xAbCd', to: '0xEeFf', value: '0xde0b6b3a7640000',
        nonce: '0x7', gasPrice: '0x3b9aca00', input: '0xDATA', transactionIndex: '0x2',
      }, {
        hash: '0x01', from: '0x02', to: null, value: '0x0', nonce: '0x0',
        maxFeePerGas: '0x10', input: '0x', transactionIndex: '0x3',
      }],
    }));
    const [blk] = await pool.getBlocks([5]);
    expect(blk.number).toBe(5);
    expect(blk.hash).toBe('0xabc');
    expect(blk.timestamp).toBe(100);
    expect(blk.transactions[0]).toMatchObject({
      hash: '0xdef', from: '0xabcd', to: '0xeeff', value: 10n ** 18n, nonce: 7,
      gasPrice: 1000000000n, transactionIndex: 2,
    });
    expect(blk.transactions[1]).toMatchObject({ to: null, gasPrice: 16n, value: 0n });
  });

  it('getBlocks halves the batch size on a timeout and throws ResizeError', async () => {
    const { a, pool } = setup();
    const err = new Error('timeout');
    err.name = 'AbortError';
    a.on('eth_getBlockByNumber', () => { throw err; });
    await expect(pool.getBlocks([1, 2])).rejects.toBeInstanceOf(ResizeError);
    expect(pool.size('blockBatch')).toBe(5);
  });

  it('decodes a transaction without nonce or value as 0', async () => {
    const { a, pool } = setup();
    a.on('eth_getBlockByNumber', () => ({
      ...rawBlock(5),
      transactions: [{ hash: '0x01', from: '0x02', to: null, input: '0x', transactionIndex: '0x0' }],
    }));
    const [blk] = await pool.getBlocks([5]);
    expect(blk.transactions[0]).toMatchObject({ nonce: 0, value: 0n, gasPrice: 0n });
  });
});

describe('RpcPool: unsupported methods', () => {
  it('moves to the next RPC on an unsupported method, without retries', async () => {
    const { a, b, pool, sleeps } = setup();
    a.on('eth_call', () => { throw new RpcError('the method eth_call does not exist/is not available', -32601); });
    b.on('eth_call', () => '0x01');
    expect(await pool.ethCall('0xTo', '0xdata', 5)).toBe('0x01');
    expect(a.calls.length).toBe(1);
    expect(b.calls.length).toBe(1);
    expect(sleeps).toEqual([]);
  });

  it('throws the original error once every RPC refused the method', async () => {
    const { a, b, pool } = setup();
    a.on('eth_call', () => { throw new RpcError('method not found', -32601); });
    b.on('eth_call', () => { throw new RpcError('eth_call is not supported', -32601); });
    const err = await pool.ethCall('0xTo', '0xdata', 5).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RpcError);
    expect((err as RpcError).message).toBe('method not found');
    expect(a.calls.length).toBe(1);
    expect(b.calls.length).toBe(1);
  });

  it('keeps the receipts fallback inside getBlockLogs on the same RPC', async () => {
    const { a, b, pool } = setup();
    a.on('eth_getBlockReceipts', () => { throw new RpcError('method not found', -32601); });
    a.on('eth_getLogs', () => []);
    expect(await pool.getBlockLogs(5)).toEqual([]);
    expect(b.calls.length).toBe(0);
  });
});

describe('RpcPool: hung endpoint', () => {
  const timeout = () => { const e = new Error('The operation was aborted due to timeout'); e.name = 'AbortError'; return e; };

  it('a second timeout in a row on the same RPC fails over instead of halving again', async () => {
    const { a, b, pool } = setup();
    a.on('eth_getLogs', () => { throw timeout(); });
    b.on('eth_getLogs', () => []);
    await expect(pool.getLogs(filter)).rejects.toBeInstanceOf(ResizeError);
    expect(pool.size('logRange')).toBe(250);
    expect(await pool.getLogs(filter)).toEqual([]);
    expect(a.calls.length).toBe(2);
    expect(b.calls.length).toBe(1);
    expect(pool.size('logRange')).toBe(625); // b's own size, grown after its success
  });

  it('two timeouts in a row on an unsized call skip the rest of the ladder', async () => {
    const { a, b, pool, sleeps } = setup();
    a.on('eth_blockNumber', () => { throw timeout(); });
    b.on('eth_blockNumber', () => '0x2');
    expect(await pool.getBlockNumber()).toBe(2);
    expect(a.calls.length).toBe(2);
    expect(sleeps).toEqual([100]);
  });

  it('a success in between resets the count', async () => {
    const { a, b, pool } = setup();
    let n = 0;
    a.on('eth_getLogs', () => { if (n++ % 2 === 0) throw timeout(); return []; });
    b.on('eth_getLogs', () => []);
    await expect(pool.getLogs(filter)).rejects.toBeInstanceOf(ResizeError);
    await pool.getLogs(filter);
    await expect(pool.getLogs(filter)).rejects.toBeInstanceOf(ResizeError);
    expect(b.calls.length).toBe(0);
  });

  it('with a single RPC it keeps halving (there is nowhere to fail over to)', async () => {
    const a = new FakeTransport('a');
    const pool = new RpcPool([a], {
      retryDelays: [100], logRange: { start: 500, min: 1, max: 2000 }, blockBatch: { start: 10, min: 1, max: 100 },
      sleep: async () => {},
    });
    a.on('eth_getLogs', () => { throw timeout(); });
    await expect(pool.getLogs(filter)).rejects.toBeInstanceOf(ResizeError);
    await expect(pool.getLogs(filter)).rejects.toBeInstanceOf(ResizeError);
    expect(pool.size('logRange')).toBe(125);
  });
});

describe('RpcPool: --debug output', () => {
  afterEach(() => {
    setDebug(false);
    vi.restoreAllMocks();
  });

  const debugLines = () => vi.mocked(console.log).mock.calls.map((c) => String(c[0])).filter((m) => m.includes('[DEBUG]'));

  it('logs retry, failover, resize and the rate-limit gap with the RPC URL and the error kind', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    setDebug(true);
    const { a, b, pool } = setup();
    let n = 0;
    a.on('eth_blockNumber', () => { throw new RpcError('down', undefined, 503); });
    b.on('eth_blockNumber', () => '0x1');
    a.on('eth_getLogs', () => { if (n++ === 0) throw new RpcError('Too Many Requests', undefined, 429); return []; });
    await expect(pool.getLogs(filter)).rejects.toBeInstanceOf(ResizeError);
    await pool.getBlockNumber();
    const lines = debugLines();
    expect(lines.some((m) => /rate-limit gap/.test(m) && m.includes('rpc a:') && m.includes('100 ms'))).toBe(true);
    expect(lines.some((m) => /resize/.test(m) && m.includes('rpc a:') && m.includes('rateLimit') && m.includes('logRange 250'))).toBe(true);
    expect(lines.some((m) => /retry/.test(m) && m.includes('rpc a:') && m.includes('network'))).toBe(true);
    expect(lines.some((m) => /failover/.test(m) && m.includes('a -> b') && m.includes('network'))).toBe(true);
  });

  it('prints nothing without --debug', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { a, b, pool } = setup();
    a.on('eth_blockNumber', () => { throw new RpcError('down', undefined, 503); });
    b.on('eth_blockNumber', () => '0x1');
    await pool.getBlockNumber();
    expect(vi.mocked(console.log)).not.toHaveBeenCalled();
  });
});
