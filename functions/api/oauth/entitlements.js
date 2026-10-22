// POST /api/oauth/entitlements — server-to-server Pro check for Ehrler apps.
//   Body (form or JSON): sub, client_id, client_secret   (or HTTP Basic client auth)
//   → { sub, plan, pro, pro_until, entitlements, status }
// Lets an app like GoVariety re-check a user's Ehrler Pro status any time, without
// the user's tokens. Only works for users who have connected that app.
import { authenticateClient, OAuthError, oauthJson, readParams } from "../../../lib/oauth.js";
import { getPlan } from "../../../lib/plans.js";

export async function onRequestPost({ request, env }) {
  const params = await readParams(request);
  try {
    const client = await authenticateClient(env, request, params);
    if (client.is_public) throw new OAuthError(401, "invalid_client", "Entitlement checks require a confidential client.");
    const sub = String(params.sub || "");
    const row = await env.DB.prepare(
      "SELECT u.id, u.email FROM oauth_grants g JOIN users u ON u.id = g.user_id WHERE g.user_id = ? AND g.client_id = ?"
    ).bind(sub, client.id).first();
    if (!row) throw new OAuthError(404, "not_found", "This user hasn't connected your app (or disconnected it).");
    const plan = await getPlan(env, row);
    return oauthJson({
      sub: row.id,
      plan: plan.plan,
      pro: plan.pro,
      pro_until: plan.pro_until,
      entitlements: plan.pro ? ["pro"] : [],
      status: plan.status,
    });
  } catch (e) {
    if (e instanceof OAuthError) return oauthJson({ error: e.code, error_description: e.message }, e.status);
    console.error(e);
    return oauthJson({ error: "server_error" }, 500);
  }
}
