// Hardhat 2 config for the integration fixture; every path is rooted at test/fixture.
const path = require('path');

/** @type {import('hardhat/config').HardhatUserConfig} */
module.exports = {
  solidity: '0.8.28',
  paths: {
    root: __dirname,
    sources: path.join(__dirname, 'contracts'),
    artifacts: path.join(__dirname, 'artifacts'),
    cache: path.join(__dirname, 'cache'),
    tests: path.join(__dirname, 'hardhat-tests'),
  },
  networks: {
    hardhat: { chainId: 31337 },
  },
};
