import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from 'fs';
import { join, relative } from 'path';
import { runCodegen } from '../../src/codegen';
import { emitEntity } from '../../src/codegen/entities';
import { parseSchema } from '../../src/codegen/schema';

const TMP = join(__dirname, '..', '.tmp', `codegen-${process.pid}`);
const ABIS = join(__dirname, '..', 'fixture', 'abis');
const SRC_INDEX = join(__dirname, '..', '..', 'src', 'index');
afterAll(() => rmSync(TMP, { recursive: true, force: true }));

const schema = {
  Pool: { token: 'ref:Token', reserve: 'bigint', price: 'decimal', createdAt: 'timestamp', tags: 'string[]', note: 'string?', parent: 'ref:Pool?', others: 'ref:Token[]?' },
  Token: { symbol: 'string', decimals: 'int' },
};
const sampleAbi = () => JSON.parse(readFileSync(join(ABIS, 'Sample.json'), 'utf8'));

function setup(name: string, schemaJson: unknown, abis: Record<string, unknown>) {
  const root = join(TMP, name);
  const abiDir = join(root, 'abis');
  mkdirSync(abiDir, { recursive: true });
  const schemaPath = join(root, 'schema.json');
  writeFileSync(schemaPath, JSON.stringify(schemaJson));
  for (const [file, content] of Object.entries(abis)) writeFileSync(join(abiDir, file), JSON.stringify(content));
  return { root, abiDir, schemaPath, outDir: join(root, 'generated') };
}
const runtimeFor = (outDir: string) => relative(join(outDir, 'entities'), SRC_INDEX).replace(/\\/g, '/');

describe('emitEntity', () => {
  it('emits the pinned shape', () => {
    const src = emitEntity('Pool', parseSchema(schema).Pool, 'evm-indexer');
    expect(src).toContain("import { BaseEntity } from 'evm-indexer';");
    expect(src).toContain("import type { FieldSpec, Timestamp, Decimal } from 'evm-indexer';");
    expect(src).not.toContain('decimal.js');
    expect(src).toContain("import { Token } from './Token';");
    expect(src).not.toContain("from './Pool'");
    expect(src).toContain('export class Pool extends BaseEntity');
    expect(src).toContain("static readonly table = 'Pool';");
    expect(src).toContain('static load(id: string): Promise<Pool | null> { return BaseEntity._load(Pool, id); }');
    expect(src).toContain('get reserve(): bigint');
    expect(src).toContain('set price(v: Decimal | string | number)');
    expect(src).toContain('set createdAt(v: Timestamp | Date | number)');
    expect(src).toContain('get note(): string | undefined');
    expect(src).toContain('get tags(): string[]');
    expect(src).toContain('get tokenId(): string');
    expect(src).toContain('getToken(): Promise<Token | null>');
    expect(src).toContain('setToken(t: Token | null): void');
    expect(src).toContain('get otherIds(): string[] | undefined');
    expect(src).toContain('getOthers(): Promise<Token[]>');
    expect(src).toContain('getParent(): Promise<Pool | null>');
  });
});

describe('emitEntity imports', () => {
  it('emits only the imports a file uses', () => {
    const src = emitEntity('Plain', parseSchema({ Plain: { name: 'string' } }).Plain, 'evm-indexer');
    expect(src).not.toContain('Decimal');
    expect(src).not.toContain('Timestamp');
    expect(src).toContain("import type { FieldSpec } from 'evm-indexer';");
  });

  it('imports Decimal from the runtime, never from decimal.js', () => {
    const src = emitEntity('Money', parseSchema({ Money: { amount: 'decimal' } }).Money, 'evm-indexer');
    expect(src).toContain("import type { FieldSpec, Decimal } from 'evm-indexer';");
    expect(src).not.toContain('decimal.js');
  });
});

describe('runCodegen', () => {
  it('handles fields named like base class internals', async () => {
    const p = setup('internals', { Odd: { values: 'string', meta: 'int', spec: 'string?', refCache: 'bigint' } }, { 'Sample.json': sampleAbi() });
    runCodegen({ ...p, runtimeImport: runtimeFor(p.outDir) });
    const mod = await import(join(p.outDir, 'index.ts'));
    const { EntityStore } = await import('../../src/store/entities');
    const { setEntityStore } = await import('../../src/runtime/entity');
    const { startMongo } = await import('../helpers/mongo');
    const mongo = await startMongo();
    setEntityStore(new EntityStore(mongo.db, 1));
    try {
      const o = new mod.Odd('o1');
      o.values = 'v'; o.meta = 3; o.refCache = 9n;
      await o.save();
      const q = await mod.Odd.load('o1');
      expect([q.values, q.meta, q.spec, q.refCache]).toEqual(['v', 3, undefined, 9n]);
    } finally {
      setEntityStore(null);
      await mongo.stop();
    }
  });

  it('generates importable contracts and entities', async () => {
    const p = setup('ok', schema, { 'Sample.json': sampleAbi(), 'Wrapped.json': { abi: sampleAbi() } });
    const { files, warnings } = runCodegen({ ...p, runtimeImport: runtimeFor(p.outDir) });
    expect(Array.isArray(warnings)).toBe(true);
    for (const rel of ['contracts/Sample.ts', 'contracts/Wrapped.ts', 'entities/Pool.ts', 'entities/Token.ts', 'index.ts']) {
      expect(files).toContain(join(p.outDir, rel));
      expect(existsSync(join(p.outDir, rel))).toBe(true);
    }
    const mod = await import(join(p.outDir, 'index.ts'));
    expect(mod.Sample).toBeTypeOf('function');
    expect(mod.Wrapped).toBeTypeOf('function');
    const pool = new mod.Pool('x');
    expect(pool.id).toBe('x');
    pool.tokenId = 't';
    expect(pool.tokenId).toBe('t');
    expect(pool.getToken).toBeTypeOf('function');
    expect(pool.setToken).toBeTypeOf('function');
    expect(pool.getOthers).toBeTypeOf('function');
    expect(mod.Token.table).toBe('Token');
    expect(mod.Pool.fields.reserve).toEqual({ type: 'bigint', array: false, optional: false });
    pool.price = '1.5';
    expect(pool.price.toString()).toBe('1.5');
  });

  it('treats a missing schema file as no entities', () => {
    const p = setup('noschema', {}, { 'Sample.json': sampleAbi() });
    const { files } = runCodegen({ ...p, schemaPath: join(p.root, 'missing.json') });
    expect(files).toEqual([
      join(p.outDir, 'contracts', 'Sample.ts'), join(p.outDir, 'contracts', 'index.ts'),
      join(p.outDir, 'entities', 'index.ts'), join(p.outDir, 'index.ts'),
    ]);
  });

  function writesNothing(p: ReturnType<typeof setup>, msg: RegExp) {
    expect(() => runCodegen({ ...p, runtimeImport: 'evm-indexer' })).toThrow(msg);
    expect(!existsSync(p.outDir) || readdirSync(p.outDir).length === 0).toBe(true);
  }

  it('writes nothing when the schema is invalid', () => {
    writesNothing(setup('badschema', { A: { x: 'nope' } }, { 'Sample.json': sampleAbi() }), /nope/);
  });

  it('writes nothing when a table is named like a type exported by a contract file', () => {
    writesNothing(setup('collide', { SampleEvents: { x: 'string' } }, { 'Sample.json': sampleAbi() }), /SampleEvents.*Sample/);
  });

  it('writes nothing when <Name>Entity collides with a contract or another table', () => {
    writesNothing(
      setup('dbl1', { Sample: { x: 'string' }, SampleEntity: { y: 'string' } }, { 'Sample.json': sampleAbi() }),
      /SampleEntity/,
    );
    writesNothing(
      setup('dbl2', { Sample: { x: 'string' } }, { 'Sample.json': sampleAbi(), 'SampleEntity.json': sampleAbi() }),
      /SampleEntity/,
    );
  });

  it('allows a table named like a contract and exports the entity as <Name>Entity', async () => {
    const p = setup('samename', { Sample: { x: 'string' }, Other: { y: 'int' } }, { 'Sample.json': sampleAbi() });
    const { warnings } = runCodegen({ ...p, runtimeImport: runtimeFor(p.outDir) });
    expect(warnings).toContain('entity Sample is exported from ./generated as SampleEntity (contract Sample has the same name)');
    expect(warnings.filter((w) => w.includes('exported from ./generated as'))).toHaveLength(1);
    const mod = await import(join(p.outDir, 'index.ts'));
    expect(mod.Sample.events).toBeDefined();
    expect(mod.Sample.table).toBeUndefined();
    expect(mod.SampleEntity.table).toBe('Sample');
    expect(mod.Other.table).toBe('Other');
    const entities = await import(join(p.outDir, 'entities', 'index.ts'));
    expect(entities.Sample.table).toBe('Sample');
    expect(entities.Other.table).toBe('Other');
    const contracts = await import(join(p.outDir, 'contracts', 'index.ts'));
    expect(contracts.Sample.events).toBeDefined();
    // The collection name still follows the table name.
    const { EntityStore } = await import('../../src/store/entities');
    const { setEntityStore } = await import('../../src/runtime/entity');
    const { startMongo } = await import('../helpers/mongo');
    const mongo = await startMongo();
    setEntityStore(new EntityStore(mongo.db, 7));
    try {
      const e = new mod.SampleEntity('s1');
      e.x = 'v';
      await e.save();
      const names = (await mongo.db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name);
      expect(names).toContain('ent_7_Sample');
    } finally {
      setEntityStore(null);
      await mongo.stop();
    }
  });

  it('exports an entity under its own name when no contract shares it', async () => {
    const p = setup('nosame', { Thing: { x: 'string' } }, { 'Sample.json': sampleAbi() });
    const { warnings } = runCodegen({ ...p, runtimeImport: runtimeFor(p.outDir) });
    expect(warnings.filter((w) => w.includes('exported from'))).toEqual([]);
    const mod = await import(join(p.outDir, 'index.ts'));
    expect(mod.Thing.table).toBe('Thing');
    expect(mod.ThingEntity).toBeUndefined();
  });

  it('writes nothing when an ABI file is invalid', () => {
    writesNothing(setup('badabi', schema, { 'Sample.json': sampleAbi(), 'Broken.json': { nope: true } }), /Broken/);
  });
});
