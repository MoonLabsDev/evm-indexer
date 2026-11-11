# evm-indexer

A subgraph-like indexer for EVM chains, backed by MongoDB.

You describe your contracts, events and tables; evm-indexer stores the raw events of those
contracts and runs your typed callbacks over them to build your own tables. When you
change callback logic, it replays from the stored events instead of scanning the chain
again.

## What it does

- **Indexes events** of the contracts you list, per chain, with RPC failover and retry.
- **Generates typed classes** from your ABIs (events and read functions) and from a
  TypeScript schema (entities with `load` / `save`).
- **Runs your callbacks** per event, with a Solidity-style context: `tx()`, `block()`,
  `chain()`, and contract reads at the event's block.
- **Follows new contracts at runtime** through templates, like a factory's pools.
- **Replays without re-indexing:** bump a revision and all entities are rebuilt from the
  stored events.

It handles events only. There are no write calls, no reorg rollback (use `confirmations`),
no traces and no query API on top of the tables.

## How it works

Two separate processes share one MongoDB database:

```
chain ──RPC──▶ indexer ──▶ stored events ──▶ processor ──▶ your tables
```

1. The **indexer** walks the chain and stores every matching event together with its
   transaction. Far behind the head it uses `eth_getLogs`; near the head it walks blocks
   and reads their receipts.
2. The **processor** reads the stored events in order and calls your callbacks, which
   write entities.
3. Each stored event carries a revision mark. `set-revision` raises the chain's revision,
   and the processor drops the entities and processes every event again.

More detail: [How it works](docs/how-it-works.md).

## Install

Requires Node 20 or newer and a MongoDB instance.

```bash
npm install evm-indexer
```

Your project needs no build step; the config files and handlers are loaded as TypeScript.

## Quick start

`init` writes a demo project (a local hardhat chain, two tables, an ERC20 and a factory
with a template) into the current directory. Existing files are skipped:

```bash
npx evm-indexer init
```

A project consists of ABIs, four TypeScript config files and your handlers:

```
abis/*.json          chains.ts            addresses.ts
schema.ts            indexer.config.ts    src/handlers.ts
```

```ts
// indexer.config.ts
import { defineIndexer } from 'evm-indexer';
import { Token } from './generated';
import { handleTransfer } from './src/handlers';

export default defineIndexer({
  contracts: {
    Token: { contract: Token, events: { Transfer: handleTransfer } },
  },
});
```

```ts
// src/handlers.ts
import { block } from 'evm-indexer';
import { Account, type TokenTransferEvent } from '../generated';

export async function handleTransfer(e: TokenTransferEvent) {
  const to = (await Account.load(e.args.to)) ?? new Account(e.args.to);
  to.balance = (to.balance ?? 0n) + e.args.value;
  to.updatedAt = block().timestamp;
  await to.save();
}
```

Generate the classes, then run the two processes:

```bash
npx evm-indexer codegen
```

```bash
npx evm-indexer index --chain 1329
```

```bash
npx evm-indexer process --chain 1329
```

The full walk-through is in [Getting started](docs/getting-started.md).

## Documentation

| Topic | Content |
|---|---|
| [Getting started](docs/getting-started.md) | Requirements, project layout, first run step by step |
| [Configuration](docs/configuration.md) | `chains.ts`, `addresses.ts`, `indexer.config.ts`, environment variables |
| [Schema and entities](docs/schema-and-entities.md) | `schema.ts` field types, entity API, references, `Timestamp`, `Decimal` |
| [Callbacks](docs/callbacks.md) | Event object, context, contract reads, index vs process callbacks, templates |
| [CLI](docs/cli.md) | `init`, `codegen`, `index`, `process`, `set-revision`, `reset`, options, stopping |
| [Operations](docs/operations.md) | Status endpoint, what to do after a change, resets, pitfalls |
| [How it works](docs/how-it-works.md) | Data model, scan modes, RPC handling, revisions |

## Development

```bash
npm run build
```

```bash
npm test
```

`npm test` runs the unit tests and the integration tests; the latter start a local hardhat
node and an in-memory MongoDB. `npm run test:unit` runs only the unit tests.
