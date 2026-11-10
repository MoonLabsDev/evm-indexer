# evm-indexer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `evm-indexer`, a reusable subgraph-like package: an indexer that stores raw EVM events in MongoDB, a separate processor that runs typed handlers over them, and codegen for contract and entity classes.

**Architecture:** One npm package (library + CLI). `indexer` and `processor` are separate long-running commands that share state only through MongoDB. Generated code and the client's `indexer.config.ts` import the runtime from the package; the CLI loads that config through `tsx`.

**Tech Stack:** TypeScript 5, Node 20+, ethers v6 (ABI coding only), `mongodb` 6, express 4, chalk 4, decimal.js, commander, tsx, vitest, mongodb-memory-server, hardhat 2 (integration tests only).

**Spec:** `docs/superpowers/specs/2026-11-10-evm-indexer-design.md` — read it before any task; section numbers below (§) refer to it.

## Global Constraints

- Package name `evm-indexer`, version `0.1.0`, CommonJS output (`"module": "commonjs"`, `outDir: dist`), `main: dist/index.js`, `bin: { "evm-indexer": "dist/cli/index.js" }`.
- **Runtime singleton:** context, RPC handle, entity store and template sink are module-level state in `src/runtime`. Generated code and client configs must reach them through the package entry (`evm-indexer`), never a second copy. In tests, generated code imports the runtime via the `runtimeImport` codegen option.
- RPC goes through `RpcPool` only. No direct `fetch`/provider use outside `src/rpc`.
- `src/indexer` and `src/processor` never import each other.
- All addresses, hashes and topics are lowercased at the boundary (config load, RPC decode).
- Collections: system `sys_events`, `sys_transactions`, `sys_chains`, `sys_templates`; entities `ent_<chainId>_<Table>`.
- New events get `processRevisionId: -1`; a chain starts with `currentRevisionId: 0`, `entityRevisionId: 0`, `indexedBlock: 0`, `processedBlock: 0`.
- Defaults (§3.2): `confirmations 0`, `retryDelays [100,500,2500]`, `logRange {start:500,min:1,max:2000}`, `blockBatch {start:10,min:1,max:100}`, `headThreshold 64`, `useBloom true`, `pollInterval 1000`.
- Adaptive constants (§5.1): grow ×1.25 when call < 2000 ms and < 2000 logs; halve on timeout / 429 / too-large / > 10000 logs; rate gap starts 100 ms, doubles per 429, halves after 20 successes.
- Heartbeat is "fresh" when younger than 60 000 ms.
- Env: `MONGO_URI`, `MONGO_DB`, `PORT` (default 3000), optional `CHAIN_ID`.
- Logging only through `src/log` (blue step, yellow result, red error, green task line).
- Every task: TDD, run `npx tsc --noEmit` before committing, commit message as given, no attribution lines.
- Tests that need MongoDB use `test/helpers/mongo.ts` (mongodb-memory-server); nothing touches a real database.

## Review Focus

1. **One address claimed by two sources** (two contracts, or a template creating a static address): `sys_events`' key has no `source`, so events would collide. Expected: fatal error at startup for static config; `Template.create` logs a warning and skips. → Task 9.
2. **RPC returns `null` for a block or receipts** (load-balanced node lagging behind the head it just reported). Expected: treated as retryable, never stored as "no events". → Task 4.
3. **Stored event whose source/event is no longer in the config** (handler removed between runs). Expected: processor warns once per source+event, stamps the event, continues. → Task 12.
4. **Tuple and nested-array event args containing `uint256`**. Expected: serialize → store → deserialize returns identical bigints at every depth. → Task 6.
5. **Schema or ABI names that break generated code** (field named `save`, `load`, `remove`, `id`; table or ABI file name that is not a valid identifier; anonymous events). Expected: codegen fails with the offending name; anonymous events are skipped with a warning. → Tasks 6, 7.

---

## File Structure

```
package.json  tsconfig.json  vitest.config.ts  README.md
src/index.ts                 public exports (runtime + define*)
src/types.ts                 shared interfaces (below)
src/log/index.ts             chalk helpers, ETA formatting
src/config/chains.ts         chains.json loader
src/config/addresses.ts      addresses.json loader
src/config/indexerConfig.ts  load indexer.config.ts via tsx
src/rpc/errors.ts            error classes + classifyError
src/rpc/sizer.ts             AdaptiveSize, RateGap
src/rpc/transport.ts         HttpTransport (fetch JSON-RPC, batch)
src/rpc/pool.ts              RpcPool
src/store/db.ts              connect()
src/store/system.ts          SystemStore (sys_* collections)
src/store/entities.ts        EntityStore (ent_* collections)
src/runtime/timestamp.ts     Timestamp
src/runtime/context.ts       tx() block() chain(), set/clear
src/runtime/events.ts        decodeLog, serializeArgs, deserializeArgs
src/runtime/contract.ts      BaseContract, setRpc
src/runtime/fields.ts        FieldSpec codecs
src/runtime/entity.ts        BaseEntity, setEntityStore
src/runtime/define.ts        defineIndexer, defineTemplate, Template
src/codegen/abi.ts           ABI analysis: names, overloads, TS types
src/codegen/contracts.ts     emit contract class source
src/codegen/schema.ts        schema.json parse + validate
src/codegen/entities.ts      emit entity class source
src/codegen/index.ts         runCodegen()
src/indexer/registry.ts      Registry
src/indexer/bloom.ts         bloomMayContain
src/indexer/backfill.ts      BackfillScanner
src/indexer/head.ts          HeadScanner
src/indexer/indexer.ts       Indexer loop
src/processor/processor.ts   Processor loop
src/server/index.ts          express status server
src/cli/index.ts             commander entry
src/cli/commands.ts          command implementations
test/helpers/mongo.ts  test/helpers/fakeTransport.ts
test/unit/*.test.ts  test/integration/*.test.ts  test/fixture/**
```

### Shared types (`src/types.ts`, created in Task 1, used everywhere)

```ts
export interface SizeBounds { start: number; min: number; max: number }
export interface ChainConfig {
  chainId: number; name: string; rpc: string[]; confirmations: number;
  retryDelays: number[]; logRange: SizeBounds; blockBatch: SizeBounds;
  headThreshold: number; useBloom: boolean; pollInterval: number;
}
export interface StaticEntry { source: string; address: string; block: number }
export interface RawLog {
  address: string; topics: string[]; data: string; blockNumber: number;
  transactionIndex: number; logIndex: number; transactionHash: string;
}
export interface RawTx {
  hash: string; from: string; to: string | null; value: bigint; nonce: number;
  gasPrice: bigint; input: string; transactionIndex: number;
}
export interface RawBlock {
  number: number; hash: string; timestamp: number; logsBloom: string; transactions: RawTx[];
}
export interface EventKey {
  chainId: number; address: string; eventId: string;
  blockNumber: number; txIndex: number; logIndex: number;
}
export interface EventDoc extends EventKey {
  txHash: string; source: string; event: string;
  data: Record<string, unknown>; processRevisionId: number;
}
export interface TxDoc {
  chainId: number; hash: string; from: string; to: string | null; value: string;
  nonce: number; gasPrice: string; input: string; transactionIndex: number;
  blockNumber: number; blockHash: string; blockTimestamp: Date;
}
export interface ChainState {
  chainId: number; indexedBlock: number; processedBlock: number;
  currentRevisionId: number; entityRevisionId: number;
  indexerHeartbeat: Date | null; processorHeartbeat: Date | null;
}
export interface TemplateDoc { chainId: number; template: string; address: string; block: number }
export interface IndexedEvent<A = Record<string, unknown>> {
  args: A; address: string; blockNumber: number; txIndex: number; logIndex: number; txHash: string;
}
```

---

### Task 1: Scaffold, shared types, logging

**Files:** Create `package.json`, `tsconfig.json`, `vitest.config.ts`, `src/types.ts`, `src/log/index.ts`, `src/index.ts`; Test `test/unit/log.test.ts`

**Interfaces — Produces:**
```ts
// src/log/index.ts
export function setDebug(on: boolean): void
export const log: {
  step(msg: string): void;    // blue  "- msg"
  result(msg: string): void;  // yellow "   - msg"
  error(msg: string, err?: unknown): void; // red "   - ERROR: msg"
  task(name: string, msg: string): void;   // green "   - [TASK] name => msg"
  debug(msg: string): void;   // only when setDebug(true)
}
export function formatTimespan(seconds: number): string        // "1d 2h 3m 4s"
export function eta(startBlock: number, startMs: number, current: number, target: number, nowMs: number):
  { seconds: number; blocksPerSecond: number } | null          // null when done<=0, todo<=0 or elapsed<=30s
```

- [ ] **Step 1: Scaffold.** `package.json` per Global Constraints with scripts `build: tsc`, `test: vitest run`, `test:unit: vitest run test/unit`, `test:integration: vitest run test/integration`; deps `ethers@^6 mongodb@^6 express@^4 chalk@^4 decimal.js commander tsx dotenv`; devDeps `typescript vitest @types/node @types/express mongodb-memory-server hardhat@^2`. `tsconfig.json`: `target ES2022`, `strict`, `declaration`, `rootDir src`, `outDir dist`, `esModuleInterop`. Run `npm install`. Write `src/types.ts` exactly as above.
- [ ] **Step 2: Failing test** `test/unit/log.test.ts`:
```ts
expect(formatTimespan(93784)).toBe('1d 2h 3m 4s');
expect(eta(100, 0, 200, 400, 50_000)).toEqual({ seconds: 100, blocksPerSecond: 2 });
expect(eta(100, 0, 200, 400, 10_000)).toBeNull();   // under 30 s elapsed
expect(eta(100, 0, 400, 400, 50_000)).toBeNull();   // nothing left
```
- [ ] **Step 3:** Run `npx vitest run test/unit/log.test.ts` → FAIL (module missing).
- [ ] **Step 4:** Implement `src/log/index.ts`.
- [ ] **Step 5:** Run again → PASS; `npx tsc --noEmit` clean.
- [ ] **Step 6:** `git add -A && git commit -m "chore: scaffold package, shared types and logging"`

---

### Task 2: chains.json and addresses.json loaders

**Files:** Create `src/config/chains.ts`, `src/config/addresses.ts`; Test `test/unit/config.test.ts`

**Interfaces — Produces:**
```ts
export function parseChains(json: unknown): Record<string, ChainConfig>   // applies defaults, throws ConfigError
export function loadChain(path: string, chainId: number): ChainConfig     // throws ConfigError if chain missing
export function parseAddresses(json: unknown, chainId: number, contractNames: string[]): StaticEntry[]
export function loadAddresses(path: string, chainId: number, contractNames: string[]): StaticEntry[]
export class ConfigError extends Error {}
```

- [ ] **Step 1: Failing tests:**
```ts
const c = parseChains({ '1329': { name: 'sei', rpc: ['http://a'] } })['1329'];
expect(c).toMatchObject({ chainId: 1329, confirmations: 0, retryDelays: [100, 500, 2500],
  logRange: { start: 500, min: 1, max: 2000 }, blockBatch: { start: 10, min: 1, max: 100 },
  headThreshold: 64, useBloom: true, pollInterval: 1000 });
expect(() => parseChains({ '1': { name: 'x', rpc: [] } })).toThrow(/rpc/);
expect(() => parseChains({ abc: { name: 'x', rpc: ['u'] } })).toThrow(/chain id/i);
expect(() => parseChains({ '1': { name: 'x', rpc: ['u'], logRange: { start: 5, min: 10, max: 2 } } })).toThrow(/logRange/);

const A = '0x' + 'Ab'.repeat(20);
expect(parseAddresses({ '1': { Factory: { address: A, block: 5 }, Token: { address: [A.replace('Ab','Cd'), '0x' + '11'.repeat(20)], block: 7 } } }, 1, ['Factory', 'Token']))
  .toEqual([{ source: 'Factory', address: A.toLowerCase(), block: 5 }, /* two Token entries, lowercased, block 7 */]);
expect(() => parseAddresses({ '1': { Nope: { address: A, block: 1 } } }, 1, ['Factory'])).toThrow(/Nope/);      // unknown name
expect(() => parseAddresses({ '1': {} }, 1, ['Factory'])).toThrow(/Factory/);                                    // missing entry
expect(() => parseAddresses({ '2': {} }, 1, [])).toThrow(/chain 1/);                                             // chain missing
expect(() => parseAddresses({ '1': { Factory: { address: '0x12', block: 1 } } }, 1, ['Factory'])).toThrow(/address/);
expect(() => parseAddresses({ '1': { Factory: { address: A } } }, 1, ['Factory'])).toThrow(/block/);
```
- [ ] **Step 2:** Run `npx vitest run test/unit/config.test.ts` → FAIL.
- [ ] **Step 3:** Implement both files. Bounds valid when `1 ≤ min ≤ start ≤ max`. Address valid when `/^0x[0-9a-fA-F]{40}$/`. `block` must be an integer ≥ 0.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** `git commit -am "feat: chains and addresses config loaders"` (add new files).

---

### Task 3: Timestamp and context

**Files:** Create `src/runtime/timestamp.ts`, `src/runtime/context.ts`; Test `test/unit/runtime.test.ts`

**Interfaces — Produces:**
```ts
export class Timestamp {
  static from(v: number | Date | Timestamp): Timestamp   // number = unix seconds; throws on NaN / non-finite
  readonly unix: number; readonly ms: number; readonly date: Date; readonly iso: string;
}
export interface ContextData {
  mode: 'index' | 'process';
  chain: { id: number; name: string };
  block: { number: number; hash: string; timestamp: Timestamp };
  tx: { hash: string; transactionIndex: number; logIndex: number; from: string; to: string | null;
        value: bigint; nonce: number; gasPrice: bigint; input: string };
}
export function setContext(c: ContextData): void
export function clearContext(): void
export function currentContext(): ContextData | null
export function tx(): ContextData['tx']        // throws ContextError outside a callback
export function block(): ContextData['block']
export function chain(): ContextData['chain']
export class ContextError extends Error {}
```

- [ ] **Step 1: Failing tests:**
```ts
const t = Timestamp.from(1731234567);
expect([t.unix, t.ms, t.iso]).toEqual([1731234567, 1731234567000, '2024-11-10T10:29:27.000Z']);
expect(Timestamp.from(new Date(1731234567000)).unix).toBe(1731234567);
expect(Timestamp.from(t)).toBe(t);
expect(() => Timestamp.from(NaN)).toThrow();
expect(() => tx()).toThrow(ContextError);
setContext(sample); expect(tx().hash).toBe(sample.tx.hash); expect(chain().name).toBe('sei');
clearContext(); expect(() => block()).toThrow(ContextError);
```
- [ ] **Step 2:** Run `npx vitest run test/unit/runtime.test.ts` → FAIL.
- [ ] **Step 3:** Implement. `Timestamp` is immutable (`Object.freeze`); `date` returns a fresh `Date` each access.
- [ ] **Step 4:** Run → PASS. Export both modules from `src/index.ts`.
- [ ] **Step 5:** `git commit -m "feat: Timestamp and callback context"`

---

### Task 4: RPC pool with retry, failover and adaptive sizing

**Files:** Create `src/rpc/errors.ts`, `src/rpc/sizer.ts`, `src/rpc/transport.ts`, `src/rpc/pool.ts`, `test/helpers/fakeTransport.ts`; Test `test/unit/sizer.test.ts`, `test/unit/pool.test.ts`

**Interfaces — Produces:**
```ts
// errors.ts
export type ErrorKind = 'timeout' | 'rateLimit' | 'tooLarge' | 'network' | 'unsupported' | 'fatal';
export function classifyError(err: unknown): ErrorKind
export class RpcError extends Error { constructor(msg: string, public code?: number, public status?: number) }
export class ResizeError extends Error {}        // sized call was halved; caller re-chunks and calls again
export class AllRpcFailedError extends Error {}

// sizer.ts
export class AdaptiveSize {
  constructor(bounds: SizeBounds); readonly value: number;
  onSuccess(durationMs: number, logCount: number): void;  // grow / hold / halve per §5.1
  halve(): boolean;                                       // false when already at min
}
export class RateGap { readonly ms: number; on429(): void; onSuccess(): void }

// transport.ts
export interface RpcTransport {
  readonly url: string;
  send(method: string, params: unknown[]): Promise<unknown>;
  sendBatch(calls: { method: string; params: unknown[] }[]): Promise<unknown[]>;
}
export class HttpTransport implements RpcTransport { constructor(url: string, timeoutMs?: number /* 30000 */) }

// pool.ts
export interface PoolOptions {
  retryDelays: number[]; logRange: SizeBounds; blockBatch: SizeBounds;
  sleep?: (ms: number) => Promise<void>; now?: () => number;
}
export class RpcPool {
  constructor(transports: RpcTransport[], opts: PoolOptions)
  size(kind: 'logRange' | 'blockBatch'): number           // learned size of the active RPC
  getBlockNumber(): Promise<number>
  getLogs(f: { fromBlock: number; toBlock: number; address?: string[]; topics: string[] }): Promise<RawLog[]>  // sized
  getBlocks(numbers: number[]): Promise<RawBlock[]>                                                            // sized
  getBlockLogs(blockNumber: number): Promise<RawLog[]>    // eth_getBlockReceipts, else eth_getLogs for the block
  ethCall(to: string, data: string, blockNumber: number): Promise<string>
}
// test/helpers/fakeTransport.ts
export class FakeTransport implements RpcTransport {
  constructor(url: string); calls: { method: string; params: unknown[] }[];
  on(method: string, handler: (params: unknown[]) => unknown): this   // handler may throw RpcError
}
```

**Behavior to implement (not derivable from signatures):**
- `classifyError`: `AbortError`/"timeout" → `timeout`; status 429 or message `/rate limit|too many requests/i` → `rateLimit`; message `/too large|too many results|exceed|limit.*range|response size/i` or code `-32005` → `tooLarge`; code `-32601` or `/method not found|not supported/i` → `unsupported`; status ≥ 500, `ECONNRESET`, `ENOTFOUND`, `fetch failed` → `network`; everything else (reverts, invalid params) → `fatal`.
- Ladder for every call: on `timeout`/`rateLimit`/`network`, sleep `retryDelays[i]` and retry on the same RPC; after the last delay switch to the next RPC (round robin) and restart the ladder; when every RPC failed once in a row throw `AllRpcFailedError`. `fatal` is rethrown at once.
- Sized calls (`getLogs`, `getBlocks`) before the ladder: on `tooLarge`, `timeout` or `rateLimit`, if `halve()` returns true → (for `rateLimit`: `gap.on429()` and sleep `retryDelays[0]`) throw `ResizeError`. At `min` they fall through to the ladder. On success call `onSuccess(duration, logs.length)` (`getBlocks` passes `0`).
- Before each request to an RPC wait until `lastRequest + gap.ms`.
- A `null` result for a requested block or for `eth_getBlockReceipts` is thrown as a `network` kind error (Review Focus 2).
- `getBlockLogs`: on `unsupported` remember it for that transport and use `eth_getLogs` with `fromBlock = toBlock = n`, no address/topic filter.
- Decoding: hex quantities → `number` (block, indexes, nonce, timestamp) or `bigint` (value, gasPrice; `gasPrice ?? maxFeePerGas ?? 0`); addresses, hashes and topics lowercased.
- Sizers and gaps are kept per transport.

- [ ] **Step 1: Failing sizer tests:**
```ts
const s = new AdaptiveSize({ start: 100, min: 1, max: 150 });
s.onSuccess(500, 10);  expect(s.value).toBe(125);
s.onSuccess(500, 10);  expect(s.value).toBe(150);      // capped at max
s.onSuccess(3000, 10); expect(s.value).toBe(150);      // slow → hold
s.onSuccess(500, 5000); expect(s.value).toBe(150);     // many logs → hold
s.onSuccess(500, 10001); expect(s.value).toBe(75);     // huge result → halve
const m = new AdaptiveSize({ start: 1, min: 1, max: 10 }); expect(m.halve()).toBe(false);
const g = new RateGap(); expect(g.ms).toBe(0); g.on429(); expect(g.ms).toBe(100); g.on429(); expect(g.ms).toBe(200);
for (let i = 0; i < 20; i++) g.onSuccess(); expect(g.ms).toBe(100);
```
- [ ] **Step 2: Failing pool tests** (fake `sleep` records delays; two `FakeTransport`s `a`, `b`):
```ts
// retry then succeed on same RPC
a fails eth_blockNumber twice with RpcError(status 503) then returns '0x10' → getBlockNumber() === 16; sleeps [100, 500]
// failover after ladder
a always 503, b returns '0x11' → result 17; sleeps [100, 500, 2500]; b.calls.length === 1
// all failed
a, b always 503 → rejects AllRpcFailedError
// fatal not retried
a throws RpcError('execution reverted', 3) on eth_call → rejects, a.calls.length === 1, no sleeps
// sized call halves
a throws RpcError('query returned more than 10000 results', -32005) on eth_getLogs →
  getLogs(...) rejects ResizeError; pool.size('logRange') === 250
// at min size falls to ladder
bounds {start:1,min:1,max:1}, a always tooLarge, b ok → resolves from b
// per-RPC sizes
after the halve above, force failover to b → pool.size('logRange') === 500
// null block is retryable
a returns [null] for the batch once, then a block → getBlocks([5]) resolves, sleeps [100]
// receipts fallback
a throws RpcError('method not found', -32601) on eth_getBlockReceipts, serves eth_getLogs →
  getBlockLogs(5) returns the logs; second getBlockLogs(6) never calls eth_getBlockReceipts
// rate limit gap
a answers 429 once on eth_getLogs → ResizeError, sleeps include 100; next request waits ≥ 100 ms (via fake now)
// decode
block with tx value '0xde0b6b3a7640000', from mixed case → value === 10n ** 18n, from lowercased
```
- [ ] **Step 3:** Run `npx vitest run test/unit/sizer.test.ts test/unit/pool.test.ts` → FAIL.
- [ ] **Step 4:** Implement the four source files and the fake. `HttpTransport` uses global `fetch` with `AbortController`; a JSON-RPC `error` member becomes `RpcError(message, code)`, a non-2xx response `RpcError(text, undefined, status)`.
- [ ] **Step 5:** Run → PASS.
- [ ] **Step 6:** `git commit -m "feat: RPC pool with failover, backoff and adaptive sizing"`

---

### Task 5: MongoDB stores

**Files:** Create `src/store/db.ts`, `src/store/system.ts`, `src/store/entities.ts`, `test/helpers/mongo.ts`; Test `test/unit/store.test.ts`

**Interfaces — Produces:**
```ts
// db.ts
export function connect(uri: string, dbName: string): Promise<{ client: MongoClient; db: Db }>
// system.ts
export class SystemStore {
  constructor(db: Db)
  init(): Promise<void>                                         // creates the indexes of §4
  getChain(chainId: number): Promise<ChainState>                // inserts defaults when missing
  setIndexed(chainId: number, block: number): Promise<void>     // also sets indexerHeartbeat
  setProcessed(chainId: number, block: number): Promise<void>   // also sets processorHeartbeat
  heartbeat(chainId: number, kind: 'indexer' | 'processor'): Promise<void>
  isAlive(chainId: number, kind: 'indexer' | 'processor', nowMs?: number): Promise<boolean>   // < 60 000 ms
  setRevision(chainId: number, revisionId: number): Promise<void>
  setEntityRevision(chainId: number, revisionId: number): Promise<void>   // also processedBlock = 0
  upsertTransactions(docs: TxDoc[]): Promise<void>
  upsertEvents(docs: EventDoc[]): Promise<void>                 // processRevisionId only via $setOnInsert
  getTransaction(chainId: number, hash: string): Promise<TxDoc | null>
  nextUnprocessed(chainId: number, revisionId: number, maxBlock: number, limit: number): Promise<EventDoc[]>
  stampEvent(key: EventKey, revisionId: number): Promise<void>
  listTemplates(chainId: number): Promise<TemplateDoc[]>
  addTemplate(doc: TemplateDoc): Promise<boolean>               // false when it already existed
  dropEntities(chainId: number): Promise<void>                  // every ent_<chainId>_* collection
  resetChain(chainId: number): Promise<void>
  resetAll(): Promise<void>                                     // every sys_* and ent_* collection
}
// entities.ts
export class EntityStore {
  constructor(db: Db, chainId: number)
  load(table: string, id: string): Promise<Record<string, unknown> | null>   // without _id
  save(table: string, id: string, doc: Record<string, unknown>): Promise<void>  // replaceOne upsert
  remove(table: string, id: string): Promise<void>
}
// test/helpers/mongo.ts
export function startMongo(): Promise<{ db: Db; stop(): Promise<void> }>   // fresh db name per call
```

- [ ] **Step 1: Failing tests:**
```ts
// defaults
expect(await sys.getChain(1)).toMatchObject({ indexedBlock: 0, processedBlock: 0, currentRevisionId: 0, entityRevisionId: 0 });
// idempotent upsert keeps revision
await sys.upsertEvents([ev(10, 0, 0)]); await sys.stampEvent(ev(10, 0, 0), 0); await sys.upsertEvents([ev(10, 0, 0)]);
expect((await sys.nextUnprocessed(1, 0, 100, 10)).length).toBe(0);
// order + filter
insert events at (12,0,1) (10,2,0) (10,0,5) (11,0,0) for chain 1 and one for chain 2 →
nextUnprocessed(1, 0, 11, 10) returns blocks/tx/log [(10,0,5),(10,2,0),(11,0,0)]
// revision bump makes everything unprocessed again
await sys.setRevision(1, 1); expect((await sys.nextUnprocessed(1, 1, 100, 10)).length).toBe(4);
// templates
expect(await sys.addTemplate(t)).toBe(true); expect(await sys.addTemplate(t)).toBe(false);
// heartbeat
await sys.heartbeat(1, 'indexer'); expect(await sys.isAlive(1, 'indexer')).toBe(true);
expect(await sys.isAlive(1, 'indexer', Date.now() + 61_000)).toBe(false); expect(await sys.isAlive(1, 'processor')).toBe(false);
// entities + per-chain reset
await e1.save('Pool', 'a', { x: 1 }); await e2.save('Pool', 'a', { x: 2 });
expect(await e1.load('Pool', 'a')).toEqual({ x: 1 }); expect(await e1.load('Pool', 'zz')).toBeNull();
await sys.resetChain(1);
expect(await e1.load('Pool', 'a')).toBeNull(); expect(await e2.load('Pool', 'a')).toEqual({ x: 2 });
expect(await sys.nextUnprocessed(2, 0, 100, 10)).toHaveLength(1);       // chain 2 untouched
expect(await sys.getChain(1)).toMatchObject({ indexedBlock: 0, currentRevisionId: 0, entityRevisionId: 0 });
// resetAll
await sys.resetAll(); expect((await db.listCollections().toArray()).filter(c => /^(sys_|ent_)/.test(c.name))).toEqual([]);
```
- [ ] **Step 2:** Run `npx vitest run test/unit/store.test.ts` → FAIL.
- [ ] **Step 3:** Implement. `nextUnprocessed` filter `{ chainId, processRevisionId: { $ne: revisionId }, blockNumber: { $lte: maxBlock } }` sorted `blockNumber, txIndex, logIndex`. Bulk writes are unordered `bulkWrite` upserts; empty arrays are a no-op.
- [ ] **Step 4:** Run → PASS.
- [ ] **Step 5:** `git commit -m "feat: system and entity stores"`

---

### Task 6: Contract codegen and contract runtime

**Files:** Create `src/codegen/abi.ts`, `src/codegen/contracts.ts`, `src/runtime/events.ts`, `src/runtime/contract.ts`; Test `test/unit/abi.test.ts`, `test/unit/contractRuntime.test.ts`, fixture `test/fixture/abis/Sample.json`

**Interfaces — Produces:**
```ts
// codegen/abi.ts
export interface FnInfo { name: string; signature: string; selector: string; inputs: ParamInfo[]; outputs: ParamInfo[] }
export interface EventInfo { name: string; signature: string; topic0: string; inputs: ParamInfo[] }
export interface ParamInfo { name: string; tsType: string }      // unnamed → "_0", "_1"
export function analyzeAbi(contractName: string, abi: unknown[]): { functions: FnInfo[]; events: EventInfo[]; warnings: string[] }
export function solidityToTs(param: ethers.ParamType): string    // table in §8.1; tuples → inline object type
// codegen/contracts.ts
export function emitContract(contractName: string, abi: unknown[], runtimeImport: string): string
// runtime/events.ts
export interface EventDef { name: string; topic0: string; signature: string }
export function decodeLog(iface: ethers.Interface, def: EventDef, log: RawLog): Record<string, unknown>
export function normalizeValue(value: unknown, type: ethers.ParamType): unknown   // bigint, lowercase address, objects for tuples
export function serializeArgs(args: Record<string, unknown>): Record<string, unknown>     // bigint → { __bigint: "123" }
export function deserializeArgs(data: Record<string, unknown>): Record<string, unknown>
// runtime/contract.ts
export function setRpc(pool: Pick<RpcPool, 'ethCall'> | null): void
export class BaseContract {
  constructor(address: string, abi: unknown[])          // lowercases the address
  readonly address: string;
  protected _call(signature: string, args: unknown[]): Promise<unknown>   // eth_call at block().number
}
```

**Decisions:**
- Only `stateMutability` `view`/`pure` functions. Overloaded names: sort by selector ascending, suffix **all** `_0`, `_1`… Events with a shared name: sort by topic0, same suffix rule. Anonymous events are skipped with a warning (Review Focus 5).
- `contractName` and every emitted member name must match `/^[A-Za-z_$][A-Za-z0-9_$]*$/`, otherwise `analyzeAbi` throws naming it. A function named like a `BaseContract` member (`address`) gets suffix `_fn`.
- Bigints are stored as `{ __bigint: "<decimal>" }` so nested tuples/arrays round-trip unambiguously and a plain string arg is never mistaken for a number. No `$`-prefixed key: MongoDB rejects those in updates.
- `_call`: single output returned directly, several as object keyed by output name; throws `ContextError` outside a callback and an error when `setRpc` was not called.
- Emitted file shape (the test pins it):
```ts
import { BaseContract, IndexedEvent, EventDef } from '<runtimeImport>';
export type SampleTransferEvent = IndexedEvent<{ from: string; to: string; value: bigint }>;
export interface SampleEvents { Transfer: SampleTransferEvent; /* … */ }
export class Sample extends BaseContract {
  static readonly abi = [/* full ABI */] as const;
  static readonly events: Record<keyof SampleEvents, EventDef> = { Transfer: { name: 'Transfer', topic0: '0x…', signature: 'Transfer(address,address,uint256)' } };
  static readonly eventTypes = {} as SampleEvents;
  constructor(address: string) { super(address, Sample.abi as unknown as unknown[]); }
  balanceOf(owner: string): Promise<bigint> { return this._call('balanceOf(address)', [owner]) as Promise<bigint>; }
}
```

- [ ] **Step 1: Fixture** `Sample.json`: `balanceOf(address) view`, overloads `get(uint256) view` + `get(address) view`, `info() view returns (uint256 a, address b)`, `pairs() view returns ((uint256 x, address y)[])`, `transfer(address,uint256) nonpayable`, events `Transfer(address indexed from, address indexed to, uint256 value)`, `Transfer(address indexed from, uint256 value)`, `Batch((uint256 id, uint256[] amounts)[] items)`, one anonymous event.
- [ ] **Step 2: Failing tests:**
```ts
const a = analyzeAbi('Sample', abi);
expect(a.functions.map(f => f.name)).not.toContain('transfer');
const gets = a.functions.filter(f => f.name.startsWith('get_'));
expect(gets.map(f => f.name)).toEqual(['get_0', 'get_1']);
expect(gets[0].selector < gets[1].selector).toBe(true);
expect(a.functions.find(f => f.name === 'balanceOf')!.outputs[0].tsType).toBe('bigint');
expect(a.events.map(e => e.name).sort()).toEqual(['Batch', 'Transfer_0', 'Transfer_1']);
expect(a.warnings.some(w => /anonymous/i.test(w))).toBe(true);
expect(() => analyzeAbi('my-token', abi)).toThrow(/my-token/);
const src = emitContract('Sample', abi, 'evm-indexer');
expect(src).toContain('export class Sample extends BaseContract');
expect(src).toContain("balanceOf(owner: string): Promise<bigint>");
expect(src).toContain('info(): Promise<{ a: bigint; b: string }>');
expect(src).not.toMatch(/\btransfer\(/);
// runtime: tuple/nested round trip (Review Focus 4)
const args = decodeLog(iface, batchDef, encodedBatchLog);       // items: [{ id: 1n, amounts: [2n, 3n] }]
expect(args).toEqual({ items: [{ id: 1n, amounts: [2n, 3n] }] });
expect(deserializeArgs(JSON.parse(JSON.stringify(serializeArgs(args))))).toEqual(args);
expect(decodeLog(iface, transfer0Def, log).from).toBe(addr.toLowerCase());
// _call
setRpc({ ethCall: async (to, data, bn) => { seen = { to, bn }; return encodedUint(5n); } });
setContext(ctxAtBlock(42)); expect(await new TestSample(ADDR).balanceOf(ADDR)).toBe(5n); expect(seen).toEqual({ to: ADDR.toLowerCase(), bn: 42 });
clearContext(); await expect(new TestSample(ADDR).balanceOf(ADDR)).rejects.toThrow(ContextError);
```
(`TestSample` is a hand-written subclass in the test that exposes `_call`.)
- [ ] **Step 3:** Run `npx vitest run test/unit/abi.test.ts test/unit/contractRuntime.test.ts` → FAIL.
- [ ] **Step 4:** Implement the four files. Export runtime pieces from `src/index.ts`.
- [ ] **Step 5:** Run → PASS.
- [ ] **Step 6:** `git commit -m "feat: contract codegen and contract runtime"`

---

### Task 7: Entity codegen and entity runtime

**Files:** Create `src/codegen/schema.ts`, `src/codegen/entities.ts`, `src/codegen/index.ts`, `src/runtime/fields.ts`, `src/runtime/entity.ts`; Test `test/unit/schema.test.ts`, `test/unit/entity.test.ts`, `test/unit/codegen.test.ts`

**Interfaces — Produces:**
```ts
// runtime/fields.ts
export type BaseType = 'string' | 'int' | 'float' | 'bigint' | 'decimal' | 'boolean' | 'address' | 'bytes' | 'timestamp' | 'ref';
export interface FieldSpec { type: BaseType; array: boolean; optional: boolean; ref?: string }
export function normalize(spec: FieldSpec, value: unknown, field: string): unknown   // setter coercion + validation
export function toDb(spec: FieldSpec, value: unknown, field: string): unknown
export function fromDb(spec: FieldSpec, value: unknown): unknown
// codegen/schema.ts
export function parseSchema(json: unknown): Record<string, Record<string, FieldSpec>>   // throws SchemaError
export class SchemaError extends Error {}
// runtime/entity.ts
export function setEntityStore(store: EntityStore | null): void
export abstract class BaseEntity {
  readonly id: string;
  constructor(id: string)
  protected static _load<T extends BaseEntity>(cls: new (id: string) => T, id: string): Promise<T | null>
  protected _get(field: string): unknown
  protected _set(field: string, value: unknown): void
  protected _getRef<T extends BaseEntity>(field: string, load: (id: string) => Promise<T | null>): Promise<T | null>
  protected _setRef(field: string, entity: BaseEntity | null): void
  protected _getRefs<T extends BaseEntity>(field: string, load: (id: string) => Promise<T | null>): Promise<T[]>
  protected _setRefs(field: string, entities: BaseEntity[]): void
  save(): Promise<void>
  remove(): Promise<void>
}
// codegen/entities.ts
export function emitEntity(table: string, fields: Record<string, FieldSpec>, runtimeImport: string): string
// codegen/index.ts
export function runCodegen(opts: { abiDir: string; schemaPath: string; outDir: string; runtimeImport?: string /* 'evm-indexer' */ }): { files: string[]; warnings: string[] }
```

**Decisions:**
- Type string grammar: `<base>[\[\]][?]`, base one of the list or `ref:<Table>`.
- `SchemaError` for: unknown type, `ref` to a missing table, field named `id`, `save`, `load`, `remove` or starting with `_`, table/field not a valid identifier, table named like a generated contract is **not** checked here (namespaces are separate folders).
- Each generated class has `static readonly table` and `static readonly fields: Record<string, FieldSpec>`; `BaseEntity` reads them via `this.constructor`.
- Ref field `token: ref:Token` emits `tokenId` get/set, `getToken()`, `setToken(t: Token | null)`; `ref:Token[]` emits `tokenIds`, `getTokens()`, `setTokens(ts)`. Setting the id clears the cached object.
- `normalize`: `int` requires `Number.isInteger`; `address` `/^0x[0-9a-fA-F]{40}$/` → lowercased; `bytes` `/^0x([0-9a-fA-F]{2})*$/` → lowercased; `decimal` accepts `Decimal | string | number`; `timestamp` via `Timestamp.from`; `bigint` requires a bigint.
- `toDb`: `bigint` → decimal string; `decimal` → `Decimal128`, throws when `value.precision(true) > 34`; `timestamp` → `Date`; `int` outside int32 → `Long`. `fromDb` reverses each.
- `save()` throws naming the first required field that is unset; `load`/`save`/`remove` throw `"entities are not available in index callbacks"` when no store is set.
- `runCodegen` validates everything first and writes nothing on failure; writes `contracts/<Name>.ts`, `entities/<Table>.ts`, `index.ts` re-exporting all. A missing `schemaPath` file means "no entities".

- [ ] **Step 1: Failing schema tests:**
```ts
const s = parseSchema({ Pool: { token: 'ref:Token', reserve: 'bigint', tags: 'string[]', note: 'string?', many: 'ref:Token[]?' }, Token: { symbol: 'string' } });
expect(s.Pool.token).toEqual({ type: 'ref', array: false, optional: false, ref: 'Token' });
expect(s.Pool.many).toEqual({ type: 'ref', array: true, optional: true, ref: 'Token' });
for (const bad of [{ A: { x: 'uint' } }, { A: { x: 'ref:B' } }, { A: { id: 'string' } }, { A: { save: 'string' } }, { 'A-B': { x: 'string' } }, { A: { 'x y': 'string' } }])
  expect(() => parseSchema(bad)).toThrow(SchemaError);
```
- [ ] **Step 2: Failing entity tests** (hand-written `Pool`/`Token` subclasses mirroring emitted shape; real `EntityStore` on memory Mongo):
```ts
const p = new Pool('p1'); p.reserve = 5n; p.price = '1.25'; p.createdAt = 1731234567; p.tokenId = 't1'; p.tags = ['a'];
expect(await Pool.load('p1')).toBeNull();                         // nothing written before save
await p.save();
const q = (await Pool.load('p1'))!;
expect(q.reserve).toBe(5n); expect(q.price.toString()).toBe('1.25'); expect(q.createdAt.unix).toBe(1731234567); expect(q.note).toBeUndefined();
expect(await rawDoc('ent_1_Pool', 'p1')).toMatchObject({ reserve: '5', token: 't1' });   // Decimal128 + Date types asserted too
expect(await q.getToken()).toBeNull();
const t = new Token('t1'); t.symbol = 'X'; await t.save();
q.tokenId = 't1'; expect((await q.getToken())!.symbol).toBe('X');
expect(await q.getToken()).toBe(await q.getToken());              // cached
q.setToken(null as any) /* required ref */; await expect(q.save()).rejects.toThrow(/token/);
await expect(new Pool('p2').save()).rejects.toThrow(/reserve|token/);
expect(() => { p.price = '1' + '0'.repeat(40) + '.5'; }).not.toThrow(); await expect(p.save()).rejects.toThrow(/34/);
expect(() => { (p as any).swapCount = 1.5; }).toThrow(/int/);
expect(() => { (p as any).owner = '0x12'; }).toThrow(/address/);
await q.remove(); expect(await Pool.load('p1')).toBeNull();
setEntityStore(null); await expect(Pool.load('p1')).rejects.toThrow(/index callbacks/);
```
- [ ] **Step 3: Failing codegen test:** `runCodegen` on `test/fixture/abis` + a schema into a temp dir with `runtimeImport` pointing at `src/index.ts`; `await import()` the generated `index.ts`; assert `Sample`, `Pool`, `Token` exist, `new Pool('x')` has `tokenId`, `getToken`, `setToken`; a schema with `{ A: { x: 'nope' } }` throws and leaves the out dir empty.
- [ ] **Step 4:** Run the three test files → FAIL.
- [ ] **Step 5:** Implement. Export runtime pieces from `src/index.ts`.
- [ ] **Step 6:** Run → PASS.
- [ ] **Step 7:** `git commit -m "feat: entity codegen, field codecs and entity runtime"`

---

### Task 8: defineIndexer, defineTemplate, config loading

**Files:** Create `src/runtime/define.ts`, `src/config/indexerConfig.ts`; Test `test/unit/define.test.ts`, `test/unit/define.types.test.ts`

**Interfaces — Consumes:** `EventDef`, `BaseContract`, `IndexedEvent` (Task 6).

**Interfaces — Produces:**
```ts
export interface ContractClass<E> { new (address: string): BaseContract; readonly abi: readonly unknown[];
  readonly events: Record<string, EventDef>; readonly eventTypes: E }
export type Callback<Ev> = (event: Ev) => void | Promise<void>;
export type EventEntry<Ev> = null | Callback<Ev> | { index?: Callback<Ev>; process?: Callback<Ev> };
export interface SourceDef<E> { contract: ContractClass<E>; events: { [K in keyof E]?: EventEntry<E[K]> } }
export class Template<E> { readonly def: SourceDef<E>; name: string | null; create(address: string): Promise<void> }
export function defineTemplate<E>(def: SourceDef<E>): Template<E>
export function defineIndexer<C, T>(cfg: {
  contracts: { [K in keyof C]: SourceDef<C[K]> };
  templates?: { [K in keyof T]: Template<T[K]> };
}): NormalizedConfig
export interface NormalizedSource { name: string; kind: 'contract' | 'template'; contract: ContractClass<any>;
  events: Record<string, { index?: Callback<any>; process?: Callback<any> }> }
export interface NormalizedConfig { sources: Record<string, NormalizedSource> }
export type TemplateSink = (template: string, address: string) => Promise<void>;
export function setTemplateSink(sink: TemplateSink | null): void
// config/indexerConfig.ts
export function loadIndexerConfig(path: string): NormalizedConfig   // tsx/cjs/api require(); default export must be a NormalizedConfig
```

**Decisions:** `defineIndexer` throws when a contract and a template share a name, or an event key is not in `contract.events`. It sets `template.name` to its key. `Template.create` throws `"Template.create is only allowed in index callbacks"` when no sink is set or `currentContext()?.mode !== 'index'`, and `"template is not registered"` when `name` is null. A config with zero events in every source throws.

- [ ] **Step 1: Failing runtime tests:**
```ts
const T = defineTemplate({ contract: FakePool, events: { Swap: h } });
const cfg = defineIndexer({ contracts: { Factory: { contract: FakeFactory, events: { Created: { index: i, process: p }, Paused: null, Owner: p } } }, templates: { PoolT: T } });
expect(cfg.sources.Factory.events).toEqual({ Created: { index: i, process: p }, Paused: {}, Owner: { process: p } });
expect(cfg.sources.PoolT).toMatchObject({ kind: 'template', name: 'PoolT' }); expect(T.name).toBe('PoolT');
expect(() => defineIndexer({ contracts: { X: { contract: FakeFactory, events: { Nope: null } as any } } })).toThrow(/Nope/);
expect(() => defineIndexer({ contracts: { PoolT: … }, templates: { PoolT: T } })).toThrow(/PoolT/);
await expect(T.create(ADDR)).rejects.toThrow(/index callbacks/);                       // no sink
setTemplateSink(async (n, a) => { seen = [n, a]; }); setContext({ ...ctx, mode: 'process' });
await expect(T.create(ADDR)).rejects.toThrow(/index callbacks/);
setContext({ ...ctx, mode: 'index' }); await T.create(ADDR.toUpperCase().replace('0X', '0x')); expect(seen).toEqual(['PoolT', ADDR.toLowerCase()]);
```
- [ ] **Step 2: Failing type test** `define.types.test.ts` (vitest `expectTypeOf` + `@ts-expect-error`; run with `npx vitest run --typecheck`):
```ts
defineIndexer({ contracts: { F: { contract: FakeFactory, events: { Created: (e) => { expectTypeOf(e.args.pool).toEqualTypeOf<string>(); } } } } });
// @ts-expect-error unknown event name
defineIndexer({ contracts: { F: { contract: FakeFactory, events: { Foo: null } } } });
// @ts-expect-error wrong callback parameter type
defineIndexer({ contracts: { F: { contract: FakeFactory, events: { Created: (e: { nope: 1 }) => {} } } } });
```
If excess-key checking does not fire through the mapped inference, constrain `events` with `{ [K in keyof Ev]: K extends keyof E ? EventEntry<E[K]> : never }` over an inferred `Ev` — the type test is the arbiter.
- [ ] **Step 3:** Run → FAIL. **Step 4:** Implement; add `typecheck: { enabled: true, include: ['test/unit/*.types.test.ts'] }` to `vitest.config.ts`. **Step 5:** Run → PASS.
- [ ] **Step 6:** Loader test: a temp `indexer.config.ts` importing `defineIndexer` by relative path loads into a `NormalizedConfig`; a file without default export throws `ConfigError`. Implement `loadIndexerConfig`. Run → PASS.
- [ ] **Step 7:** `git commit -m "feat: typed defineIndexer/defineTemplate and config loader"`

---

### Task 9: Registry

**Files:** Create `src/indexer/registry.ts`; Test `test/unit/registry.test.ts`

**Interfaces — Consumes:** `NormalizedSource` (Task 8), `StaticEntry`, `TemplateDoc`, `RawLog`.

**Interfaces — Produces:**
```ts
export interface Match { source: NormalizedSource; eventName: string; def: EventDef }
export class Registry {
  constructor(sources: Record<string, NormalizedSource>)
  addStatic(entries: StaticEntry[]): void                 // throws RegistryError on an address owned by another source
  add(source: string, address: string, block: number): 'added' | 'exists' | 'conflict'
  match(log: RawLog): Match | null                        // address + topic0 + log.blockNumber >= entry.block
  addresses(): string[]; topics(): string[]; minBlock(): number | null; size(): number
  topicsOf(address: string): string[]
}
export class RegistryError extends Error {}
```

- [ ] **Step 1: Failing tests:**
```ts
r.addStatic([{ source: 'Factory', address: A, block: 100 }]);
expect(r.match(log(A, CREATED_TOPIC, 99))).toBeNull();
expect(r.match(log(A, CREATED_TOPIC, 100))!.eventName).toBe('Created');
expect(r.match(log(A, OTHER_TOPIC, 100))).toBeNull();                 // event not configured
expect(r.match(log(B, CREATED_TOPIC, 100))).toBeNull();
expect(r.add('PoolT', B, 150)).toBe('added'); expect(r.add('PoolT', B, 150)).toBe('exists');
expect(r.add('PoolT', A, 150)).toBe('conflict');                      // Review Focus 1
expect(() => r.addStatic([{ source: 'Other', address: A, block: 1 }])).toThrow(RegistryError);
expect(r.minBlock()).toBe(100); expect(r.topics().sort()).toEqual([CREATED_TOPIC, SWAP_TOPIC].sort());
expect(new Registry(sources).minBlock()).toBeNull();
```
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement (one `Map<address, entry>`). **Step 4:** Run → PASS.
- [ ] **Step 5:** `git commit -m "feat: indexer registry"`

---

### Task 10: Scanners (backfill, head, bloom)

**Files:** Create `src/indexer/bloom.ts`, `src/indexer/backfill.ts`, `src/indexer/head.ts`, `src/indexer/scan.ts`; Test `test/unit/bloom.test.ts`, `test/unit/scanners.test.ts`

**Interfaces — Consumes:** `RpcPool` (`getLogs`, `getBlocks`, `getBlockLogs`, `size`, `ResizeError`), `Registry`.

**Interfaces — Produces:**
```ts
// scan.ts
export interface ScanBatch {
  from: number; to: number;
  logs: RawLog[];                                   // registry matches only, sorted block/tx/log
  getBlock(n: number): Promise<RawBlock>;           // any block that has a returned log
  logsFor(address: string, fromBlock: number): Promise<RawLog[]>;   // that address, fromBlock..to, registry-matched, sorted
}
export interface Scanner { scan(from: number, target: number): Promise<ScanBatch> }
export function sortLogs(logs: RawLog[]): RawLog[]
// bloom.ts
export function bloomMayContain(logsBloom: string, hexValue: string): boolean      // Ethereum 2048-bit bloom, 3 bits from keccak256
export function blockMayMatch(logsBloom: string, addresses: string[], topics: string[]): boolean  // any address AND any topic
// backfill.ts / head.ts
export class BackfillScanner implements Scanner { constructor(pool: RpcPool, registry: Registry) }
export class HeadScanner implements Scanner { constructor(pool: RpcPool, registry: Registry, useBloom: boolean) }
```

**Decisions:**
- Both scanners loop on `ResizeError`: recompute the range/batch from `pool.size(...)` and call again.
- Backfill `to = min(from + pool.size('logRange') − 1, target)`. With `registry.size() > 100` the `address` filter is omitted. Blocks for matched logs are fetched eagerly in chunks of `pool.size('blockBatch')`. `logsFor` = `getLogs({ fromBlock, toBlock: to, address: [address], topics })` then registry filter.
- Head `to = min(from + pool.size('blockBatch') − 1, target)`. It keeps every fetched block and, per block, either its full log list or a "skipped by bloom" mark. `logsFor` re-filters kept log lists and, for skipped blocks ≥ `fromBlock` whose bloom may contain the address, calls `getBlockLogs` then.
- An all-zero `logsBloom` with `useBloom` on is treated as "may match" when the block has transactions (guards chains that do not fill the bloom).

- [ ] **Step 1: Failing bloom tests:** build a bloom from a known address + topic with a test helper using `ethers.keccak256`; `bloomMayContain` true for both, false for an unrelated address; `blockMayMatch(bloom, [addr], [otherTopic])` false; all-zero bloom → `bloomMayContain` false.
- [ ] **Step 2: Failing scanner tests** (fake pool object implementing the consumed methods over an in-memory chain of blocks/logs):
```ts
// backfill
const b = await new BackfillScanner(pool, reg).scan(100, 5000);
expect([b.from, b.to]).toEqual([100, 599]); expect(b.logs.map(key)).toEqual(expectedSorted);
expect((await b.getBlock(b.logs[0].blockNumber)).number).toBe(b.logs[0].blockNumber);
// resize: pool.getLogs throws ResizeError once and size drops 500 → 250
expect((await scanner.scan(100, 5000)).to).toBe(349);
// > 100 addresses → getLogs called without address filter, still only matched logs returned
// logsFor returns only that address's matched logs within fromBlock..to
// head
const h = await new HeadScanner(pool, reg, true).scan(100, 104);
expect(h.to).toBe(104); expect(pool.getBlockLogsCalls).toEqual([102]);      // only the bloom-matching block
expect(h.logs.map(key)).toEqual(expectedSorted);
// head logsFor: new address NEW emitted in block 102 (already loaded) and 103 (skipped; bloom matches NEW)
reg.add('PoolT', NEW, 102); expect((await h.logsFor(NEW, 102)).map(l => l.blockNumber)).toEqual([102, 103]);
// useBloom false → getBlockLogs for every block
// equality: same chain data → BackfillScanner and HeadScanner return identical logs for [100,104]
// zero bloom + transactions → block is fetched
```
- [ ] **Step 3:** Run `npx vitest run test/unit/bloom.test.ts test/unit/scanners.test.ts` → FAIL. **Step 4:** Implement. **Step 5:** Run → PASS.
- [ ] **Step 6:** `git commit -m "feat: backfill and head scanners with bloom skip"`

---

### Task 11: Indexer loop

**Files:** Create `src/indexer/indexer.ts`; Test `test/unit/indexer.test.ts`

**Interfaces — Consumes:** Tasks 3–10.

**Interfaces — Produces:**
```ts
export interface IndexerDeps { chain: ChainConfig; pool: RpcPool; store: SystemStore; config: NormalizedConfig;
  statics: StaticEntry[]; scanners?: { backfill: Scanner; head: Scanner }; sleep?: (ms: number) => Promise<void> }
export class Indexer {
  constructor(deps: IndexerDeps)
  init(): Promise<void>               // store.init, registry from statics + sys_templates, setRpc, setTemplateSink
  tick(): Promise<'worked' | 'idle'>  // one range; 'idle' when indexedBlock >= target
  run(): Promise<never>               // loop; on AllRpcFailedError or any error: log.error, sleep pollInterval, retry same range
  status(): { chainId: number; name: string; currentBlock: number; indexBlock: number }
  lastLoopAt(): number
}
```

**Algorithm (§6.2 steps 4–6):**
```
head = pool.getBlockNumber(); target = head - confirmations
from = state.indexedBlock > 0 ? state.indexedBlock + 1 : registry.minBlock()
if registry.minBlock() == null or from > target → heartbeat, return 'idle'
scanner = (target - from + 1 > headThreshold) ? backfill : head
batch = scanner.scan(from, target)
queue = batch.logs; i = 0; events = []; txs = Map
while i < queue.length:
  log = queue[i++]; m = registry.match(log); if !m continue
  blk = batch.getBlock(log.blockNumber); rawTx = blk.transactions[tx with hash]
  args = decodeLog(...); setContext(mode 'index'); pending = []
  try { await m.source.events[m.eventName].index?.(event) } finally { clearContext() }
  events.push(doc with processRevisionId -1); txs.set(hash, txDoc)
  for each address created during this callback (sink result 'added'):
     extra = (await batch.logsFor(address, log.blockNumber)).filter(l => after(l, log))
     queue = sortLogs(dedupe(queue.slice(i) ∪ extra)); i = 0
store.upsertTransactions; store.upsertEvents; store.setIndexed(chainId, batch.to)
```
- The template sink calls `registry.add(name, address, block().number)`; on `'added'` it awaits `store.addTemplate` and records the address for catch-up; on `'exists'` nothing; on `'conflict'` `log.error` warning and nothing (Review Focus 1).
- A log without its transaction in the fetched block throws (range is retried).
- While more than `headThreshold` behind, print `log.task('index', …)` with `eta(...)` every 10 s.

- [ ] **Step 1: Failing tests** (memory Mongo, fake scanners/pool, config with `Factory.Created` index callback creating `PoolT`, `PoolT.Swap`):
```ts
// basic: stores events + one tx doc per tx, indexedBlock = batch.to, processRevisionId -1
// start block: fresh chain starts at registry.minBlock(); after a tick it starts at indexedBlock + 1
// mode: target-from+1 = 65 → backfill.scan called; = 64 → head.scan called
// idle: from > target → 'idle', no scan, heartbeat written
// template in range: Created at (10,0,0) creates P; P.Swap at (10,0,1), (10,1,0), (12,0,0) and one at (10,0,0)-earlier index (9,0,0)
//   → Swap events stored for the three later logs only, in order; sys_templates has { template:'PoolT', address:P, block:10 }
// chained templates: a template event's index callback creates another template → its later logs are indexed too
// index callback context: inside callback tx().hash === log.transactionHash, block().number === log.blockNumber, chain().id === chainId
// entity access inside index callback rejects with /index callbacks/
// Template.create of a static address → no sys_templates row, no throw
// crash safety: scanner ok, store.upsertEvents throws → indexedBlock unchanged; next tick re-runs, final state has no duplicates
// restart: new Indexer over same DB picks template P from sys_templates into the registry
// confirmations 5, head 100 → target 95
```
- [ ] **Step 2:** Run `npx vitest run test/unit/indexer.test.ts` → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** `git commit -m "feat: indexer loop with index callbacks and templates"`

---

### Task 12: Processor loop

**Files:** Create `src/processor/processor.ts`; Test `test/unit/processor.test.ts`

**Interfaces — Produces:**
```ts
export interface ProcessorDeps { chain: ChainConfig; pool: RpcPool; store: SystemStore; entities: EntityStore;
  config: NormalizedConfig; batchSize?: number /* 500 */; sleep?: (ms: number) => Promise<void> }
export class Processor {
  constructor(deps: ProcessorDeps)
  init(): Promise<void>                      // store.init, setRpc, setEntityStore
  tick(): Promise<'worked' | 'idle'>         // one batch
  run(): Promise<never>                      // on callback error: log.error with event key, sleep pollInterval, retry
  status(): { chainId: number; name: string; currentBlock: number; indexBlock: number; processBlock: number; revisionId: number }
  lastLoopAt(): number
}
```

**Algorithm (§7.2):** each `tick` re-reads `sys_chains`; if `entityRevisionId !== currentRevisionId` → `dropEntities`, `setEntityRevision(current)`, `log.step`. Then `nextUnprocessed(chainId, current, indexedBlock, batchSize)`; for each event: `getTransaction` (missing → throw), `deserializeArgs`, `setContext(mode 'process')`, run `config.sources[source]?.events[event]?.process`, `clearContext`, `stampEvent`. A callback error propagates out of `tick` **before** the stamp. Unknown source/event → warn once per pair, stamp (Review Focus 3). After the batch `setProcessed(chainId, lastEvent.blockNumber)`; with an empty batch `setProcessed(chainId, indexedBlock)` and return `'idle'`. `currentBlock` in `status()` comes from `pool.getBlockNumber()` refreshed at most every 5 s inside `tick`.

- [ ] **Step 1: Failing tests** (memory Mongo; events inserted directly; callbacks write entities via hand-written `Counter` entity):
```ts
// order: callbacks see events in (block, tx, log) order regardless of insert order
// typed args: callback receives bigint args and tx().from / block().timestamp.unix from sys_transactions
// stamp: after tick all events have processRevisionId 0; second tick is 'idle' and calls no callback
// null callback: event without process handler is stamped
// only up to indexedBlock: event at block 50 with indexedBlock 40 is not processed
// failure: callback throws on 2nd event → tick rejects; 1st stamped, 2nd and 3rd not; after fixing, tick resumes at the 2nd
// replay: Counter.count === 3; setRevision(1,1); tick → entities dropped and rebuilt, count === 3 (not 6), entityRevisionId 1
// revision change picked up between ticks without constructing a new Processor
// unknown source: event with source 'Gone' → stamped, warning logged once for two such events
// Template.create inside a process callback rejects with /index callbacks/
// contract call in a callback uses the event's block: pool.ethCall received blockNumber === event.blockNumber
// status(): processBlock === indexedBlock when idle
```
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** `git commit -m "feat: processor loop with revision replay"`

---

### Task 13: Status server

**Files:** Create `src/server/index.ts`; Test `test/unit/server.test.ts`

**Interfaces — Produces:**
```ts
export function startServer(opts: { port: number; status: () => object; lastLoopAt: () => number; now?: () => number }):
  Promise<{ port: number; close(): Promise<void> }>
```
- `GET /health` → `200 "ok"` when `now − lastLoopAt() < 60_000`, else `503 "stale"`. `GET /status` → `200` JSON of `status()`.

- [ ] **Step 1: Failing tests** (port 0, global `fetch`): fresh loop → 200 `ok`; `lastLoopAt` 61 s old → 503; `/status` returns the object from `status()` verbatim; unknown path → 404.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS.
- [ ] **Step 5:** `git commit -m "feat: health and status endpoint"`

---

### Task 14: CLI

**Files:** Create `src/cli/commands.ts`, `src/cli/index.ts`, `README.md`; Test `test/unit/cli.test.ts`

**Interfaces — Produces:**
```ts
export interface ProjectPaths { root: string }   // chains.json, addresses.json, schema.json, abis/, generated/, indexer.config.ts under root
export function resolveChainId(flag: string | undefined, env: NodeJS.ProcessEnv): number        // flag, else CHAIN_ID; throws ConfigError
export function cmdCodegen(p: ProjectPaths): Promise<void>
export function cmdIndex(p: ProjectPaths, chainId: number): Promise<never>
export function cmdProcess(p: ProjectPaths, chainId: number): Promise<never>
export function cmdSetRevision(db: Db, chainId: number, revision?: number): Promise<number>   // returns the new id; default current + 1
export function cmdReset(db: Db, opts: { chainId?: number; yes: boolean; confirm?: () => Promise<boolean> }): Promise<boolean>
export function assertNotRunning(store: SystemStore, chainId: number, kind: 'indexer' | 'processor'): Promise<void>
```

**Decisions:** `src/cli/index.ts` starts with `#!/usr/bin/env node`, loads `dotenv/config`, uses commander with commands and flags exactly as §9 plus global `--debug` and `--root <dir>` (default `process.cwd()`). `cmdIndex`/`cmdProcess`: load configs → connect → `assertNotRunning` → build pool from `chain.rpc.map(u => new HttpTransport(u))` → `init()` → `startServer` → set the process title to `evm-indexer [<kind>] <chainId>` → `run()`. `cmdSetRevision` rejects a negative or non-integer revision. `cmdReset` without `yes` calls `confirm` (default: readline prompt `Type "yes" to delete …`) and returns `false` when declined. Fatal errors print through `log.error` and exit with code 1. README: install, project layout, the four config files, commands, and the note that changing an index callback needs `reset --chain`.

- [ ] **Step 1: Failing tests:**
```ts
expect(resolveChainId('1329', {})).toBe(1329); expect(resolveChainId(undefined, { CHAIN_ID: '5' })).toBe(5);
expect(() => resolveChainId(undefined, {})).toThrow(/chain/i); expect(() => resolveChainId('abc', {})).toThrow();
expect(await cmdSetRevision(db, 1)).toBe(1); expect(await cmdSetRevision(db, 1, 7)).toBe(7);
await expect(cmdSetRevision(db, 1, -1)).rejects.toThrow();
expect(await cmdReset(db, { chainId: 1, yes: false, confirm: async () => false })).toBe(false);   // data still there
expect(await cmdReset(db, { chainId: 1, yes: true })).toBe(true);                                 // chain 1 empty, chain 2 intact
expect(await cmdReset(db, { yes: true })).toBe(true);                                             // no sys_/ent_ collections left
await store.heartbeat(1, 'indexer'); await expect(assertNotRunning(store, 1, 'indexer')).rejects.toThrow(/already running/);
await expect(assertNotRunning(store, 1, 'processor')).resolves.toBeUndefined();
```
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement. **Step 4:** Run → PASS; `npm run build` succeeds and `node dist/cli/index.js --help` lists `codegen`, `index`, `process`, `set-revision`, `reset`.
- [ ] **Step 5:** `git commit -m "feat: CLI commands and README"`

---

### Task 15: End-to-end integration test

**Files:** Create `test/fixture/hardhat.config.cjs`, `test/fixture/contracts/Factory.sol`, `test/fixture/contracts/Pool.sol`, `test/fixture/project/{chains.json,addresses.json,schema.json,indexer.config.ts,handlers.ts}`, `test/integration/globalSetup.ts`, `test/integration/e2e.test.ts`; Modify `vitest.config.ts` (integration project with `globalSetup`, `testTimeout: 120_000`)

**Fixture:**
- `Factory.sol`: `createPool() returns (address)` deploys a `Pool`, emits `PoolCreated(address indexed pool, uint256 index)` and, **in the same transaction after creation**, calls `pool.ping()`; `uint256 public poolCount`.
- `Pool.sol`: `ping()` emits `Ping(address indexed sender, uint256 n)` with an incrementing `n`; `uint256 public pings`.
- `schema.json`: `PoolEntity { createdAt: timestamp, pings: int, lastPing: bigint, creator: address }`, `Stats { poolCount: int }`.
- `indexer.config.ts`: `Factory.PoolCreated` → `index: PoolTemplate.create(e.args.pool)`, `process: handlePoolCreated`; template `PoolTemplate` (`Pool`) with `Ping: handlePing`.
- Handlers: `handlePoolCreated` creates `PoolEntity` (`createdAt = block().timestamp`, `creator = tx().from`, `pings = 0`, `lastPing = 0n`) and sets `Stats('global').poolCount = Number(await new Factory(e.address).poolCount())`; `handlePing` increments `pings` and sets `lastPing = e.args.n`.
- `globalSetup`: `hardhat compile` (cwd `test/fixture`), copy the two ABIs into `test/fixture/project/abis`, `runCodegen` with `runtimeImport` → `src/index.ts`, spawn `hardhat node --port 8546`, wait for the port; teardown kills it. Chain id 31337; `chains.json` rpc `http://127.0.0.1:8546`, `headThreshold: 3`.

**Scenario (one test file, sequential, memory Mongo, `Indexer`/`Processor` driven by `tick()` until `'idle'`):**
- [ ] **Step 1: Write the test:**
```ts
// arrange: deploy Factory (block = addresses.json block, written by the test), createPool() x2, ping pool A x3, pool B x1, mine 5 empty blocks
// 1 index (backfill then head, since headThreshold 3): sys_templates has 2 rows; sys_events has 2 PoolCreated + 6 Ping
//   (the same-tx Ping after each creation is included); every event has a sys_transactions doc; indexedBlock === head
// 2 process: PoolEntity A { pings: 4, lastPing: 4n, creator: deployer }, B { pings: 2 }; Stats.poolCount === 2
//   (contract call ran at the event's block: after the first PoolCreated the handler read poolCount 1, final value 2)
// 3 head mode: one more ping on A, tick indexer + processor → A.pings === 5
// 4 replay: cmdSetRevision(db, 31337); tick processor → same entity values as before (A.pings === 5, not 10); entityRevisionId === 1
// 5 restart safety: new Indexer on the same DB ticks 'idle'; event count unchanged
// 6 reset chain: cmdReset(db, { chainId: 31337, yes: true }) → no events, no ent_31337_* collections, indexedBlock 0
// 7 re-index from scratch after reset yields the same event count as step 3
```
- [ ] **Step 2:** Run `npm run test:integration` → FAIL on the first assertion that exposes a real defect, or PASS. Fix defects in the owning module with a unit test added there first.
- [ ] **Step 3:** Run `npm test` (all unit + integration) → PASS; `npx tsc --noEmit` and `npm run build` clean.
- [ ] **Step 4:** `git commit -m "test: end-to-end integration against a hardhat node"`
