// GET /api/oauth/userinfo  (Authorization: Bearer <access_token>)
import { corsHeaders, getClient, oauthJson } from "../../../lib/oauth.js";
import { now, sha256Hex } from "../../../lib/util.js";

export async function onRequestOptions({ request, env }) {
  return new Response(null, { status: 204, headers: await corsHeaders(env, request, null) });
}

export async function onRequestGet({ request, env }) {
  const auth = request.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  const challenge = { "www-authenticate": 'Bearer realm="ehrler-systems", error="invalid_token"' };
  if (!token) return oauthJson({ error: "invalid_token", error_description: "Missing bearer token." }, 401, { ...challenge, ...(await corsHeaders(env, request, null)) });

  const row = await env.DB.prepare(
    `SELECT t.client_id, t.scope, t.expires_at, t.revoked, u.id, u.email, u.name, u.created_at
       FROM oauth_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ? AND t.kind = 'access'`
  ).bind(await sha256Hex(token)).first();

  const cors = await corsHeaders(env, request, row ? await getClient(env, row.client_id) : null);
  if (!row || row.revoked || row.expires_at < now())
    return oauthJson({ error: "invalid_token", error_description: "Token is invalid or expired." }, 401, { ...challenge, ...cors });

  await env.DB.prepare("UPDATE oauth_grants SET last_used = ? WHERE user_id = ? AND client_id = ?").bind(now(), row.id, row.client_id).run();

  const scopes = row.scope.split(" ");
  const info = { sub: row.id, name: row.name, created_at: row.created_at, issuer: "ehrler-systems" };
  if (scopes.includes("email")) Object.assign(info, { email: row.email, email_verified: false });
  return oauthJson(info, 200, cors);
}
