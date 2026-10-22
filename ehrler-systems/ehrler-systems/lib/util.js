// Shared helpers for Ehrler Systems Pages Functions.

export const now = () => Date.now();

const enc = new TextEncoder();

export function b64url(bytes) {
  let s = "";
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) s += String.fromCharCode(arr[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function b64urlDecode(str) {
  const s = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function randomToken(bytes = 32) {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function newId(prefix) {
  return `${prefix}_${randomToken(12)}`;
}

export async function sha256Hex(input) {
  const digest = await crypto.subtle.digest("SHA-256", typeof input === "string" ? enc.encode(input) : input);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256B64url(input) {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(input));
  return b64url(digest);
}

export function timingSafeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function json(data, init = {}) {
  const headers = new Headers(init.headers || {});
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", "no-store");
  return new Response(JSON.stringify(data), { ...init, headers });
}

export function error(status, message, code = "error", extraHeaders = {}) {
  return json({ error: code, message }, { status, headers: extraHeaders });
}

export function getCookie(request, name) {
  const header = request.headers.get("cookie") || "";
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

export function isSecure(request) {
  return new URL(request.url).protocol === "https:";
}

// Reads a JSON body for cookie-authenticated mutations. Requiring JSON (plus an
// Origin check) blocks cross-site form posts, which is our CSRF defence.
export async function readJson(request) {
  const ct = request.headers.get("content-type") || "";
  if (!ct.includes("application/json")) throw new HttpError(415, "Expected application/json", "bad_content_type");
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) throw new HttpError(403, "Cross-origin request blocked", "bad_origin");
  try {
    return await request.json();
  } catch {
    throw new HttpError(400, "Invalid JSON body", "bad_json");
  }
}

export class HttpError extends Error {
  constructor(status, message, code = "error") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// Wraps a handler so thrown HttpErrors become clean JSON responses.
export function handler(fn) {
  return async (ctx) => {
    try {
      return await fn(ctx);
    } catch (e) {
      if (e instanceof HttpError) return error(e.status, e.message, e.code);
      console.error(e);
      return error(500, "Something went wrong on our side.", "server_error");
    }
  };
}

export function clientIp(request) {
  return request.headers.get("cf-connecting-ip") || "local";
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
