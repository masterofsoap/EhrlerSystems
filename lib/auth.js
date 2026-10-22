// Email + password accounts and cookie sessions.
import { b64url, b64urlDecode, getCookie, HttpError, isSecure, now, randomToken, sha256Hex, timingSafeEqual } from "./util.js";

export const SESSION_COOKIE = "es_session";
const SESSION_TTL = 30 * 24 * 60 * 60 * 1000; // 30 days
const PBKDF2_ITER = 100000; // Workers' maximum for PBKDF2

const enc = new TextEncoder();

async function pbkdf2(password, salt, iterations) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

export async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITER);
  return `pbkdf2$${PBKDF2_ITER}$${b64url(salt)}$${b64url(hash)}`;
}

export async function verifyPassword(password, stored) {
  const [scheme, iter, saltB64, hashB64] = String(stored).split("$");
  if (scheme !== "pbkdf2") return false;
  const hash = await pbkdf2(password, b64urlDecode(saltB64), Number(iter));
  return timingSafeEqual(b64url(hash), hashB64);
}

// A real hash to compare against when the email doesn't exist, so response time
// doesn't reveal which emails have accounts.
let dummyHash;
export async function dummyVerify(password) {
  dummyHash ||= await hashPassword("not-a-real-password");
  await verifyPassword(password, dummyHash);
}

export function validatePassword(pw) {
  if (typeof pw !== "string" || pw.length < 8) throw new HttpError(400, "Password must be at least 8 characters.", "weak_password");
  if (pw.length > 200) throw new HttpError(400, "Password is too long.", "weak_password");
}

export async function createSession(env, request, userId) {
  const token = randomToken(32);
  const t = now();
  await env.DB.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at, user_agent) VALUES (?, ?, ?, ?, ?)")
    .bind(await sha256Hex(token), userId, t, t + SESSION_TTL, (request.headers.get("user-agent") || "").slice(0, 200))
    .run();
  return sessionCookie(request, token, SESSION_TTL / 1000);
}

export function sessionCookie(request, value, maxAgeSeconds) {
  const parts = [`${SESSION_COOKIE}=${value}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${maxAgeSeconds}`];
  if (isSecure(request)) parts.push("Secure");
  return parts.join("; ");
}

export async function getSessionUser(env, request) {
  const token = getCookie(request, SESSION_COOKIE);
  if (!token) return null;
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.created_at, s.expires_at, s.token_hash
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?`
  ).bind(await sha256Hex(token)).first();
  if (!row) return null;
  if (row.expires_at < now()) {
    await env.DB.prepare("DELETE FROM sessions WHERE token_hash = ?").bind(row.token_hash).run();
    return null;
  }
  return { id: row.id, email: row.email, name: row.name, created_at: row.created_at, session: row.token_hash };
}

export async function requireUser(env, request) {
  const user = await getSessionUser(env, request);
  if (!user) throw new HttpError(401, "Please sign in.", "unauthenticated");
  return user;
}

export function publicUser(u) {
  return { id: u.id, email: u.email, name: u.name, created_at: u.created_at };
}

// Simple sliding-window throttle backed by D1.
export async function throttle(env, key, limit, windowMs) {
  const since = now() - windowMs;
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM login_attempts WHERE key = ? AND created_at > ?").bind(key, since).first();
  if ((row?.n || 0) >= limit) throw new HttpError(429, "Too many attempts. Please wait a few minutes and try again.", "rate_limited");
}

export async function recordAttempt(env, key) {
  await env.DB.prepare("INSERT INTO login_attempts (key, created_at) VALUES (?, ?)").bind(key, now()).run();
}

export async function clearAttempts(env, key) {
  await env.DB.prepare("DELETE FROM login_attempts WHERE key = ?").bind(key).run();
}
