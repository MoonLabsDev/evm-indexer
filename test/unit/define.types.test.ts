import { describe, it, expectTypeOf } from 'vitest';
import {
  defineIndexer, defineTemplate, defineSchema, defineChains, defineAddresses, type NormalizedConfig,
} from '../../src/runtime/define';
import type { IndexedEvent, AddressEntry } from '../../src/types';
import { FakeFactory, FakePool } from '../helpers/fakeContracts';

// Type-level checks only: these run under `vitest --typecheck` and are never executed.

describe('defineIndexer types', () => {
  it('infers callback parameter types from the contract class', () => {
    defineIndexer({
      contracts: {
        F: {
          contract: FakeFactory,
          events: {
            Created: (e) => { expectTypeOf(e.args.pool).toEqualTypeOf<string>(); },
            Owner: { index: (e) => { expectTypeOf(e.args.owner).toEqualTypeOf<string>(); }, process: async (e) => { expectTypeOf(e).toEqualTypeOf<IndexedEvent<{ owner: string }>>(); } },
            Paused: null,
          },
        },
      },
    });
  });

  it('types templates and lets index callbacks create them', () => {
    const T = defineTemplate({ contract: FakePool, events: { Swap: (e) => { expectTypeOf(e.args.amount).toEqualTypeOf<bigint>(); } } });
    defineIndexer({
      contracts: { F: { contract: FakeFactory, events: { Created: { index: (e) => T.create(e.args.pool) } } } },
      templates: { T },
    });
  });

  it('rejects unknown event names', () => {
    // @ts-expect-error unknown event name
    defineIndexer({ contracts: { F: { contract: FakeFactory, events: { Foo: null } } } });
    // @ts-expect-error unknown event name on a template
    defineTemplate({ contract: FakePool, events: { Created: null } });
  });

  it('rejects wrongly typed callbacks', () => {
    // @ts-expect-error wrong callback parameter type
    defineIndexer({ contracts: { F: { contract: FakeFactory, events: { Created: (e: { nope: 1 }) => {} } } } });
    // @ts-expect-error wrong index callback parameter type
    defineIndexer({ contracts: { F: { contract: FakeFactory, events: { Created: { index: (e: IndexedEvent<{ owner: number }>) => {} } } } } });
  });
});

describe('defineSchema types', () => {
  it('accepts valid field types and refs between tables', () => {
    defineSchema({ A: { b: 'ref:B[]?' }, B: { n: 'int?' } });
  });

  it('rejects unknown field types and unknown ref tables', () => {
    // @ts-expect-error unknown base type
    defineSchema({ A: { x: 'bigintt' } });
    // @ts-expect-error ref to a table that does not exist
    defineSchema({ A: { b: 'ref:B' } });
  });
});

describe('defineChains types', () => {
  it('requires rpc and rejects unknown keys', () => {
    // @ts-expect-error rpc missing
    defineChains({ 1: { name: 'x' } });
    // @ts-expect-error unknown key
    defineChains({ 1: { name: 'x', rpc: [], foo: 1 } });
    defineChains({ 1: { name: 'x', rpc: [], logRange: { max: 5 } } });
  });
});

describe('defineAddresses types', () => {
  const T = defineTemplate({ contract: FakePool, events: { Swap: null } });
  const cfg = defineIndexer({
    contracts: {
      Factory: { contract: FakeFactory, events: { Created: null } },
      Token: { contract: FakeFactory, events: { Paused: null } },
    },
    templates: { PoolTemplate: T },
  });
  const e: AddressEntry = { address: '0x' + '1'.repeat(40), block: 1 };

  it('keeps the contract names on the config type', () => {
    expectTypeOf(cfg).toEqualTypeOf<NormalizedConfig<'Factory' | 'Token'>>();
  });

  it('requires exactly the contracts, no templates and no extras', () => {
    // @ts-expect-error Token missing
    defineAddresses(cfg, { 1: { Factory: e } });
    // @ts-expect-error unknown name
    defineAddresses(cfg, { 1: { Factory: e, Token: e, Other: e } });
    // @ts-expect-error templates have no static address
    defineAddresses(cfg, { 1: { Factory: e, Token: e, PoolTemplate: e } });
    defineAddresses(cfg, { 1: { Factory: e, Token: e } });
  });
});
