// Encrypts stored OAuth tokens with AES-GCM when TOKEN_ENCRYPTION_KEY is set.
import { b64url, b64urlDecode } from "./util.js";

const enc = new TextEncoder();
const dec = new TextDecoder();
let cachedKey, cachedFor;

async function key(env) {
  const secret = env.TOKEN_ENCRYPTION_KEY;
  if (!secret) return null;
  if (cachedFor === secret) return cachedKey;
  const raw = await crypto.subtle.digest("SHA-256", enc.encode(secret));
  cachedKey = await crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
  cachedFor = secret;
  return cachedKey;
}

export async function seal(env, text) {
  if (text == null) return null;
  const k = await key(env);
  if (!k) return "plain:" + text;
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, k, enc.encode(text));
  return `enc:v1:${b64url(iv)}:${b64url(ct)}`;
}

export async function open(env, stored) {
  if (stored == null) return null;
  if (stored.startsWith("plain:")) return stored.slice(6);
  if (!stored.startsWith("enc:v1:")) return stored;
  const k = await key(env);
  if (!k) throw new Error("TOKEN_ENCRYPTION_KEY is missing, so saved connections can't be read.");
  const [, , iv, ct] = stored.split(":");
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: b64urlDecode(iv) }, k, b64urlDecode(ct));
  return dec.decode(pt);
}
