import "server-only";

import { createPublicClient, http, parseAbiItem } from "viem";
import { base } from "viem/chains";

const rpcUrl =
  process.env.BASE_RPC_URL ??
  process.env.NEXT_PUBLIC_BASE_RPC_URL ??
  "https://mainnet.base.org";

export const publicClient = createPublicClient({
  chain: base,
  transport: http(rpcUrl),
});

// Scoreboard.sol event
export const scoreSubmittedEvent = parseAbiItem(
  "event ScoreSubmitted(address indexed player, uint256 score, uint256 newBest, uint256 timestamp)"
);
