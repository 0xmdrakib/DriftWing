import { createPublicClient, createWalletClient, custom, http } from "viem";
import { base } from "viem/chains";
import { scoreboardAbi } from "./scoreboardAbi";
import { getEthereumProvider } from "./ethProvider";

const RPC_URL = process.env.NEXT_PUBLIC_BASE_RPC_URL || "https://mainnet.base.org";
const SCOREBOARD_ADDRESS = process.env.NEXT_PUBLIC_SCOREBOARD_ADDRESS as `0x${string}` | undefined;

export function hasScoreboard() {
  return Boolean(SCOREBOARD_ADDRESS);
}

export function getPublicClient() {
  return createPublicClient({ chain: base, transport: http(RPC_URL) });
}


export async function waitForReceipt(hash: `0x${string}`) {
  const client = getPublicClient();
  const receipt = await client.waitForTransactionReceipt({ hash });
  return receipt;
}


export async function getWalletClient() {
  const eth = await getEthereumProvider();
  if (!eth) return null;
  const wallet = createWalletClient({ chain: base, transport: custom(eth) });

  // Best-effort: ensure the wallet is on Base.
  try {
    await wallet.switchChain({ id: base.id });
  } catch {
    // Some providers don't support switching or may prompt the user.
  }
  return wallet;
}

export async function readBestScore(player: `0x${string}`) {
  if (!SCOREBOARD_ADDRESS) return null;
  const client = getPublicClient();
  const best = await client.readContract({
    address: SCOREBOARD_ADDRESS,
    abi: scoreboardAbi,
    functionName: "bestScore",
    args: [player]
  });
  return Number(best);
}

export async function submitScore(score: number) {
  if (!SCOREBOARD_ADDRESS) throw new Error("Scoreboard contract address not set");
  const wallet = await getWalletClient();
  if (!wallet) throw new Error("No wallet provider found");
  const [account] = await wallet.getAddresses();
  if (!account) throw new Error("No account");
  const hash = await wallet.writeContract({
    address: SCOREBOARD_ADDRESS,
    abi: scoreboardAbi,
    functionName: "submitScore",
    args: [BigInt(score)],
    account
  });
  return { hash, account };
}
