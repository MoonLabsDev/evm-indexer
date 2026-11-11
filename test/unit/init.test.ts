import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { cmdInit } from '../../src/cli/init';
import { buildProgram } from '../../src/cli';

const TMP = resolve(__dirname, '..', '.tmp');
const TARGETS = [
  '.env.example', 'abis/Factory.json', 'abis/Pool.json', 'abis/Token.json', 'addresses.ts', 'chains.ts',
  'indexer.config.ts', 'schema.ts', 'src/handlers.ts', 'tsconfig.json',
];

let root: string;
beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
  root = mkdtempSync(join(TMP, 'init-'));
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('cmdInit', () => {
  it('writes the ten files into an empty directory', () => {
    const res = cmdInit(root, { force: false });
    expect([...res.written].sort()).toEqual(TARGETS);
    expect(res.skipped).toEqual([]);
    for (const f of TARGETS) {
      expect(existsSync(join(root, f)), f).toBe(true);
      expect(statSync(join(root, f)).size, f).toBeGreaterThan(0);
    }
  });

  function populate(): void {
    writeFileSync(join(root, 'chains.ts'), '// mine');
    mkdirSync(join(root, 'abis'));
    writeFileSync(join(root, 'abis', 'Other.json'), '[]');
    writeFileSync(join(root, 'tsconfig.json'), '{}');
  }

  it('skips existing files and leaves other files alone', () => {
    populate();
    const res = cmdInit(root, { force: false });
    expect([...res.skipped].sort()).toEqual(['chains.ts', 'tsconfig.json']);
    expect(res.written).toHaveLength(8);
    expect(readFileSync(join(root, 'chains.ts'), 'utf8')).toBe('// mine');
    expect(readFileSync(join(root, 'abis', 'Other.json'), 'utf8')).toBe('[]');
    expect(readFileSync(join(root, 'tsconfig.json'), 'utf8')).toBe('{}');
  });

  it('a second run writes nothing and skips all ten', () => {
    cmdInit(root, { force: false });
    const res = cmdInit(root, { force: false });
    expect(res.written).toEqual([]);
    expect([...res.skipped].sort()).toEqual(TARGETS);
  });

  it('--force replaces files but never tsconfig.json', () => {
    populate();
    const res = cmdInit(root, { force: true });
    expect(readFileSync(join(root, 'chains.ts'), 'utf8')).toContain('defineChains');
    expect(readFileSync(join(root, 'tsconfig.json'), 'utf8')).toBe('{}');
    expect(res.skipped).toEqual(['tsconfig.json']);
    expect(res.written).toContain('chains.ts');
  });

  it('creates a root that does not exist', () => {
    const nested = join(root, 'a', 'b');
    cmdInit(nested, { force: false });
    expect(existsSync(join(nested, 'chains.ts'))).toBe(true);
  });
});

describe('buildProgram', () => {
  it('has an init command with --force', () => {
    const init = buildProgram().commands.find((c) => c.name() === 'init');
    expect(init).toBeDefined();
    expect(init!.options.map((o) => o.long)).toContain('--force');
  });
});
