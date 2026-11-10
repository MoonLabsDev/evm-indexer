import { Indexed, Interface, ParamType } from 'ethers';
import type { RawLog } from '../types';

export interface EventDef { name: string; topic0: string; signature: string }

const BIGINT_KEY = '__bigint';

function argName(p: ParamType, i: number): string {
  return p.name || `_${i}`;
}

/** Turns an ethers decode result into plain JS values (bigint, lowercase hex, objects, arrays). */
export function normalizeValue(value: unknown, type: ParamType): unknown {
  // Indexed dynamic types are only available as their topic hash.
  if (Indexed.isIndexed(value)) return String(value.hash).toLowerCase();
  if (type.baseType === 'array') {
    const child = type.arrayChildren as ParamType;
    return Array.from(value as ArrayLike<unknown>, (v) => normalizeValue(v, child));
  }
  if (type.baseType === 'tuple') {
    const comps = type.components as readonly ParamType[];
    const out: Record<string, unknown> = {};
    comps.forEach((c, i) => {
      out[argName(c, i)] = normalizeValue((value as ArrayLike<unknown>)[i], c);
    });
    return out;
  }
  if (type.baseType === 'address') return String(value).toLowerCase();
  if (type.baseType.startsWith('bytes')) return String(value).toLowerCase();
  if (/^u?int/.test(type.baseType)) return BigInt(value as bigint);
  return value;
}

/** Decodes a raw log with the event's full signature, so overloaded events resolve correctly. */
export function decodeLog(iface: Interface, def: EventDef, log: RawLog): Record<string, unknown> {
  const fragment = iface.getEvent(def.signature);
  if (!fragment) throw new Error(`Unknown event ${def.signature}`);
  const decoded = iface.decodeEventLog(fragment, log.data, log.topics);
  const out: Record<string, unknown> = {};
  fragment.inputs.forEach((p, i) => {
    out[argName(p, i)] = normalizeValue(decoded[i], p);
  });
  return out;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function ser(v: unknown): unknown {
  if (typeof v === 'bigint') return { [BIGINT_KEY]: v.toString() };
  if (Array.isArray(v)) return v.map(ser);
  if (isPlainObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, ser(x)]));
  return v;
}

function de(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(de);
  if (isPlainObject(v)) {
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === BIGINT_KEY && typeof v[BIGINT_KEY] === 'string') {
      return BigInt(v[BIGINT_KEY] as string);
    }
    return Object.fromEntries(keys.map((k) => [k, de(v[k])]));
  }
  return v;
}

/** bigint becomes { __bigint: "123" } (no $-prefixed keys: MongoDB rejects those). */
export function serializeArgs(args: Record<string, unknown>): Record<string, unknown> {
  return ser(args) as Record<string, unknown>;
}

export function deserializeArgs(data: Record<string, unknown>): Record<string, unknown> {
  return de(data) as Record<string, unknown>;
}
