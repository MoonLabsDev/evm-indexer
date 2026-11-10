# evm-indexer — Design

Date: 2026-11-10
Status: awaiting review

## 1. Goal

A reusable, subgraph-like indexing package for EVM chains. A client project installs
`evm-indexer`, adds its ABIs, three config files and its handlers, and gets:

- an **indexer** that walks blocks and stores raw events in MongoDB,
- a separate **processor** that runs typed handlers over the stored events and writes entities,
- **codegen** for typed contract classes (read functions and events) and entity classes,
- **templates** to add contract addresses at runtime,
- a re-process path that needs no re-indexing.

Success: a project can index one chain with `evm-indexer index --chain <id>`, process it with
`evm-indexer process --chain <id>`, change handler logic, and replay with `set-revision`
without touching the chain again.

### Out of scope

- Write (state-changing) contract functions.
- Reorg detection and rollback (covered by a confirmation delay only).
- Traces; the true `msg.sender` of inner calls. There is no `msg()` context.
- A GraphQL or query API over the entities.
- Call handlers and block handlers (events only).

## 2. Shape

`evm-indexer` is one npm package containing a library and a CLI. TypeScript, Node 20+,
ethers v6, the official `mongodb` driver, express, chalk v4, decimal.js, vitest.

A client project looks like this:

```
abis/*.json            one ABI per contract class, file name = class name
chains.json            chain settings
addresses.json         static contract addresses per chain
schema.json            entity tables
indexer.config.ts      contracts, templates, events, callbacks
src/handlers/*.ts      the project's callbacks
generated/             output of `evm-indexer codegen` (not edited by hand)
.env                   MONGO_URI, MONGO_DB, PORT
```

The CLI loads `indexer.config.ts` through `tsx`, so the project needs no build step to run.

### Package layout

| Folder | Responsibility |
|---|---|
| `src/cli` | Argument parsing, the commands in section 9 |
| `src/config` | Load and validate `chains.json`, `addresses.json`, `schema.json`, `indexer.config.ts` |
| `src/rpc` | Provider pool: failover over the RPC list, retry backoff |
| `src/store` | MongoDB access for system tables and entity tables, index creation |
| `src/indexer` | Registry, block walker, index callbacks, template creation |
| `src/processor` | Ordered event loop, revision handling, process callbacks |
| `src/runtime` | `tx()`, `block()`, `chain()`, `Timestamp`, base classes used by generated code, `defineIndexer` |
| `src/codegen` | ABI → contract classes, schema → entity classes |
| `src/server` | express `/health` and `/status` |
| `src/log` | chalk log helpers |

Each unit talks to the others through its exported interface only; `indexer` and `processor`
never import each other and share state only through MongoDB.

## 3. Configuration

### 3.1 `.env`

`MONGO_URI`, `MONGO_DB`, `PORT` (default 3000).

### 3.2 `chains.json`

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

| Field | Required | Default | Meaning |
|---|---|---|---|
| `name` | yes | | Chain name, exposed by `chain().name` |
| `rpc` | yes, ≥ 1 | | RPC URLs in order of preference |
| `confirmations` | no | `0` | Indexer goes up to `head − confirmations` |
| `retryDelays` | no | `[100, 500, 2500]` | Backoff steps in ms before switching RPC |
| `logRange` | no | `{ start: 500, min: 1, max: 2000 }` | Bounds for the adaptive `eth_getLogs` block range (backfill) |
| `blockBatch` | no | `{ start: 10, min: 1, max: 100 }` | Bounds for the adaptive number of blocks per batch request (head mode) |
| `headThreshold` | no | `64` | At most this many blocks behind the target → head mode, otherwise backfill |
| `useBloom` | no | `true` | Head mode skips blocks whose `logsBloom` cannot match. Set `false` on chains with unreliable blooms |
| `pollInterval` | no | `1000` | Loop pause in ms when caught up |

### 3.3 `addresses.json`

```json
{
  "1329": {
    "Factory": { "address": "0x…", "block": 1200000 },
    "Token":   { "address": ["0x…", "0x…"], "block": 1250000 }
  }
}
```

Keys under a chain are the contract names from `indexer.config.ts` → `contracts`.
`block` is the first block from which that entry reacts to logs. At startup the names are
checked both ways: an unknown name or a contract without an entry for the started chain
is a fatal error. Addresses are normalised to lowercase.

### 3.4 `indexer.config.ts`

```ts
import { defineIndexer, defineTemplate } from 'evm-indexer';
import { Factory, Pool } from './generated';

export const PoolTemplate = defineTemplate({
  contract: Pool,
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

- Only events listed here are indexed.
- An event entry is `null`, a process callback, or `{ index?, process? }`.
- `defineIndexer` is generic over the generated classes: an event name that the class does
  not have is a compile error, and each callback's parameter is inferred as that event's
  generated type. Callbacks may be sync or async.
- A template is declared with `defineTemplate` before the indexer config, so index
  callbacks can reference it without a circular type. It is typed the same way as a
  contract entry and gets its name from its key under `templates`. A template that is
  not registered there makes `Template.create` throw.
- Contract names and template names share one namespace and must be unique.

### 3.5 `schema.json`

See section 8.

## 4. Data model

All collections live in `MONGO_DB`. System collections are prefixed `sys_`, entity
collections `ent_<chainId>_<Table>`.

### `sys_events`

| Field | Notes |
|---|---|
| `chainId`, `address`, `eventId`, `blockNumber`, `txIndex`, `logIndex` | Unique key. `eventId` is topic0 |
| `txHash` | Links to `sys_transactions` |
| `source` | Contract or template name from the config |
| `event` | Event name as used in the config (incl. overload suffix) |
| `data` | Decoded args; each bigint stored as `{ __bigint: "<decimal string>" }` so nested values round-trip |
| `processRevisionId` | `-1` when inserted; set to the current revision after its handler ran |

Indexes: the unique key; `{ chainId, blockNumber, txIndex, logIndex }` for ordered reads;
`{ chainId, processRevisionId, blockNumber, txIndex, logIndex }` for the processor query.

### `sys_transactions`

Key `{ chainId, hash }`. Fields: `from`, `to`, `value`, `nonce`, `gasPrice`, `input`,
`transactionIndex`, `blockNumber`, `blockHash`, `blockTimestamp`. One document per
transaction, shared by all its events.

### `sys_chains`

One document per chain: `chainId`, `indexedBlock`, `processedBlock`, `currentRevisionId`,
`entityRevisionId`, `indexerHeartbeat`, `processorHeartbeat`.

- `currentRevisionId` is the revision the processor should work towards (starts at 0).
- `entityRevisionId` is the revision the entity tables were built for (starts at 0).

### `sys_templates`

Unique key `{ chainId, template, address }`. Fields `block`, `txIndex`, `logIndex`: the
position of the event whose index callback created it. Only the address's logs after that
position are indexed, also after a retry or restart.

## 5. RPC pool

- One pool per process, built from the chain's `rpc` list.
- Every call (logs, blocks, `eth_call`) goes through `pool.call(fn)`.
- Retryable errors: timeouts, HTTP 429 / rate-limit messages, network errors, 5xx.
  The pool retries on the same RPC after each step in `retryDelays`, then switches to the
  next RPC and starts the steps again. Other errors (reverts, invalid params) are thrown at once.
- When every RPC has failed, the pool throws `AllRpcFailedError`; the calling loop logs it,
  sleeps `pollInterval` and retries the same work. No block is ever skipped.

### 5.1 Adaptive sizing

The pool keeps two learned sizes **per RPC**, in memory: the `eth_getLogs` block range
(bounded by `logRange`) and the blocks per batch request (bounded by `blockBatch`).
Each starts at `start` and then follows the same rule:

- **Grow** by 25 % after a call that succeeded, answered within 2 s and returned fewer
  than 2000 matching logs.
- **Halve** on a timeout, a 429, or a "range / batch / response too large" error, and
  when a call returned more than 10 000 logs. The failed work is retried with the
  smaller size; a halving does not count as a retry step.
- **Hold** otherwise.

Rate limiting: after a 429 the pool waits per `retryDelays` and adds a minimum gap
between requests to that RPC (starting at 100 ms, doubling on each further 429, halving
after 20 successful calls).

Switching RPC keeps each RPC's own learned sizes, so a slow fallback RPC does not
inherit the fast one's range. At `min` size with retries exhausted the pool moves to
the next RPC; with all RPCs failed it throws `AllRpcFailedError` as above.

## 6. Indexer

### 6.1 Registry

Built at startup, held in memory: `address → [{ source, contractClass, events, block }]`,
filled from `addresses.json` (static) and `sys_templates` (dynamic). It also yields the set
of topic0 values to filter on.

Start block: `sys_chains.indexedBlock + 1` if the chain was indexed before, otherwise the
lowest `block` in the registry. A registry entry only matches logs with
`blockNumber ≥ entry.block`.

### 6.2 Loop

The scan is a hybrid, like graph-node. With `target = head − confirmations`, each
iteration picks a mode from the distance `target − indexedBlock`:

- more than `headThreshold` → **backfill** (`eth_getLogs`, fast over long histories),
- otherwise → **head mode** (walk blocks and read their receipts).

Both modes produce the same ordered list of matching logs with their blocks and feed the
same steps 4–6, so the stored data does not depend on the mode.

**Backfill** — range `[from, to]`, `to = min(from + range − 1, target)`, `range` from 5.1:

1. `eth_getLogs` for the registry addresses and topic0 set. If the registry holds more
   than 100 addresses, filter by topics only and match addresses in memory.
2. Drop logs that no registry entry matches (address, topic0, `block`).
3. For each block that has matches, fetch the block with transactions once
   (as batch requests, sized by `blockBatch`).

**Head mode** — the next `n` blocks up to `target`, `n` from 5.1:

1. Fetch the `n` blocks with transactions as one JSON-RPC batch request.
2. If `useBloom` is on, test each block's `logsBloom` against the registry's addresses
   and topic0 values and skip blocks that cannot match.
3. For the remaining blocks call `eth_getBlockReceipts` and collect the logs that a
   registry entry matches. If the RPC does not support that method, fall back to
   `eth_getLogs` for that single block and remember the fallback for that RPC.

**Common steps**

4. Walk the logs in `blockNumber, txIndex, logIndex` order. For each log:
   - decode it with the contract class,
   - set the context (section 7.1),
   - run the `index` callback if one is configured,
   - buffer the event and its transaction.
5. If index callbacks created templates, add the new address's logs that come after the
   creating event, up to the end of the current range, merge them into the ordered list
   and continue the walk. Repeat until no new template appears.
   - Backfill: fetch them with `eth_getLogs` from the creating event's block to `to`.
   - Head mode: re-filter the receipts already in memory, and run steps 2–3 again for
     later blocks of the batch that the bloom check had skipped.
6. Upsert the buffered transactions and events (idempotent by their unique keys; an
   existing event keeps its `processRevisionId`), then set `indexedBlock` to the end of
   the range and write the heartbeat.

A crash before step 6 re-runs the range; index callbacks and upserts are idempotent.
Receipt-only fields (`gasUsed`, `status`) are not stored, because backfill never fetches
receipts.

### 6.3 Index callbacks and templates

An index callback receives the typed event and may use `tx()`, `block()`, `chain()` and
contract read calls (executed at the event's block). It has no entity access: loading or
saving an entity inside an index callback throws. Its only side effect is
`Template.create(address)`, which

1. upserts `sys_templates` with `block` = the current event's block,
2. adds the address to the in-memory registry,
3. marks the address for the same-range catch-up in step 5.

Creating an address that already exists for that template is a no-op.
`Template.create` called outside an index callback (e.g. in a process callback) throws.

Changing an index callback changes which addresses are scanned, so it requires
`reset --chain <id>` and a re-index. Changing process callbacks only needs `set-revision`.

## 7. Processor

### 7.1 Context

Set before each callback, cleared after it; access outside a callback throws.

- `tx()`: `hash`, `transactionIndex`, `logIndex`, `from`, `to`, `value`, `nonce`, `gasPrice`, `input`
- `block()`: `number`, `hash`, `timestamp` (a `Timestamp`, section 8.3)
- `chain()`: `id`, `name`

The same three functions work in index callbacks. Events are handled strictly one at a
time, so the context is a module-level value, not async-local storage.

### 7.2 Loop

1. Read `sys_chains`. If `entityRevisionId ≠ currentRevisionId`: drop every
   `ent_<chainId>_*` collection, then set `entityRevisionId = currentRevisionId` and
   `processedBlock = 0`. The drop is idempotent, so a crash in between is safe.
2. Query `sys_events` for the chain where `processRevisionId ≠ currentRevisionId` and
   `blockNumber ≤ indexedBlock`, ordered by `blockNumber, txIndex, logIndex`, in batches.
3. For each event: load its transaction, rebuild the typed event (strings back to bigint),
   set the context, run the `process` callback for `source` + `event` if there is one,
   then set the event's `processRevisionId = currentRevisionId`.
4. After a batch, set `processedBlock` and the heartbeat. With no events left,
   `processedBlock = indexedBlock`; sleep `pollInterval`.
5. Re-read `currentRevisionId` at the start of every batch, so a `set-revision` takes
   effect without a restart.

Contract read calls in process callbacks run at the event's block. A processor that lags
far behind the head therefore needs an archive RPC.

### 7.3 Errors

- A callback that throws stops the loop at that event: the event key and error are logged
  in red, the processor sleeps and retries the same event. It never continues past a
  failed event.
- The revision stamp is written after the callback finished. If the process dies between
  a callback's entity saves and the stamp, that one event runs again on restart. Callbacks
  that are not idempotent (e.g. `balance += amount`) can then count once too often; the
  fix is a replay via `set-revision`. This limitation is accepted for the first version.

## 8. Codegen

`evm-indexer codegen` reads `abis/*.json` and `schema.json`, validates both, and writes
`generated/contracts/<Name>.ts`, `generated/entities/<Table>.ts` and `generated/index.ts`.
It fails with a clear message on invalid input and writes nothing in that case.

### 8.1 Contract classes

- One class per ABI file, named after the file. `new Token(address)`.
- One method per `view` / `pure` function; no others are generated.
- Each call is an `eth_call` at the current context block through the RPC pool.
  Called outside a callback, it throws.
- Overloads: functions that share a name are sorted by 4-byte selector and **all** get an
  index suffix: `balanceOf_0`, `balanceOf_1`. Unique names stay plain. Events sharing a
  name follow the same rule, sorted by topic0 (`Transfer_0`, `Transfer_1`), and those
  suffixed names are the keys used in `indexer.config.ts`.
- Type mapping:

  | Solidity | TypeScript |
  |---|---|
  | `uint*`, `int*` | `bigint` |
  | `address` | lowercase `string` |
  | `bool` | `boolean` |
  | `bytes`, `bytesN` | hex `string` |
  | `string` | `string` |
  | tuple / struct | typed object |
  | `T[]`, `T[N]` | `T[]` |

- A single return value is returned directly, multiple return values as a typed object
  keyed by output name (`_0`, `_1` for unnamed outputs).

### 8.2 Event types

One type per event, `<Contract><Event>Event`:
`{ args: {…}, address, blockNumber, txIndex, logIndex, txHash }`. Unnamed args are keyed
`_0`, `_1`. Each class exposes a static map from event name to topic0 and a decoder, which
the indexer and `defineIndexer` typing use.

### 8.3 Entity classes

```json
{
  "Pool":  { "token": "ref:Token", "reserve": "bigint", "price": "decimal",
             "createdAt": "timestamp", "tags": "string[]", "note": "string?" },
  "Token": { "symbol": "string", "decimals": "int" }
}
```

Root keys are table names; each maps field names to a type string.

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
| `ref:<Table>` | see below | the referenced id (string) |

Modifiers: `[]` for arrays, `?` for optional (`string[]?` is allowed). `ref` fields can be
arrays and optional too. Validation fails on unknown types, a `ref` to a missing table,
or a field named `id`.

**`decimal`**: `Decimal128` holds 34 significant digits. `save()` throws when a value
needs more, rather than rounding.

**`Timestamp`**: an immutable wrapper with `.unix` (seconds), `.ms`, `.date` (JS `Date`),
`.iso`. Numbers are always read as unix seconds. `block().timestamp` is a `Timestamp`.

**API**

```ts
const pool = (await Pool.load(id)) ?? new Pool(id);
pool.reserve = 5n;            // in memory only
await pool.save();            // upsert of the whole document
await pool.remove();
```

- Every entity has a string `id`, stored as `_id`.
- `load` returns `null` when the document does not exist. Required fields that were never
  set make `save()` throw.
- Collections are named `ent_<chainId>_<Table>`; the chain comes from the running process.

**References** (`token: "ref:Token"`)

```ts
pool.tokenId = '0x…';               // sync, no read; clears the cached object
pool.tokenId;                       // raw id
const token = await pool.getToken(); // loads on first call, then cached; null if missing
pool.setToken(token);               // sets id and cache
```

For `ref:Token[]`: `tokenIds`, `getTokens()`, `setTokens()`.

## 9. CLI

| Command | Effect |
|---|---|
| `evm-indexer codegen` | Generate `generated/` |
| `evm-indexer index --chain <id>` | Run the indexer for one chain |
| `evm-indexer process --chain <id>` | Run the processor for one chain |
| `evm-indexer set-revision --chain <id> [--revision <n>]` | Set `currentRevisionId` (default: current + 1); triggers wipe and replay |
| `evm-indexer reset [--chain <id>] [--yes]` | See below |

`--chain` can also come from `CHAIN_ID`. `--debug` enables verbose logs on every command.

**`reset`** asks for confirmation unless `--yes` is given.

- Without `--chain`: drops every `sys_*` and `ent_*` collection — the empty initial state.
- With `--chain`: deletes that chain's documents from `sys_events`, `sys_transactions`
  and `sys_templates`, drops its `ent_<chainId>_*` collections, and sets
  `indexedBlock`, `processedBlock`, `currentRevisionId` and `entityRevisionId` to 0.

`index` and `process` refuse to start when another process of the same kind has a fresh
heartbeat for that chain.

## 10. Status endpoint

Both long-running commands start express on `PORT`.

- `GET /health` → `200 ok` while the loop's last iteration is younger than 60 s,
  otherwise `503`.
- `GET /status` →
  - indexer: `{ chainId, name, currentBlock, indexBlock }`
  - processor: `{ chainId, name, currentBlock, indexBlock, processBlock, revisionId }`

`currentBlock` is the chain head, refreshed by the loop (not per request).

## 11. Logging

chalk, in the style of `index-token`: blue for steps (`- Connect to MongoDB`), yellow for
results (`   - connected`), red for errors, green task lines with ETA and blocks/s while
catching up. `--debug` adds per-event and per-RPC-retry lines.

## 12. Testing

Unit (vitest, no network):

- overload naming and ordering by selector / topic0,
- ABI type mapping and event decoding round-trip (bigint ↔ string),
- schema validation, each field type's conversion, `Decimal128` overflow, `Timestamp`,
- `defineIndexer` typing (type-level tests),
- RPC pool retry, backoff and failover against a fake provider,
- adaptive sizing: grow, halve, bounds, per-RPC state, rate-limit gap,
- mode selection by `headThreshold`, bloom matching, `eth_getBlockReceipts` fallback,
- backfill and head mode yield identical events for the same blocks,
- registry `block` filtering and start-block selection.

Integration (local hardhat node + a throwaway Mongo database, dropped afterwards):

- index a deployed test contract, check `sys_events` / `sys_transactions`,
- process and check entities,
- `set-revision` wipes and replays to the same result,
- an index callback creates a template in the same range; its later events are indexed in order,
- `reset --chain` and `reset` return to the expected empty state,
- restart mid-range does not duplicate events.
