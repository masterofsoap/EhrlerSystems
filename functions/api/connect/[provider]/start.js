// GET /api/connect/:provider/start → redirects to Google / GitHub to connect the account.
import { getSessionUser } from "../../../../lib/auth.js";
import { startAuth } from "../../../../lib/connections.js";
import { HttpError } from "../../../../lib/util.js";

export async function onRequestGet({ request, env, params }) {
  const user = await getSessionUser(env, request);
  if (!user) return Response.redirect(new URL("/?next=/app", request.url).toString(), 302);
  try {
    const url = await startAuth(env, request, user.id, params.provider, "/app");
    return new Response(null, { status: 302, headers: { location: url, "cache-control": "no-store" } });
  } catch (e) {
    const msg = e instanceof HttpError ? e.code : "error";
    return Response.redirect(new URL(`/app?connect_error=${msg}`, request.url).toString(), 302);
  }
}
