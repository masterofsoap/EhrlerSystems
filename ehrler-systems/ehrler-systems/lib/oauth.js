// "Sign in with Ehrler Systems": OAuth 2.0 authorization-code flow with PKCE.
import { b64url, HttpError, now, randomToken, sha256B64url, sha256Hex, timingSafeEqual } from "./util.js";

export const SUPPORTED_SCOPES = ["profile", "email"];
export const ACCESS_TTL = 60 * 60 * 1000; // 1 hour
export const REFRESH_TTL = 60 * 24 * 60 * 60 * 1000; // 60 days
export const CODE_TTL = 5 * 60 * 1000; // 5 minutes

export async function getClient(env, clientId) {
  if (!clientId) return null;
  const row = await env.DB.prepare("SELECT id, name, secret_hash, redirect_uris, homepage_url FROM oauth_clients WHERE id = ?").bind(String(clientId)).first();
  if (!row) return null;
  let uris = [];
  try { uris = JSON.parse(row.redirect_uris); } catch {}
  return { ...row, redirect_uris: uris, is_public: !row.secret_hash };
}

export function normalizeScope(scope) {
  const requested = String(scope || "profile email").split(/[\s,]+/).filter(Boolean);
  const bad = requested.filter((s) => !SUPPORTED_SCOPES.includes(s));
  if (bad.length) throw new HttpError(400, `Unsupported scope: ${bad.join(", ")}`, "invalid_scope");
  if (!requested.includes("profile")) requested.unshift("profile");
  return [...new Set(requested)].join(" ");
}

// Validates an authorization request. Problems with client_id / redirect_uri are
// shown to the user (never redirected), per the OAuth spec.
export async function validateAuthorizeRequest(env, p) {
  const client = await getClient(env, p.client_id);
  if (!client) throw new HttpError(400, "This app isn't registered with Ehrler Systems.", "invalid_client");
  if (!p.redirect_uri || !client.redirect_uris.includes(p.redirect_uri))
    throw new HttpError(400, "The app sent an unrecognized return address (redirect_uri).", "invalid_redirect_uri");
  if ((p.response_type || "code") !== "code") throw new HttpError(400, "Only response_type=code is supported.", "unsupported_response_type");

  let challenge = p.code_challenge || null;
  if (challenge) {
    if ((p.code_challenge_method || "S256") !== "S256") throw new HttpError(400, "PKCE must use S256.", "invalid_request");
    if (!/^[A-Za-z0-9_-]{43,128}$/.test(challenge)) throw new HttpError(400, "Invalid PKCE code_challenge.", "invalid_request");
  } else if (client.is_public) {
    throw new HttpError(400, "This app must use PKCE (code_challenge).", "invalid_request");
  }

  return {
    client,
    redirect_uri: p.redirect_uri,
    scope: normalizeScope(p.scope),
    state: p.state ? String(p.state).slice(0, 500) : null,
    code_challenge: challenge,
  };
}

export function buildRedirect(redirectUri, params) {
  const url = new URL(redirectUri);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  return url.toString();
}

export async function issueCode(env, req, userId) {
  const code = randomToken(32);
  await env.DB.prepare(
    "INSERT INTO oauth_codes (code_hash, client_id, user_id, redirect_uri, scope, code_challenge, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).bind(await sha256Hex(code), req.client.id, userId, req.redirect_uri, req.scope, req.code_challenge, now() + CODE_TTL).run();
  return code;
}

export async function recordGrant(env, userId, clientId, scope) {
  const t = now();
  await env.DB.prepare(
    `INSERT INTO oauth_grants (user_id, client_id, scope, created_at, last_used) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, client_id) DO UPDATE SET scope = excluded.scope, last_used = excluded.last_used`
  ).bind(userId, clientId, scope, t, t).run();
}

export async function issueTokens(env, clientId, userId, scope) {
  const access = "esa_" + randomToken(32);
  const refresh = "esr_" + randomToken(32);
  const t = now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO oauth_tokens (token_hash, kind, client_id, user_id, scope, expires_at, created_at) VALUES (?, 'access', ?, ?, ?, ?, ?)")
      .bind(await sha256Hex(access), clientId, userId, scope, t + ACCESS_TTL, t),
    env.DB.prepare("INSERT INTO oauth_tokens (token_hash, kind, client_id, user_id, scope, expires_at, created_at) VALUES (?, 'refresh', ?, ?, ?, ?, ?)")
      .bind(await sha256Hex(refresh), clientId, userId, scope, t + REFRESH_TTL, t),
  ]);
  return { access_token: access, token_type: "Bearer", expires_in: ACCESS_TTL / 1000, refresh_token: refresh, scope };
}

export async function verifyPkce(verifier, challenge) {
  if (!verifier || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  return timingSafeEqual(await sha256B64url(verifier), challenge);
}

// Client authentication for the token / revoke endpoints.
export async function authenticateClient(env, request, params) {
  let id = params.client_id;
  let secret = params.client_secret;
  const auth = request.headers.get("authorization") || "";
  if (auth.startsWith("Basic ")) {
    try {
      const [u, s] = atob(auth.slice(6)).split(":");
      id = decodeURIComponent(u);
      secret = decodeURIComponent(s || "");
    } catch {}
  }
  const client = await getClient(env, id);
  if (!client) throw new OAuthError(401, "invalid_client", "Unknown client.");
  if (!client.is_public) {
    if (!secret || !timingSafeEqual(await sha256Hex(secret), client.secret_hash)) throw new OAuthError(401, "invalid_client", "Client authentication failed.");
  }
  return client;
}

export class OAuthError extends Error {
  constructor(status, code, description) {
    super(description);
    this.status = status;
    this.code = code;
  }
}

// CORS: an app's browser code may call token/userinfo only from the origins of
// its registered redirect URIs.
export async function corsHeaders(env, request, client) {
  const origin = request.headers.get("origin");
  if (!origin) return {};
  let allowed = false;
  if (client) {
    allowed = client.redirect_uris.some((u) => { try { return new URL(u).origin === origin; } catch { return false; } });
  } else {
    const { results } = await env.DB.prepare("SELECT redirect_uris FROM oauth_clients").all();
    allowed = results.some((r) => { try { return JSON.parse(r.redirect_uris).some((u) => new URL(u).origin === origin); } catch { return false; } });
  }
  if (!allowed) return {};
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "authorization, content-type",
    "access-control-max-age": "600",
    vary: "Origin",
  };
}

export async function readParams(request) {
  const ct = request.headers.get("content-type") || "";
  if (ct.includes("application/json")) return await request.json().catch(() => ({}));
  if (ct.includes("application/x-www-form-urlencoded") || ct.includes("multipart/form-data")) {
    const form = await request.formData();
    return Object.fromEntries([...form.entries()].map(([k, v]) => [k, String(v)]));
  }
  return {};
}

export function oauthJson(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", pragma: "no-cache", ...extra },
  });
}

export { b64url };
