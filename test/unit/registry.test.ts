import { describe, it, expect } from 'vitest';
import { Registry, RegistryError } from '../../src/indexer/registry';
import type { NormalizedSource } from '../../src/runtime/define';
import type { EventDef } from '../../src/runtime/events';
import type { RawLog } from '../../src/types';

const CREATED_TOPIC = '0x' + 'aa'.repeat(32);
const OTHER_TOPIC = '0x' + 'bb'.repeat(32);
const SWAP_TOPIC = '0x' + 'cc'.repeat(32);
const A = '0x' + 'a1'.repeat(20);
const B = '0x' + 'b2'.repeat(20);

function contractOf(events: Record<string, EventDef>): NormalizedSource['contract'] {
  return class { static readonly abi = []; static readonly events = events; static readonly eventTypes = {}; } as unknown as NormalizedSource['contract'];
}

const sources: Record<string, NormalizedSource> = {
  Factory: {
    name: 'Factory', kind: 'contract',
    contract: contractOf({
      Created: { name: 'Created', topic0: CREATED_TOPIC, signature: 'Created(address)' },
      Other: { name: 'Other', topic0: OTHER_TOPIC, signature: 'Other()' },
    }),
    events: { Created: {} },
  },
  Other: {
    name: 'Other', kind: 'contract',
    contract: contractOf({ Created: { name: 'Created', topic0: CREATED_TOPIC, signature: 'Created(address)' } }),
    events: { Created: {} },
  },
  PoolT: {
    name: 'PoolT', kind: 'template',
    contract: contractOf({ Swap: { name: 'Swap', topic0: SWAP_TOPIC, signature: 'Swap()' } }),
    events: { Swap: {} },
  },
};

const log = (address: string, topic0: string | undefined, blockNumber: number, transactionIndex = 0, logIndex = 0): RawLog => ({
  address, topics: topic0 === undefined ? [] : [topic0], data: '0x', blockNumber,
  transactionIndex, logIndex, transactionHash: '0x00',
});

function make(): Registry {
  const r = new Registry(sources);
  r.addStatic([{ source: 'Factory', address: A, block: 100 }]);
  return r;
}

describe('Registry', () => {
  it('matches address, configured topic0 and block', () => {
    const r = make();
    expect(r.match(log(A, CREATED_TOPIC, 99))).toBeNull();
    const m = r.match(log(A, CREATED_TOPIC, 100))!;
    expect(m.eventName).toBe('Created');
    expect(m.source).toBe(sources.Factory);
    expect(m.def.topic0).toBe(CREATED_TOPIC);
    expect(r.match(log(A, OTHER_TOPIC, 100))).toBeNull(); // event not configured
    expect(r.match(log(B, CREATED_TOPIC, 100))).toBeNull();
    expect(r.match(log(A, undefined, 100))).toBeNull();
  });

  it('compares addresses and topics case-insensitively', () => {
    const r = new Registry(sources);
    r.addStatic([{ source: 'Factory', address: A.toUpperCase().replace('0X', '0x'), block: 1 }]);
    expect(r.match(log(A, CREATED_TOPIC.toUpperCase().replace('0X', '0x'), 1))).not.toBeNull();
    expect(r.match(log(A.toUpperCase().replace('0X', '0x'), CREATED_TOPIC, 1))).not.toBeNull();
    expect(r.addresses()).toEqual([A]);
  });

  it('adds dynamic addresses and reports exists / conflict', () => {
    const r = make();
    expect(r.add('PoolT', B, 150)).toBe('added');
    expect(r.add('PoolT', B, 150)).toBe('exists');
    expect(r.add('PoolT', B, 10)).toBe('exists');
    expect(r.match(log(B, SWAP_TOPIC, 149))).toBeNull(); // kept the first block
    expect(r.match(log(B, SWAP_TOPIC, 150))!.eventName).toBe('Swap');
    expect(r.add('PoolT', A, 150)).toBe('conflict');
    expect(r.add('Factory', B, 150)).toBe('conflict');
    expect(r.size()).toBe(2);
  });

  it('a dynamic address with a creating position only matches logs after it in the creating block', () => {
    const r = make();
    expect(r.add('PoolT', B, 150, { txIndex: 2, logIndex: 3 })).toBe('added');
    expect(r.match(log(B, SWAP_TOPIC, 150, 1, 9))).toBeNull(); // earlier tx
    expect(r.match(log(B, SWAP_TOPIC, 150, 2, 2))).toBeNull(); // same tx, earlier log
    expect(r.match(log(B, SWAP_TOPIC, 150, 2, 3))).toBeNull(); // the creating position itself
    expect(r.match(log(B, SWAP_TOPIC, 150, 2, 4))).not.toBeNull();
    expect(r.match(log(B, SWAP_TOPIC, 150, 3, 0))).not.toBeNull();
    expect(r.match(log(B, SWAP_TOPIC, 151, 0, 0))).not.toBeNull(); // later blocks: any position
    expect(r.match(log(B, SWAP_TOPIC, 149, 9, 9))).toBeNull();
    // a static entry has no position: every log of its start block matches
    expect(r.match(log(A, CREATED_TOPIC, 100, 0, 0))).not.toBeNull();
  });

  it('removes an address', () => {
    const r = make();
    r.add('PoolT', B, 150);
    r.remove(B.toUpperCase().replace('0X', '0x'));
    expect(r.match(log(B, SWAP_TOPIC, 150))).toBeNull();
    expect(r.size()).toBe(1);
    expect(r.add('PoolT', B, 150)).toBe('added');
  });

  it('throws RegistryError for unknown sources and cross-source static addresses', () => {
    const r = make();
    expect(() => r.add('Nope', B, 1)).toThrow(RegistryError);
    expect(() => r.addStatic([{ source: 'Nope', address: B, block: 1 }])).toThrow(RegistryError);
    expect(() => r.addStatic([{ source: 'Other', address: A, block: 1 }])).toThrow(RegistryError);
  });

  it('treats a repeated static entry of the same source as a no-op keeping the lower block', () => {
    const r = make();
    r.addStatic([{ source: 'Factory', address: A, block: 150 }]);
    expect(r.minBlock()).toBe(100);
    expect(r.match(log(A, CREATED_TOPIC, 100))).not.toBeNull();
    r.addStatic([{ source: 'Factory', address: A, block: 50 }]);
    expect(r.minBlock()).toBe(50);
    expect(r.size()).toBe(1);
  });

  it('reports addresses, topics, minBlock and size', () => {
    const r = make();
    expect(r.minBlock()).toBe(100);
    r.add('PoolT', B, 150);
    expect(r.addresses().sort()).toEqual([A, B].sort());
    expect(r.topics().sort()).toEqual([CREATED_TOPIC, SWAP_TOPIC].sort());
    expect(r.topicsOf(A)).toEqual([CREATED_TOPIC]);
    expect(r.topicsOf(B)).toEqual([SWAP_TOPIC]);
    expect(r.topicsOf('0x' + 'ff'.repeat(20))).toEqual([]);
    expect(r.size()).toBe(2);
    const empty = new Registry(sources);
    expect(empty.minBlock()).toBeNull();
    expect(empty.size()).toBe(0);
    expect(empty.topics()).toEqual([]);
  });
});
