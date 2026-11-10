import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { Db, Decimal128 } from 'mongodb';
import Decimal from 'decimal.js';
import { startMongo } from '../helpers/mongo';
import { EntityStore } from '../../src/store/entities';
import { BaseEntity, setEntityStore } from '../../src/runtime/entity';
import { FieldSpec, normalize, toDb, fromDb } from '../../src/runtime/fields';
import { Timestamp } from '../../src/runtime/timestamp';

const f = (type: FieldSpec['type'], extra: Partial<FieldSpec> = {}): FieldSpec => ({ type, array: false, optional: false, ...extra });

class Token extends BaseEntity {
  static readonly table = 'Token';
  static readonly fields: Record<string, FieldSpec> = { symbol: f('string') };
  static load(id: string): Promise<Token | null> { return BaseEntity._load(Token, id); }
  get symbol(): string { return this._get('symbol') as string; }
  set symbol(v: string) { this._set('symbol', v); }
}

class Pool extends BaseEntity {
  static readonly table = 'Pool';
  static readonly fields: Record<string, FieldSpec> = {
    token: f('ref', { ref: 'Token' }), reserve: f('bigint'), price: f('decimal'), createdAt: f('timestamp'),
    tags: f('string', { array: true }), note: f('string', { optional: true }),
    swapCount: f('int', { optional: true }), owner: f('address', { optional: true }),
    others: f('ref', { ref: 'Token', array: true, optional: true }),
  };
  static load(id: string): Promise<Pool | null> { return BaseEntity._load(Pool, id); }
  get reserve(): bigint { return this._get('reserve') as bigint; }
  set reserve(v: bigint) { this._set('reserve', v); }
  get price(): Decimal { return this._get('price') as Decimal; }
  set price(v: Decimal | string | number) { this._set('price', v); }
  get createdAt(): Timestamp { return this._get('createdAt') as Timestamp; }
  set createdAt(v: Timestamp | Date | number) { this._set('createdAt', v); }
  get swapCount(): number | undefined { return this._get('swapCount') as number | undefined; }
  set swapCount(v: number | undefined) { this._set('swapCount', v); }
  get owner(): string | undefined { return this._get('owner') as string | undefined; }
  set owner(v: string | undefined) { this._set('owner', v); }
  get tags(): string[] { return this._get('tags') as string[]; }
  set tags(v: string[]) { this._set('tags', v); }
  get note(): string | undefined { return this._get('note') as string | undefined; }
  set note(v: string | undefined) { this._set('note', v); }
  get tokenId(): string { return this._get('token') as string; }
  set tokenId(v: string) { this._set('token', v); }
  getToken(): Promise<Token | null> { return this._getRef('token', (id) => Token.load(id)); }
  setToken(t: Token | null): void { this._setRef('token', t); }
  get otherIds(): string[] | undefined { return this._get('others') as string[] | undefined; }
  getOthers(): Promise<Token[]> { return this._getRefs('others', (id) => Token.load(id)); }
  setOthers(ts: Token[]): void { this._setRefs('others', ts); }
}

let mongo: { db: Db; stop(): Promise<void> };
const rawDoc = (col: string, id: string) => mongo.db.collection(col).findOne({ _id: id as never });

beforeAll(async () => {
  mongo = await startMongo();
  setEntityStore(new EntityStore(mongo.db, 1));
});
afterAll(async () => {
  setEntityStore(null);
  await mongo.stop();
});

describe('field codecs', () => {
  it('normalizes values', () => {
    expect(normalize(f('address'), '0xABCDEFabcdefABCDEFabcdefABCDEFabcdefABCD', 'a')).toBe('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd');
    expect(normalize(f('bytes'), '0xAB', 'b')).toBe('0xab');
    expect(() => normalize(f('bytes'), '0xA', 'b')).toThrow(/bytes/);
    expect(() => normalize(f('bigint'), 5, 'n')).toThrow(/bigint/);
    expect(() => normalize(f('string'), 5, 's')).toThrow(/string/);
    expect(() => normalize(f('boolean'), 'x', 'b')).toThrow(/boolean/);
    expect((normalize(f('decimal'), 1.5, 'd') as Decimal).toString()).toBe('1.5');
    expect(() => normalize(f('decimal'), 'abc', 'd')).toThrow(/decimal/);
    expect((normalize(f('timestamp'), new Date(5000), 't') as Timestamp).unix).toBe(5);
    expect(normalize(f('string', { optional: true }), undefined, 's')).toBeUndefined();
    expect(() => normalize(f('string', { array: true }), 'x', 's')).toThrow(/array/);
    expect(normalize(f('int', { array: true }), [1, 2], 'n')).toEqual([1, 2]);
    expect(() => normalize(f('int', { array: true }), [1, 2.5], 'n')).toThrow(/int/);
  });

  it('round-trips through the database representation', () => {
    expect(toDb(f('bigint'), 12345678901234567890n, 'n')).toBe('12345678901234567890');
    expect(fromDb(f('bigint'), '12345678901234567890')).toBe(12345678901234567890n);
    expect(toDb(f('decimal'), new Decimal('1.25'), 'd')).toBeInstanceOf(Decimal128);
    expect((fromDb(f('decimal'), Decimal128.fromString('1.25')) as Decimal).toString()).toBe('1.25');
    expect(toDb(f('timestamp'), Timestamp.from(10), 't')).toEqual(new Date(10000));
    expect((fromDb(f('timestamp'), new Date(10000)) as Timestamp).unix).toBe(10);
    expect(toDb(f('int'), 5, 'n')).toBe(5);
    const big = toDb(f('int'), 2 ** 40, 'n');
    expect(typeof big).not.toBe('number');
    expect(fromDb(f('int'), big)).toBe(2 ** 40);
    expect(fromDb(f('int'), 7)).toBe(7);
  });
});

describe('entities', () => {
  it('saves, loads, references and removes', async () => {
    const p = new Pool('p1');
    p.reserve = 5n; p.price = '1.25'; p.createdAt = 1731234567; p.tokenId = 't1'; p.tags = ['a'];
    expect(await Pool.load('p1')).toBeNull();
    await p.save();
    const q = (await Pool.load('p1'))!;
    expect(q.reserve).toBe(5n);
    expect(q.price.toString()).toBe('1.25');
    expect(q.createdAt.unix).toBe(1731234567);
    expect(q.tags).toEqual(['a']);
    expect(q.note).toBeUndefined();

    const raw = (await rawDoc('ent_1_Pool', 'p1'))!;
    expect(raw).toMatchObject({ reserve: '5', token: 't1', tags: ['a'] });
    expect(raw.price).toBeInstanceOf(Decimal128);
    expect(raw.createdAt).toBeInstanceOf(Date);
    expect('note' in raw).toBe(false);

    expect(await q.getToken()).toBeNull();
    const t = new Token('t1'); t.symbol = 'X'; await t.save();
    q.tokenId = 't1';
    expect((await q.getToken())!.symbol).toBe('X');
    expect(await q.getToken()).toBe(await q.getToken());

    q.setToken(null);
    await expect(q.save()).rejects.toThrow(/token/);
    q.setToken(t);
    expect(q.tokenId).toBe('t1');
    await q.save();

    await expect(new Pool('p2').save()).rejects.toThrow(/reserve|token/);

    p.price = '1' + '0'.repeat(40) + '.5';
    await expect(p.save()).rejects.toThrow(/34/);
    expect(() => { (p as any).swapCount = 1.5; }).toThrow(/int/);
    expect(() => { (p as any).owner = '0x12'; }).toThrow(/address/);

    await q.remove();
    expect(await Pool.load('p1')).toBeNull();
  });

  it('clears the cached reference when the id is set directly', async () => {
    const a = new Token('a'); a.symbol = 'A'; await a.save();
    const b = new Token('b'); b.symbol = 'B'; await b.save();
    const p = new Pool('p3');
    p.tokenId = 'a';
    expect((await p.getToken())!.symbol).toBe('A');
    p.tokenId = 'b';
    expect((await p.getToken())!.symbol).toBe('B');
  });

  it('handles reference arrays and optional ids', async () => {
    const a = new Token('ra'); a.symbol = 'A'; await a.save();
    const b = new Token('rb'); b.symbol = 'B'; await b.save();
    const p = new Pool('p4');
    p.reserve = 1n; p.price = 1; p.createdAt = 1; p.tags = []; p.tokenId = 'ra';
    expect(await p.getOthers()).toEqual([]);
    p.setOthers([a, b]);
    expect(p.otherIds).toEqual(['ra', 'rb']);
    await p.save();
    expect(await rawDoc('ent_1_Pool', 'p4')).toMatchObject({ others: ['ra', 'rb'] });
    const q = (await Pool.load('p4'))!;
    expect((await q.getOthers()).map((t) => t.symbol)).toEqual(['A', 'B']);
  });

  it('throws without a store', async () => {
    setEntityStore(null);
    try {
      await expect(Pool.load('p1')).rejects.toThrow(/index callbacks/);
      const t = new Token('z'); t.symbol = 'Z';
      await expect(t.save()).rejects.toThrow(/index callbacks/);
      await expect(t.remove()).rejects.toThrow(/index callbacks/);
    } finally {
      setEntityStore(new EntityStore(mongo.db, 1));
    }
  });
});
