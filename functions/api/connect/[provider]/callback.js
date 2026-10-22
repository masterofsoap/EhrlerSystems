// GET /api/connect/:provider/callback — Google / GitHub sends the user back here.
import { getSessionUser } from "../../../../lib/auth.js";
import { finishAuth, PROVIDERS } from "../../../../lib/connections.js";

export async function onRequestGet({ request, env, params }) {
  const back = (q) => new Response(null, { status: 302, headers: { location: `/app?${q}`, "cache-control": "no-store" } });
  if (!PROVIDERS[params.provider]) return back("connect_error=unknown");
  try {
    const r = await finishAuth(env, request, params.provider);
    const user = await getSessionUser(env, request);
    if (!user || user.id !== r.userId) return back("connect_error=session");
    return back(r.cancelled ? "connect_error=cancelled" : `connected=${params.provider}`);
  } catch (e) {
    console.error("connect failed", e);
    return back(`connect_error=${encodeURIComponent(e.code || "failed")}`);
  }
}
