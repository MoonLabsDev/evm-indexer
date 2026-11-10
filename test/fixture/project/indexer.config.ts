import { defineIndexer, defineTemplate } from '../../../src/index';
import { Factory, Pool } from './generated';
import { handlePing, handlePoolCreated } from './handlers';

export const PoolTemplate = defineTemplate({
  contract: Pool,
  events: { Ping: handlePing },
});

export default defineIndexer({
  contracts: {
    Factory: {
      contract: Factory,
      events: {
        PoolCreated: {
          index: (e) => PoolTemplate.create(e.args.pool),
          process: handlePoolCreated,
        },
      },
    },
  },
  templates: { PoolTemplate },
});
