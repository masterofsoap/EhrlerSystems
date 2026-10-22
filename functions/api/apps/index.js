// GET /api/apps — apps the user has connected with "Sign in with Ehrler Systems".
import { requireUser } from "../../../lib/auth.js";
import { handler, json } from "../../../lib/util.js";

export const onRequestGet = handler(async ({ request, env }) => {
  const user = await requireUser(env, request);
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.name, c.homepage_url, g.scope, g.created_at, g.last_used
       FROM oauth_grants g JOIN oauth_clients c ON c.id = g.client_id
      WHERE g.user_id = ? ORDER BY g.last_used DESC`
  ).bind(user.id).all();
  return json({ apps: results });
});
