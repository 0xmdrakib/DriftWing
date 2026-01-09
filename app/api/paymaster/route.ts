// Proxies paymaster JSON-RPC calls to CDP (Base Paymaster).
//
// Why:
// - The Paymaster & Bundler endpoint from CDP includes an API key.
// - Wallets must be able to call a `paymasterService.url` over the public internet.
// - We keep the secret URL on the server (CDP_PAYMASTER_URL) and expose only this proxy.
//
// See:
// - Base gasless cookbook (paymaster + wallet_sendCalls)
// - CDP Paymaster guide (wagmi/viem integration + proxy recommendation)

export const runtime = 'nodejs';

function corsHeaders(origin?: string) {
  // Wallets/clients can have different origins (or none). Be permissive.
  return {
    'access-control-allow-origin': origin || '*',
    'access-control-allow-methods': 'POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
  };
}

export async function OPTIONS(req: Request) {
  const origin = req.headers.get('origin') ?? undefined;
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

export async function POST(req: Request) {
  const origin = req.headers.get('origin') ?? undefined;
  const target = process.env.CDP_PAYMASTER_URL;
  if (!target) {
    return new Response(
      JSON.stringify({ error: 'CDP_PAYMASTER_URL is not set on the server.' }),
      {
        status: 500,
        headers: {
          'content-type': 'application/json',
          ...corsHeaders(origin),
        },
      }
    );
  }

  // Forward the raw JSON-RPC body.
  const bodyText = await req.text();
  const upstream = await fetch(target, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: bodyText,
  });

  const respText = await upstream.text();
  return new Response(respText, {
    status: upstream.status,
    headers: {
      'content-type': upstream.headers.get('content-type') || 'application/json',
      ...corsHeaders(origin),
    },
  });
}
