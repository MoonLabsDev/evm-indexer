import { describe, it, expect } from 'vitest';
import { formatTimespan, eta } from '../../src/log';

describe('log helpers', () => {
  it('formats a timespan', () => {
    expect(formatTimespan(93784)).toBe('1d 2h 3m 4s');
  });
  it('computes an eta', () => {
    expect(eta(100, 0, 200, 400, 50_000)).toEqual({ seconds: 100, blocksPerSecond: 2 });
    expect(eta(100, 0, 200, 400, 10_000)).toBeNull();
    expect(eta(100, 0, 400, 400, 50_000)).toBeNull();
  });
});
