import { api, setBusy, showNotice } from "./common.js";

const $ = (id) => document.getElementById(id);
$("year").textContent = new Date().getFullYear();

// Where to go after signing in (e.g. back to an OAuth consent screen).
const params = new URLSearchParams(location.search);
const next = (() => {
  const n = params.get("next");
  return n && n.startsWith("/") && !n.startsWith("//") ? n : "/app";
})();

// Already signed in? Go straight to the app.
api("/api/auth/me").then(() => location.replace(next)).catch(() => {});

function selectTab(which) {
  const login = which === "login";
  $("tabLogin").setAttribute("aria-selected", login);
  $("tabSignup").setAttribute("aria-selected", !login);
  $("loginForm").hidden = !login;
  $("signupForm").hidden = login;
  (login ? $("loginEmail") : $("signupName")).focus();
}
$("tabLogin").onclick = () => selectTab("login");
$("tabSignup").onclick = () => selectTab("signup");
if (params.get("mode") === "signup") selectTab("signup");
$("jumpSignin").onclick = (e) => { e.preventDefault(); selectTab("login"); $("auth").scrollIntoView({ behavior: "smooth" }); };

document.querySelectorAll(".pw-toggle").forEach((b) => {
  b.onclick = () => {
    const input = $(b.dataset.for);
    const show = input.type === "password";
    input.type = show ? "text" : "password";
    b.textContent = show ? "HIDE" : "SHOW";
  };
});

$("signupPassword").addEventListener("input", (e) => {
  const v = e.target.value;
  let score = 0;
  if (v.length >= 8) score++;
  if (v.length >= 12) score++;
  if (/[A-Z]/.test(v) && /[a-z]/.test(v)) score++;
  if (/\d/.test(v)) score++;
  if (/[^A-Za-z0-9]/.test(v)) score++;
  const m = $("pwMeter");
  m.style.width = `${(score / 5) * 100}%`;
  m.style.background = score <= 2 ? "var(--danger)" : score <= 3 ? "var(--ember-2)" : "var(--signal)";
});

$("loginForm").onsubmit = async (e) => {
  e.preventDefault();
  showNotice($("loginNotice"), "");
  const btn = $("loginBtn");
  setBusy(btn, true, "Signing in");
  try {
    await api("/api/auth/login", { method: "POST", body: { email: $("loginEmail").value, password: $("loginPassword").value } });
    location.assign(next);
  } catch (err) {
    showNotice($("loginNotice"), err.message);
    setBusy(btn, false);
  }
};

$("signupForm").onsubmit = async (e) => {
  e.preventDefault();
  showNotice($("signupNotice"), "");
  const btn = $("signupBtn");
  setBusy(btn, true, "Creating");
  try {
    await api("/api/auth/signup", {
      method: "POST",
      body: { name: $("signupName").value, email: $("signupEmail").value, password: $("signupPassword").value },
    });
    location.assign(next);
  } catch (err) {
    showNotice($("signupNotice"), err.message);
    setBusy(btn, false);
  }
};
