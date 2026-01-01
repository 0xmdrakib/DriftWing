// Minimal EIP-1193 provider resolver that works:
// - inside Farcaster clients (via the Mini App SDK wallet provider)
// - inside normal browsers (via window.ethereum)

export type Eip1193Provider = {
  request: (args: { method: string; params?: unknown[] | Record<string, unknown> }) => Promise<unknown>;
  on?: (event: string, handler: (...args: any[]) => void) => void;
  removeListener?: (event: string, handler: (...args: any[]) => void) => void;
};

export async function getEthereumProvider(): Promise<Eip1193Provider | null> {
  if (typeof window === "undefined") return null;

  // 1) Prefer the Mini App SDK provider when running in a Mini App.
  try {
    const mod = await import("@farcaster/miniapp-sdk");
    // Mini app detection lets the same code run in normal browsers too.
    const inMiniApp = await mod.sdk.isInMiniApp();
    if (inMiniApp) {
      const p = await Promise.resolve(mod.sdk.wallet.getEthereumProvider());
      if (p) return p as Eip1193Provider;
    }
  } catch {
    // ignore and fall back
  }

  // 2) Fallback: browser-injected provider (e.g., MetaMask).
  return ((window as any).ethereum as Eip1193Provider | undefined) ?? null;
}
