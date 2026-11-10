// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.20;

contract Pool {
    uint256 public pings;

    event Ping(address indexed sender, uint256 n);

    function ping() external {
        pings += 1;
        emit Ping(msg.sender, pings);
    }
}
