import type { BaseType, FieldSpec } from '../runtime/fields';
import { fieldMembers } from './schema';

const GET_TYPE: Record<Exclude<BaseType, 'ref'>, string> = {
  string: 'string', int: 'number', float: 'number', bigint: 'bigint', decimal: 'Decimal',
  boolean: 'boolean', address: 'string', bytes: 'string', timestamp: 'Timestamp',
};
/** Setters accept more than the getter returns for these. */
const SET_TYPE: Partial<Record<BaseType, string>> = {
  decimal: 'Decimal | string | number',
  timestamp: 'Timestamp | Date | number',
};

function withModifiers(base: string, spec: FieldSpec): string {
  let t = base.includes(' ') && spec.array ? `(${base})` : base;
  if (spec.array) t += '[]';
  return spec.optional ? `${t} | undefined` : t;
}

/** Emits the TypeScript source of one entity class. */
export function emitEntity(table: string, fields: Record<string, FieldSpec>, runtimeImport: string): string {
  const L: string[] = [];
  const refs = [...new Set(Object.values(fields).filter((f) => f.type === 'ref').map((f) => f.ref!))]
    .filter((r) => r !== table)
    .sort();

  const types = new Set(Object.values(fields).map((f) => f.type));
  L.push(`import { BaseEntity } from '${runtimeImport}';`);
  // Decimal comes from the runtime too: a client project need not depend on decimal.js itself.
  const typeImports = ['FieldSpec', ...(types.has('timestamp') ? ['Timestamp'] : []), ...(types.has('decimal') ? ['Decimal'] : [])];
  L.push(`import type { ${typeImports.join(', ')} } from '${runtimeImport}';`);
  for (const r of refs) L.push(`import { ${r} } from './${r}';`);
  L.push('');
  L.push(`export class ${table} extends BaseEntity {`);
  L.push(`  static readonly table = ${JSON.stringify(table).replace(/"/g, "'")};`);
  L.push(`  static readonly fields: Record<string, FieldSpec> = ${JSON.stringify(fields, null, 2).replace(/\n/g, '\n  ')};`);
  L.push(`  static load(id: string): Promise<${table} | null> { return BaseEntity._load(${table}, id); }`);

  for (const [name, spec] of Object.entries(fields)) {
    const key = JSON.stringify(name).replace(/"/g, "'");
    const m = fieldMembers(name, spec);
    if (!m.ref) {
      const base = GET_TYPE[spec.type as Exclude<BaseType, 'ref'>];
      const get = withModifiers(base, spec);
      const set = withModifiers(SET_TYPE[spec.type] ?? base, spec);
      L.push(`  get ${m.prop}(): ${get} { return this._get(${key}) as ${get}; }`);
      L.push(`  set ${m.prop}(v: ${set}) { this._set(${key}, v); }`);
      continue;
    }
    const target = spec.ref!;
    const ids = withModifiers('string', spec);
    L.push(`  get ${m.ids}(): ${ids} { return this._get(${key}) as ${ids}; }`);
    L.push(`  set ${m.ids}(v: ${ids}) { this._set(${key}, v); }`);
    if (spec.array) {
      L.push(`  ${m.getRef}(): Promise<${target}[]> { return this._getRefs(${key}, (id) => ${target}.load(id)); }`);
      L.push(`  ${m.setRef}(ts: ${target}[]): void { this._setRefs(${key}, ts); }`);
    } else {
      L.push(`  ${m.getRef}(): Promise<${target} | null> { return this._getRef(${key}, (id) => ${target}.load(id)); }`);
      L.push(`  ${m.setRef}(t: ${target} | null): void { this._setRef(${key}, t); }`);
    }
  }
  L.push('}', '');
  return L.join('\n');
}
