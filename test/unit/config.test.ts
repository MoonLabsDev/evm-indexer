import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
  afterAll(() => { rmSync(dir, { recursive: true, force: true }); });
  const indexSrc = JSON.stringify(resolve(__dirname, '../../src/index.ts'));
  const write = (name: string, text: string): string => {
    const p = join(dir, name);
    writeFileSync(p, text);
    return p;
  };
  const chainsFile = (name: string, body = "{ 1: { name: 'eth', rpc: ['http://x'] } }"): string =>
    write(name, `import { defineChains } from ${indexSrc};
export default defineChains(${body});
`);

  it('loads chain and addresses from .ts files', () => {
    const cp = chainsFile('chains.ts');
    expect(loadChain(cp, 1).name).toBe('eth');
    expect(() => loadChain(cp, 2)).toThrow(ConfigError);
    const ap = write(
      'addresses.ts',
      `export default { __evmIndexerConfig: 'addresses', value: { 1: { Factory: { address: ${JSON.stringify(A)}, block: 5 } } } };
`,
    );
    expect(loadAddresses(ap, 1, ['Factory'])).toHaveLength(1);
  });
  it('names the file when it is missing', () => {
    const missing = join(dir, 'nope.ts');
    expect(() => loadChain(missing, 1)).toThrow(ConfigError);
    expect(() => loadChain(missing, 1)).toThrow(/cannot read .*nope\.ts/);
  });
  it('points at the .ts migration when only a .json sibling exists', () => {
    write('x.json', '{}');
    const missing = join(dir, 'x.ts');
    expect(() => loadChain(missing, 1)).toThrow(/x\.json is no longer read/);
    expect(() => loadChain(missing, 1)).toThrow(/defineChains/);
  });
  it('requires the default export to be tagged for its kind', () => {
    const untagged = write('untagged.ts', "export default { 1: { name: 'eth', rpc: ['http://x'] } };\n");
    expect(() => loadChain(untagged, 1)).toThrow(/untagged\.ts.*must default-export the result of defineChains\(\)/);
    const wrong = write('wrong.ts', "export default { __evmIndexerConfig: 'schema', value: {} };\n");
    expect(() => loadChain(wrong, 1)).toThrow(/must default-export the result of defineChains\(\)/);
    expect(() => loadAddresses(wrong, 1, [])).toThrow(/must default-export the result of defineAddresses\(\)/);
  });
  it('wraps load errors and syntax errors with the file name', () => {
    const boom = write('boom.ts', "throw new Error('boom');\n");
    expect(() => loadChain(boom, 1)).toThrow(/cannot load .*boom\.ts: boom/);
    const syntax = write('syntax.ts', 'export default {');
    expect(() => loadChain(syntax, 1)).toThrow(ConfigError);
    expect(() => loadChain(syntax, 1)).toThrow(/syntax\.ts/);
  });
  it('still validates the value inside a correctly tagged file', () => {
    const cp = chainsFile('invalid.ts', "{ 1: { name: 'eth', rpc: [] } }");
    expect(() => loadChain(cp, 1)).toThrow(/rpc must be a non-empty array of URLs/);
  });
});
