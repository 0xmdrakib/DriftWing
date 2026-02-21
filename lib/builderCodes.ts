type Hex = `0x${string}`;

// ERC-8021 marker: last 16 bytes are the repeating 0x8021 pattern.
// 0x8021 is 2 bytes, repeated 8 times => 16 bytes.
const ERC8021_MARKER_HEX = '8021'.repeat(8);

function strip0x(hex: string): string {
  return hex.startsWith('0x') ? hex.slice(2) : hex;
}

function toHexByte(n: number): string {
  const v = n & 0xff;
  return v.toString(16).padStart(2, '0');
}

function utf8ToHex(str: string): string {
  const enc = new TextEncoder();
  const bytes = enc.encode(str);
  let out = '';
  for (const b of bytes) out += toHexByte(b);
  return out;
}

export function hasErc8021Suffix(data: Hex): boolean {
  const raw = strip0x(data.toLowerCase());
  return raw.endsWith(ERC8021_MARKER_HEX);
}

export function getBuilderCodesFromEnv(): string[] {
  // Prefer NEXT_PUBLIC_BUILDER_CODES (comma-separated), fallback to NEXT_PUBLIC_BUILDER_CODE.
  const multi = process.env.NEXT_PUBLIC_BUILDER_CODES;
  const single = process.env.NEXT_PUBLIC_BUILDER_CODE;

  const list = (multi ?? single ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  // De-dupe while preserving order.
  const seen = new Set<string>();
  return list.filter((c) => {
    if (seen.has(c)) return false;
    seen.add(c);
    return true;
  });
}

/**
 * ERC-8021 Attribution (Schema 0 - canonical registry) data suffix.
 *
 * Encoding matches the ox/erc8021 reference format:
 *   <utf8("code1,code2")> <1-byte length> <1-byte schemaId=0x00> <16-byte marker>
 */
export function builderCodesToDataSuffix(codes: string[]): Hex | null {
  const clean = codes.map((c) => c.trim()).filter(Boolean);
  if (!clean.length) return null;

  const codesCsv = clean.join(',');
  const codesHex = utf8ToHex(codesCsv);
  const codesLenBytes = codesHex.length / 2;
  if (codesLenBytes > 255) {
    throw new Error('Builder codes payload too long (max 255 bytes)');
  }

  // Schema 0
  const schemaIdHex = '00';
  const lenHex = toHexByte(codesLenBytes);

  return (`0x${codesHex}${lenHex}${schemaIdHex}${ERC8021_MARKER_HEX}`) as Hex;
}

export function getBuilderCodesDataSuffix(): Hex | null {
  return builderCodesToDataSuffix(getBuilderCodesFromEnv());
}

export function appendBuilderCodesSuffix(data: Hex): Hex {
  const suffix = getBuilderCodesDataSuffix();
  if (!suffix) return data;
  if (hasErc8021Suffix(data)) return data;
  return (`0x${strip0x(data)}${strip0x(suffix)}`) as Hex;
}
