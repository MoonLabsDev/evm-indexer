import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseChains, loadChain, ConfigError } from '../../src/config/chains';
import { parseAddresses, loadAddresses } from '../../src/config/addresses';

const A = '0x' + 'Ab'.repeat(20);
const B = A.replace('Ab', 'Cd');
const C = '0x' + '11'.repeat(20);

describe('parseChains', () => {
  it('applies defaults', () => {
    const c = parseChains({ '1329': { name: 'sei', rpc: ['http://a'] } })['1329'];
    expect(c).toMatchObject({
      chainId: 1329, confirmations: 0, retryDelays: [100, 500, 2500],
      logRange: { start: 500, min: 1, max: 2000 }, blockBatch: { start: 10, min: 1, max: 100 },
      headThreshold: 64, useBloom: true, pollInterval: 1000,
    });
  });
  it('rejects invalid input', () => {
    expect(() => parseChains({ '1': { name: 'x', rpc: [] } })).toThrow(/rpc/);
    expect(() => parseChains({ abc: { name: 'x', rpc: ['u'] } })).toThrow(/chain id/i);
    expect(() => parseChains({ '1': { name: 'x', rpc: ['u'], logRange: { start: 5, min: 10, max: 2 } } })).toThrow(/logRange/);
    expect(() => parseChains(null)).toThrow(ConfigError);
  });
});

describe('parseAddresses', () => {
  it('expands and lowercases addresses', () => {
    expect(parseAddresses({ '1': { Factory: { address: A, block: 5 }, Token: { address: [B, C], block: 7 } } }, 1, ['Factory', 'Token']))
      .toEqual([
        { source: 'Factory', address: A.toLowerCase(), block: 5 },
        { source: 'Token', address: B.toLowerCase(), block: 7 },
        { source: 'Token', address: C, block: 7 },
      ]);
  });
  it('rejects invalid input', () => {
    expect(() => parseAddresses({ '1': { Nope: { address: A, block: 1 } } }, 1, ['Factory'])).toThrow(/Nope/);
    expect(() => parseAddresses({ '1': {} }, 1, ['Factory'])).toThrow(/Factory/);
    expect(() => parseAddresses({ '2': {} }, 1, [])).toThrow(/chain 1/);
    expect(() => parseAddresses({ '1': { Factory: { address: '0x12', block: 1 } } }, 1, ['Factory'])).toThrow(/address/);
    expect(() => parseAddresses({ '1': { Factory: { address: A } } }, 1, ['Factory'])).toThrow(/block/);
  });
});

describe('file loaders', () => {
  const dir = mkdtempSync(join(tmpdir(), 'evm-cfg-'));
  it('loads chain and addresses from files', () => {
    const cp = join(dir, 'chains.json');
    writeFileSync(cp, JSON.stringify({ '1': { name: 'eth', rpc: ['http://a'] } }));
    expect(loadChain(cp, 1).name).toBe('eth');
    expect(() => loadChain(cp, 2)).toThrow(ConfigError);
    const ap = join(dir, 'addresses.json');
    writeFileSync(ap, JSON.stringify({ '1': { Factory: { address: A, block: 5 } } }));
    expect(loadAddresses(ap, 1, ['Factory'])).toHaveLength(1);
  });
  it('throws ConfigError naming the path for missing or invalid files', () => {
    const missing = join(dir, 'nope.json');
    expect(() => loadChain(missing, 1)).toThrow(ConfigError);
    expect(() => loadChain(missing, 1)).toThrow(/nope\.json/);
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, '{not json');
    expect(() => loadAddresses(bad, 1, [])).toThrow(/bad\.json/);
  });
});
