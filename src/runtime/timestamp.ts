/** Immutable point in time, stored as unix seconds. */
export class Timestamp {
  readonly unix: number;
  readonly ms: number;

  private constructor(unix: number) {
    this.unix = unix;
    this.ms = unix * 1000;
    Object.freeze(this);
  }

  /** A number is unix seconds; a Date is floored to whole seconds. */
  static from(v: number | Date | Timestamp): Timestamp {
    if (v instanceof Timestamp) return v;
    const unix = v instanceof Date ? Math.floor(v.getTime() / 1000) : v;
    if (typeof unix !== 'number' || !Number.isFinite(unix)) {
      throw new Error(`Invalid timestamp: ${String(v)}`);
    }
    return new Timestamp(unix);
  }

  /** A fresh Date on every access, so callers cannot mutate shared state. */
  get date(): Date {
    return new Date(this.ms);
  }

  get iso(): string {
    return this.date.toISOString();
  }
}
