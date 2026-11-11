# Getting started

This page takes a new project from an empty folder to a running indexer and processor.
It starts with `init`, which writes a working demo project that you then change.

## Requirements

- Node 20 or newer
- A MongoDB instance
- At least one RPC URL for the chain

## Install

```bash
npm install evm-indexer
```

Run the CLI through the project's own install (`npx evm-indexer …` or an npm script), not
a globally installed copy. The CLI and your callbacks must share one copy of the package.

Your project needs no build step: the config files and your handlers are loaded through
`tsx`. CommonJS and ESM projects (`"type": "module"`) both work. A config that uses
top-level `await` cannot be loaded.

## Create the project

```bash
npx evm-indexer init
```

`init` writes the demo project into the current directory (or into `--root <dir>`). It
needs no database and no RPC and does not run `codegen`. Files that already exist are
skipped and listed; `--force` overwrites them. `tsconfig.json` is written only if the
project has none and is never overwritten. See [CLI](cli.md#init).

## Project layout

```
abis/*.json            one ABI per contract class; the file name is the class name
chains.ts              chain settings, built with defineChains
addresses.ts           static contract addresses per chain, built with defineAddresses
schema.ts              entity tables, built with defineSchema
indexer.config.ts      contracts, templates, events, callbacks
src/handlers.ts        your callbacks
generated/             output of `evm-indexer codegen`, not edited by hand
.env.example           MONGO_URI, MONGO_DB, PORT; copy it to .env
tsconfig.json          compiler settings for the editor and `tsc --noEmit`
```

The demo project contains:

| File | Content |
|---|---|
| `chains.ts` | Chain 31337 `hardhat` at `http://127.0.0.1:8545` |
| `schema.ts` | `Account` (balance, updatedAt) and `Pool` (token, swapCount, createdAt) |
| `abis/Token.json` | ERC20 subset: `Transfer`, `balanceOf`, `decimals`, `symbol` |
| `abis/Factory.json` | `PoolCreated(address indexed token, address pool)` |
| `abis/Pool.json` | `Swap(address indexed sender, uint256 amountIn, uint256 amountOut)` |
| `indexer.config.ts` | `Token` indexes `Transfer`; `Factory` indexes `PoolCreated` and creates a `PoolTemplate`; `PoolTemplate` indexes `Swap` |
| `addresses.ts` | `Token` and `Factory` at the first two deploy addresses of hardhat's default account, block 0. Replace them with your own |
| `src/handlers.ts` | Three commented handlers: `handleTransfer`, `handlePoolCreated`, `handleSwap` |
| `.env.example` | `MONGO_URI`, `MONGO_DB`, `PORT` |
| `tsconfig.json` | Minimal strict config |

An ABI file is a plain ABI array or an artifact object with an `abi` array (hardhat,
foundry). All commands take `--root <dir>` if the project is not the current directory.

## Steps

The steps below replace the demo with your own contracts. Skip what you keep.

1. **Add ABIs.** Put `Factory.json`, `PoolPair.json` and so on into `abis/`.

2. **Describe the chain** in `chains.ts`. Only `name` and `rpc` are required:

   ```ts
   import { defineChains } from 'evm-indexer';

   export default defineChains({
     1329: { name: 'sei', rpc: ['https://rpc-a', 'https://rpc-b'] },
   });
   ```

3. **Define your tables** in `schema.ts`:

   ```ts
   import { defineSchema } from 'evm-indexer';

   export default defineSchema({
     Pool: { token: 'address', swapCount: 'int', createdAt: 'timestamp' },
   });
   ```

5. **Generate the classes:**

   ```bash
   npx evm-indexer codegen
   ```

6. **Write `indexer.config.ts` and your handlers.** See [Configuration](configuration.md)
   and [Callbacks](callbacks.md).

7. **List the static contracts** in `addresses.ts`, with the block to start from. The
   contract names come from `indexer.config.ts`, so write this file after it:

   ```ts
   import { defineAddresses } from 'evm-indexer';
   import config from './indexer.config';

   export default defineAddresses(config, {
     1329: { Factory: { address: '0x…', block: 1200000 } },
   });
   ```

8. **Set the environment** in `.env` (the demo ships `.env.example`):

   ```
   MONGO_URI=mongodb://localhost:27017
   MONGO_DB=my_indexer
   PORT=3000
   ```

9. **Check the types, then run the indexer and the processor**, each in its own process and on its own port:

   ```bash
   npx tsc --noEmit
   ```

   ```bash
   npx evm-indexer index --chain 1329
   ```

   ```bash
   PORT=3001 npx evm-indexer process --chain 1329
   ```

## Next

- [Configuration](configuration.md): every field of the config files
- [Schema and entities](schema-and-entities.md): field types and the entity API
- [Callbacks](callbacks.md): context, contract reads, templates
- [CLI](cli.md): all commands and options
- [Operations](operations.md): status endpoint, replays, resets, pitfalls
- [How it works](how-it-works.md): data model, scan modes, RPC handling
