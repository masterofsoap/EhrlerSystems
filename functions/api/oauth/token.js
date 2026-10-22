// POST /api/oauth/token
//   grant_type=authorization_code: code, redirect_uri, client_id, [client_secret], [code_verifier]
//   grant_type=refresh_token:      refresh_token, client_id, [client_secret]
// Accepts application/x-www-form-urlencoded or JSON. Client secret may also be sent via HTTP Basic.
import { authenticateClient, corsHeaders, getClient, issueTokens, OAuthError, oauthJson, readParams, verifyPkce } from "../../../lib/oauth.js";
import { now, sha256Hex } from "../../../lib/util.js";

export async function onRequestOptions({ request, env }) {
  return new Response(null, { status: 204, headers: await corsHeaders(env, request, null) });
}

export async function onRequestPost({ request, env }) {
  const params = await readParams(request);
  let cors = await corsHeaders(env, request, await getClient(env, params.client_id));
  try {
    const client = await authenticateClient(env, request, params);
    cors = await corsHeaders(env, request, client);

    if (params.grant_type === "authorization_code") {
      const codeHash = await sha256Hex(String(params.code || ""));
      const row = await env.DB.prepare("SELECT * FROM oauth_codes WHERE code_hash = ?").bind(codeHash).first();
      if (!row || row.client_id !== client.id) throw new OAuthError(400, "invalid_grant", "Invalid authorization code.");

      // Single use: mark used atomically. A replayed code revokes what it issued.
      const upd = await env.DB.prepare("UPDATE oauth_codes SET used = 1 WHERE code_hash = ? AND used = 0").bind(codeHash).run();
      if (!upd.meta?.changes) {
        await env.DB.prepare("UPDATE oauth_tokens SET revoked = 1 WHERE user_id = ? AND client_id = ? AND created_at >= ?")
          .bind(row.user_id, client.id, row.expires_at - 5 * 60 * 1000).run();
        throw new OAuthError(400, "invalid_grant", "Authorization code was already used.");
      }
      if (row.expires_at < now()) throw new OAuthError(400, "invalid_grant", "Authorization code expired.");
      if (row.redirect_uri !== params.redirect_uri) throw new OAuthError(400, "invalid_grant", "redirect_uri does not match.");
      if (row.code_challenge) {
        if (!(await verifyPkce(params.code_verifier, row.code_challenge))) throw new OAuthError(400, "invalid_grant", "PKCE verification failed.");
      } else if (client.is_public) {
        throw new OAuthError(400, "invalid_grant", "PKCE is required.");
      }
      return oauthJson(await issueTokens(env, client.id, row.user_id, row.scope), 200, cors);
    }

    if (params.grant_type === "refresh_token") {
      const hash = await sha256Hex(String(params.refresh_token || ""));
      const row = await env.DB.prepare("SELECT * FROM oauth_tokens WHERE token_hash = ? AND kind = 'refresh'").bind(hash).first();
      if (!row || row.client_id !== client.id || row.revoked || row.expires_at < now())
        throw new OAuthError(400, "invalid_grant", "Invalid or expired refresh token.");
      const grant = await env.DB.prepare("SELECT 1 FROM oauth_grants WHERE user_id = ? AND client_id = ?").bind(row.user_id, client.id).first();
      if (!grant) throw new OAuthError(400, "invalid_grant", "Access was revoked by the user.");
      // Rotate: the old refresh token stops working.
      await env.DB.prepare("UPDATE oauth_tokens SET revoked = 1 WHERE token_hash = ?").bind(hash).run();
      return oauthJson(await issueTokens(env, client.id, row.user_id, row.scope), 200, cors);
    }

    throw new OAuthError(400, "unsupported_grant_type", "grant_type must be authorization_code or refresh_token.");
  } catch (e) {
    if (e instanceof OAuthError) return oauthJson({ error: e.code, error_description: e.message }, e.status, cors);
    console.error(e);
    return oauthJson({ error: "server_error", error_description: "Unexpected error." }, 500, cors);
  }
}
