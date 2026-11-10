import { describe, it, expect } from 'vitest';
import { makeBloom } from '../helpers/bloom';
import { blockMayMatch, bloomMayContain } from '../../src/indexer/bloom';

const ADDR = '0x' + 'a1'.repeat(20);
const OTHER_ADDR = '0x' + 'b2'.repeat(20);
const TOPIC = '0x' + 'cc'.repeat(32);
const OTHER_TOPIC = '0x' + 'dd'.repeat(32);

describe('bloom', () => {
  const bloom = makeBloom([ADDR, TOPIC]);

  it('contains the values it was built from', () => {
    expect(bloomMayContain(bloom, ADDR)).toBe(true);
    expect(bloomMayContain(bloom, TOPIC)).toBe(true);
  });

  it('does not contain unrelated values', () => {
    expect(bloomMayContain(bloom, OTHER_ADDR)).toBe(false);
    expect(bloomMayContain(bloom, OTHER_TOPIC)).toBe(false);
  });

  it('is case-insensitive on the value', () => {
    expect(bloomMayContain(bloom, ADDR.toUpperCase().replace('0X', '0x'))).toBe(true);
  });

  it('an all-zero bloom contains nothing', () => {
    expect(bloomMayContain('0x' + '00'.repeat(256), ADDR)).toBe(false);
  });

  it('blockMayMatch needs any address AND any topic', () => {
    expect(blockMayMatch(bloom, [OTHER_ADDR, ADDR], [OTHER_TOPIC, TOPIC])).toBe(true);
    expect(blockMayMatch(bloom, [ADDR], [OTHER_TOPIC])).toBe(false);
    expect(blockMayMatch(bloom, [OTHER_ADDR], [TOPIC])).toBe(false);
  });

  it('blockMayMatch is false for empty lists', () => {
    expect(blockMayMatch(bloom, [], [TOPIC])).toBe(false);
    expect(blockMayMatch(bloom, [ADDR], [])).toBe(false);
  });
});
