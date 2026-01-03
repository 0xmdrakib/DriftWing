// Minimal EIP-1193 provider resolver for DriftWing.
// Wallet connections are intentionally supported ONLY inside Base/Farcaster Mini Apps
// (via the Mini App SDK wallet provider). Normal web injected wallets (MetaMask, etc.)
// are disabled by design.

export type Eip1193Provider = {
  request: (args: { method: string; params?: unknown[] | Record<string, unknown> }) => Promise<unknown>;
  on?: (event: string, handler: (...args: any[]) => void) => void;
  removeListener?: (event: string, handler: (...args: any[]) => void) => void;
};

export async function getEthereumProvider(): Promise<Eip1193Provider | null> {
  if (typeof window === "undefined") return null;

  try {
    const mod = await import("@farcaster/miniapp-sdk");
    const inMiniApp = await mod.sdk.isInMiniApp();
    if (!inMiniApp) return null;
    const p = await Promise.resolve(mod.sdk.wallet.getEthereumProvider());
    return (p as Eip1193Provider) ?? null;
  } catch {
    return null;
  }
}
