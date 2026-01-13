import type { EIP1193Provider } from './ethProvider';

type Hex = `0x${string}`;

type PaymasterCapabilities = Record<Hex, { paymasterService?: { supported?: boolean } }>;

type SendCall = { to: Hex; data: Hex; value?: Hex };

type CallsStatus = {
  status?: 'PENDING' | 'CONFIRMED' | 'FAILED';
  receipts?: Array<{ transactionHash?: Hex }>; // wallet implementations vary
  transactionHash?: Hex; // some wallets return this directly
};

function isHexString(x: unknown): x is Hex {
  return typeof x === 'string' && x.startsWith('0x');
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Returns an absolute URL that wallets can reach.
 * Prefer NEXT_PUBLIC_PAYMASTER_PROXY_SERVER_URL; fallback to same-origin /api/paymaster.
 */
export function getPaymasterProxyUrl(): string | null {
  const envUrl = process.env.NEXT_PUBLIC_PAYMASTER_PROXY_SERVER_URL;
  if (envUrl && envUrl.startsWith('http')) return envUrl;
  if (typeof window === 'undefined') return null;
  return `${window.location.origin}/api/paymaster`;
}

async function walletGetCapabilities(
  eth: EIP1193Provider,
  account?: Hex,
  chainIds?: Hex[]
): Promise<PaymasterCapabilities | null> {
  // Wallets differ on params shape. Try a few harmless variants.
  // Per EIP-5792, the canonical form is: [account, [chainId1, chainId2, ...]].
  const variants: any[] = [
    [],
    account && chainIds?.length ? [account, chainIds] : null,
    account ? [account] : null,
    account ? [{ account }] : null,
    account && chainIds?.length ? [{ account, chainIds }] : null,
  ].filter(Boolean);

  for (const params of variants) {
    try {
      const res = (await eth.request({
        method: 'wallet_getCapabilities',
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        params,
      })) as any;
      if (res && typeof res === 'object') return res as PaymasterCapabilities;
    } catch {
      // try next variant
    }
  }

  return null;
}

export async function supportsPaymaster(
  eth: EIP1193Provider,
  chainIdHex: Hex,
  account?: Hex
): Promise<boolean> {
  // Query only the chain we care about first (some wallets require this param).
  const caps = await walletGetCapabilities(eth, account, [chainIdHex]);
  if (!caps) return false;
  // Some stacks (e.g. wrapper libs) return numeric chain IDs instead of hex keys.
  const chainIdNum = Number.parseInt(chainIdHex, 16);
  const anyCaps = caps as any;
  const entry =
    (anyCaps?.[chainIdHex] as any) ??
    (anyCaps?.[chainIdNum] as any) ??
    (anyCaps?.['0x0'] as any);
  return Boolean(entry?.paymasterService?.supported);
}

function normalizeCallsId(callsIdRaw: unknown): string | null {
  if (typeof callsIdRaw === 'string') return callsIdRaw;
  if (!callsIdRaw || typeof callsIdRaw !== 'object') return null;
  const anyObj = callsIdRaw as any;
  const v = anyObj.id ?? anyObj.result ?? anyObj.callsId;
  return typeof v === 'string' ? v : null;
}

async function walletGetCallsStatus(
  eth: EIP1193Provider,
  callsId: string
): Promise<CallsStatus | null> {
  try {
    const res = (await eth.request({
      method: 'wallet_getCallsStatus',
      params: [callsId],
    })) as any;
    if (res && typeof res === 'object') return res as CallsStatus;
    return null;
  } catch {
    return null;
  }
}

function extractTxHash(status: CallsStatus | null): Hex | null {
  if (!status) return null;
  const direct = status.transactionHash;
  if (isHexString(direct)) return direct;

  const receiptHash = status.receipts?.[0]?.transactionHash;
  if (isHexString(receiptHash)) return receiptHash;

  return null;
}

/**
 * Sends ERC-5792 calls with a paymasterService capability (ERC-7677).
 * Returns the onchain transaction hash.
 */
export async function sendSponsoredCallsAndGetTxHash(params: {
  eth: EIP1193Provider;
  chainIdHex: Hex;
  from: Hex;
  calls: SendCall[];
  paymasterServiceUrl: string;
  paymasterContext?: Record<string, any>;
}): Promise<Hex> {
  const { eth, chainIdHex, from, calls, paymasterServiceUrl, paymasterContext } = params;

  // EIP-7677 paymasterService capability is provided inside wallet_sendCalls.
  // The wallet is responsible for contacting the paymaster URL.
  const callsIdRaw = await eth.request({
    method: 'wallet_sendCalls',
    params: [
      {
        version: '1.0',
        chainId: chainIdHex,
        from,
        calls: calls.map((c) => ({ ...c, value: c.value ?? '0x0' })),
        capabilities: {
          paymasterService: {
            url: paymasterServiceUrl,
            context: paymasterContext ?? {},
          },
        },
      },
    ],
  });

  const callsId = normalizeCallsId(callsIdRaw);
  if (!callsId) {
    throw new Error('wallet_sendCalls did not return a callsId');
  }

  // Poll status until we get a tx hash.
  for (let i = 0; i < 30; i++) {
    const status = await walletGetCallsStatus(eth, callsId);
    const txHash = extractTxHash(status);
    if (txHash) return txHash;

    // If wallet reports failure, stop polling.
    if (status?.status === 'FAILED') {
      throw new Error('Sponsored call failed');
    }
    await sleep(800);
  }

  throw new Error('Timed out waiting for transaction hash');
}
