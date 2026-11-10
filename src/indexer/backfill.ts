import { ResizeError } from '../rpc/errors';
import type { RawBlock, RawLog } from '../types';
import type { Registry } from './registry';
import { sortLogs, type ScanBatch, type ScanPool, type Scanner } from './scan';

/** Above this many registry addresses the eth_getLogs address filter is dropped. */
const MAX_ADDRESS_FILTER = 100;

/** Far-from-head scanner: eth_getLogs over block ranges. */
export class BackfillScanner implements Scanner {
  constructor(private readonly pool: ScanPool, private readonly registry: Registry) {}

  async scan(from: number, target: number): Promise<ScanBatch> {
    const { pool, registry } = this;
    const blocks = new Map<number, RawBlock>();

    const fetchBlocks = async (numbers: number[]): Promise<void> => {
      let pending = numbers.filter((n) => !blocks.has(n));
      while (pending.length > 0) {
        const chunk = pending.slice(0, pool.size('blockBatch'));
        try {
          const res = await pool.getBlocks(chunk);
          chunk.forEach((n, i) => blocks.set(n, res[i]));
          pending = pending.slice(chunk.length);
        } catch (err) {
          if (!(err instanceof ResizeError)) throw err;
        }
      }
    };

    let to: number;
    let matched: RawLog[] = [];
    for (;;) {
      to = Math.min(from + pool.size('logRange') - 1, target);
      if (registry.size() === 0) break;
      try {
        const logs = await pool.getLogs({
          fromBlock: from,
          toBlock: to,
          ...(registry.size() > MAX_ADDRESS_FILTER ? {} : { address: registry.addresses() }),
          topics: registry.topics(),
        });
        matched = sortLogs(logs.filter((l) => registry.match(l) !== null));
        break;
      } catch (err) {
        if (!(err instanceof ResizeError)) throw err;
      }
    }
    const end = to;

    await fetchBlocks([...new Set(matched.map((l) => l.blockNumber))]);

    return {
      from,
      to: end,
      logs: matched,
      getBlock: async (n) => {
        await fetchBlocks([n]);
        return blocks.get(n) as RawBlock;
      },
      logsFor: async (address, fromBlock) => {
        const addr = address.toLowerCase();
        const topics = registry.topicsOf(addr);
        if (topics.length === 0) return [];
        const out: RawLog[] = [];
        let cursor = Math.max(fromBlock, from);
        while (cursor <= end) {
          const chunkEnd = Math.min(cursor + pool.size('logRange') - 1, end);
          try {
            out.push(...(await pool.getLogs({ fromBlock: cursor, toBlock: chunkEnd, address: [addr], topics })));
            cursor = chunkEnd + 1;
          } catch (err) {
            if (!(err instanceof ResizeError)) throw err;
          }
        }
        return sortLogs(out.filter((l) => l.address.toLowerCase() === addr && registry.match(l) !== null));
      },
    };
  }
}
