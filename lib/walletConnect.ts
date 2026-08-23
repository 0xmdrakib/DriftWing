"use client";

import type UniversalProvider from "@walletconnect/universal-provider";
import type { WalletConnectModal } from "@walletconnect/modal";
import type { Eip1193Provider } from "./ethProvider";

const BASE_CAIP_CHAIN = "eip155:8453";
const USER_REJECTED_CODE = 4001;

let providerInstance: UniversalProvider | null = null;
let modalInstance: WalletConnectModal | null = null;

function walletConnectProjectId() {
  return process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID?.trim() || "";
}

export function isWalletConnectConfigured() {
  return Boolean(walletConnectProjectId());
}

function userRejectedError() {
  const error = new Error("WalletConnect request cancelled") as Error & { code: number };
  error.code = USER_REJECTED_CODE;
  return error;
}

async function getWalletConnectProvider() {
  if (providerInstance) return providerInstance;

  const projectId = walletConnectProjectId();
  if (!projectId) {
    throw new Error("WalletConnect is not configured yet");
  }

  const [{ default: UniversalProviderClient }, { WalletConnectModal: ModalClient }] =
    await Promise.all([
      import("@walletconnect/universal-provider"),
      import("@walletconnect/modal"),
    ]);

  const appUrl = window.location.origin;
  providerInstance = await UniversalProviderClient.init({
    projectId,
    metadata: {
      name: "Drift Wing",
      description: "Connect a wallet to save your Drift Wing score on Base.",
      url: appUrl,
      icons: [`${appUrl}/icon.png`],
    },
  });

  modalInstance = new ModalClient({
    projectId,
    chains: [BASE_CAIP_CHAIN],
    themeVariables: {
      "--wcm-z-index": "2000",
      "--wcm-accent-color": "#3BEFFF",
      "--wcm-accent-fill-color": "#000000",
      "--wcm-background-color": "#FFFFFF",
      "--wcm-font-family": "inherit",
      "--wcm-background-border-radius": "16px",
      "--wcm-container-border-radius": "12px",
      "--wcm-button-border-radius": "10px",
    },
  });

  return providerInstance;
}

export async function connectWalletConnect(): Promise<Eip1193Provider> {
  const provider = await getWalletConnectProvider();

  // Reuse an approved WalletConnect session without creating another pairing.
  if (provider.session) {
    const accounts = await provider.request<string[]>({ method: "eth_accounts" });
    if (accounts.length > 0) return provider as Eip1193Provider;
  }

  let modalOpened = false;
  let settled = false;
  let rejectCancellation: ((reason: Error) => void) | null = null;

  const cancelled = new Promise<never>((_, reject) => {
    rejectCancellation = reject;
  });

  const unsubscribe = modalInstance?.subscribeModal(({ open }) => {
    if (open) {
      modalOpened = true;
      return;
    }

    if (modalOpened && !settled) {
      void provider.cleanupPendingPairings({ deletePairings: true });
      rejectCancellation?.(userRejectedError());
    }
  });

  const onDisplayUri = (uri: string) => {
    void modalInstance
      ?.openModal({ uri, chains: [BASE_CAIP_CHAIN] })
      .catch(() => rejectCancellation?.(userRejectedError()));
  };
  provider.on("display_uri", onDisplayUri);

  const connection = provider.connect({
    namespaces: {
      eip155: {
        chains: [BASE_CAIP_CHAIN],
        methods: ["eth_sendTransaction"],
        events: ["accountsChanged", "chainChanged"],
      },
    },
    optionalNamespaces: {
      eip155: {
        chains: [BASE_CAIP_CHAIN],
        methods: [
          "personal_sign",
          "wallet_switchEthereumChain",
          "wallet_getCapabilities",
          "wallet_sendCalls",
          "wallet_getCallsStatus",
        ],
        events: ["accountsChanged", "chainChanged"],
      },
    },
  });

  try {
    const session = await Promise.race([connection, cancelled]);
    if (!session) throw new Error("WalletConnect did not create a session");

    settled = true;
    modalInstance?.closeModal();

    const accounts = await provider.request<string[]>({ method: "eth_accounts" });
    if (!accounts.length) throw new Error("WalletConnect returned no account");
    return provider as Eip1193Provider;
  } catch (error) {
    if (!settled) {
      // If approval arrives after the user closed the modal, immediately end
      // that late session instead of reconnecting behind their back.
      void connection
        .then(async (session) => {
          if (session && provider.session) await provider.disconnect();
        })
        .catch(() => undefined);
    }
    modalInstance?.closeModal();
    throw error;
  } finally {
    provider.removeListener("display_uri", onDisplayUri);
    unsubscribe?.();
  }
}

export async function disconnectWalletConnect() {
  const provider = providerInstance;
  providerInstance = null;
  modalInstance?.closeModal();
  modalInstance = null;

  if (!provider?.session) return;
  try {
    await provider.disconnect();
  } catch {
    // The wallet may already have ended the session.
  }
}
