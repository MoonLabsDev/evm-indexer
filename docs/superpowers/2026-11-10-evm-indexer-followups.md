# evm-indexer — open follow-ups after the initial implementation

Findings from the task reviews and the final review that were judged non-blocking and
left unfixed. None affects stored data.

## Worth doing soon

- **Second Ctrl+C / signals outside the loops.** A signal only sets the stop flag. During
  startup (e.g. Mongo unreachable), `set-revision`, `reset` or `codegen`, Ctrl+C has no
  effect until the command ends or the 30 s timer forces exit. A second signal should exit
  at once. (`src/cli/index.ts`)
- **Global CLI + local package.** A globally installed CLI with a different local
  `node_modules/evm-indexer` copy still gives two runtime instances. Document "run the
  project's local CLI" or keep the runtime singletons on `globalThis`.
- **Single-instance guard race.** Two processes started at the same moment can both pass
  `assertNotRunning` before the first heartbeat is written. Use an atomic claim.
- **Stale generated files.** `codegen` leaves files of removed tables/contracts on disk.
- **Required entity getters** are typed non-optional but return `undefined` on a new
  entity (`pool.count += 1` gives `NaN` without a compile error).
- **Reverts vs RPC failures in handlers.** A `try/catch` around a contract read cannot
  tell a revert from "all RPCs failed". Export a typed error or generate `try_` variants.
- **Fixture type-check coverage.** The by-name CLI fixture (`test/fixture/cli-project`)
  is excluded from every tsconfig; the main fixture is checked only under
  `module: preserve`.
- **`classifyError`** does not recognise every provider's range-limit wording (e.g. "block
  range is too wide"); such errors are fatal and loop. `--debug` shows them.

## Small

- `processedBlock` in `/status` can overstate by one block at a batch boundary.
- Catch-up after template creation re-sorts the whole remaining queue per creating log.
- Bloom check recomputes hashes per address per block.
- Head mode reads receipts one block at a time.
- `HEARTBEAT_FRESH_MS` is defined in both `src/server` and `src/store`.
- Array-reference naming drops exactly one trailing "s" (`statuses` → `statuseIds`).
- `Decimal` precision check counts trailing integer zeros as significant digits.
- `reset --chain N` / `set-revision` for an unknown chain create an empty `sys_chains` row.
- The first failing indexer tick can refresh `/health` once after its scan.
- e2e test reads the indexer's private `scanners` field through a cast.
- Toolchain resolved to very new majors (TypeScript 7, vitest 5, commander 15).
