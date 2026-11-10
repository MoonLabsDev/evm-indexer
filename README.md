# evm-indexer

A subgraph-like indexer for EVM chains. It walks blocks and stores the raw events of your
contracts in MongoDB (the **indexer**), then runs your typed callbacks over the stored events
and writes entities (the **processor**). Changing callback logic does not need a new scan of
the chain: bump the revision and the processor replays from the stored events.

- Typed contract classes (events and read functions) and entity classes are generated from ABIs and a schema.
- Contract addresses can be added at runtime through templates.
- Events only. No write calls, no reorg rollback (use `confirmations`), no traces, no query API.

## Install

Node 20 or newer and a MongoDB instance.

```bash
npm install evm-indexer
```

`indexer.config.ts` is loaded through `tsx`, so the project needs no build step.

## Project layout

```
abis/*.json            one ABI per contract class; the file name is the class name
chains.json            chain settings
addresses.json         static contract addresses per chain
schema.json            entity tables
indexer.config.ts      contracts, templates, events, callbacks
src/handlers/*.ts      your callbacks
generated/             output of `evm-indexer codegen`, not edited by hand
.env                   MONGO_URI, MONGO_DB, PORT
```

All commands take `--root <dir>` (default: the current directory) and look for
`chains.json`, `addresses.json`, `schema.json`, `abis/`, `generated/` and `indexer.config.ts`
there. An ABI file is a plain ABI array or an artifact object with an `abi` array (hardhat, foundry).

## Configuration

### chains.json

Keyed by chain id. Every field except `name` and `rpc` is optional; the values below are the defaults.

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
| `confirmations` | The indexer goes up to `head - confirmations` |
| `retryDelays` | Backoff steps in ms on one RPC before switching to the next |
| `logRange` | Bounds for the adaptive `eth_getLogs` block range (backfill) |
| `blockBatch` | Bounds for the adaptive number of blocks per batch request (head mode) |
| `headThreshold` | At most this many blocks behind the target: head mode (blocks and receipts); otherwise backfill (`eth_getLogs`) |
| `useBloom` | Head mode skips blocks whose `logsBloom` cannot match. Set `false` on chains with unreliable blooms |
| `pollInterval` | Loop pause in ms when caught up, and after an error |

The RPC pool retries retryable errors (timeouts, 429, network, 5xx), fails over to the next RPC,
and learns a log range and a batch size per RPC (grow when fast, halve on timeouts, 429 and
"too large" errors). No block is ever skipped.

### addresses.json

Keyed by chain id, then by contract name from `indexer.config.ts`. `block` is the first block
from which the entry reacts to logs. `address` is one address or a list.

```json
{
  "1329": {
    "Factory": { "address": "0x0000000000000000000000000000000000000001", "block": 1200000 },
    "Erc20":   { "address": ["0x0000000000000000000000000000000000000002", "0x0000000000000000000000000000000000000003"], "block": 1250000 }
  }
}
```

At startup the names are checked both ways: an unknown name, or a contract without an entry for
the started chain, is fatal. Addresses are lowercased. `process` does not read this file.

### schema.json

Root keys are table names, each maps field names to a type string.

```json
{
  "Pool":  { "token": "ref:Token", "reserve": "bigint", "price": "decimal",
             "createdAt": "timestamp", "tags": "string[]", "note": "string?" },
  "Token": { "symbol": "string", "decimals": "int" }
}
```

| Type | In code | In MongoDB |
|---|---|---|
| `string` | `string` | string |
| `int` | `number` (integer, checked on save) | int / long |
| `float` | `number` | double |
| `bigint` | `bigint` | decimal string (not numerically sortable) |
| `decimal` | `Decimal` (decimal.js); setter also takes string / number | `Decimal128` |
| `boolean` | `boolean` | bool |
| `address` | lowercase `string`, validated | string |
| `bytes` | hex `string`, validated | string |
| `timestamp` | `Timestamp`; setter takes unix seconds, `Date` or `Timestamp` | `Date` |
| `ref:<Table>` | see References | the referenced id (string) |

Modifiers: `[]` for arrays, `?` for optional (`string[]?` is allowed, also on `ref`). A table
cannot have a field named `id` (every entity has a string `id`, stored as `_id`) and a `ref`
must point to an existing table. Table names must not equal contract (ABI file) names: both are exported from `generated/index.ts`.

### indexer.config.ts

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

- Only listed events are indexed. An entry is `null`, a process callback, or `{ index?, process? }`.
- Event names are type-checked against the generated class; callback parameters are inferred. Callbacks may be sync or async.
- Declare templates with `defineTemplate` before the indexer config and register them under `templates`; the key is the template name. `Template.create` on an unregistered template throws.
- Contract and template names share one namespace and must be unique.
- Overloaded events and functions get an index suffix, sorted by topic0 / 4-byte selector: `Transfer_0`, `Transfer_1`, `balanceOf_0`. Unique names stay plain.

## Writing callbacks

Callbacks run one event at a time. The context functions work inside a callback and throw outside one.

```ts
import { tx, block, chain } from 'evm-indexer';
import { Erc20, Pool, type PoolPairSwapEvent } from '../generated';

export async function handleSwap(e: PoolPairSwapEvent) {
  tx().hash; tx().from; tx().to; tx().value; tx().gasPrice; tx().input; // also nonce, transactionIndex, logIndex
  block().number; block().hash; block().timestamp;                      // a Timestamp
  chain().id; chain().name;

  const pool = (await Pool.load(e.address)) ?? new Pool(e.address);
  pool.reserve = (pool.reserve ?? 0n) + e.args.amount0In;
  pool.createdAt = block().timestamp;       // or unix seconds, a Date
  pool.price = '1.2345';                    // Decimal, string or number
  await pool.save();                        // upsert of the whole document
}
```

- **Events**: `e.args`, `e.address`, `e.blockNumber`, `e.txIndex`, `e.logIndex`, `e.txHash`. Solidity `uint*`/`int*` are `bigint`, addresses lowercase strings, tuples typed objects.
- **Contract reads**: every `view`/`pure` function is a method, executed with `eth_call` at the event's block: `await new Erc20(addr).balanceOf(user)`. A single return value comes back directly, several as an object keyed by output name (`_0`, `_1` when unnamed).
- **Entities**: `Entity.load(id)` returns `null` when missing, `new Entity(id)` creates one, `save()` upserts the whole document, `remove()` deletes it. Required fields that were never set make `save()` throw. Collections are `ent_<chainId>_<Table>`.
- **References** (`token: "ref:Token"`):

  ```ts
  pool.tokenId = '0x...';                // sync, no read
  const token = await pool.getToken();   // loads once, then cached; null if missing
  pool.setToken(token);                  // sets id and cache
  ```

  An array reference named `tokens: "ref:Token[]"` gives `tokenIds`, `getTokens()`, `setTokens()` (a trailing `s` of the field name is dropped for the ids property).
- **`Timestamp`**: immutable, `.unix` (seconds), `.ms`, `.date`, `.iso`. Numbers are always unix seconds.
- **`Decimal`**: decimal.js, exported from `evm-indexer`. MongoDB `Decimal128` holds 34 significant digits; `save()` throws on more instead of rounding.
- **Index callbacks** may use `tx()`, `block()`, `chain()` and contract reads, but not entities. Their only side effect is `Template.create(address)`. **Process callbacks** may use everything except `Template.create`.

## Commands

| Command | Effect |
|---|---|
| `evm-indexer codegen` | Generate `generated/contracts/*`, `generated/entities/*` and `generated/index.ts` from `abis/` and `schema.json` |
| `evm-indexer index --chain <id>` | Run the indexer for one chain |
| `evm-indexer process --chain <id>` | Run the processor for one chain |
| `evm-indexer set-revision --chain <id> [--revision <n>]` | Set `currentRevisionId` (default: current + 1) and print it. The processor drops the chain's entities and replays |
| `evm-indexer reset [--chain <id>] [--yes]` | Without `--chain`: drop every `sys_*` and `ent_*` collection. With `--chain`: delete that chain's events, transactions and templates, drop its entities, set its counters to 0. Asks for `yes` unless `--yes` is given |

Global options: `--debug` (per-event and per-RPC-retry log lines) and `--root <dir>`.
`--chain` can come from `CHAIN_ID`; `reset` only reads `--chain`. `index` and `process` refuse to
start while another process of the same kind has a heartbeat younger than 60 s for that chain
(after a crash, wait up to a minute). SIGINT and SIGTERM close the status server and the MongoDB
connection, then exit 0. Fatal errors are printed in red and exit with code 1.

## Environment

Read from the process environment, from `.env` in the working directory and from `.env` under `--root`.

| Variable | Meaning |
|---|---|
| `MONGO_URI` | MongoDB connection string. Required for `index`, `process`, `set-revision`, `reset` |
| `MONGO_DB` | Database name. Required, same commands |
| `PORT` | Status server port, default `3000` |
| `CHAIN_ID` | Default for `--chain` |

## Status endpoint

`index` and `process` start an HTTP server on `PORT`.

- `GET /health`: `200 ok` while the loop's last successful iteration is younger than 60 s, otherwise `503`.
- `GET /status`: indexer `{ chainId, name, currentBlock, indexBlock }`; processor `{ chainId, name, currentBlock, indexBlock, processBlock, revisionId }`. `currentBlock` is the chain head, refreshed by the loop.

Run the indexer and the processor of one chain on different ports.

## Operational notes

- **Changing a process callback**: run `evm-indexer set-revision --chain <id>`. The running processor picks it up, drops the chain's entities and replays every stored event. No re-indexing.
- **Changing an index callback** (or anything that decides which addresses and events are scanned): run `evm-indexer reset --chain <id>` and index again. Then run the processor.
- **Archive RPC**: contract reads in callbacks run at the event's block. A processor that is far behind the head needs an archive node.
- **Templates**: an address added with `Template.create` is indexed only from after the event that created it. Earlier logs of that address are not read.
- **Idempotence**: a callback is stamped as done after it returns. If the processor dies between a callback's saves and the stamp, that event runs again on restart, so a callback like `balance += amount` can count once too often. Replay with `set-revision` to repair.
- **A failing callback** stops the processor at that event: the error is logged and the same event is retried after `pollInterval`. Events after it are never skipped.
- **Reorgs** are not handled; use `confirmations` on chains that reorganise.
- Collections: `sys_events`, `sys_transactions`, `sys_chains`, `sys_templates`, and `ent_<chainId>_<Table>`.
