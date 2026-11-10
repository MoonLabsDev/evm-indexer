import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { defineIndexer, defineTemplate, setTemplateSink } from '../../src/runtime/define';
import { setContext, clearContext, type ContextData } from '../../src/runtime/context';
import { loadIndexerConfig } from '../../src/config/indexerConfig';
import { ConfigError } from '../../src/config/chains';
import { Timestamp } from '../../src/runtime/timestamp';
import { FakeFactory, FakePool } from '../helpers/fakeContracts';

const ADDR = '0xabcdef0000000000000000000000000000000001';

const ctx: ContextData = {
  mode: 'index',
  chain: { id: 1, name: 'test' },
  block: { number: 1, hash: '0x00', timestamp: undefined as unknown as Timestamp },
  tx: {
    hash: '0x00', transactionIndex: 0, logIndex: 0, from: ADDR, to: null,
    value: 0n, nonce: 0, gasPrice: 0n, input: '0x',
  },
};

afterEach(() => {
  setTemplateSink(null);
  clearContext();
});

describe('defineIndexer', () => {
  const h = async () => {};
  const i = async () => {};
  const p = async () => {};

  it('normalizes event entries and names templates', () => {
    const T = defineTemplate({ contract: FakePool, events: { Swap: h } });
    const cfg = defineIndexer({
      contracts: { Factory: { contract: FakeFactory, events: { Created: { index: i, process: p }, Paused: null, Owner: p } } },
      templates: { PoolT: T },
    });
    expect(cfg.sources.Factory).toMatchObject({ kind: 'contract', name: 'Factory', contract: FakeFactory });
    expect(cfg.sources.Factory.events).toEqual({ Created: { index: i, process: p }, Paused: {}, Owner: { process: p } });
    expect(cfg.sources.PoolT).toMatchObject({ kind: 'template', name: 'PoolT', contract: FakePool });
    expect(cfg.sources.PoolT.events).toEqual({ Swap: { process: h } });
    expect(T.name).toBe('PoolT');
  });

  it('rejects unknown event names', () => {
    expect(() => defineIndexer({ contracts: { X: { contract: FakeFactory, events: { Nope: null } as any } } })).toThrow(/Nope/);
  });

  it('rejects a contract and a template sharing a name', () => {
    const T = defineTemplate({ contract: FakePool, events: { Swap: h } });
    expect(() => defineIndexer({
      contracts: { PoolT: { contract: FakePool, events: { Swap: null } } },
      templates: { PoolT: T },
    })).toThrow(/PoolT/);
  });

  it('rejects a config without any events', () => {
    expect(() => defineIndexer({ contracts: { X: { contract: FakeFactory, events: {} } } })).toThrow(/event/);
  });
});

describe('Template.create', () => {
  it('only works in index callbacks of a registered template', async () => {
    const T = defineTemplate({ contract: FakePool, events: { Swap: null } });
    defineIndexer({ contracts: { F: { contract: FakeFactory, events: { Created: null } } }, templates: { PoolT: T } });
    let seen: [string, string] | null = null;

    await expect(T.create(ADDR)).rejects.toThrow(/index callbacks/); // no sink
    setTemplateSink(async (n, a) => { seen = [n, a]; });
    setContext({ ...ctx, mode: 'process' });
    await expect(T.create(ADDR)).rejects.toThrow(/index callbacks/);

    setContext({ ...ctx, mode: 'index' });
    await expect(T.create('0x1234')).rejects.toThrow(/address/);
    await T.create(ADDR.toUpperCase().replace('0X', '0x'));
    expect(seen).toEqual(['PoolT', ADDR.toLowerCase()]);
  });

  it('throws for a template that is not registered', async () => {
    const T = defineTemplate({ contract: FakePool, events: { Swap: null } });
    setTemplateSink(async () => {});
    setContext(ctx);
    await expect(T.create(ADDR)).rejects.toThrow(/template is not registered/);
  });
});

describe('loadIndexerConfig', () => {
  const dir = join(__dirname, '..', '.tmp', `define-${process.pid}`);
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('loads a TypeScript config into a NormalizedConfig', () => {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'indexer.config.ts');
    writeFileSync(file, [
      "import { defineIndexer } from '../../../src/index';",
      "import { FakeFactory } from '../../helpers/fakeContracts';",
      'export default defineIndexer({ contracts: { F: { contract: FakeFactory, events: { Created: null } } } });',
      '',
    ].join('\n'));
    const cfg = loadIndexerConfig(file);
    expect(Object.keys(cfg.sources)).toEqual(['F']);
    expect(cfg.sources.F.kind).toBe('contract');
    expect(cfg.sources.F.events).toEqual({ Created: {} });
  });

  it('throws a ConfigError naming the path when there is no config export', () => {
    mkdirSync(dir, { recursive: true });
    const file = join(dir, 'empty.config.ts');
    writeFileSync(file, 'export const nothing = 1;\n');
    expect(() => loadIndexerConfig(file)).toThrow(ConfigError);
    expect(() => loadIndexerConfig(file)).toThrow(/empty\.config\.ts/);
  });
});
