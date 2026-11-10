// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

import { Pool } from "./Pool.sol";

contract Factory {
    uint256 public poolCount;

    event PoolCreated(address indexed pool, uint256 index);

    /// Deploys a pool, announces it, then pings it in the same transaction (so the Ping log
    /// comes after PoolCreated in the same block and transaction).
    function createPool() external returns (address) {
        Pool pool = new Pool();
        poolCount += 1;
        emit PoolCreated(address(pool), poolCount);
        pool.ping();
        return address(pool);
    }
}
