import type { BaseType, FieldSpec } from '../runtime/fields';
import { isIdentifier } from './abi';

export class SchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaError';
  }
}

const BASE_TYPES = new Set<string>(['string', 'int', 'float', 'bigint', 'decimal', 'boolean', 'address', 'bytes', 'timestamp']);
/** Members of BaseEntity (and the generated static `load`) that a field must not shadow. */
const RESERVED_FIELDS = new Set(['id', 'save', 'load', 'remove', 'constructor']);
/** Names a generated entity file already uses at module level, plus words that cannot be a class name. */
const RESERVED_TABLES = new Set([
  'BaseEntity', 'FieldSpec', 'Timestamp', 'Decimal',
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum',
  'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null',
  'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
  'let', 'static', 'implements', 'interface', 'package', 'private', 'protected', 'public', 'await', 'arguments', 'eval',
]);

const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

export type FieldMembers = { ref: false; prop: string } | { ref: true; ids: string; getRef: string; setRef: string };

/**
 * Member names a field produces on the generated class. Shared with the emitter so both agree.
 * An array ref drops one trailing "s" for the id list (`tokens` -> `tokenIds`).
 */
export function fieldMembers(name: string, spec: FieldSpec): FieldMembers {
  if (spec.type !== 'ref') return { ref: false, prop: name };
  const stem = spec.array && name.length > 1 && name.endsWith('s') ? name.slice(0, -1) : name;
  return {
    ref: true,
    ids: spec.array ? `${stem}Ids` : `${name}Id`,
    getRef: `get${cap(name)}`,
    setRef: `set${cap(name)}`,
  };
}

function memberNames(name: string, spec: FieldSpec): string[] {
  const m = fieldMembers(name, spec);
  return m.ref ? [m.ids, m.getRef, m.setRef] : [m.prop];
}

function parseType(where: string, raw: unknown, tables: Set<string>): FieldSpec {
  if (typeof raw !== 'string') throw new SchemaError(`${where}: type must be a string, got ${JSON.stringify(raw)}`);
  let rest = raw;
  let optional = false;
  let array = false;
  if (rest.endsWith('?')) {
    optional = true;
    rest = rest.slice(0, -1);
  }
  if (rest.endsWith('[]')) {
    array = true;
    rest = rest.slice(0, -2);
  }
  if (rest.startsWith('ref:')) {
    const ref = rest.slice(4);
    if (!isIdentifier(ref)) throw new SchemaError(`${where}: invalid reference "${raw}"`);
    if (!tables.has(ref)) throw new SchemaError(`${where}: references unknown table "${ref}"`);
    return { type: 'ref', array, optional, ref };
  }
  if (!BASE_TYPES.has(rest)) throw new SchemaError(`${where}: unknown type "${raw}"`);
  return { type: rest as BaseType, array, optional };
}

/** Validates the schema (the value of `schema.ts`) and turns it into field specs per table. */
export function parseSchema(json: unknown): Record<string, Record<string, FieldSpec>> {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new SchemaError('Schema must be an object mapping table names to field definitions');
  }
  const root = json as Record<string, unknown>;
  const tables = new Set(Object.keys(root));
  const out: Record<string, Record<string, FieldSpec>> = {};

  for (const [table, defs] of Object.entries(root)) {
    if (!isIdentifier(table) || RESERVED_TABLES.has(table)) throw new SchemaError(`Invalid table name "${table}"`);
    if (typeof defs !== 'object' || defs === null || Array.isArray(defs)) {
      throw new SchemaError(`${table}: must map field names to types`);
    }
    const fields: Record<string, FieldSpec> = {};
    const members = new Map<string, string>();
    for (const [name, raw] of Object.entries(defs)) {
      const where = `${table}.${name}`;
      if (!isIdentifier(name)) throw new SchemaError(`${where}: invalid field name`);
      if (RESERVED_FIELDS.has(name) || name.startsWith('_')) throw new SchemaError(`${where}: field name is reserved`);
      const spec = parseType(where, raw, tables);
      for (const member of memberNames(name, spec)) {
        const clash = members.get(member);
        if (clash) throw new SchemaError(`${where}: generated member "${member}" clashes with field "${clash}"`);
        members.set(member, name);
      }
      fields[name] = spec;
    }
    out[table] = fields;
  }
  return out;
}
