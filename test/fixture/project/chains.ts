import { defineChains } from '../../../src/index';

export default defineChains({
  31337: {
    name: 'hardhat',
    rpc: ['http://127.0.0.1:8546'],
    retryDelays: [50, 100],
    logRange: { start: 2, min: 1, max: 2 },
    headThreshold: 3,
    pollInterval: 50,
  },
});
