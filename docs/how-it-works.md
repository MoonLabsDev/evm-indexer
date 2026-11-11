# How it works

evm-indexer splits the work into two processes that share nothing but MongoDB.

```
chain ──RPC──▶ indexer ──▶ sys_events, sys_transactions ──▶ processor ──▶ ent_* tables
                  │                                             │
            index callbacks                              process callbacks
          (Template.create)                              (entities, reads)
```

- The **indexer** finds the events of your contracts and stores them raw. It is the only
  part that scans the chain.
- The **processor** runs your callbacks over the stored events and writes entities.

Because the raw events stay in the database, changing callback logic never needs a second
scan: bump the revision and the processor replays.

## Data model

### sys_events

One document per indexed log.

| Field | Meaning |
|---|---|
| `chainId`, `address`, `eventId`, `blockNumber`, `txIndex`, `logIndex` | Unique key. `eventId` is the event's topic0 |
| `txHash` | Links to `sys_transactions` |
| `source`, `event` | Contract or template name and event name from the config |
| `data` | Decoded arguments. A bigint is stored as `{ "__bigint": "<decimal>" }` |
| `processRevisionId` | `-1` when stored; set to the chain's revision once its callback ran |

### sys_transactions

One document per transaction, shared by all its events: `from`, `to`, `value`, `nonce`,
`gasPrice`, `input`, `transactionIndex`, block number, hash and timestamp. This is what
`tx()` and `block()` return in the processor.

### sys_chains

One document per chain: `indexedBlock`, `processedBlock`, `currentRevisionId`,
`entityRevisionId` and the two heartbeats.

### sys_templates

One document per address added with `Template.create`: template name, address, and the
block, transaction index and log index of the creating event.

### Entities

`ent_<chainId>_<Table>`, one collection per table and chain.

## The indexer

On start it builds a registry of `address → contract → events` from `addresses.json` and
`sys_templates`. Each entry reacts only from its own start block (for templates: from
after the creating event).

For each range of blocks it:

1. Finds the matching logs (see [Scanning](#scanning)).
2. Walks them in block / transaction / log order. For each log it decodes the event, sets
   the context and runs the index callback, if there is one.
3. If a callback created a template, it fetches that address's later logs in the same
   range and merges them into the walk.
4. Writes transactions and events, then advances `indexedBlock`.

Writes are idempotent and `indexedBlock` moves last, so a crash anywhere simply repeats
the range. The stored result is the same with or without retries.

## Scanning

The scan is a hybrid, similar to graph-node.

**Backfill** is used while far behind. It asks the RPC for logs with `eth_getLogs` over a
block range, filtered by your addresses and event topics, then loads the block (with
transactions) for each block that had a match. With more than 100 addresses it filters by
topics only and matches addresses in memory.

**Head mode** is used within `headThreshold` blocks of the target. It fetches the blocks
as a batch, skips those whose `logsBloom` cannot contain a match, and reads the receipts
of the rest. If the RPC has no `eth_getBlockReceipts`, it falls back to `eth_getLogs` for
that single block.

Backfill always stops `headThreshold` blocks before the target and leaves the tail to head
mode. A load-balanced RPC whose backend lags behind the head can answer `eth_getLogs` with
an empty result; head mode notices a missing block or receipt and retries instead.

The target is `head − confirmations`.

## RPC handling

All calls go through a pool built from the chain's `rpc` list.

- **Retry and failover:** on a timeout, a rate limit (429), a network error or a 5xx it
  waits through `retryDelays` on the same RPC, then switches to the next one. If every RPC
  fails, the loop waits and retries the same work. No block is skipped.
- **Adaptive size, learned per RPC:** the log range and the block batch grow by 25 % after
  a fast call with few logs, and halve on a timeout, a rate limit, a "too large" error or
  a very large result.
- **Rate limits:** after a 429 the pool also keeps a minimum gap between requests to that
  RPC, which shrinks again after a run of successes.
- **Hung endpoint:** a second timeout in a row moves to the next RPC instead of halving
  again.
- **Unsupported method:** moves to the next RPC; if every RPC refuses, the error is thrown.
- **Reverts** in contract reads are not retried; they are thrown to the callback.

## The processor

Each iteration it:

1. Compares the chain's `currentRevisionId` with `entityRevisionId`. If they differ, it
   drops the chain's entity collections and starts over from the first event.
2. Reads the next events whose `processRevisionId` differs from the current revision, up
   to `indexedBlock`, in block / transaction / log order.
3. For each event: loads its transaction, sets the context, runs the process callback,
   then marks the event with the current revision.

An event is marked only after its callback returned, and a failing callback stops the loop
at that event, so events are never skipped and never run out of order.

## Revisions and replay

`set-revision` raises `currentRevisionId`. Every stored event now carries an older mark,
so the processor treats all of them as unprocessed, after first dropping the entity
collections built by the old logic. The result is the same as processing from scratch,
without touching the chain.

Revisions only move forward. Going back to an earlier number would leave events that still
carry that number unprocessed.

## Generated code

`codegen` produces two kinds of classes:

- **Contract classes** from ABIs: one method per `view` / `pure` function, typed event
  definitions, and the topic of each event. A method encodes the call, runs it at the
  current event's block through the RPC pool and decodes the result.
- **Entity classes** from `schema.json`: typed getters and setters, `load`, `save`,
  `remove`, and reference accessors.

Both rely on runtime state that the CLI sets up (the current context, the RPC pool, the
entity store). This is why the CLI and your project must use the same copy of the package.
