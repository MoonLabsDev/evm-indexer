import type { RpcPool } from '../rpc/pool';
import type { RawBlock, RawLog } from '../types';

/** The part of the RPC pool the scanners use (lets tests pass an in-memory chain). */
export type ScanPool = Pick<RpcPool, 'size' | 'getLogs' | 'getBlocks' | 'getBlockLogs'>;

export interface ScanBatch {
  from: number;
  to: number;
  /** registry matches only, sorted block/tx/log */
  logs: RawLog[];
  /** any block that has a returned log */
  getBlock(n: number): Promise<RawBlock>;
  /** that address, fromBlock..to, registry-matched, sorted */
  logsFor(address: string, fromBlock: number): Promise<RawLog[]>;
}

export interface Scanner {
  scan(from: number, target: number): Promise<ScanBatch>;
}

/** Returns a copy ordered by blockNumber, transactionIndex, logIndex. */
export function sortLogs(logs: RawLog[]): RawLog[] {
  return [...logs].sort(
    (a, b) => a.blockNumber - b.blockNumber || a.transactionIndex - b.transactionIndex || a.logIndex - b.logIndex,
  );
}
