import { describe, it, expect } from 'vitest';
import { parseSchema, SchemaError } from '../../src/codegen/schema';

describe('parseSchema', () => {
  it('parses the type grammar', () => {
    const s = parseSchema({
      Pool: { token: 'ref:Token', reserve: 'bigint', tags: 'string[]', note: 'string?', many: 'ref:Token[]?' },
      Token: { symbol: 'string' },
    });
    expect(s.Pool.token).toEqual({ type: 'ref', array: false, optional: false, ref: 'Token' });
    expect(s.Pool.many).toEqual({ type: 'ref', array: true, optional: true, ref: 'Token' });
    expect(s.Pool.tags).toEqual({ type: 'string', array: true, optional: false });
    expect(s.Pool.note).toEqual({ type: 'string', array: false, optional: true });
    expect(s.Pool.reserve).toEqual({ type: 'bigint', array: false, optional: false });
  });

  it('allows optional arrays and self references', () => {
    const s = parseSchema({ Node: { parent: 'ref:Node?', tags: 'string[]?' } });
    expect(s.Node.tags).toEqual({ type: 'string', array: true, optional: true });
    expect(s.Node.parent.ref).toBe('Node');
  });

  it('rejects invalid schemas', () => {
    const bad: unknown[] = [
      { A: { x: 'uint' } },
      { A: { x: 'ref:B' } },
      { A: { x: 'ref' } },
      { A: { x: 'ref:' } },
      { A: { id: 'string' } },
      { A: { save: 'string' } },
      { A: { load: 'string' } },
      { A: { remove: 'string' } },
      { A: { _x: 'string' } },
      { 'A-B': { x: 'string' } },
      { A: { 'x y': 'string' } },
      { A: { x: 'string[][]' } },
      { A: { x: 5 } },
      { A: 'string' },
      [],
      null,
    ];
    for (const b of bad) expect(() => parseSchema(b), JSON.stringify(b)).toThrow(SchemaError);
  });

  it('rejects table names that clash with generated imports', () => {
    for (const t of ['Decimal', 'Timestamp', 'BaseEntity', 'FieldSpec', 'class']) {
      expect(() => parseSchema({ [t]: { x: 'string' } })).toThrow(SchemaError);
    }
  });

  it('rejects generated member name collisions', () => {
    expect(() => parseSchema({ A: { token: 'ref:A', tokenId: 'string' } })).toThrow(SchemaError);
    expect(() => parseSchema({ A: { getX: 'string', x: 'ref:A' } })).toThrow(SchemaError);
  });
});
