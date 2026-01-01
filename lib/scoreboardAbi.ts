export const scoreboardAbi = [
  {
    type: "function",
    name: "bestScore",
    stateMutability: "view",
    inputs: [{ name: "player", type: "address" }],
    outputs: [{ name: "", type: "uint256" }]
  },
  {
    type: "function",
    name: "submitScore",
    stateMutability: "nonpayable",
    inputs: [{ name: "score", type: "uint256" }],
    outputs: []
  },
  {
    type: "event",
    name: "ScoreSubmitted",
    inputs: [
      { name: "player", type: "address", indexed: true },
      { name: "score", type: "uint256", indexed: false },
      { name: "newBest", type: "uint256", indexed: false },
      { name: "timestamp", type: "uint256", indexed: false }
    ],
    anonymous: false
  }
] as const;
