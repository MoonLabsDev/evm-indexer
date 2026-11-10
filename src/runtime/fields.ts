import { Decimal128, Long } from 'mongodb';
import Decimal from 'decimal.js';
import { Timestamp } from './timestamp';

export type BaseType = 'string' | 'int' | 'float' | 'bigint' | 'decimal' | 'boolean' | 'address' | 'bytes' | 'timestamp' | 'ref';

export interface FieldSpec {
  type: BaseType;
  array: boolean;
  optional: boolean;
  /** Target table, only for `type: 'ref'`. */
  ref?: string;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BYTES = /^0x([0-9a-fA-F]{2})*$/;
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;
const DECIMAL128_DIGITS = 34;

function describe(v: unknown): string {
  return typeof v === 'string' ? JSON.stringify(v) : typeof v === 'bigint' ? `${v}n` : String(v);
}

function fail(field: string, expected: string, value: unknown): never {
  throw new Error(`Field "${field}" expects ${expected}, got ${describe(value)}`);
}

function normalizeOne(spec: FieldSpec, v: unknown, field: string): unknown {
  switch (spec.type) {
    case 'string':
    case 'ref':
      if (typeof v !== 'string') fail(field, spec.type === 'ref' ? 'a string id (ref)' : 'a string', v);
      return v;
    case 'int':
      if (typeof v !== 'number' || !Number.isSafeInteger(v)) fail(field, 'a safe integer (int)', v);
      return v;
    case 'float':
      if (typeof v !== 'number' || !Number.isFinite(v)) fail(field, 'a finite number (float)', v);
      return v;
    case 'bigint':
      if (typeof v !== 'bigint') fail(field, 'a bigint', v);
      return v;
    case 'boolean':
      if (typeof v !== 'boolean') fail(field, 'a boolean', v);
      return v;
    case 'address':
      if (typeof v !== 'string' || !ADDRESS.test(v)) fail(field, 'a 20-byte hex address (address)', v);
      return v.toLowerCase();
    case 'bytes':
      if (typeof v !== 'string' || !BYTES.test(v)) fail(field, 'a 0x-prefixed hex string (bytes)', v);
      return v.toLowerCase();
    case 'decimal': {
      if (!(Decimal.isDecimal(v) || typeof v === 'string' || typeof v === 'number')) {
        fail(field, 'a Decimal, string or number (decimal)', v);
      }
      let d: Decimal;
      try {
        d = new Decimal(v as Decimal.Value);
      } catch {
        return fail(field, 'a numeric value (decimal)', v);
      }
      if (!d.isFinite()) fail(field, 'a finite value (decimal)', v);
      return d;
    }
    case 'timestamp':
      if (!(v instanceof Timestamp || v instanceof Date || typeof v === 'number')) {
        fail(field, 'a Timestamp, Date or unix seconds (timestamp)', v);
      }
      try {
        return Timestamp.from(v);
      } catch {
        return fail(field, 'a valid time (timestamp)', v);
      }
  }
}

/** Setter coercion and validation. `null` and `undefined` both mean "unset". */
export function normalize(spec: FieldSpec, value: unknown, field: string): unknown {
  if (value === undefined || value === null) return undefined;
  if (spec.array) {
    if (!Array.isArray(value)) fail(field, 'an array', value);
    return value.map((item, i) => normalizeOne(spec, item, `${field}[${i}]`));
  }
  return normalizeOne(spec, value, field);
}

function toDbOne(spec: FieldSpec, v: unknown, field: string): unknown {
  switch (spec.type) {
    case 'bigint':
      return (v as bigint).toString();
    case 'decimal': {
      const d = v as Decimal;
      if (d.precision(true) > DECIMAL128_DIGITS) {
        throw new Error(`Field "${field}": ${d.toString()} needs more than ${DECIMAL128_DIGITS} significant digits (Decimal128)`);
      }
      return Decimal128.fromString(d.toString());
    }
    case 'timestamp':
      return (v as Timestamp).date;
    case 'int': {
      const n = v as number;
      return n < INT32_MIN || n > INT32_MAX ? Long.fromNumber(n) : n;
    }
    default:
      return v;
  }
}

/** In-memory (already normalized) value to its MongoDB representation. */
export function toDb(spec: FieldSpec, value: unknown, field: string): unknown {
  if (value === undefined || value === null) return undefined;
  return spec.array ? (value as unknown[]).map((item, i) => toDbOne(spec, item, `${field}[${i}]`)) : toDbOne(spec, value, field);
}

function fromDbOne(spec: FieldSpec, v: unknown): unknown {
  switch (spec.type) {
    case 'bigint':
      return BigInt(v as string);
    case 'decimal':
      return new Decimal((v as Decimal128).toString());
    case 'timestamp':
      return Timestamp.from(v as Date);
    case 'int':
      return Long.isLong(v) ? (v as Long).toNumber() : v;
    default:
      return v;
  }
}

/** MongoDB representation back to the in-memory value. */
export function fromDb(spec: FieldSpec, value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  return spec.array ? (value as unknown[]).map((item) => fromDbOne(spec, item)) : fromDbOne(spec, value);
}
