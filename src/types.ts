export interface SizeBounds { start: number; min: number; max: number }
export interface ChainConfig {
  chainId: number; name: string; rpc: string[]; confirmations: number;
  retryDelays: number[]; logRange: SizeBounds; blockBatch: SizeBounds;
  headThreshold: number; useBloom: boolean; pollInterval: number;
}
/** A chain as written in a config file; omitted tuning fields get defaults when parsed. */
export interface ChainInput {
  name: string; rpc: string[];
  confirmations?: number; retryDelays?: number[];
  logRange?: Partial<SizeBounds>; blockBatch?: Partial<SizeBounds>;
  headThreshold?: number; useBloom?: boolean; pollInterval?: number;
}
export interface AddressEntry { address: string | string[]; block: number }
export interface StaticEntry { source: string; address: string; block: number }
export interface RawLog {
  address: string; topics: string[]; data: string; blockNumber: number;
  transactionIndex: number; logIndex: number; transactionHash: string;
}
export interface RawTx {
  hash: string; from: string; to: string | null; value: bigint; nonce: number;
  gasPrice: bigint; input: string; transactionIndex: number;
}
export interface RawBlock {
  number: number; hash: string; timestamp: number; logsBloom: string; transactions: RawTx[];
}
export interface EventKey {
  chainId: number; address: string; eventId: string;
  blockNumber: number; txIndex: number; logIndex: number;
}
export interface EventDoc extends EventKey {
  txHash: string; source: string; event: string;
  data: Record<string, unknown>; processRevisionId: number;
}
export interface TxDoc {
  chainId: number; hash: string; from: string; to: string | null; value: string;
  nonce: number; gasPrice: string; input: string; transactionIndex: number;
  blockNumber: number; blockHash: string; blockTimestamp: Date;
}
export interface ChainState {
  chainId: number; indexedBlock: number; processedBlock: number;
  currentRevisionId: number; entityRevisionId: number;
  indexerHeartbeat: Date | null; processorHeartbeat: Date | null;
}
export interface TemplateDoc {
  chainId: number; template: string; address: string; block: number;
  /** position of the creating event inside `block`; only later logs of that block belong to the template */
  txIndex: number; logIndex: number;
}
export interface IndexedEvent<A = Record<string, unknown>> {
  args: A; address: string; blockNumber: number; txIndex: number; logIndex: number; txHash: string;
}
