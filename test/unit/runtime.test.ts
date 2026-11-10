import { describe, it, expect, afterEach } from 'vitest';
import { Timestamp } from '../../src/runtime/timestamp';
import {
  ContextError, ContextData, setContext, clearContext, currentContext, tx, block, chain,
} from '../../src/runtime/context';

const sample: ContextData = {
  mode: 'index',
  chain: { id: 1329, name: 'sei' },
  block: { number: 100, hash: '0xblock', timestamp: Timestamp.from(1731234567) },
  tx: {
    hash: '0xtx', transactionIndex: 2, logIndex: 5, from: '0xfrom', to: null,
    value: 10n, nonce: 7, gasPrice: 1000n, input: '0x',
  },
};

afterEach(() => clearContext());

describe('Timestamp', () => {
  it('converts between unix, ms, date and iso', () => {
    const t = Timestamp.from(1731234567);
    expect([t.unix, t.ms, t.iso]).toEqual([1731234567, 1731234567000, '2024-11-10T10:29:27.000Z']);
    expect(t.date.getTime()).toBe(1731234567000);
    expect(t.date).not.toBe(t.date);
  });
  it('accepts Date and Timestamp', () => {
    const t = Timestamp.from(1731234567);
    expect(Timestamp.from(new Date(1731234567999)).unix).toBe(1731234567);
    expect(Timestamp.from(t)).toBe(t);
  });
  it('throws on non-finite input', () => {
    expect(() => Timestamp.from(NaN)).toThrow();
    expect(() => Timestamp.from(Infinity)).toThrow();
    expect(() => Timestamp.from(new Date('x'))).toThrow();
  });
  it('is immutable', () => {
    expect(Object.isFrozen(Timestamp.from(1))).toBe(true);
  });
});

describe('context', () => {
  it('throws outside a callback', () => {
    expect(currentContext()).toBeNull();
    expect(() => tx()).toThrow(ContextError);
    expect(() => chain()).toThrow(ContextError);
  });
  it('exposes the set context and clears it', () => {
    setContext(sample);
    expect(tx().hash).toBe(sample.tx.hash);
    expect(chain().name).toBe('sei');
    expect(block().number).toBe(100);
    expect(currentContext()).toBe(sample);
    clearContext();
    expect(() => block()).toThrow(ContextError);
  });
});
