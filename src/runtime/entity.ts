import type { EntityStore } from '../store/entities';
import { type FieldSpec, normalize, toDb, fromDb } from './fields';

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
  private readonly _values: Record<string, unknown> = {};
  private readonly _refCache = new Map<string, unknown>();

  constructor(id: string) {
    this.id = id;
  }

  private static _metaOf(cls: unknown): EntityClass {
    return cls as EntityClass;
  }

  private get _meta(): EntityClass {
    return BaseEntity._metaOf(this.constructor);
  }

  protected static async _load<T extends BaseEntity>(cls: new (id: string) => T, id: string): Promise<T | null> {
    const { table, fields } = BaseEntity._metaOf(cls);
    const doc = await requireStore().load(table, id);
    if (!doc) return null;
    const entity = new cls(id);
    for (const [name, spec] of Object.entries(fields)) {
      const v = fromDb(spec, doc[name]);
      if (v !== undefined) entity._values[name] = v;
    }
    return entity;
  }

  private _spec(field: string): FieldSpec {
    const spec = this._meta.fields[field];
    if (!spec) throw new Error(`Unknown field "${field}" on ${this._meta.table}`);
    return spec;
  }

  protected _get(field: string): unknown {
    return this._values[field];
  }

  protected _set(field: string, value: unknown): void {
    const v = normalize(this._spec(field), value, field);
    if (v === undefined) delete this._values[field];
    else this._values[field] = v;
    this._refCache.delete(field);
  }

  protected async _getRef<T extends BaseEntity>(field: string, load: (id: string) => Promise<T | null>): Promise<T | null> {
    if (this._refCache.has(field)) return this._refCache.get(field) as T;
    const id = this._values[field] as string | undefined;
    if (id === undefined) return null;
    const entity = await load(id);
    // A miss is not cached: the target may be saved later.
    if (entity) this._refCache.set(field, entity);
    return entity;
  }

  protected _setRef(field: string, entity: BaseEntity | null): void {
    this._set(field, entity === null ? undefined : entity.id);
    if (entity !== null) this._refCache.set(field, entity);
  }

  protected async _getRefs<T extends BaseEntity>(field: string, load: (id: string) => Promise<T | null>): Promise<T[]> {
    if (this._refCache.has(field)) return this._refCache.get(field) as T[];
    const ids = (this._values[field] as string[] | undefined) ?? [];
    const loaded: Array<T | null> = await Promise.all(ids.map((id) => load(id)));
    const found = loaded.filter((e): e is T => e !== null);
    if (found.length === ids.length) this._refCache.set(field, found);
    return found;
  }

  protected _setRefs(field: string, entities: BaseEntity[]): void {
    this._set(field, entities.map((e) => e.id));
    this._refCache.set(field, [...entities]);
  }

  async save(): Promise<void> {
    const s = requireStore();
    const { table, fields } = this._meta;
    const doc: Record<string, unknown> = {};
    for (const [name, spec] of Object.entries(fields)) {
      const v = this._values[name];
      if (v === undefined) {
        if (!spec.optional) throw new Error(`Cannot save ${table} "${this.id}": required field "${name}" is not set`);
        continue;
      }
      doc[name] = toDb(spec, v, name);
    }
    await s.save(table, this.id, doc);
  }

  async remove(): Promise<void> {
    await requireStore().remove(this._meta.table, this.id);
  }
}
