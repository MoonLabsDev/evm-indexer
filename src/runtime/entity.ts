import type { EntityStore } from '../store/entities';
import { FieldSpec, normalize, toDb, fromDb } from './fields';

// Like the context, the entity store is module-level state shared through the package entry.
let store: EntityStore | null = null;

export function setEntityStore(s: EntityStore | null): void {
  store = s;
}

function requireStore(): EntityStore {
  if (!store) throw new Error('entities are not available in index callbacks');
  return store;
}

interface EntityClass {
  table: string;
  fields: Record<string, FieldSpec>;
}

/** Base of every generated entity class. Subclasses provide `static table` and `static fields`. */
export abstract class BaseEntity {
  readonly id: string;
  private readonly values: Record<string, unknown> = {};
  private readonly refCache = new Map<string, unknown>();

  constructor(id: string) {
    this.id = id;
  }

  private static meta(cls: unknown): EntityClass {
    return cls as EntityClass;
  }

  private get meta(): EntityClass {
    return BaseEntity.meta(this.constructor);
  }

  protected static async _load<T extends BaseEntity>(cls: new (id: string) => T, id: string): Promise<T | null> {
    const { table, fields } = BaseEntity.meta(cls);
    const doc = await requireStore().load(table, id);
    if (!doc) return null;
    const entity = new cls(id);
    for (const [name, spec] of Object.entries(fields)) {
      const v = fromDb(spec, doc[name]);
      if (v !== undefined) entity.values[name] = v;
    }
    return entity;
  }

  private spec(field: string): FieldSpec {
    const spec = this.meta.fields[field];
    if (!spec) throw new Error(`Unknown field "${field}" on ${this.meta.table}`);
    return spec;
  }

  protected _get(field: string): unknown {
    return this.values[field];
  }

  protected _set(field: string, value: unknown): void {
    const v = normalize(this.spec(field), value, field);
    if (v === undefined) delete this.values[field];
    else this.values[field] = v;
    this.refCache.delete(field);
  }

  protected async _getRef<T extends BaseEntity>(field: string, load: (id: string) => Promise<T | null>): Promise<T | null> {
    if (this.refCache.has(field)) return this.refCache.get(field) as T;
    const id = this.values[field] as string | undefined;
    if (id === undefined) return null;
    const entity = await load(id);
    // A miss is not cached: the target may be saved later.
    if (entity) this.refCache.set(field, entity);
    return entity;
  }

  protected _setRef(field: string, entity: BaseEntity | null): void {
    this._set(field, entity === null ? undefined : entity.id);
    if (entity !== null) this.refCache.set(field, entity);
  }

  protected async _getRefs<T extends BaseEntity>(field: string, load: (id: string) => Promise<T | null>): Promise<T[]> {
    if (this.refCache.has(field)) return this.refCache.get(field) as T[];
    const ids = (this.values[field] as string[] | undefined) ?? [];
    const loaded: Array<T | null> = await Promise.all(ids.map((id) => load(id)));
    const found = loaded.filter((e): e is T => e !== null);
    if (found.length === ids.length) this.refCache.set(field, found);
    return found;
  }

  protected _setRefs(field: string, entities: BaseEntity[]): void {
    this._set(field, entities.map((e) => e.id));
    this.refCache.set(field, [...entities]);
  }

  async save(): Promise<void> {
    const s = requireStore();
    const { table, fields } = this.meta;
    const doc: Record<string, unknown> = {};
    for (const [name, spec] of Object.entries(fields)) {
      const v = this.values[name];
      if (v === undefined) {
        if (!spec.optional) throw new Error(`Cannot save ${table} "${this.id}": required field "${name}" is not set`);
        continue;
      }
      doc[name] = toDb(spec, v, name);
    }
    await s.save(table, this.id, doc);
  }

  async remove(): Promise<void> {
    await requireStore().remove(this.meta.table, this.id);
  }
}
