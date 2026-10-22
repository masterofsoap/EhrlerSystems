import { api, setBusy, showNotice } from "./common.js";

const $ = (id) => document.getElementById(id);
const params = Object.fromEntries(new URLSearchParams(location.search));
const KEYS = ["client_id", "redirect_uri", "response_type", "scope", "state", "code_challenge", "code_challenge_method"];
const authParams = Object.fromEntries(KEYS.filter((k) => params[k] != null).map((k) => [k, params[k]]));

const SCOPE_TEXT = {
  profile: ["Your name and Ehrler Systems account ID", '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/></svg>'],
  email: ["Your email address", '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/></svg>'],
};

function show(view) {
  for (const v of ["loading", "errorView", "loginView", "consentView"]) $(v).hidden = v !== view;
}

async function load() {
  show("loading");
  let info;
  try {
    info = await api(`/api/oauth/client?${new URLSearchParams(authParams)}`);
  } catch (e) {
    $("errorText").textContent = e.message;
    show("errorView");
    return;
  }
  document.querySelectorAll(".app-name").forEach((el) => (el.textContent = info.client.name));
  $("appBadge").textContent = info.client.name.charAt(0).toUpperCase();
  document.title = `Continue to ${info.client.name} · Ehrler Systems`;

  if (!info.user) {
    $("signupLink").href = `/?mode=signup&next=${encodeURIComponent(location.pathname + location.search)}`;
    show("loginView");
    $("email").focus();
    return;
  }

  if (info.already_granted) {
    $("loadingText").textContent = `Continuing to ${info.client.name}…`;
    return decide("approve");
  }

  $("scopes").innerHTML = info.scope.map((s) => `<li>${SCOPE_TEXT[s]?.[1] || ""}<span>${SCOPE_TEXT[s]?.[0] || s}</span></li>`).join("");
  $("acctName").textContent = info.user.name;
  $("acctEmail").textContent = info.user.email;
  $("acctAvatar").textContent = info.user.name.charAt(0).toUpperCase();
  $("returnTo").textContent = info.redirect_origin;
  show("consentView");
  $("allowBtn").focus();
}

async function decide(decision) {
  const btn = decision === "approve" ? $("allowBtn") : $("denyBtn");
  if (!$("consentView").hidden) setBusy(btn, true);
  try {
    const { redirect } = await api("/api/oauth/authorize", { method: "POST", body: { ...authParams, decision } });
    location.replace(redirect);
  } catch (e) {
    $("errorText").textContent = e.message;
    show("errorView");
  }
}

$("allowBtn").onclick = () => decide("approve");
$("denyBtn").onclick = () => decide("deny");
$("switchAcct").onclick = async () => {
  try { await api("/api/auth/logout", { method: "POST", body: {} }); } catch {}
  load();
};

$("loginForm").onsubmit = async (e) => {
  e.preventDefault();
  showNotice($("loginNotice"), "");
  setBusy($("loginBtn"), true, "Signing in");
  try {
    await api("/api/auth/login", { method: "POST", body: { email: $("email").value, password: $("password").value } });
    setBusy($("loginBtn"), false);
    load();
  } catch (err) {
    showNotice($("loginNotice"), err.message);
    setBusy($("loginBtn"), false);
  }
};

load();
