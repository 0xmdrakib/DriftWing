// Minimal EIP-1193 provider resolver for DriftWing.
//
// Provider priority:
//  1) Farcaster Mini App SDK wallet provider (only when actually running inside a Mini App)
//  2) Web injected wallets (MetaMask/Rabby/Coinbase/etc.) with multi-provider support (EIP-6963)

export type Eip1193Provider = {
  request: (args: { method: string; params?: unknown[] | Record<string, unknown> }) => Promise<unknown>;
  on?: (event: string, handler: (...args: any[]) => void) => void;
  removeListener?: (event: string, handler: (...args: any[]) => void) => void;
};

// Alias with conventional all-caps spelling used by many libs (viem/web3).
export type EIP1193Provider = Eip1193Provider;

type Eip6963ProviderInfo = {
  uuid: string;
  name: string;
  icon?: string;
  rdns?: string;
};

export type InjectedWallet = {
  id: string;
  name: string;
  icon?: string;
  provider: Eip1193Provider;
};

const PREF_KEY = "dw:preferredInjectedWallet";

export function getPreferredInjectedWalletId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(PREF_KEY);
  } catch {
    return null;
  }
}

export function setPreferredInjectedWalletId(id: string | null) {
  if (typeof window === "undefined") return;
  try {
    if (!id) window.localStorage.removeItem(PREF_KEY);
    else window.localStorage.setItem(PREF_KEY, id);
  } catch {
    // ignore
  }
}

function makeEip6963Id(info: Eip6963ProviderInfo): string {
  // Prefer RDNS (stable) when present.
  return info.rdns ? `eip6963:${info.rdns}` : `eip6963:${info.uuid}`;
}

async function discoverEip6963Wallets(timeoutMs = 250): Promise<InjectedWallet[]> {
  if (typeof window === "undefined") return [];

  const wallets = new Map<string, InjectedWallet>();

  const handler = (event: Event) => {
    const ce = event as CustomEvent<{ info: Eip6963ProviderInfo; provider: Eip1193Provider }>;
    const detail = ce?.detail;
    if (!detail?.provider || !detail?.info?.uuid || !detail?.info?.name) return;

    const id = makeEip6963Id(detail.info);
    if (!wallets.has(id)) {
      wallets.set(id, {
        id,
        name: detail.info.name,
        icon: detail.info.icon,
        provider: detail.provider,
      });
    }
  };

  window.addEventListener("eip6963:announceProvider", handler as EventListener);
  try {
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    await new Promise((r) => setTimeout(r, timeoutMs));
  } finally {
    window.removeEventListener("eip6963:announceProvider", handler as EventListener);
  }

  return Array.from(wallets.values());
}

function fallbackInjectedWallets(): InjectedWallet[] {
  if (typeof window === "undefined") return [];

  const anyWindow = window as any;
  const eth = anyWindow?.ethereum as Eip1193Provider | undefined;
  if (!eth) return [];

  // Some environments expose an array of providers.
  const providers = (eth as any)?.providers as Eip1193Provider[] | undefined;
  if (Array.isArray(providers) && providers.length > 0) {
    return providers.map((p, i) => ({
      id: `window.ethereum.providers:${i}`,
      name: `Injected wallet #${i + 1}`,
      provider: p,
    }));
  }

  return [{ id: "window.ethereum", name: "Injected wallet", provider: eth }];
}

let injectedCache: { at: number; wallets: InjectedWallet[] } | null = null;

export async function listInjectedWallets(): Promise<InjectedWallet[]> {
  if (typeof window === "undefined") return [];

  // Small cache to avoid re-discovery loops on rapid UI interactions.
  const now = Date.now();
  if (injectedCache && now - injectedCache.at < 1000) return injectedCache.wallets;

  const eip6963 = await discoverEip6963Wallets();
  const wallets = eip6963.length > 0 ? eip6963 : fallbackInjectedWallets();
  injectedCache = { at: now, wallets };
  return wallets;
}

export async function getEthereumProvider(): Promise<Eip1193Provider | null> {
  if (typeof window === "undefined") return null;

  // 1) Farcaster Mini App provider (only when actually inside a Mini App context)
  try {
    const mod = await import("@farcaster/miniapp-sdk");
    const inMiniApp = await mod.sdk.isInMiniApp();
    if (inMiniApp) {
      const p = await Promise.resolve(mod.sdk.wallet.getEthereumProvider());
      if (p) return p as Eip1193Provider;
    }
  } catch {
    // ignore (web can work without the SDK)
  }

  // 2) Web injected providers
  const wallets = await listInjectedWallets();
  if (!wallets.length) return null;

  const preferredId = getPreferredInjectedWalletId();
  const preferred = preferredId ? wallets.find((w) => w.id === preferredId) : null;
  return (preferred?.provider ?? wallets[0]?.provider) ?? null;
}
