import { describe, it, expect, afterEach } from 'vitest';
import { Interface, AbiCoder, getAddress } from 'ethers';
import abi from '../fixture/abis/Sample.json';
import { decodeLog, serializeArgs, deserializeArgs, EventDef } from '../../src/runtime/events';
import { BaseContract, setRpc } from '../../src/runtime/contract';
import { setContext, clearContext, ContextError, ContextData } from '../../src/runtime/context';
import { Timestamp } from '../../src/runtime/timestamp';
import { RawLog } from '../../src/types';

const iface = new Interface(abi as never);
const ADDR = getAddress('0xabcdef0000000000000000000000000000000001');
const ADDR2 = getAddress('0x00000000000000000000000000000000000000aa');
const coder = AbiCoder.defaultAbiCoder();

function defOf(sig: string): EventDef {
  const f = iface.getEvent(sig)!;
  return { name: f.name, topic0: f.topicHash, signature: f.format('sighash') };
}
function rawLog(topics: string[], data: string): RawLog {
  return { address: ADDR.toLowerCase(), topics, data, blockNumber: 1, transactionIndex: 0, logIndex: 0, transactionHash: '0x' + '11'.repeat(32) };
}
function ctxAtBlock(n: number): ContextData {
  return {
    mode: 'index', chain: { id: 1, name: 'x' },
    block: { number: n, hash: '0x0', timestamp: Timestamp.from(0) },
    tx: { hash: '0x0', transactionIndex: 0, logIndex: 0, from: '0x0', to: null, value: 0n, nonce: 0, gasPrice: 0n, input: '0x' },
  };
}
class TestSample extends BaseContract {
  constructor(a: string) { super(a, abi as unknown[]); }
  balanceOf(o: string) { return this._call('balanceOf(address)', [o]) as Promise<bigint>; }
  info() { return this._call('info()', []); }
  pairs() { return this._call('pairs()', []); }
}

describe('BaseContract', () => {
  it('builds one ethers Interface per ABI, shared by every instance', () => {
    const a = new TestSample(ADDR);
    const b = new TestSample(ADDR2);
    const ifaceOf = (c: BaseContract) => (c as unknown as { _iface: Interface })._iface;
    expect(ifaceOf(a)).toBe(ifaceOf(b));
    class Other extends BaseContract {
      constructor(x: string) { super(x, [...(abi as unknown[])]); }
    }
    expect(ifaceOf(new Other(ADDR))).not.toBe(ifaceOf(a));
  });
});

describe('decodeLog', () => {
  it('decodes tuple arrays and round-trips through serialization', () => {
    const batch = iface.getEvent('Batch')!;
    const data = coder.encode(['tuple(uint256 id, uint256[] amounts)[]'], [[[1n, [2n, 3n]]]]);
    const args = decodeLog(iface, defOf('Batch((uint256,uint256[])[])'), rawLog([batch.topicHash], data));
    expect(args).toEqual({ items: [{ id: 1n, amounts: [2n, 3n] }] });
    expect(deserializeArgs(JSON.parse(JSON.stringify(serializeArgs(args))))).toEqual(args);
    expect(JSON.stringify(serializeArgs(args))).toContain('{"__bigint":"1"}');
  });

  it('lowercases indexed addresses and picks the right overload', () => {
    const t0 = iface.getEvent('Transfer(address,address,uint256)')!;
    const topic = (a: string) => '0x' + getAddress(a).slice(2).toLowerCase().padStart(64, '0');
    const log = rawLog([t0.topicHash, topic(ADDR), topic(ADDR2)], coder.encode(['uint256'], [7n]));
    const args = decodeLog(iface, defOf('Transfer(address,address,uint256)'), log);
    expect(args).toEqual({ from: ADDR.toLowerCase(), to: ADDR2.toLowerCase(), value: 7n });
    const t1 = iface.getEvent('Transfer(address,uint256)')!;
    const log1 = rawLog([t1.topicHash, topic(ADDR)], coder.encode(['uint256'], [9n]));
    expect(decodeLog(iface, defOf('Transfer(address,uint256)'), log1)).toEqual({ from: ADDR.toLowerCase(), value: 9n });
  });

  it('keys unnamed args _0, _1 and returns indexed dynamic args as topic hash', () => {
    const i2 = new Interface(['event E(string indexed, uint256)']);
    const f = i2.getEvent('E')!;
    const hash = '0x' + 'ab'.repeat(32);
    const args = decodeLog(i2, { name: 'E', topic0: f.topicHash, signature: f.format('sighash') },
      rawLog([f.topicHash, hash], coder.encode(['uint256'], [4n])));
    expect(args).toEqual({ _0: hash, _1: 4n });
  });
});

describe('serializeArgs', () => {
  it('does not confuse plain strings with bigints', () => {
    const args = { s: '123', n: 5n, nested: [{ v: 1n }] };
    expect(deserializeArgs(JSON.parse(JSON.stringify(serializeArgs(args))))).toEqual(args);
  });
});

describe('BaseContract._call', () => {
  afterEach(() => { clearContext(); setRpc(null); });

  it('calls at the context block and decodes the result', async () => {
    let seen: { to: string; bn: number } | undefined;
    setRpc({ ethCall: async (to, _d, bn) => { seen = { to, bn }; return coder.encode(['uint256'], [5n]); } });
    setContext(ctxAtBlock(42));
    expect(await new TestSample(ADDR).balanceOf(ADDR)).toBe(5n);
    expect(seen).toEqual({ to: ADDR.toLowerCase(), bn: 42 });
  });

  it('returns multiple outputs as an object and tuple arrays as plain objects', async () => {
    setContext(ctxAtBlock(1));
    setRpc({ ethCall: async () => coder.encode(['uint256', 'address'], [3n, ADDR]) });
    expect(await new TestSample(ADDR).info()).toEqual({ a: 3n, b: ADDR.toLowerCase() });
    setRpc({ ethCall: async () => coder.encode(['tuple(uint256,address)[]'], [[[1n, ADDR]]]) });
    expect(await new TestSample(ADDR).pairs()).toEqual([{ x: 1n, y: ADDR.toLowerCase() }]);
  });

  it('throws ContextError outside a callback and an error without rpc', async () => {
    setRpc({ ethCall: async () => '0x' });
    await expect(new TestSample(ADDR).balanceOf(ADDR)).rejects.toThrow(ContextError);
    setRpc(null);
    setContext(ctxAtBlock(1));
    await expect(new TestSample(ADDR).balanceOf(ADDR)).rejects.toThrow(/setRpc/);
  });
});
