# Configuration

A project is configured by three JSON files, one TypeScript file and a few environment
variables. `schema.json` is covered in [Schema and entities](schema-and-entities.md).

## chains.json

Keyed by chain id. Every field except `name` and `rpc` is optional; the values below are
the defaults.

```json
{
  "1329": {
    "name": "sei",
    "rpc": ["https://rpc-a", "https://rpc-b"],
    "confirmations": 0,
    "retryDelays": [100, 500, 2500],
    "logRange": { "start": 500, "min": 1, "max": 2000 },
    "blockBatch": { "start": 10, "min": 1, "max": 100 },
    "headThreshold": 64,
    "useBloom": true,
    "pollInterval": 1000
  }
}
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

## addresses.json

Keyed by chain id, then by contract name from `indexer.config.ts`. `block` is the first
block from which the entry reacts to logs. `address` is one address or a list.

```json
{
  "1329": {
    "Factory": { "address": "0x0000000000000000000000000000000000000001", "block": 1200000 },
    "Erc20":   { "address": ["0x0000000000000000000000000000000000000002",
                             "0x0000000000000000000000000000000000000003"], "block": 1250000 }
  }
}
```

- The names are checked both ways at startup: an unknown name, or a contract without an
  entry for the started chain, is a fatal error.
- Addresses are lowercased.
- An address can belong to only one contract.
- Scanning starts at the lowest `block` of all entries.
- Only `index` reads this file; `process` does not.

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

## Environment

Read from the process environment, from `.env` in the working directory and from `.env`
under `--root`.

| Variable | Meaning |
|---|---|
| `MONGO_URI` | MongoDB connection string. Required for `index`, `process`, `set-revision`, `reset` |
| `MONGO_DB` | Database name. Required for the same commands |
| `PORT` | Status server port, default `3000`. `index` and `process` on one machine need different values |
| `CHAIN_ID` | Default for `--chain` (not used by `reset`) |
