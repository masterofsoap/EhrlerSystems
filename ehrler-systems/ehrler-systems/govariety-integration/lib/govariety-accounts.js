// ─────────────────────────────────────────────────────────────────────────────
// ADAPTER: the only file that touches GoVariety's own tables.
//
// It assumes GoVariety's D1 has:
//   users    (id TEXT PRIMARY KEY, email TEXT UNIQUE, name TEXT, password_hash TEXT, created_at INTEGER)
//   sessions (token_hash TEXT PRIMARY KEY, user_id TEXT, created_at INTEGER, expires_at INTEGER)
// and a session cookie named "gv_session" holding a random token whose SHA-256
// hex is stored in sessions.token_hash.
//
// If GoVariety's tables or cookie are named differently, change the SQL and
// constants here — nothing else in the kit needs to change.
// ─────────────────────────────────────────────────────────────────────────────
import { getCookie, randomToken } from "./ehrler.js";

export const GV_SESSION_COOKIE = "gv_session";
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// Accounts created through Ehrler Systems have no GoVariety password. This value
// can never match a real password hash, so password login stays impossible
// until the user sets one.
const NO_PASSWORD = "!ehrler-sso";

const sha256Hex = async (s) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)))].map((b) => b.toString(16).padStart(2, "0")).join("");

export async function findUserByEhrlerSub(env, sub) {
  return env.DB.prepare("SELECT id, email, name FROM users WHERE ehrler_sub = ?").bind(sub).first();
}

export async function findUserByEmail(env, email) {
  return env.DB.prepare("SELECT id, email, name, ehrler_sub FROM users WHERE email = ? COLLATE NOCASE").bind(email).first();
}

export async function createUserFromEhrler(env, profile) {
  const id = `usr_${randomToken(12)}`;
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, created_at, ehrler_sub) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, profile.email.toLowerCase(), profile.name, NO_PASSWORD, Date.now(), profile.sub)
    .run();
  return { id, email: profile.email, name: profile.name };
}

export async function linkEhrler(env, userId, sub) {
  await env.DB.prepare("UPDATE users SET ehrler_sub = ? WHERE id = ?").bind(sub, userId).run();
}

// The GoVariety user currently signed in (used when linking from settings).
export async function currentGoVarietyUser(env, request) {
  const token = getCookie(request, GV_SESSION_COOKIE);
  if (!token) return null;
  return env.DB.prepare(
    "SELECT u.id, u.email, u.name FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ? AND s.expires_at > ?"
  ).bind(await sha256Hex(token), Date.now()).first();
}

// Creates a GoVariety session and returns the Set-Cookie header value.
export async function startGoVarietySession(env, request, userId) {
  const token = randomToken(32);
  const t = Date.now();
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)")
    .bind(await sha256Hex(token), userId, t, t + SESSION_TTL_MS)
    .run();
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return `${GV_SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL_MS / 1000}${secure}`;
}
