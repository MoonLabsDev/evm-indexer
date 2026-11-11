import { defineSchema } from 'evm-indexer';

export default defineSchema({
  PoolEntity: { createdAt: 'timestamp', pings: 'int', lastPing: 'bigint', creator: 'address' },
  Stats: { poolCount: 'int' },
});
