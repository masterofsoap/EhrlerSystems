// DELETE /api/connections/:provider — disconnect (and revoke when possible).
import { requireUser } from "../../../lib/auth.js";
import { disconnect, PROVIDERS } from "../../../lib/connections.js";
import { handler, HttpError, json, readJson } from "../../../lib/util.js";

export const onRequestDelete = handler(async ({ request, env, params }) => {
  const user = await requireUser(env, request);
  await readJson(request);
  if (!PROVIDERS[params.provider]) throw new HttpError(404, "Unknown connection.", "not_found");
  await disconnect(env, user.id, params.provider);
  return json({ ok: true });
});
