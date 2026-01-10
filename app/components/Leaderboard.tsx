import { useEffect, useState } from "react";
import { getEthereumProvider } from "@/lib/ethProvider";

type Address = `0x${string}`;

export function useMiniAppAddress() {
  const [address, setAddress] = useState<Address | null>(null);

  useEffect(() => {
    let alive = true;

    (async () => {
      const p = await getEthereumProvider();
      if (!p) return;

      // Try silent check first (no popup)
      const accounts = (await p.request({ method: "eth_accounts" })) as string[] | undefined;
      const a = accounts?.[0] as Address | undefined;

      if (alive) setAddress(a ?? null);
    })();

    return () => {
      alive = false;
    };
  }, []);

  return address;
}
