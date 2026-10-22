// GoVariety ⇄ Ehrler Systems: OAuth helpers (runs in GoVariety's Pages Functions).
//
// Required GoVariety settings:
//   [vars]   EHRLER_URL = "https://ehrler-systems.pages.dev"   (your Ehrler Systems site, no trailing slash)
//            EHRLER_CLIENT_ID = "govariety"
//   secret   EHRLER_CLIENT_SECRET   (npx wrangler pages secret put EHRLER_CLIENT_SECRET)

export const FLOW_COOKIE = "gv_ehrler_flow";

const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
export const randomToken = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));

export async function pkcePair() {
  const verifier = randomToken(48);
  const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge };
}

export function callbackUrl(request) {
  return new URL("/auth/ehrler/callback", request.url).toString();
}

export function getCookie(request, name) {
  for (const part of (request.headers.get("cookie") || "").split(";")) {
    const i = part.indexOf("=");
    if (i > -1 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function cookie(request, name, value, maxAge, path = "/") {
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${name}=${encodeURIComponent(value)}; Path=${path}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

export async function exchangeCode(env, request, code, verifier) {
  const res = await fetch(`${env.EHRLER_URL}/api/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: callbackUrl(request),
      client_id: env.EHRLER_CLIENT_ID,
      client_secret: env.EHRLER_CLIENT_SECRET,
      code_verifier: verifier,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || `Token exchange failed (${res.status})`);
  return data;
}

export async function fetchProfile(env, accessToken) {
  const res = await fetch(`${env.EHRLER_URL}/api/oauth/userinfo`, { headers: { authorization: `Bearer ${accessToken}` } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error_description || `Could not load Ehrler Systems profile (${res.status})`);
  return data; // { sub, name, email, email_verified, created_at }
}
