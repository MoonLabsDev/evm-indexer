import { ResizeError } from '../rpc/errors';
import type { RawBlock, RawLog } from '../types';
import { blockMayMatch } from './bloom';
import type { Registry } from './registry';
import { sortLogs, type ScanBatch, type ScanPool, type Scanner } from './scan';

interface Held {
  block: RawBlock;
  /** every log of the block once its receipts were read; null while skipped by the bloom */
  logs: RawLog[] | null;
}

function isZeroBloom(logsBloom: string | undefined): boolean {
  if (!logsBloom) return true;
  return /^(0x)?0*$/i.test(logsBloom);
}

/** Near-head scanner: walks blocks, skips those the bloom rules out and reads the receipts of the rest. */
export class HeadScanner implements Scanner {
  constructor(
    private readonly pool: ScanPool,
    private readonly registry: Registry,
    private readonly useBloom: boolean,
  ) {}

  async scan(from: number, target: number): Promise<ScanBatch> {
    const { pool, registry } = this;
    const held = new Map<number, Held>();

    let to: number;
    let fetched: RawBlock[] = [];
    for (;;) {
      to = Math.min(from + pool.size('blockBatch') - 1, target);
      const numbers = Array.from({ length: to - from + 1 }, (_, i) => from + i);
      try {
        fetched = await pool.getBlocks(numbers);
        break;
      } catch (err) {
        if (!(err instanceof ResizeError)) throw err;
      }
    }
    const end = to;
    for (const block of fetched) held.set(block.number, { block, logs: null });

    /** A zero bloom on a block with transactions counts as "may match" (chains that do not fill the bloom). */
    const mayMatch = (block: RawBlock, addresses: string[], topics: string[]): boolean => {
      if (!this.useBloom) return true;
      if (isZeroBloom(block.logsBloom)) return block.transactions.length > 0;
      return blockMayMatch(block.logsBloom, addresses, topics);
    };
    const load = async (h: Held): Promise<void> => {
      h.logs = await pool.getBlockLogs(h.block.number);
    };

    let matched: RawLog[] = [];
    if (registry.size() > 0) {
      const addresses = registry.addresses();
      const topics = registry.topics();
      for (const h of held.values()) {
        if (mayMatch(h.block, addresses, topics)) await load(h);
      }
      matched = sortLogs([...held.values()].flatMap((h) => (h.logs ? h.logs.filter((l) => registry.match(l) !== null) : [])));
    }

    return {
      from,
      to: end,
      logs: matched,
      getBlock: async (n) => {
        let h = held.get(n);
        if (!h) {
          const [block] = await pool.getBlocks([n]);
          h = { block, logs: null };
          held.set(n, h);
        }
        return h.block;
      },
      logsFor: async (address, fromBlock) => {
        const addr = address.toLowerCase();
        const topics = registry.topicsOf(addr);
        if (topics.length === 0) return [];
        const out: RawLog[] = [];
        for (const h of held.values()) {
          if (h.block.number < fromBlock || h.block.number > end) continue;
          if (!h.logs && mayMatch(h.block, [addr], topics)) await load(h);
          if (h.logs) out.push(...h.logs.filter((l) => l.address.toLowerCase() === addr && registry.match(l) !== null));
        }
        return sortLogs(out);
      },
    };
  }
}
