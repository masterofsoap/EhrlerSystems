// Minimal Stripe client for Workers (no SDK needed).
import { HttpError, now } from "./util.js";

const API = "https://api.stripe.com/v1";
export const STRIPE_VERSION = "2025-08-27.basil"; // matches the webhook endpoint's version

// Flattens nested objects/arrays into Stripe's form encoding: a[b][0][c]=…
function encode(params, prefix, out = new URLSearchParams()) {
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    const key = prefix ? `${prefix}[${k}]` : k;
    if (Array.isArray(v)) v.forEach((item, i) => (typeof item === "object" ? encode(item, `${key}[${i}]`, out) : out.append(`${key}[${i}]`, String(item))));
    else if (typeof v === "object") encode(v, key, out);
    else out.append(key, String(v));
  }
  return out;
}

export async function stripe(env, method, path, params) {
  if (!env.STRIPE_SECRET_KEY) throw new HttpError(503, "Billing isn't set up yet.", "billing_disabled");
  let url = API + path;
  const init = {
    method,
    headers: {
      authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "stripe-version": STRIPE_VERSION,
    },
  };
  if (params && method === "GET") url += "?" + encode(params).toString();
  else if (params) {
    init.headers["content-type"] = "application/x-www-form-urlencoded";
    init.body = encode(params).toString();
  }
  const res = await fetch(url, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    console.error("Stripe error", res.status, data?.error);
    throw new HttpError(502, "The payment service had a problem. Please try again.", "stripe_error");
  }
  return data;
}

// Verifies the Stripe-Signature header (HMAC-SHA256 over "timestamp.payload").
export async function verifyWebhook(secret, payload, header, toleranceSec = 300) {
  if (!secret || !header) return false;
  const parts = Object.create(null);
  const sigs = [];
  for (const kv of header.split(",")) {
    const [k, v] = kv.split("=");
    if (k === "v1") sigs.push(v);
    else parts[k] = v;
  }
  const t = Number(parts.t);
  if (!t || !sigs.length) return false;
  if (Math.abs(Date.now() / 1000 - t) > toleranceSec) return false;
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${t}.${payload}`));
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return sigs.some((s) => s.length === expected.length && [...s].reduce((d, c, i) => d | (c.charCodeAt(0) ^ expected.charCodeAt(i)), 0) === 0);
}

// Only subscriptions for the Ehrler Pro product count (the Stripe account may sell other things).
export function isEhrlerPro(env, sub) {
  const productId = env.STRIPE_PRODUCT_ID || "ehrler_pro";
  return (sub?.items?.data || []).some((it) => {
    const p = it.price?.product;
    return (typeof p === "string" ? p : p?.id) === productId || it.price?.id === env.STRIPE_PRICE_ID;
  });
}

// Saves a Stripe subscription to D1. Returns the user id it belongs to, or null.
export async function saveSubscription(env, sub, userIdHint) {
  if (!sub?.id || !isEhrlerPro(env, sub)) return null;
  const customer = typeof sub.customer === "string" ? sub.customer : sub.customer?.id;
  let userId = sub.metadata?.user_id || userIdHint || null;
  if (!userId && customer) {
    const u = await env.DB.prepare("SELECT id FROM users WHERE stripe_customer_id = ?").bind(customer).first();
    userId = u?.id || null;
  }
  if (!userId) return null;
  const exists = await env.DB.prepare("SELECT 1 FROM users WHERE id = ?").bind(userId).first();
  if (!exists) return null;

  const item = sub.items?.data?.[0];
  const periodEnd = sub.current_period_end ?? item?.current_period_end ?? null;
  await env.DB.prepare(
    `INSERT INTO subscriptions (id, user_id, customer_id, status, price_id, current_period_end, cancel_at_period_end, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET status = excluded.status, price_id = excluded.price_id,
       current_period_end = excluded.current_period_end, cancel_at_period_end = excluded.cancel_at_period_end,
       updated_at = excluded.updated_at`
  ).bind(
    sub.id, userId, customer, sub.status, item?.price?.id || null,
    periodEnd ? periodEnd * 1000 : null, sub.cancel_at_period_end || sub.cancel_at ? 1 : 0, now()
  ).run();
  if (customer) {
    await env.DB.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ? AND stripe_customer_id IS NULL").bind(customer, userId).run();
  }
  return userId;
}

// Pulls a customer's subscriptions straight from Stripe (used right after checkout,
// in case the webhook hasn't arrived yet).
export async function syncCustomer(env, userId, customerId) {
  const list = await stripe(env, "GET", "/subscriptions", { customer: customerId, status: "all", limit: 10 });
  for (const sub of list.data || []) await saveSubscription(env, sub, userId);
}
