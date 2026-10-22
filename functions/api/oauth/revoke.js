// POST /api/oauth/revoke  (RFC 7009) — token, client_id, [client_secret]
import { authenticateClient, corsHeaders, getClient, OAuthError, oauthJson, readParams } from "../../../lib/oauth.js";
import { sha256Hex } from "../../../lib/util.js";

export async function onRequestOptions({ request, env }) {
  return new Response(null, { status: 204, headers: await corsHeaders(env, request, null) });
}

export async function onRequestPost({ request, env }) {
  const params = await readParams(request);
  const cors = await corsHeaders(env, request, await getClient(env, params.client_id));
  try {
    const client = await authenticateClient(env, request, params);
    await env.DB.prepare("UPDATE oauth_tokens SET revoked = 1 WHERE token_hash = ? AND client_id = ?")
      .bind(await sha256Hex(String(params.token || "")), client.id)
      .run();
    return oauthJson({ ok: true }, 200, cors);
  } catch (e) {
    if (e instanceof OAuthError) return oauthJson({ error: e.code, error_description: e.message }, e.status, cors);
    return oauthJson({ error: "server_error" }, 500, cors);
  }
}
