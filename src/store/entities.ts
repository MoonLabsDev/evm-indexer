import { Db, Collection, Document } from 'mongodb';

/** Per-chain access to the `ent_<chainId>_<Table>` collections. */
export class EntityStore {
  constructor(private readonly db: Db, private readonly chainId: number) {}

  private col(table: string): Collection<Document> {
    return this.db.collection(`ent_${this.chainId}_${table}`);
  }

  async load(table: string, id: string): Promise<Record<string, unknown> | null> {
    const doc = await this.col(table).findOne({ _id: id as never });
    if (!doc) return null;
    const { _id, ...rest } = doc;
    return rest;
  }

  async save(table: string, id: string, doc: Record<string, unknown>): Promise<void> {
    await this.col(table).replaceOne({ _id: id as never }, { _id: id, ...doc } as Document, { upsert: true });
  }

  async remove(table: string, id: string): Promise<void> {
    await this.col(table).deleteOne({ _id: id as never });
  }
}
