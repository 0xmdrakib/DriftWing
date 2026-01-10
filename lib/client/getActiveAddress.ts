declare global {
  interface Window {
    ethereum?: any;
    miniKit?: any; // Farcaster/Base MiniKit
  }
}

export async function getActiveAddress(): Promise<`0x${string}` | null> {
  try {
    // 1) Farcaster/Base MiniKit (যদি injected থাকে)
    if (typeof window !== "undefined" && window.miniKit?.wallet?.getAddress) {
      const res = await window.miniKit.wallet.getAddress();
      if (res?.address) return res.address as `0x${string}`;
    }

    // 2) EIP-1193 (Base App / ব্রাউজার)
    if (typeof window !== "undefined" && window.ethereum) {
      const [addr] = await window.ethereum.request({ method: "eth_requestAccounts" });
      if (addr) return addr as `0x${string}`;
    }

    // 3) কিছুই না হলে null
    return null;
  } catch {
    return null;
  }
}
