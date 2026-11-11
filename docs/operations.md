# Operations

What to run, what to watch, and what to do when something changes.

## Status endpoint

`index` and `process` each start an HTTP server on `PORT` (default 3000). Give the two
processes different ports on one machine; a port in use is reported with its number.

**`GET /health`**

- `200 ok` while the loop made progress within the last 60 s.
- `503` otherwise.

Progress is a successful loop iteration, a processed event, or a scan or store step of the
indexer. A long healthy batch stays `200`; a loop that keeps failing turns `503`.

**`GET /status`**

| Process | Response |
|---|---|
| indexer | `{ chainId, name, currentBlock, indexBlock }` |
| processor | `{ chainId, name, currentBlock, indexBlock, processBlock, revisionId }` |

- `currentBlock`: the chain head as last seen by the loop.
- `indexBlock`: the last block the indexer has fully stored.
- `processBlock`: the last block the processor has worked on.

## When you change something

| Change | What to do |
|---|---|
| A process callback | `set-revision --chain <id>`. The processor drops the chain's entities and replays all stored events. No re-index |
| `schema.ts` | `codegen`, then `set-revision --chain <id>` |
| An ABI | `codegen`. If the events you index changed, also reset and re-index |
| An index callback | Stop both processes, `reset --chain <id>`, start `index`, then `process` |
| Events or contracts in `indexer.config.ts`, or `addresses.ts` | Stop both processes, `reset --chain <id>`, index again. Newly added events and addresses are not backfilled otherwise |
| `chains.ts` (RPCs, limits) | Restart the affected process |

## Resetting safely

Stop the indexer and the processor of a chain before resetting it. A running indexer keeps
its template addresses in memory; a reset removes them from the database, so after its
next restart those addresses would never be indexed again. That is why `reset` refuses
while a heartbeat is fresh. `--force` overrides the check for a process that is known to
be gone.

## Things to know

- **Archive RPC:** contract reads in callbacks run at the event's block. A processor that
  is far behind the head, and every replay, needs an archive node.
- **Reorgs are not rolled back.** Set `confirmations` in `chains.ts` on chains that
  reorganise; the indexer then stays that many blocks behind the head.
- **A failing callback stops the processor** at that event and retries it. Fix the
  callback and restart, or the processor will not move on.
- **Idempotence:** if the processor dies between a callback's saves and the "done" mark,
  that one event runs again on restart. A callback like `balance += amount` can then count
  once too often. Replay with `set-revision` to repair.
- **Undecodable logs:** a log whose topic matches but whose layout does not fit the ABI
  (an ERC-721 `Transfer` at an address configured as ERC-20) is skipped and logged in red
  once per address and topic.
- **Templates** are indexed only from after their creating event.
- **Local CLI:** run the project's own `evm-indexer`, not a global install. With two
  copies of the package, callbacks cannot see the context the CLI sets.

## Collections

| Collection | Content |
|---|---|
| `sys_events` | Every indexed event with its decoded data and revision mark |
| `sys_transactions` | One document per transaction that has indexed events |
| `sys_chains` | Per chain: indexed block, processed block, revision, heartbeats |
| `sys_templates` | Addresses added at runtime, with the position of the creating event |
| `ent_<chainId>_<Table>` | Your entities |

Details are in [How it works](how-it-works.md#data-model).

## Deployment sketch

- One `index` and one `process` per chain, as two services, each with its own `PORT`.
- Point a liveness probe at `/health`.
- Send SIGTERM to stop; allow at least 30 s before a hard kill.
- Both processes share `MONGO_URI` and `MONGO_DB`.
