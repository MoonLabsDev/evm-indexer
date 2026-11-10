import { describe, it, expectTypeOf } from 'vitest';
import { defineIndexer, defineTemplate } from '../../src/runtime/define';
import type { IndexedEvent } from '../../src/types';
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
