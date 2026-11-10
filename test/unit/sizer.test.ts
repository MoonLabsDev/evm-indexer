import { describe, it, expect } from 'vitest';
import { AdaptiveSize, RateGap } from '../../src/rpc/sizer';

describe('AdaptiveSize', () => {
  it('grows by 25% (capped), holds when slow or many logs, halves on huge results', () => {
    const s = new AdaptiveSize({ start: 100, min: 1, max: 150 });
    s.onSuccess(500, 10);
    expect(s.value).toBe(125);
    s.onSuccess(500, 10);
    expect(s.value).toBe(150);
    s.onSuccess(3000, 10);
    expect(s.value).toBe(150);
    s.onSuccess(500, 5000);
    expect(s.value).toBe(150);
    s.onSuccess(500, 10001);
    expect(s.value).toBe(75);
  });

  it('halve() reports false at min', () => {
    const m = new AdaptiveSize({ start: 1, min: 1, max: 10 });
    expect(m.halve()).toBe(false);
    const n = new AdaptiveSize({ start: 3, min: 2, max: 10 });
    expect(n.halve()).toBe(true);
    expect(n.value).toBe(2);
    expect(n.halve()).toBe(false);
  });
});

describe('RateGap', () => {
  it('starts at 0, 100 ms after the first 429, doubles, halves after 20 successes', () => {
    const g = new RateGap();
    expect(g.ms).toBe(0);
    g.on429();
    expect(g.ms).toBe(100);
    g.on429();
    expect(g.ms).toBe(200);
    for (let i = 0; i < 20; i++) g.onSuccess();
    expect(g.ms).toBe(100);
  });
});
