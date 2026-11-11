# CLI

```
evm-indexer [--debug] [--root <dir>] <command> [options]
```

Run it through the project's own install: `npx evm-indexer …` or an npm script.

## Commands

| Command | Effect |
|---|---|
| [`codegen`](#codegen) | Generate `generated/` from `abis/` and `schema.json` |
| [`index --chain <id>`](#index) | Run the indexer for one chain |
| [`process --chain <id>`](#process) | Run the processor for one chain |
| [`set-revision --chain <id> [--revision <n>]`](#set-revision) | Trigger a replay of all stored events |
| [`reset [--chain <id>] [--yes] [--force]`](#reset) | Delete data |

## Global options

| Option | Meaning |
|---|---|
| `--root <dir>` | Project folder holding `chains.json`, `addresses.json`, `schema.json`, `abis/`, `generated/`, `indexer.config.ts`. Default: the current directory |
| `--debug` | Adds gray lines for every stored event (indexer), every processed event (processor) and every RPC retry, failover, size halving and rate-limit gap, with the RPC URL and the error kind |

`--chain` can also come from the `CHAIN_ID` environment variable, except for `reset`.

## codegen

```bash
npx evm-indexer codegen
```

Writes `generated/contracts/*.ts`, `generated/entities/*.ts` and `generated/index.ts`.

- One contract class per ABI file; the file name is the class name.
- One entity class per table in `schema.json`. A missing `schema.json` means no entities.
- Everything is validated first. On an error nothing is written.
- Needs no database and no RPC.

Run it again whenever an ABI or the schema changes.

## index

```bash
npx evm-indexer index --chain 1329
```

Walks the chain from the lowest `block` in `addresses.json` (or from where it stopped),
stores matching events and their transactions, and runs index callbacks. It never runs
process callbacks and does not report `processBlock`.

## process

```bash
npx evm-indexer process --chain 1329
```

Runs process callbacks over stored events in block / transaction / log order, up to the
indexer's `indexedBlock`. It needs the RPC only for contract reads in callbacks and for
the head number in `/status`.

`index` and `process` are independent processes. Either can be stopped and restarted
without the other. On one machine they need different `PORT` values.

## set-revision

```bash
npx evm-indexer set-revision --chain 1329
```

Sets the chain's revision to the current one plus 1 and prints it. The processor, running
or started later, then drops that chain's entity collections and replays every stored
event. Use it after changing a process callback or the schema. The chain is not scanned
again.

`--revision <n>` sets an explicit value. It must be greater than the current revision;
a lower or equal value is refused.

## reset

```bash
npx evm-indexer reset --chain 1329
```

| Form | Deletes |
|---|---|
| `reset --chain <id>` | That chain's events, transactions and templates, its entity collections, and sets its counters and revision back to 0 |
| `reset` | Every `sys_*` and `ent_*` collection: the empty initial state |

- Asks you to type `yes` first. `--yes` skips the question.
- **Refuses to run while an indexer or processor is alive** for an affected chain (a
  heartbeat younger than 60 s), and deletes nothing. Stop them first. `--force` skips this
  check, for a process that is known to be gone. `--yes` does not skip it.
- Reads the chain only from `--chain`, never from `CHAIN_ID`, so a stray variable cannot
  change what gets deleted.

Use `reset --chain` after changing an index callback or anything else that decides which
addresses and events are scanned, then index again.

## Running and stopping

- **Single instance:** `index` and `process` write a heartbeat to the database every
  10 s. A second process of the same kind for the same chain refuses to start while that
  heartbeat is younger than 60 s.
- **Clean stop:** on SIGINT or SIGTERM the processor finishes the current event and the
  indexer its current range. Then the heartbeat is cleared, the status server and the
  database connection are closed, and the process exits with code 0. A restart or a
  `reset` right after a clean stop is not refused.
- **After a crash** the old heartbeat stays fresh for up to 60 s. Wait, or use
  `reset --force` if you only want to reset.
- A stop that takes longer than 30 s exits with code 1. Fatal errors are printed in red
  and exit with code 1.

## Log output

Blue lines are steps, yellow lines results, red lines errors. While catching up, both
loops print a green progress line every 10 s with blocks per second and an ETA.
