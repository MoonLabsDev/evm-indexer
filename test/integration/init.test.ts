import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawnSync } from 'child_process';
import { existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, unlinkSync } from 'fs';
import { join } from 'path';
import { loadChain } from '../../src/config/chains';
import { ROOT } from './fixture';

// The generated demo project must work as a user gets it: init, codegen against the package name,
// then a strict type-check of the result.

const PROJECT = join(ROOT, 'test', '.tmp', 'init-project');
const CLI = join(ROOT, 'dist', 'cli', 'index.js');
const TSC_BIN = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

function run(args: string[]): { status: number | null; output: string } {
  const res = spawnSync(process.execPath, args, { cwd: PROJECT, encoding: 'utf8' });
  return { status: res.status, output: `${res.stdout ?? ''}${res.stderr ?? ''}${res.error ?? ''}` };
}

function removeLink(link: string): void {
  try {
    lstatSync(link);
  } catch {
    return;
  }
  unlinkSync(link); // the junction only, never its target
}

beforeAll(() => {
  const build = spawnSync(process.execPath, [TSC_BIN, '-p', join(ROOT, 'tsconfig.json')], { cwd: ROOT, encoding: 'utf8' });
  if (build.status !== 0) throw new Error(`npm run build (tsc) failed:\n${build.stdout}${build.stderr}`);
  removeLink(join(PROJECT, 'node_modules', 'evm-indexer'));
  rmSync(PROJECT, { recursive: true, force: true });
  mkdirSync(PROJECT, { recursive: true });
});

afterAll(() => {
  removeLink(join(PROJECT, 'node_modules', 'evm-indexer'));
  rmSync(PROJECT, { recursive: true, force: true });
});

describe('evm-indexer init', () => {
  it('writes a project that generates code and type-checks under strict', () => {
    const init = run([CLI, '--root', PROJECT, 'init']);
    expect(init.status, init.output).toBe(0);
    expect(existsSync(join(PROJECT, 'chains.ts'))).toBe(true);

    mkdirSync(join(PROJECT, 'node_modules'), { recursive: true });
    symlinkSync(ROOT, join(PROJECT, 'node_modules', 'evm-indexer'), 'junction');

    const codegen = run([CLI, '--root', PROJECT, 'codegen']);
    expect(codegen.status, codegen.output).toBe(0);
    expect(existsSync(join(PROJECT, 'generated', 'index.ts'))).toBe(true);

    const tsc = run([TSC_BIN, '--noEmit', '-p', join(PROJECT, 'tsconfig.json')]);
    expect(tsc.status, tsc.output).toBe(0);
  });

  it('the generated chains.ts loads', () => {
    expect(loadChain(join(PROJECT, 'chains.ts'), 31337).name).toBe('hardhat');
  });
});
