// GET /auth/ehrler/callback — Ehrler Systems sends the user back here.
import { cookie, exchangeCode, fetchProfile, FLOW_COOKIE, getCookie } from "../../../lib/ehrler.js";
import {
  createUserFromEhrler, currentGoVarietyUser, findUserByEhrlerSub, findUserByEmail, linkEhrler, startGoVarietySession,
} from "../../../lib/govariety-accounts.js";

// Where to send people when something goes wrong. Your sign-in page can read
// ?ehrler=<reason> to show a friendly message.
const LOGIN_PAGE = "/login";

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const clearFlow = cookie(request, FLOW_COOKIE, "", 0, "/auth/ehrler");
  const fail = (reason) => redirect(`${LOGIN_PAGE}?ehrler=${reason}`, [clearFlow]);

  let flow;
  try { flow = JSON.parse(getCookie(request, FLOW_COOKIE) || "null"); } catch {}
  if (!flow || !url.searchParams.get("state") || url.searchParams.get("state") !== flow.state) return fail("expired");
  if (url.searchParams.get("error")) return fail("cancelled");

  let profile;
  try {
    const tokens = await exchangeCode(env, request, url.searchParams.get("code") || "", flow.verifier);
    profile = await fetchProfile(env, tokens.access_token);
  } catch (e) {
    console.error("Ehrler sign-in failed:", e);
    return fail("failed");
  }
  if (!profile.email) return fail("no_email");

  // 1) Linking from GoVariety settings: attach to the signed-in account.
  if (flow.link) {
    const me = await currentGoVarietyUser(env, request);
    if (!me) return fail("signin_first");
    const taken = await findUserByEhrlerSub(env, profile.sub);
    if (taken && taken.id !== me.id) return redirect(withParam(flow.next, "already_linked"), [clearFlow]);
    await linkEhrler(env, me.id, profile.sub);
    return redirect(withParam(flow.next, "linked"), [clearFlow]);
  }

  // 2) Returning user: already linked.
  let user = await findUserByEhrlerSub(env, profile.sub);

  if (!user) {
    // 3) Email already has a GoVariety password account. Ehrler Systems doesn't
    //    verify emails, so we never auto-merge (that would let anyone claim an
    //    account by signing up elsewhere with its email). Ask them to sign in
    //    with their password and connect Ehrler from settings instead.
    const existing = await findUserByEmail(env, profile.email);
    if (existing) return fail("email_exists");

    // 4) New user: create a GoVariety account from the Ehrler profile.
    user = await createUserFromEhrler(env, profile);
  }

  const session = await startGoVarietySession(env, request, user.id);
  return redirect(flow.next, [clearFlow, session]);
}

function withParam(path, value) {
  return `${path}${path.includes("?") ? "&" : "?"}ehrler=${value}`;
}

function redirect(location, cookies) {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status: 302, headers });
}
