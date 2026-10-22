// POST /api/oauth/authorize — the signed-in user approves or denies an app.
// Body: the original authorize params + { decision: "approve" | "deny" }
// Returns { redirect } for the browser to follow.
import { requireUser } from "../../../lib/auth.js";
import { buildRedirect, issueCode, recordGrant, validateAuthorizeRequest } from "../../../lib/oauth.js";
import { handler, json, readJson } from "../../../lib/util.js";

export const onRequestPost = handler(async ({ request, env }) => {
  const user = await requireUser(env, request);
  const body = await readJson(request);
  const req = await validateAuthorizeRequest(env, body);

  if (body.decision !== "approve") {
    return json({ redirect: buildRedirect(req.redirect_uri, { error: "access_denied", error_description: "The user declined.", state: req.state }) });
  }

  const code = await issueCode(env, req, user.id);
  await recordGrant(env, user.id, req.client.id, req.scope);
  return json({ redirect: buildRedirect(req.redirect_uri, { code, state: req.state }) });
});
