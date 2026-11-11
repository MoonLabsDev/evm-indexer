import { defineSchema } from 'evm-indexer';

// The entity tables your handlers read and write. `evm-indexer codegen` turns each one into a class.
export default defineSchema({
  Account: { balance: 'bigint', updatedAt: 'timestamp' },
  Pool: { token: 'address', swapCount: 'int', createdAt: 'timestamp' },
});
