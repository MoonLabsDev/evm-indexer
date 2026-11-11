# TypeScript config files and `init` command — design

Date: 2026-11-11. Target version: 0.2.0.

## Goal

1. All project config lives in the project root as TypeScript, checked by the compiler
   against the real config types. `chains.json`, `addresses.json` and `schema.json` are
   replaced by `chains.ts`, `addresses.ts` and `schema.ts`.
2. A new `evm-indexer init` command writes a working demo project: a local hardhat chain,
   entities, an ERC20 with a handler, and a factory whose event creates a template.

Out of scope: Solidity sources, a hardhat config, deploy scripts. ABIs stay JSON under
`abis/` (they are compiler artifacts).

## 1. Config files

Four root files, each with a default export built by a `define…` helper. The CLI loads
all of them the way it loads `indexer.config.ts` today (global tsx `register()`, plain
`require`, default export).

```ts
// chains.ts
import { defineChains } from 'evm-indexer';
export default defineChains({
  31337: { name: 'hardhat', rpc: ['http://127.0.0.1:8545'] },
});

// schema.ts
import { defineSchema } from 'evm-indexer';
export default defineSchema({
  Account: { id: 'string', balance: 'bigint', updatedAt: 'timestamp' },
});

// addresses.ts
import { defineAddresses } from 'evm-indexer';
import config from './indexer.config';
export default defineAddresses(config, {
  31337: {
    Token: { address: '0x…', block: 0 },
    Factory: { address: '0x…', block: 0 },
  },
});
```

### Helpers

- `defineChains(input: Record<number, ChainInput>)`. `ChainInput` is the user-facing shape:
  `name` and `rpc` required, everything else optional (`confirmations`, `retryDelays`,
  `logRange`, `blockBatch`, `headThreshold`, `useBloom`, `pollInterval`). Returns the input
  wrapped in a branded object.
- `defineSchema(input)`. The input type mirrors what `schema.json` accepts today (same
  field-type literals, same reference and optional syntax), expressed as a TypeScript type
  so an unknown field type is a compile error. Returns a branded object.
- `defineIndexer` now returns `NormalizedConfig<Names>` where `Names` is the union of the
  keys under `contracts` (not templates). Runtime behaviour is unchanged.
- `defineAddresses(config, input)`. `input` is
  `Record<number, { [K in Names]: { address: string | string[]; block: number } }>`.
  A missing or unknown contract name is a compile error. Templates cannot be listed.
  `config` is used for typing only. Returns a branded object.

All helpers are exported from the package root together with their input types.

### Loading and validation

- One loader, `loadTsDefault(path, kind)`, requires the file, takes `default`, and checks
  the brand. Errors are `ConfigError`s naming the path: file missing, no default export,
  default export not created by the matching `define…` helper.
- If `<name>.ts` is missing but `<name>.json` exists, the error says the JSON format was
  replaced and names the helper to use.
- Runtime validation stays: `parseChains`, `parseAddresses` and the schema validation run
  on the loaded object with the same messages as today. The CLI runs TypeScript without
  type checking, so both layers are needed.
- `readJsonFile` remains for ABIs only. JSON loaders for chains, addresses and schema are
  removed; there is no fallback.
- `codegen` loads `schema.ts` before `generated/` exists, so `schema.ts` must not import
  from `generated/`. A missing `schema.ts` still means "no entities". `codegen` does not
  load `chains.ts`, `addresses.ts` or `indexer.config.ts`.
- `addresses.ts` imports `indexer.config.ts`, which imports `generated/`; it is only
  loaded by `index`, after codegen.

## 2. `evm-indexer init`

```
evm-indexer init [--force]        (honours the global --root)
```

Writes into the root:

| File | Content |
|---|---|
| `chains.ts` | Chain 31337 `hardhat`, `http://127.0.0.1:8545` |
| `schema.ts` | `Account` (balance, updatedAt) and `Pool` (token, swapCount, createdAt) |
| `abis/Token.json` | ERC20 subset: `Transfer`, `balanceOf`, `decimals`, `symbol` |
| `abis/Factory.json` | `PoolCreated(address indexed token, address pool)` |
| `abis/Pool.json` | `Swap(address indexed sender, uint256 amountIn, uint256 amountOut)` |
| `indexer.config.ts` | Token → `Transfer`; Factory → `PoolCreated` with index callback `PoolTemplate.create(e.args.pool)` and a process callback; `PoolTemplate` → `Swap` |
| `addresses.ts` | Token and Factory at the first two deploy addresses of hardhat's default account (`0x5FbDB2315678afecb367f032d93F642f64180aa3`, `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512`), block 0, with a comment to replace them |
| `src/handlers.ts` | Three commented handlers (`handleTransfer`, `handlePoolCreated`, `handleSwap`) |
| `.env.example` | `MONGO_URI`, `MONGO_DB`, `PORT` |
| `tsconfig.json` | Minimal strict config; written only if none exists, never overwritten |

Behaviour:

- Existing files are skipped and listed; `--force` overwrites them (except
  `tsconfig.json`). The command prints written and skipped files.
- No database, no RPC, no codegen run. It ends by printing the next steps: install
  `evm-indexer` if missing, `codegen`, start a hardhat node and deploy, `index`,
  `process`.
- Templates are plain files under `templates/init/` in the package, copied verbatim
  (`.ts` templates are stored with a `.tpl` suffix so the package's own `tsc` ignores
  them). `templates/` is added to `files` in `package.json`.

## 3. Code changes

| Area | Change |
|---|---|
| `src/runtime/define.ts` | `NormalizedConfig<Names>`; new `defineChains`, `defineSchema`, `defineAddresses`, brands |
| `src/config/load.ts` (new) | `loadTsDefault` |
| `src/config/chains.ts`, `addresses.ts` | Load via `loadTsDefault`; parsers unchanged |
| `src/codegen/schema.ts`, `index.ts` | Read `schema.ts` via `loadTsDefault`; typed schema input |
| `src/cli/commands.ts`, `index.ts` | New paths, `init` command, tsx registered before codegen too |
| `src/cli/init.ts` (new) | Copy logic |
| `src/index.ts` | Export the helpers and input types |
| `test/fixture/**` | Converted to TS config |

## 4. Tests

- Unit: helpers (runtime and type tests: wrong field type, missing/unknown contract in
  `defineAddresses` fail to compile), `loadTsDefault` errors incl. the JSON hint, parsers
  through the new loader, `init` into an empty directory, into a populated one, and with
  `--force`.
- Integration: `init` → `codegen` → `tsc --noEmit` in the generated project, so the
  templates cannot go stale. Existing e2e and CLI tests run on the converted fixture.

## 5. Docs

README, `getting-started`, `configuration`, `schema-and-entities`, `cli` and `operations`
are updated to the TS files and the `init` command. `getting-started` starts with `init`.

## 6. Compatibility

Breaking for JSON-based projects; no fallback. Released as 0.2.0 (pre-1.0, no known
users).
