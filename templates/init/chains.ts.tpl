import { defineChains } from 'evm-indexer';

// One entry per chain id. `rpc` lists the endpoints to use, the first one is tried first.
export default defineChains({
  31337: { name: 'hardhat', rpc: ['http://127.0.0.1:8545'] },
});
