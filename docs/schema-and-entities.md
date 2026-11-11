# Schema and entities

`schema.ts` defines your tables. `evm-indexer codegen` turns each table into an entity
class that process callbacks use to read and write MongoDB.

## schema.ts

Root keys are table names; each maps field names to a type string. The file default-exports
the result of `defineSchema`.

```ts
import { defineSchema } from 'evm-indexer';

export default defineSchema({
  Pool: { token: 'ref:Token', reserve: 'bigint', price: 'decimal',
          createdAt: 'timestamp', tags: 'string[]', note: 'string?' },
  Token: { symbol: 'string', decimals: 'int' },
});
```

The type strings are checked by the compiler: an unknown field type, or a `ref:` to a
table that is not in the schema, is a type error. The CLI does not type-check, so run
`npx tsc --noEmit`. `codegen` validates the schema again at runtime and writes nothing on
an error.

`schema.ts` is loaded before `generated/` exists. It must not import from `generated/`.

### Field types

| Type | In code | In MongoDB |
|---|---|---|
| `string` | `string` | string |
| `int` | `number` (safe integer, checked when set) | int / long |
| `float` | `number` | double |
| `bigint` | `bigint` | decimal string (not numerically sortable) |
| `decimal` | `Decimal` (decimal.js); setter also takes string / number | `Decimal128` |
| `boolean` | `boolean` | bool |
| `address` | lowercase `string`, validated | string |
| `bytes` | hex `string`, validated | string |
| `timestamp` | `Timestamp`; setter takes unix seconds, `Date` or `Timestamp` | `Date` |
| `ref:<Table>` | see [References](#references) | the referenced id (string) |

Modifiers: `[]` for arrays, `?` for optional. Both can be combined (`string[]?`) and both
work on `ref`.

### Rules

- Every entity has a string `id`, stored as `_id`. A table cannot declare a field named `id`.
- Field names cannot be `save`, `load` or `remove`, and cannot start with `_`.
- A `ref` must point to an existing table.
- Table and field names must be valid identifiers. Two tables cannot differ only by case.

## Entity API

```ts
import { Pool } from './generated';

const pool = (await Pool.load(id)) ?? new Pool(id);
pool.reserve = 5n;        // in memory only
await pool.save();        // upsert of the whole document
await pool.remove();      // delete
```

- `load(id)` returns `null` when the document does not exist.
- Setting a field changes nothing in the database until `save()`.
- An invalid value (a non-integer for `int`, a malformed `address`) throws in the setter.
- `save()` throws when a required field was never set.
- Entities are only available in process callbacks.
- Collections are named `ent_<chainId>_<Table>`. The prefix keeps them apart from the
  system collections (`sys_*`), and the chain id keeps chains apart.

## References

A field `token: "ref:Token"` stores only the id of the other document.

```ts
pool.tokenId = '0x…';                  // sync, no read; clears the cached object
pool.tokenId;                          // the raw id
const token = await pool.getToken();   // loads on first call, then cached; null if missing
pool.setToken(token);                  // sets id and cache
```

An array reference `tokens: "ref:Token[]"` gives `tokenIds`, `getTokens()` and
`setTokens()`. The ids property drops one trailing `s` from the field name.

## Timestamp

A `timestamp` field accepts unix seconds, a `Date` or a `Timestamp`, and returns a
`Timestamp`:

```ts
pool.createdAt = 1731234567;          // unix seconds
pool.createdAt = new Date();
pool.createdAt = block().timestamp;   // block().timestamp is a Timestamp

pool.createdAt.unix;   // 1731234567 (seconds)
pool.createdAt.ms;     // 1731234567000
pool.createdAt.date;   // JS Date (UTC)
pool.createdAt.iso;    // "2024-11-10T10:29:27.000Z"
```

Numbers are always read as unix seconds, never milliseconds. The value is stored as a
MongoDB `Date`, so it sorts and filters natively.

## Decimal

A `decimal` field is a `Decimal` from decimal.js, exported from `evm-indexer`:

```ts
import { Decimal } from 'evm-indexer';

pool.price = new Decimal('1.25');
pool.price = '1.25';                  // string or number also work
pool.price.mul(2);
```

It is stored as `Decimal128`, which sorts and range-queries correctly but holds 34
significant digits. `save()` throws on a value that needs more, rather than rounding. Keep
raw `uint256` amounts in `bigint` fields.

## A contract and a table with the same name

A table may share its name with a contract (ABI file). `generated/index.ts` then exports
the contract under the name and the entity as `<Name>Entity`; `codegen` prints a warning
for each. Both stay available under their own names from the sub-folders:

```ts
import { Pool, PoolEntity } from './generated';          // contract Pool, entity Pool
import { Pool as PoolRow } from './generated/entities';  // the entity under its own name
```

The MongoDB collection always follows the table name (`ent_<chainId>_Pool`).

`codegen` fails when `<Name>Entity` is itself taken by a contract or a table, or when a
table is named like a type a contract file exports (`<Contract>Events`,
`<Contract><Event>Event`).
