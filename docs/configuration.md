# Configuration

A project is configured by four TypeScript files in the project root and a few
environment variables. `evm-indexer init` writes all four; see
[Getting started](getting-started.md). `schema.ts` is covered in
[Schema and entities](schema-and-entities.md).

Each file default-exports the result of a helper from `evm-indexer`:

| File | Helper |
|---|---|
| `chains.ts` | `defineChains` |
| `schema.ts` | `defineSchema` |
| `addresses.ts` | `defineAddresses` |
| `indexer.config.ts` | `defineIndexer` |

The helpers type their input, so the editor and the compiler check the files. The CLI
loads the files through `tsx`, which does not type-check. **Run `npx tsc --noEmit`
yourself** to see type errors. The CLI only checks at runtime what it can: see
[Load errors](#load-errors).

## chains.ts

Keyed by chain id. Every field except `name` and `rpc` is optional; the values below are
the defaults.

```ts
import { defineChains } from 'evm-indexer';

export default defineChains({
  1329: {
    name: 'sei',
    rpc: ['https://rpc-a', 'https://rpc-b'],
    confirmations: 0,
    retryDelays: [100, 500, 2500],
    logRange: { start: 500, min: 1, max: 2000 },
    blockBatch: { start: 10, min: 1, max: 100 },
    headThreshold: 64,
    useBloom: true,
    pollInterval: 1000,
  },
});
```

| Field | Meaning |
|---|---|
| `name` | Chain name, exposed as `chain().name` |
| `rpc` | RPC URLs in order of preference (at least one) |
| `confirmations` | The indexer goes up to `head - confirmations`. Use it on chains that reorganise |
| `retryDelays` | Backoff steps in ms on one RPC before switching to the next |
| `logRange` | Bounds for the adaptive `eth_getLogs` block range (backfill) |
| `blockBatch` | Bounds for the adaptive number of blocks per batch request (head mode) |
| `headThreshold` | Within this many blocks of the target the indexer walks blocks (head mode); further behind it uses `eth_getLogs` (backfill) |
| `useBloom` | Head mode skips blocks whose `logsBloom` cannot match. Set `false` on chains with unreliable blooms |
| `pollInterval` | Loop pause in ms when caught up, and after an error |

How these are used is described in [How it works](how-it-works.md#scanning).

The compiler checks that `name` and `rpc` are present and that every other field has the
right type. The chain id is a number key.

## addresses.ts

Keyed by chain id, then by contract name from `indexer.config.ts`. `block` is the first
block from which the entry reacts to logs. `address` is one address or a list.

```ts
import { defineAddresses } from 'evm-indexer';
import config from './indexer.config';

export default defineAddresses(config, {
  1329: {
    Factory: { address: '0x0000000000000000000000000000000000000001', block: 1200000 },
    Erc20: {
      address: ['0x0000000000000000000000000000000000000002',
                '0x0000000000000000000000000000000000000003'],
      block: 1250000,
    },
  },
});
```

`defineAddresses` takes the default export of `indexer.config.ts` as its first argument.
It is used for typing only: the contract names under `contracts` become the allowed keys.

- The compiler rejects a contract name that is not under `contracts`, and a chain entry
  that lacks one of them. Templates cannot be listed; their addresses come from
  `Template.create`.
- The names are also checked at startup: an unknown name, or a contract without an
  entry for the started chain, is a fatal error.
- Addresses are lowercased.
- An address can belong to only one contract.
- Scanning starts at the lowest `block` of all entries.
- Only `index` reads this file; `process` does not.
- `addresses.ts` imports `indexer.config.ts`, which imports `generated/`. Run `codegen`
  first.

## indexer.config.ts

```ts
import { defineIndexer, defineTemplate } from 'evm-indexer';
import { Factory, PoolPair } from './generated';
import { handlePoolCreated, handleOwnerChanged, handleSwap } from './src/handlers';

export const PoolTemplate = defineTemplate({
  contract: PoolPair,
  events: { Swap: handleSwap, Sync: null },
});

export default defineIndexer({
  contracts: {
    Factory: {
      contract: Factory,
      events: {
        PoolCreated: {
          index: (e) => PoolTemplate.create(e.args.pool),
          process: handlePoolCreated,
        },
        OwnerChanged: handleOwnerChanged, // shorthand: process callback only
        Paused: null,                     // indexed, no callback
      },
    },
  },
  templates: { PoolTemplate },
});
```

- **Only listed events are indexed.**
- **An event entry** is `null` (index only), a process callback, or `{ index?, process? }`.
- **Type safety:** event names are checked against the generated class, and each
  callback's parameter is inferred as that event's type. An unknown event name is a
  compile error. Callbacks may be sync or async.
- **Templates** are declared with `defineTemplate` before the indexer config and
  registered under `templates`; the key is the template name. See
  [Callbacks](callbacks.md#templates).
- **Names:** contract and template names share one namespace and must be unique.
- **Overloads:** events and functions that share a name get an index suffix, sorted by
  topic0 / 4-byte selector: `Transfer_0`, `Transfer_1`, `balanceOf_0`. Unique names stay
  plain. Use the suffixed name as the key in `events`.

The two callback kinds:

| | `index` callback | `process` callback |
|---|---|---|
| Runs in | the indexer, when the event is stored | the processor, over stored events |
| May use | `tx()`, `block()`, `chain()`, contract reads, `Template.create` | `tx()`, `block()`, `chain()`, contract reads, entities |
| Changing it needs | `reset --chain` and a re-index | `set-revision` (replay, no re-index) |

## Load errors

The CLI reports these when it loads a config file:

| Message | Cause |
|---|---|
| `cannot read <path>: file not found` | The file does not exist |
| `<path> not found; <name>.json is no longer read: move it to <name>.ts with export default <helper>(...)` | A project from before 0.2 still has `chains.json`, `addresses.json` or `schema.json`. The JSON files are not read; there is no fallback |
| `cannot load <path>: <reason>` | The file threw while loading, for example a syntax error or a failing import |
| `cannot load <path>: <reason> (schema.ts must not import from generated/; it is loaded before generated/ exists)` | The same `cannot load` failure when it comes from `schema.ts` during `codegen`: the suffix is added because `schema.ts` is loaded before `generated/` exists, so it must not import from it |
| `<path> must default-export the result of <helper>()` | The default export is missing or was not built by `defineChains`, `defineSchema` or `defineAddresses` |

A missing `schema.ts` (with no `schema.json` either) is not an error for `codegen`: it
means no entities.

ABIs stay JSON under `abis/`.

## Environment

Read from the process environment, from `.env` in the working directory and from `.env`
under `--root`.

| Variable | Meaning |
|---|---|
| `MONGO_URI` | MongoDB connection string. Required for `index`, `process`, `set-revision`, `reset` |
| `MONGO_DB` | Database name. Required for the same commands |
| `PORT` | Status server port, default `3000`. `index` and `process` on one machine need different values |
| `CHAIN_ID` | Default for `--chain` (not used by `reset`) |
