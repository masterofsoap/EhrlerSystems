import { getSessionUser, sessionCookie } from "../../../lib/auth.js";
import { handler, json, readJson } from "../../../lib/util.js";

export const onRequestPost = handler(async ({ request, env }) => {
  await readJson(request);
  const user = await getSessionUser(env, request);
  if (user) await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(user.session).run();
  return json({ ok: true }, { headers: { "set-cookie": sessionCookie(request, "", 0) } });
});
