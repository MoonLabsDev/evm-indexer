import { describe, it, expect, afterAll } from 'vitest';
import { Interface } from 'ethers';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import abi from '../fixture/abis/Sample.json';
import { analyzeAbi } from '../../src/codegen/abi';
import { emitContract } from '../../src/codegen/contracts';

const TMP_DIR = join(__dirname, '..', '.tmp', `abi-${process.pid}`);
afterAll(() => rmSync(TMP_DIR, { recursive: true, force: true }));

describe('analyzeAbi', () => {
  const a = analyzeAbi('Sample', abi);

  it('skips non view/pure functions and suffixes overloads by selector', () => {
    expect(a.functions.map((f) => f.name)).not.toContain('transfer');
    const gets = a.functions.filter((f) => f.name.startsWith('get_'));
    expect(gets.map((f) => f.name)).toEqual(['get_0', 'get_1']);
    expect(gets[0].selector < gets[1].selector).toBe(true);
    expect(a.functions.find((f) => f.name === 'balanceOf')!.outputs[0].tsType).toBe('bigint');
  });

  it('suffixes shared event names and warns on anonymous events', () => {
    expect(a.events.map((e) => e.name).sort()).toEqual(['Batch', 'Transfer_0', 'Transfer_1']);
    const t = a.events.filter((e) => e.name.startsWith('Transfer_'));
    expect(t[0].topic0 < t[1].topic0).toBe(true);
    expect(a.warnings.some((w) => /anonymous/i.test(w))).toBe(true);
  });

  it('rejects invalid contract and member names', () => {
    expect(() => analyzeAbi('my-token', abi)).toThrow(/my-token/);
    const bad = [{ type: 'function', name: 'bad-name', stateMutability: 'view', inputs: [], outputs: [] }];
    expect(() => analyzeAbi('X', bad)).toThrow(/bad-name/);
  });

  it('renames functions colliding with BaseContract members', () => {
    const c = [{ type: 'function', name: 'address', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'address' }] }];
    expect(analyzeAbi('X', c).functions[0].name).toBe('address_fn');
  });

  it('types indexed dynamic event args as string', () => {
    const e = [{ type: 'event', name: 'E', anonymous: false, inputs: [
      { name: 'k', type: 'string', indexed: true }, { name: '', type: 'uint8', indexed: false }] }];
    const r = analyzeAbi('X', e).events[0];
    expect(r.inputs).toEqual([{ name: 'k', tsType: 'string' }, { name: '_1', tsType: 'bigint' }]);
  });
});

describe('emitContract', () => {
  it('emits the pinned shape', () => {
    const src = emitContract('Sample', abi, 'evm-indexer');
    expect(src).toContain('export class Sample extends BaseContract');
    expect(src).toContain('balanceOf(owner: string): Promise<bigint>');
    expect(src).toContain('info(): Promise<{ a: bigint; b: string }>');
    expect(src).toContain('pairs(): Promise<{ x: bigint; y: string }[]>');
    expect(src).not.toMatch(/\btransfer\(/);
  });

  it('emits valid, importable TypeScript', async () => {
    const dir = TMP_DIR;
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'Sample.ts');
    writeFileSync(file, emitContract('Sample', abi, '../../../src/index'));
    const mod = await import(file);
    const iface = new Interface(abi as never);
    const ADDR = '0xAbCdEf0000000000000000000000000000000001';
    expect(mod.Sample.events.Batch.topic0).toBe(iface.getEvent('Batch')!.topicHash);
    expect(mod.Sample.events.Transfer_0.signature).toMatch(/^Transfer\(/);
    expect(new mod.Sample(ADDR).address).toBe(ADDR.toLowerCase());
  });
});
