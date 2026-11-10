// A client project as users write it: the runtime comes from the package name, the generated code
// from `evm-indexer codegen` with the default runtimeImport.
import { defineIndexer, defineTemplate } from 'evm-indexer';
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
