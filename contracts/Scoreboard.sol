// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @notice Minimal onchain scoreboard:
/// - Stores personal best in storage
/// - Emits event for every submitted score (full history onchain via logs)
contract Scoreboard {
    mapping(address => uint256) public bestScore;

    event ScoreSubmitted(address indexed player, uint256 score, uint256 newBest, uint256 timestamp);

    function submitScore(uint256 score) external {
        uint256 best = bestScore[msg.sender];
        uint256 newBest = best;
        if (score > best) {
            bestScore[msg.sender] = score;
            newBest = score;
        }
        emit ScoreSubmitted(msg.sender, score, newBest, block.timestamp);
    }
}
