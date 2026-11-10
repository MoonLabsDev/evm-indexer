import type { SizeBounds } from '../types';

const GROW_FACTOR = 1.25;
const FAST_MS = 2000;
const FEW_LOGS = 2000;
const HUGE_LOGS = 10000;

/** Learned size (log block range or blocks per batch) of one RPC. */
export class AdaptiveSize {
  private current: number;

  constructor(private readonly bounds: SizeBounds) {
    this.current = bounds.start;
  }

  get value(): number {
    return this.current;
  }

  /** Grow after a fast, small answer; halve after a huge one; hold otherwise. */
  onSuccess(durationMs: number, logCount: number): void {
    if (logCount > HUGE_LOGS) {
      this.halve();
    } else if (durationMs < FAST_MS && logCount < FEW_LOGS) {
      this.current = Math.min(this.bounds.max, Math.ceil(this.current * GROW_FACTOR));
    }
  }

  /** Returns false when the value did not change (already at min). */
  halve(): boolean {
    const next = Math.max(this.bounds.min, Math.floor(this.current / 2));
    const changed = next !== this.current;
    this.current = next;
    return changed;
  }
}

const GAP_START_MS = 100;
const GAP_RELAX_AFTER = 20;

/** Minimum gap between requests to one RPC: appears on 429, doubles, relaxes after 20 successes. */
export class RateGap {
  private gap = 0;
  private successes = 0;

  get ms(): number {
    return this.gap;
  }

  on429(): void {
    this.gap = this.gap === 0 ? GAP_START_MS : this.gap * 2;
    this.successes = 0;
  }

  onSuccess(): void {
    if (this.gap === 0) return;
    if (++this.successes < GAP_RELAX_AFTER) return;
    this.successes = 0;
    const half = Math.floor(this.gap / 2);
    this.gap = half < GAP_START_MS ? 0 : half;
  }
}
