import { defineIndexer, defineTemplate } from 'evm-indexer';
import { Factory, Pool, Token } from './generated';
import { handlePoolCreated, handleSwap, handleTransfer } from './src/handlers';

// A template is a contract that is deployed many times: each Pool is created by the Factory,
// so its address is only known once a PoolCreated event has been indexed.
export const PoolTemplate = defineTemplate({
  contract: Pool,
  events: { Swap: handleSwap },
});

export default defineIndexer({
  contracts: {
    Token: {
      contract: Token,
      events: { Transfer: handleTransfer },
    },
    Factory: {
      contract: Factory,
      events: {
        PoolCreated: {
          // index runs while events are fetched: it registers the new pool address
          index: (e) => PoolTemplate.create(e.args.pool),
          // process runs afterwards, in order, and writes the entities
          process: handlePoolCreated,
        },
      },
    },
  },
  templates: { PoolTemplate },
});
