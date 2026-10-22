// GET /auth/ehrler/start            → sign up / sign in to GoVariety with Ehrler Systems
// GET /auth/ehrler/start?link=1     → connect Ehrler Systems to the signed-in GoVariety account
// GET /auth/ehrler/start?next=/path → where to land afterwards (same-site paths only)
import { callbackUrl, cookie, FLOW_COOKIE, pkcePair, randomToken } from "../../../lib/ehrler.js";

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const next = url.searchParams.get("next");
  const flow = {
    state: randomToken(24),
    ...(await pkcePair()),
    link: url.searchParams.get("link") === "1",
    next: next && next.startsWith("/") && !next.startsWith("//") ? next : "/",
  };

  const authorize = new URL(`${env.EHRLER_URL}/authorize`);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: env.EHRLER_CLIENT_ID,
    redirect_uri: callbackUrl(request),
    scope: "profile email",
    state: flow.state,
    code_challenge: flow.challenge,
    code_challenge_method: "S256",
  }).toString();

  delete flow.challenge;
  return new Response(null, {
    status: 302,
    headers: {
      location: authorize.toString(),
      "set-cookie": cookie(request, FLOW_COOKIE, JSON.stringify(flow), 600, "/auth/ehrler"),
      "cache-control": "no-store",
    },
  });
}
