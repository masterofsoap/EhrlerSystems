// Connected accounts (Google, GitHub): OAuth client flows, token storage and refresh.
import { open, seal } from "./secure.js";
import { HttpError, now, randomToken, sha256B64url } from "./util.js";

export const PROVIDERS = {
  google: {
    name: "Google",
    authorize: "https://accounts.google.com/o/oauth2/v2/auth",
    token: "https://oauth2.googleapis.com/token",
    scope: "openid email profile https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/calendar.events",
    clientId: (env) => env.GOOGLE_CLIENT_ID,
    clientSecret: (env) => env.GOOGLE_CLIENT_SECRET,
    extraAuth: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
    pkce: true,
  },
  github: {
    name: "GitHub",
    authorize: "https://github.com/login/oauth/authorize",
    token: "https://github.com/login/oauth/access_token",
    scope: "repo read:user",
    clientId: (env) => env.GITHUB_CLIENT_ID,
    clientSecret: (env) => env.GITHUB_CLIENT_SECRET,
    extraAuth: { allow_signup: "false" },
    pkce: false,
  },
};

export function providerConfigured(env, provider) {
  const p = PROVIDERS[provider];
  return !!(p && p.clientId(env) && p.clientSecret(env));
}

export function callbackUrl(request, provider) {
  return new URL(`/api/connect/${provider}/callback`, request.url).toString();
}

export async function startAuth(env, request, userId, provider, returnTo = "/app") {
  const p = PROVIDERS[provider];
  if (!p) throw new HttpError(404, "Unknown connection.", "not_found");
  if (!providerConfigured(env, provider)) throw new HttpError(503, `${p.name} isn't set up on this site yet.`, "not_configured");
  const state = randomToken(24);
  const verifier = p.pkce ? randomToken(48) : null;
  await env.DB.prepare("INSERT INTO oauth_states (state, user_id, provider, verifier, expires_at) VALUES (?, ?, ?, ?, ?)")
    .bind(state, userId, provider, JSON.stringify({ verifier, returnTo }), now() + 10 * 60 * 1000)
    .run();
  const url = new URL(p.authorize);
  const params = {
    client_id: p.clientId(env),
    redirect_uri: callbackUrl(request, provider),
    response_type: "code",
    scope: p.scope,
    state,
    ...p.extraAuth,
  };
  if (verifier) Object.assign(params, { code_challenge: await sha256B64url(verifier), code_challenge_method: "S256" });
  url.search = new URLSearchParams(params).toString();
  return url.toString();
}

export async function finishAuth(env, request, provider) {
  const p = PROVIDERS[provider];
  const u = new URL(request.url);
  const state = u.searchParams.get("state") || "";
  const row = await env.DB.prepare("SELECT * FROM oauth_states WHERE state = ? AND provider = ?").bind(state, provider).first();
  if (!row) throw new HttpError(400, "This connection link expired. Please try again.", "bad_state");
  await env.DB.prepare("DELETE FROM oauth_states WHERE state = ?").bind(state).run();
  if (row.expires_at < now()) throw new HttpError(400, "This connection link expired. Please try again.", "bad_state");
  const extra = JSON.parse(row.verifier || "{}");
  if (u.searchParams.get("error")) return { userId: row.user_id, returnTo: extra.returnTo, cancelled: true };

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: u.searchParams.get("code") || "",
    redirect_uri: callbackUrl(request, provider),
    client_id: p.clientId(env),
    client_secret: p.clientSecret(env),
  });
  if (extra.verifier) body.set("code_verifier", extra.verifier);
  const res = await fetch(p.token, { method: "POST", headers: { accept: "application/json", "content-type": "application/x-www-form-urlencoded" }, body });
  const tok = await res.json().catch(() => ({}));
  if (!res.ok || !tok.access_token) throw new HttpError(502, `${p.name} didn't accept the connection (${tok.error_description || tok.error || res.status}).`, "token_failed");

  const account = await identify(provider, tok.access_token);
  const t = now();
  await env.DB.prepare(
    `INSERT INTO connections (user_id, provider, account, access_token, refresh_token, expires_at, scope, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(user_id, provider) DO UPDATE SET account = excluded.account, access_token = excluded.access_token,
       refresh_token = COALESCE(excluded.refresh_token, connections.refresh_token), expires_at = excluded.expires_at,
       scope = excluded.scope, updated_at = excluded.updated_at`
  ).bind(
    row.user_id, provider, account, await seal(env, tok.access_token), tok.refresh_token ? await seal(env, tok.refresh_token) : null,
    tok.expires_in ? t + tok.expires_in * 1000 : null, tok.scope || p.scope, t, t
  ).run();
  return { userId: row.user_id, returnTo: extra.returnTo, account };
}

async function identify(provider, token) {
  try {
    if (provider === "google") {
      const r = await fetch("https://openidconnect.googleapis.com/v1/userinfo", { headers: { authorization: `Bearer ${token}` } });
      return (await r.json()).email || null;
    }
    if (provider === "github") {
      const r = await fetch("https://api.github.com/user", { headers: ghHeaders(token) });
      return (await r.json()).login || null;
    }
  } catch {}
  return null;
}

export async function listConnections(env, userId) {
  const { results } = await env.DB.prepare("SELECT provider, account, scope, created_at FROM connections WHERE user_id = ?").bind(userId).all();
  // Connections that aren't set up on this site are hidden entirely (they reappear once configured).
  return Object.keys(PROVIDERS).filter((key) => providerConfigured(env, key)).map((key) => {
    const c = results.find((r) => r.provider === key);
    return { provider: key, name: PROVIDERS[key].name, available: providerConfigured(env, key), connected: !!c, account: c?.account || null, since: c?.created_at || null };
  });
}

export async function isConnected(env, userId, provider) {
  return !!(await env.DB.prepare("SELECT 1 FROM connections WHERE user_id = ? AND provider = ?").bind(userId, provider).first());
}

export async function disconnect(env, userId, provider) {
  const row = await env.DB.prepare("SELECT access_token FROM connections WHERE user_id = ? AND provider = ?").bind(userId, provider).first();
  if (row && provider === "google") {
    try {
      const token = await open(env, row.access_token);
      await fetch("https://oauth2.googleapis.com/revoke", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token }) });
    } catch {}
  }
  await env.DB.prepare("DELETE FROM connections WHERE user_id = ? AND provider = ?").bind(userId, provider).run();
}

// Returns a valid access token, refreshing Google tokens when needed.
export async function accessToken(env, userId, provider) {
  const row = await env.DB.prepare("SELECT * FROM connections WHERE user_id = ? AND provider = ?").bind(userId, provider).first();
  if (!row) throw new ToolError(`${PROVIDERS[provider].name} isn't connected. Ask the user to connect it in Account → Connections.`);
  if (!row.expires_at || row.expires_at - 60000 > now()) return open(env, row.access_token);
  const refresh = await open(env, row.refresh_token);
  if (!refresh) throw new ToolError(`The ${PROVIDERS[provider].name} connection expired. Ask the user to reconnect it.`);
  const p = PROVIDERS[provider];
  const res = await fetch(p.token, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: refresh, client_id: p.clientId(env), client_secret: p.clientSecret(env) }),
  });
  const tok = await res.json().catch(() => ({}));
  if (!res.ok || !tok.access_token) throw new ToolError(`The ${p.name} connection needs to be reconnected (${tok.error || res.status}).`);
  await env.DB.prepare("UPDATE connections SET access_token = ?, expires_at = ?, updated_at = ? WHERE user_id = ? AND provider = ?")
    .bind(await seal(env, tok.access_token), now() + (tok.expires_in || 3600) * 1000, now(), userId, provider).run();
  return tok.access_token;
}

export class ToolError extends Error {}

export const ghHeaders = (token) => ({
  authorization: `Bearer ${token}`,
  accept: "application/vnd.github+json",
  "x-github-api-version": "2022-11-28",
  "user-agent": "Ehrler-Systems",
});
