# Getting started

This page takes a new project from an empty folder to a running indexer and processor.

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

Your project needs no build step: `indexer.config.ts` and your handlers are loaded through
`tsx`. CommonJS and ESM projects (`"type": "module"`) both work. A config that uses
top-level `await` cannot be loaded.

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

An ABI file is a plain ABI array or an artifact object with an `abi` array (hardhat,
foundry). All commands take `--root <dir>` if the project is not the current directory.

## Steps

1. **Add ABIs.** Put `Factory.json`, `PoolPair.json` and so on into `abis/`.

2. **Describe the chain** in `chains.json`. Only `name` and `rpc` are required:

   ```json
   { "1329": { "name": "sei", "rpc": ["https://rpc-a", "https://rpc-b"] } }
   ```

3. **List the static contracts** in `addresses.json`, with the block to start from:

   ```json
   { "1329": { "Factory": { "address": "0x…", "block": 1200000 } } }
   ```

4. **Define your tables** in `schema.json`:

   ```json
   { "Pool": { "token": "address", "swapCount": "int", "createdAt": "timestamp" } }
   ```

5. **Generate the classes:**

   ```bash
   npx evm-indexer codegen
   ```

6. **Write `indexer.config.ts` and your handlers.** See [Configuration](configuration.md)
   and [Callbacks](callbacks.md).

7. **Set the environment** in `.env`:

   ```
   MONGO_URI=mongodb://localhost:27017
   MONGO_DB=my_indexer
   PORT=3000
   ```

8. **Run the indexer and the processor**, each in its own process and on its own port:

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
