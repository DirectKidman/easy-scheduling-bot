// Discord のインタラクションは Ed25519 で署名されている。毎リクエスト検証し、失敗したら 401 を返す。
// https://discord.com/developers/docs/interactions/overview#setting-up-an-endpoint-validating-security-request-headers

const keyCache = new Map<string, Promise<CryptoKey>>();

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

function importKey(publicKeyHex: string): Promise<CryptoKey> {
  let key = keyCache.get(publicKeyHex);
  if (!key) {
    const raw = hexToBytes(publicKeyHex);
    if (!raw) throw new Error("DISCORD_PUBLIC_KEY is not valid hex");
    key = crypto.subtle.importKey("raw", raw, { name: "Ed25519" }, false, ["verify"]);
    keyCache.set(publicKeyHex, key);
  }
  return key;
}

export async function verifyDiscordRequest(
  publicKeyHex: string,
  signatureHex: string | null,
  timestamp: string | null,
  body: string,
): Promise<boolean> {
  if (!signatureHex || !timestamp) return false;
  const signature = hexToBytes(signatureHex);
  if (!signature || signature.length !== 64) return false;
  const key = await importKey(publicKeyHex);
  const data = new TextEncoder().encode(timestamp + body);
  try {
    return await crypto.subtle.verify({ name: "Ed25519" }, key, signature, data);
  } catch {
    return false;
  }
}
