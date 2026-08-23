import {
  createWalletClient,
  custom,
  encodeFunctionData,
} from "viem";
import { base } from "viem/chains";
import { scoreboardAbi } from "./scoreboardAbi";
import { getEthereumProvider } from "./ethProvider";
import {
  getPaymasterProxyUrl,
  sendSponsoredCallsAndGetTxHash,
  supportsPaymaster,
} from "./gasless";
import { appendBuilderCodesSuffix } from "./builderCodes";

const SCOREBOARD_ADDRESS = process.env.NEXT_PUBLIC_SCOREBOARD_ADDRESS as `0x${string}` | undefined;
const RECEIPT_POLL_INTERVAL_MS = 1_200;
const RECEIPT_POLL_ATTEMPTS = 75;

export function hasScoreboard() {
  return Boolean(SCOREBOARD_ADDRESS);
}

export async function waitForReceipt(hash: `0x${string}`) {
  for (let attempt = 0; attempt < RECEIPT_POLL_ATTEMPTS; attempt++) {
    const response = await fetch(
      `/api/chain?operation=receipt&hash=${encodeURIComponent(hash)}`,
      { cache: "no-store", headers: { accept: "application/json" } }
    );

    if (response.status === 202) {
      await new Promise((resolve) => setTimeout(resolve, RECEIPT_POLL_INTERVAL_MS));
      continue;
    }

    const data = await response.json().catch(() => null);
    if (!response.ok) {
      throw new Error(data?.error || "Could not check transaction receipt");
    }
    if (data?.status !== "success") {
      throw new Error("Transaction reverted");
    }
    return data;
  }

  throw new Error("Timed out waiting for transaction confirmation");
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
  const response = await fetch(
    `/api/chain?operation=bestScore&player=${encodeURIComponent(player)}`,
    { cache: "no-store", headers: { accept: "application/json" } }
  );
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(data?.error || "Could not read best score");
  }

  const score = Number(data?.score);
  if (!Number.isSafeInteger(score) || score < 0) {
    throw new Error("Invalid best score returned by server");
  }
  return score;
}

export async function submitScore(score: number) {
  if (!SCOREBOARD_ADDRESS) throw new Error("Scoreboard contract address not set");

  const eth = await getEthereumProvider();
  if (!eth) throw new Error("No wallet provider found");

  // Use the connected account.
  const accounts = (await eth.request({ method: "eth_accounts" })) as string[];
  const from = accounts?.[0] as `0x${string}` | undefined;
  if (!from) throw new Error("No account");

  // Prefer paymaster (gasless) only when the wallet advertises support.
  // This avoids breaking Farcaster clients that don't support ERC-7677.
  const chainIdHex = (await eth.request({ method: "eth_chainId" })) as `0x${string}`;
  const paymasterUrl = getPaymasterProxyUrl();

  const data = encodeFunctionData({
    abi: scoreboardAbi,
    functionName: "submitScore",
    args: [BigInt(score)],
  });

  if (paymasterUrl && (await supportsPaymaster(eth, chainIdHex, from))) {
    const hash = await sendSponsoredCallsAndGetTxHash({
      eth,
      chainIdHex,
      from,
      calls: [{ to: SCOREBOARD_ADDRESS, data, value: "0x0" }],
      paymasterServiceUrl: paymasterUrl,
    });

    return { hash, account: from };
  }

  // Fallback: normal writeContract (works in Farcaster, and in any wallet without paymaster).
  const wallet = await getWalletClient();
  if (!wallet) throw new Error("No wallet provider found");
  const hash = await wallet.sendTransaction({
    to: SCOREBOARD_ADDRESS,
    data: appendBuilderCodesSuffix(data),
    value: 0n,
    account: from,
  });

  return { hash, account: from };
}
