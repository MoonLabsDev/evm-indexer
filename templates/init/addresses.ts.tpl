import { defineAddresses } from 'evm-indexer';
import config from './indexer.config';

// These are the first two deployments of hardhat's default account (nonce 0 and 1).
// Replace them with your own addresses and deployment blocks.
export default defineAddresses(config, {
  31337: {
    Token: { address: '0x5FbDB2315678afecb367f032d93F642f64180aa3', block: 0 },
    Factory: { address: '0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512', block: 0 },
  },
});
