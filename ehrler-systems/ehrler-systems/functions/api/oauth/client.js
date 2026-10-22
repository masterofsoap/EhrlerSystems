// GET /api/oauth/client?client_id=…&redirect_uri=…&scope=…&code_challenge=…
// Used by the consent screen to validate a request and show the app's name.
import { getSessionUser } from "../../../lib/auth.js";
import { validateAuthorizeRequest } from "../../../lib/oauth.js";
import { handler, json } from "../../../lib/util.js";

export const onRequestGet = handler(async ({ request, env }) => {
  const p = Object.fromEntries(new URL(request.url).searchParams);
  const req = await validateAuthorizeRequest(env, p);
  const user = await getSessionUser(env, request);
  let granted = false;
  if (user) {
    const g = await env.DB.prepare("SELECT scope FROM oauth_grants WHERE user_id = ? AND client_id = ?").bind(user.id, req.client.id).first();
    granted = !!g && req.scope.split(" ").every((s) => g.scope.split(" ").includes(s));
  }
  return json({
    client: { id: req.client.id, name: req.client.name, homepage_url: req.client.homepage_url },
    scope: req.scope.split(" "),
    redirect_origin: new URL(req.redirect_uri).origin,
    already_granted: granted,
    user: user ? { email: user.email, name: user.name } : null,
  });
});
