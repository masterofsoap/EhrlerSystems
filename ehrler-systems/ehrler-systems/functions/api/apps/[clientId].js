// DELETE /api/apps/:clientId — disconnect an app and revoke its tokens.
import { requireUser } from "../../../lib/auth.js";
import { handler, json, readJson } from "../../../lib/util.js";

export const onRequestDelete = handler(async ({ request, env, params }) => {
  const user = await requireUser(env, request);
  await readJson(request);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM oauth_grants WHERE user_id = ? AND client_id = ?").bind(user.id, params.clientId),
    env.DB.prepare("UPDATE oauth_tokens SET revoked = 1 WHERE user_id = ? AND client_id = ?").bind(user.id, params.clientId),
  ]);
  return json({ ok: true });
});
