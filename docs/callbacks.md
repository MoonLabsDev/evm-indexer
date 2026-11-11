# Callbacks

Callbacks are the functions you register per event in `indexer.config.ts`. They run one
event at a time, in block / transaction / log order.

```ts
import { tx, block, chain } from 'evm-indexer';
import { Erc20, Pool, type PoolPairSwapEvent } from '../generated';

export async function handleSwap(e: PoolPairSwapEvent) {
  const pool = (await Pool.load(e.address)) ?? new Pool(e.address);
  pool.reserve = (pool.reserve ?? 0n) + e.args.amount0In;
  pool.createdAt = block().timestamp;
  await pool.save();
}
```

## The event

Each callback gets one parameter, typed from the ABI as `<Contract><Event>Event`:

| Property | Meaning |
|---|---|
| `e.args` | The decoded event arguments, by name (`_0`, `_1` when unnamed) |
| `e.address` | The emitting contract (lowercase) |
| `e.blockNumber`, `e.txIndex`, `e.logIndex` | Position of the log |
| `e.txHash` | Transaction hash |

Type mapping: `uint*` / `int*` are `bigint`, addresses are lowercase strings, `bool` is
`boolean`, `bytes` are hex strings, tuples are typed objects, arrays are arrays. An indexed
dynamic argument (string, bytes, array, tuple) arrives as its topic hash.

## Context

Three functions give the Solidity-style context of the current event. They work inside a
callback and throw outside one.

```ts
tx().hash;  tx().from;  tx().to;  tx().value;  tx().nonce;
tx().gasPrice;  tx().input;  tx().transactionIndex;  tx().logIndex;

block().number;  block().hash;  block().timestamp;   // a Timestamp

chain().id;  chain().name;
```

There is no `msg()`. The sender of an inner call is only visible in traces, so
`tx().from` is the transaction's sender and `tx().value` its value.

## Contract reads

Every `view` / `pure` function of an ABI is a method on the generated class. A call runs
as `eth_call` **at the block of the current event**:

```ts
const balance = await new Erc20(tokenAddress).balanceOf(user);
```

- A single return value comes back directly; several come back as an object keyed by
  output name (`_0`, `_1` when unnamed).
- State-changing functions are not generated.
- Because calls run at the event's block, a processor that is far behind the head needs an
  archive RPC.
- A revert is thrown as an error right away. RPC problems are retried and failed over
  first; see [How it works](how-it-works.md#rpc-handling).

## Index callbacks and process callbacks

| | `index` callback | `process` callback |
|---|---|---|
| Runs in | the indexer, once when the event is stored | the processor, over stored events |
| Context and contract reads | yes | yes |
| Entities | no (throws) | yes |
| `Template.create` | yes | no (throws) |

Most events only need a process callback. An index callback exists for one job: telling
the indexer about new contract addresses.

## Templates

A template is a contract whose addresses are not known up front, such as the pools a
factory creates.

```ts
export const PoolTemplate = defineTemplate({
  contract: PoolPair,
  events: { Swap: handleSwap, Sync: null },
});

export default defineIndexer({
  contracts: {
    Factory: {
      contract: Factory,
      events: {
        PoolCreated: { index: (e) => PoolTemplate.create(e.args.pool), process: handlePoolCreated },
      },
    },
  },
  templates: { PoolTemplate },
});
```

- `Template.create(address)` writes the address to the database and adds it to the
  indexer's registry. From then on its listed events are indexed like any static contract.
- **An address is indexed only from after the event that created it.** Earlier logs of
  that address, including earlier ones in the same block, are not read. This holds the same
  way after a retry or a restart.
- Creating an address that already exists for the template does nothing. Creating an
  address that belongs to another contract is skipped with a warning.
- A template must be registered under `templates`, otherwise `create` throws.

## Failure behaviour

- **A process callback that throws** stops the processor at that event. The error is
  logged and the same event is retried after `pollInterval`. Later events are never
  skipped.
- **An index callback that throws** aborts the current range; nothing of it is stored and
  it is retried.
- **Idempotence:** an event is marked done after its callback returns. If the processor
  dies between a callback's saves and that mark, the event runs once more on restart, so
  `balance += amount` can count twice. A replay with `set-revision` repairs it.
- **Unawaited work:** await everything inside a callback. Work that finishes later runs
  without a context or in the next event's context.
