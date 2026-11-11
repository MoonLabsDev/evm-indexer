# TypeScript Config Files and `init` Command Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `chains.json`, `addresses.json` and `schema.json` with compiler-checked `chains.ts`, `addresses.ts` and `schema.ts`, and add `evm-indexer init`, which writes a working demo project.

**Architecture:** Three new `define…` helpers wrap the user's input in a tagged object. One loader (`loadTsDefault`) requires a root `.ts` file through the already-used global tsx hook, checks the tag and hands the raw value to the existing runtime parsers, which stay unchanged. `init` copies static template files shipped in the package.

**Tech Stack:** TypeScript 7 (strict, CommonJS), tsx `register()`, commander, vitest 5 (unit + type tests via `tsconfig.test.json`, integration with hardhat on port 8546 and mongodb-memory-server).

**Spec:** `docs/superpowers/specs/2026-11-11-ts-config-and-init-design.md`

## Global Constraints

- TS only: no JSON fallback for chains, addresses, schema. ABIs stay JSON under `abis/`.
- Runtime parsers (`parseChains`, `parseAddresses`, `parseSchema`) keep their behaviour and messages.
- Config files are loaded with a plain `require` after the global tsx `register()` (one runtime copy; never `tsx.require`).
- The tag must survive two module copies of the runtime (vitest ESM copy vs. tsx CJS copy): it is a plain string property, never `instanceof` or a module-local symbol.
- `schema.ts` must be loadable before `generated/` exists.
- `init` needs no database, no RPC, runs no codegen, never overwrites without `--force`, and never overwrites `tsconfig.json`.
- Commit messages carry no attribution lines. Do not push; the 0.2.0 version bump happens at push time, outside this plan.
- Full suite must stay green: `npm run build`, `npm run test:unit`, `npm run test:integration`.

## Review Focus

1. A config file whose default export is a plain object (helper forgotten) → `ConfigError` naming the file and the helper to use, not a parser error. (Task 2)
2. A config file that throws or has a syntax error on load → `ConfigError` naming the file and carrying the original message. (Task 2)
3. A project with `"type": "module"` in `package.json` → `chains.ts`, `schema.ts`, `addresses.ts` load the same way `indexer.config.ts` does today. (Task 3, extends the existing ESM case in `test/integration/cli.test.ts`)
4. `schema.ts` that imports from `generated/` before the first codegen → error names `schema.ts` and says it must not import from `generated/`. (Task 3)
5. `init` in a partly populated directory, and `init` run twice → existing files untouched and listed as skipped, the rest written; second run writes nothing. (Task 4)

---

## File Structure

| File | Responsibility |
|---|---|
| `src/types.ts` | + `ChainInput`, `AddressEntry` |
| `src/runtime/define.ts` | + `Defined`, `ConfigKind`, `defineChains`, `defineSchema`, `defineAddresses`, `SchemaInput`; `NormalizedConfig<Names>` |
| `src/config/load.ts` (new) | `registerTsx`, `loadTsDefault` |
| `src/config/indexerConfig.ts` | uses `registerTsx` from `load.ts` |
| `src/config/chains.ts`, `addresses.ts` | `loadChain` / `loadAddresses` read TS |
| `src/codegen/index.ts` | takes a loaded schema value instead of a path |
| `src/cli/init.ts` (new) | `cmdInit` |
| `src/cli/commands.ts`, `index.ts` | new paths, schema loading, `init` command |
| `templates/init/**` (new) | demo project files |
| `test/fixture/project`, `cli-project` | converted to TS config |

---

### Task 1: `define…` helpers and types

**Files:**
- Modify: `src/types.ts`, `src/runtime/define.ts`
- Test: `test/unit/define.test.ts`, `test/unit/define.types.test.ts`

**Interfaces — Produces:**

```ts
// src/types.ts
export interface ChainInput {
  name: string; rpc: string[];
  confirmations?: number; retryDelays?: number[];
  logRange?: Partial<SizeBounds>; blockBatch?: Partial<SizeBounds>;
  headThreshold?: number; useBloom?: boolean; pollInterval?: number;
}
export interface AddressEntry { address: string | string[]; block: number }

// src/runtime/define.ts
export type ConfigKind = 'chains' | 'schema' | 'addresses';
export interface Defined<K extends ConfigKind, V> { readonly __evmIndexerConfig: K; readonly value: V }

export interface NormalizedConfig<Names extends string = string> {
  sources: Record<string, NormalizedSource>;
  /** Type-only: the keys under `contracts`. Never set at runtime. */
  readonly __contracts?: Names;
}
// defineIndexer<C, T>(…): NormalizedConfig<keyof C & string>   (runtime unchanged)

type BaseFieldType = 'string'|'int'|'float'|'bigint'|'decimal'|'boolean'|'address'|'bytes'|'timestamp';
export type SchemaFieldType<Tables extends string> = `${BaseFieldType | `ref:${Tables}`}${'' | '[]'}${'' | '?'}`;
export type SchemaInput<S> = { [T in keyof S]: Record<string, SchemaFieldType<keyof S & string>> };

export function defineChains(input: Record<number, ChainInput>): Defined<'chains', Record<number, ChainInput>>;
export function defineSchema<const S extends SchemaInput<S>>(input: S): Defined<'schema', S>;
export function defineAddresses<N extends string>(
  config: NormalizedConfig<N>, input: Record<number, { [K in N]: AddressEntry }>,
): Defined<'addresses', Record<number, Record<N, AddressEntry>>>;
```

- [ ] **Step 1: Write failing runtime tests** in `test/unit/define.test.ts`:

```ts
it('define helpers tag their input and keep it by reference', () => {
  const chains = { 1: { name: 'eth', rpc: ['http://x'] } };
  expect(defineChains(chains)).toEqual({ __evmIndexerConfig: 'chains', value: chains });
  expect(defineSchema({ A: { x: 'int' } })).toEqual({ __evmIndexerConfig: 'schema', value: { A: { x: 'int' } } });
  const cfg = defineIndexer({ contracts: { Factory: { contract: FakeFactory, events: { PoolCreated: null } } } });
  const addrs = { 1: { Factory: { address: '0x' + '1'.repeat(40), block: 5 } } };
  expect(defineAddresses(cfg, addrs)).toEqual({ __evmIndexerConfig: 'addresses', value: addrs });
});
```
(Use the fake contract class the file already uses for `defineIndexer` tests.)

- [ ] **Step 2: Write failing type tests** in `test/unit/define.types.test.ts` (each bad case with `// @ts-expect-error`):
  - `defineSchema({ A: { x: 'bigintt' } })` errors; `defineSchema({ A: { b: 'ref:B' } })` errors (unknown table); `defineSchema({ A: { b: 'ref:B[]?' }, B: { n: 'int?' } })` compiles.
  - `defineChains({ 1: { name: 'x' } })` errors (rpc missing); `defineChains({ 1: { name: 'x', rpc: [], foo: 1 } })` errors.
  - With `cfg` from a `defineIndexer` with contracts `Factory` and `Token` and one template `PoolTemplate`: `defineAddresses(cfg, { 1: { Factory: e } })` errors (Token missing); adding `Other: e` errors; adding `PoolTemplate: e` errors; `{ 1: { Factory: e, Token: e } }` compiles.
  - `expectTypeOf(cfg).toEqualTypeOf<NormalizedConfig<'Factory' | 'Token'>>()`.

- [ ] **Step 3: Run** `npm run test:unit -- define` → FAIL (helpers not exported).
- [ ] **Step 4: Implement** the types and the three helpers; each helper returns `{ __evmIndexerConfig: kind, value: input }`. `defineAddresses` ignores `config` at runtime.
- [ ] **Step 5: Run** `npm run test:unit` and `npm run build` → PASS (other code still compiles because `NormalizedConfig` defaults `Names` to `string`).
- [ ] **Step 6: Commit** `feat: defineChains, defineSchema, defineAddresses`.

---

### Task 2: TS loader; chains and addresses from `.ts`

**Files:**
- Create: `src/config/load.ts`
- Modify: `src/config/indexerConfig.ts`, `src/config/chains.ts`, `src/config/addresses.ts`, `src/cli/commands.ts` (paths `chains.ts`, `addresses.ts`), `src/cli/index.ts` (`--root` help text), `.gitignore`
- Convert: `test/fixture/project/chains.json` → `chains.ts`, `test/fixture/cli-project/chains.json` → `chains.ts`; delete `test/fixture/project/addresses.example.json`
- Test: `test/unit/config.test.ts`, `test/unit/cli.test.ts`, `test/integration/e2e.test.ts`, `test/integration/cli.test.ts`

**Interfaces:**
- Consumes: `ConfigKind`, `Defined` (Task 1).
- Produces:

```ts
// src/config/load.ts
export function registerTsx(): void;                       // moved from indexerConfig.ts, same behaviour
/** Requires `path`, returns the `value` of its default export, which must be tagged `kind`. */
export function loadTsDefault(path: string, kind: ConfigKind): unknown;
```
`loadChain(path, chainId)` and `loadAddresses(path, chainId, contractNames)` keep their signatures; `path` is now the `.ts` file.

`loadTsDefault` errors, all `ConfigError`:
- file missing, sibling `<base>.json` exists → `` `${file} not found; ${base}.json is no longer read: move it to ${base}.ts with export default ${helper}(...)` ``
- file missing → `` `cannot read ${file}: file not found` ``
- require throws → `` `cannot load ${file}: ${message}` ``
- default export missing or not tagged with `kind` → `` `${file} must default-export the result of ${helper}()` ``

`helper` is `defineChains` / `defineSchema` / `defineAddresses`. Accept both `mod.default` and `mod` itself (as `loadIndexerConfig` does).

- [ ] **Step 1: Rewrite the file-loading tests** in `test/unit/config.test.ts`. Temp files are written as `.ts` text that imports the helpers by absolute path to `src/index.ts` (use `JSON.stringify(path)` for the import specifier). Cases:
  - `chains.ts` with `defineChains({ 1: { name: 'eth', rpc: ['http://x'] } })` → `loadChain(cp, 1).name === 'eth'`; `loadChain(cp, 2)` throws `ConfigError`.
  - `addresses.ts` with a tagged value → `loadAddresses(ap, 1, ['Factory'])` has length 1. (Write the tagged object literally, `export default { __evmIndexerConfig: 'addresses', value: {…} }`, so the test needs no indexer config.)
  - missing file → `/cannot read .*nope\.ts/`.
  - missing `x.ts` next to an existing `x.json` → `/x\.json is no longer read/` and `/defineChains/`.
  - `export default { 1: { name: 'eth', rpc: ['http://x'] } }` (no helper) → `/must default-export the result of defineChains\(\)/`.
  - a chains file tagged `'schema'` → same error.
  - file content `throw new Error('boom')` → `/cannot load .*: boom/`; file content `export default {` → `ConfigError` naming the file.
  - a runtime-invalid value inside a valid tag (`rpc: []`) still raises the existing `parseChains` message.
- [ ] **Step 2: Update** `test/unit/cli.test.ts:81` to expect `/chains\.ts/`.
- [ ] **Step 3: Run** `npm run test:unit -- config cli` → FAIL.
- [ ] **Step 4: Implement** `src/config/load.ts`; make `loadIndexerConfig` import `registerTsx` from it; switch `loadChain` / `loadAddresses` to `parseX(loadTsDefault(path, kind), …)`; change the two paths in `commands.ts`. `readJsonFile` stays exported (ABIs).
- [ ] **Step 5: Convert the fixtures.** `chains.ts` in both fixture projects with the same values as the JSON, importing `defineChains` the same way that project's `indexer.config.ts` imports `defineIndexer`. In `e2e.test.ts` and `cli.test.ts`, where `addresses.json` is written with the deployed factory address, write `addresses.ts` instead:

```ts
import { defineAddresses } from '<same specifier as that project's indexer.config.ts>';
import config from './indexer.config';
export default defineAddresses(config, { 31337: { Factory: { address: '<deployed>', block: <n> } } });
```
and pass `addresses.ts` / `chains.ts` to `loadAddresses` / `loadChain`. Add `test/fixture/*/addresses.ts` to `.gitignore` (replacing the `addresses.json` entry if present).
- [ ] **Step 6: Run** `npm run build && npm run test:unit && npm run test:integration` → PASS.
- [ ] **Step 7: Commit** `feat!: read chains and addresses from TypeScript files`.

---

### Task 3: `schema.ts` for codegen

**Files:**
- Modify: `src/codegen/index.ts`, `src/codegen/schema.ts` (comment only), `src/cli/commands.ts` (`cmdCodegen`, path `schema.ts`), `src/cli/index.ts` (command description)
- Convert: `test/fixture/project/schema.json`, `test/fixture/cli-project/schema.json` → `schema.ts`
- Test: `test/unit/codegen.test.ts`, `test/unit/cli.test.ts`, `test/integration/globalSetup.ts`, `test/integration/cli.test.ts`

**Interfaces:**
- Consumes: `loadTsDefault(path, 'schema')` (Task 2).
- Produces:

```ts
export interface CodegenOptions {
  abiDir: string;
  /** The loaded schema value (what `defineSchema` wraps); `undefined` means no entities. */
  schema?: unknown;
  /** Name used in schema error messages. Default 'schema.ts'. */
  schemaSource?: string;
  outDir: string;
  runtimeImport?: string;
}
```
`runCodegen` no longer touches the file system for the schema. Every message that used `${opts.schemaPath}` uses `schemaSource`.

`cmdCodegen`: if `<root>/schema.ts` exists, `schema = loadTsDefault(path, 'schema')`; else if `<root>/schema.json` exists, let `loadTsDefault` throw its JSON hint (call it); else `schema = undefined`. A `cannot load …` failure is rethrown with the suffix `` ` (schema.ts must not import from generated/; it is loaded before generated/ exists)` ``.

- [ ] **Step 1: Update** `test/unit/codegen.test.ts`: `setup()` returns `{ abiDir, schema, outDir }` (schema object passed through, no file written); the two "missing schema" tests pass `schema: undefined`; error expectations that matched the schema path match `schema.ts`.
- [ ] **Step 2: Add** to `test/unit/cli.test.ts` (temp project dirs with an empty `abis/`):
  - `cmdCodegen` with a `schema.ts` exporting `defineSchema({ A: { n: 'int' } })` writes `generated/entities/A.ts`.
  - with only `schema.json` → rejects `/schema\.json is no longer read/`.
  - with neither → resolves, `generated/entities/index.ts` is `export {};`.
  - with a `schema.ts` whose first line is `import './generated';` → rejects `/must not import from generated/`.
- [ ] **Step 3: Run** `npm run test:unit -- codegen cli` → FAIL.
- [ ] **Step 4: Implement** the `CodegenOptions` change and `cmdCodegen`.
- [ ] **Step 5: Convert** both fixture `schema.json` files to `schema.ts` (same tables). `globalSetup.ts` and `cli.test.ts` setup: load with `loadTsDefault(join(PROJECT, 'schema.ts'), 'schema')` and pass `schema`. Extend the existing ESM-project case in `test/integration/cli.test.ts` so that project also has `chains.ts` and `schema.ts`, and assert `codegen` exits 0 there.
- [ ] **Step 6: Run** `npm run build && npm run test:unit && npm run test:integration` → PASS.
- [ ] **Step 7: Commit** `feat!: read the entity schema from schema.ts`.

---

### Task 4: `init` command and templates

**Files:**
- Create: `src/cli/init.ts`, `templates/init/chains.ts.tpl`, `schema.ts.tpl`, `addresses.ts.tpl`, `indexer.config.ts.tpl`, `src/handlers.ts.tpl`, `abis/Token.json`, `abis/Factory.json`, `abis/Pool.json`, `env.example`, `tsconfig.json`
- Modify: `src/cli/index.ts`, `package.json` (`files` += `"templates"`)
- Test: `test/unit/init.test.ts`, `test/integration/init.test.ts`

**Interfaces — Produces:**

```ts
// src/cli/init.ts
export interface InitResult { written: string[]; skipped: string[] }   // paths relative to root, '/'-separated
export function cmdInit(root: string, opts: { force: boolean }): InitResult;
```
Template dir: `join(__dirname, '..', '..', 'templates', 'init')` (valid from `src/cli` and `dist/cli`). Target name = template name without `.tpl`; `env.example` → `.env.example`. `tsconfig.json` is written only when absent, also with `force`. The root is created if missing. CLI: `init` with `--force`; prints one `log.result` line per written and per skipped file, then the next steps (install `evm-indexer`, `npx evm-indexer codegen`, start a hardhat node and deploy, `index --chain 31337`, `process --chain 31337`).

**Template content (fixed by the spec):**
- `chains.ts`: `defineChains({ 31337: { name: 'hardhat', rpc: ['http://127.0.0.1:8545'] } })`.
- `schema.ts`: `Account: { balance: 'bigint', updatedAt: 'timestamp' }`, `Pool: { token: 'address', swapCount: 'int', createdAt: 'timestamp' }`.
- ABIs: Token — `Transfer(address indexed from, address indexed to, uint256 value)`, `balanceOf(address) view returns (uint256)`, `decimals() view returns (uint8)`, `symbol() view returns (string)`. Factory — `PoolCreated(address indexed token, address pool)`. Pool — `Swap(address indexed sender, uint256 amountIn, uint256 amountOut)`.
- `indexer.config.ts`: `PoolTemplate = defineTemplate({ contract: Pool, events: { Swap: handleSwap } })`; contracts `Token` → `Transfer: handleTransfer`, `Factory` → `PoolCreated: { index: (e) => PoolTemplate.create(e.args.pool), process: handlePoolCreated }`; `templates: { PoolTemplate }`. Because an entity and a contract are both named `Pool`, the entity is imported as `PoolEntity` from `./generated`.
- `addresses.ts`: `Token` at `0x5FbDB2315678afecb367f032d93F642f64180aa3`, `Factory` at `0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512`, both `block: 0`, with a comment: these are the first two deployments of hardhat's default account; replace them with your own.
- `src/handlers.ts`: `handleTransfer` credits `to` and debits `from` on `Account` (skipping the zero address) and sets `updatedAt = block().timestamp`; `handlePoolCreated` creates `PoolEntity` with `token`, `swapCount = 0`, `createdAt`; `handleSwap` increments `swapCount`. Each handler has a short comment saying what it shows (entity load/save, context, template address).
- `.env.example`: `MONGO_URI=mongodb://127.0.0.1:27017`, `MONGO_DB=evm_indexer`, `PORT=3000`.
- `tsconfig.json`: `target ES2022`, `module commonjs`, `strict`, `esModuleInterop`, `skipLibCheck`, `noEmit`, `include: ["*.ts", "src", "generated"]`.

- [ ] **Step 1: Write failing unit tests** `test/unit/init.test.ts` (temp dirs under `test/.tmp`):
  - empty dir: `written` equals the ten target paths (sorted compare), `skipped` is empty, every file exists and is non-empty.
  - populated dir (`chains.ts` containing `// mine`, `abis/Other.json`, `tsconfig.json` containing `{}`): `skipped` is `['chains.ts', 'tsconfig.json']`, `chains.ts` still `// mine`, `abis/Other.json` untouched, the other eight written.
  - second run on the same dir: `written` is empty, `skipped` has all ten.
  - `force: true` on the populated dir: `chains.ts` replaced, `tsconfig.json` still `{}` and listed in `skipped`.
  - non-existing root is created.
  - `buildProgram()` has an `init` command with a `--force` option.
- [ ] **Step 2: Run** `npm run test:unit -- init` → FAIL.
- [ ] **Step 3: Write the templates and implement** `cmdInit` and the CLI command.
- [ ] **Step 4: Run** `npm run test:unit -- init` → PASS.
- [ ] **Step 5: Write the integration test** `test/integration/init.test.ts`: build `dist` (as `cli.test.ts` does), run `node dist/cli/index.js --root <tmp> init`, make `evm-indexer` resolvable from `<tmp>` the same way `cli.test.ts` does for `cli-project`, run `codegen`, then `tsc --noEmit -p <tmp>/tsconfig.json`. Expect all three exit codes 0 and `generated/index.ts` to exist. Then load the result in-process: `loadChain(<tmp>/chains.ts, 31337).name === 'hardhat'`.
- [ ] **Step 6: Run** `npm run build && npm run test:integration` → PASS. Also `npm pack --dry-run` lists `templates/init/chains.ts.tpl`.
- [ ] **Step 7: Commit** `feat: init command with a demo project`.

---

### Task 5: Documentation

**Files:**
- Modify: `README.md`, `docs/getting-started.md`, `docs/configuration.md`, `docs/schema-and-entities.md`, `docs/cli.md`, `docs/operations.md`, `docs/how-it-works.md`, `docs/superpowers/2026-11-10-evm-indexer-followups.md` (only if an item is now obsolete)

- [ ] **Step 1: Find every stale reference:** `grep -rn "chains.json\|addresses.json\|schema.json" README.md docs/*.md src` → replace each with the `.ts` file and, where an example is shown, the `define…` form from the spec. `src` comments included.
- [ ] **Step 2: Content changes.**
  - `README.md` quick start: project layout lists `chains.ts  addresses.ts  schema.ts  indexer.config.ts`; first command is `npx evm-indexer init`.
  - `docs/getting-started.md`: starts with `init`, then explains each written file; states that existing files are skipped.
  - `docs/configuration.md`: one section per file with its helper and what the compiler checks (unknown field type, missing or unknown contract in `addresses.ts`); note that the CLI does not type-check, so run `tsc --noEmit`; note that `schema.ts` must not import from `generated/`.
  - `docs/cli.md`: `init [--force]` in the command table and its own section (files written, skip rule, `tsconfig.json` rule, no network).
  - `docs/operations.md` "When you change something": rows name the `.ts` files.
- [ ] **Step 3: Verify:** the grep from Step 1 returns nothing outside `docs/superpowers/`; every relative link in the edited files resolves to an existing file or heading.
- [ ] **Step 4: Commit** `docs: TypeScript config files and init`.
