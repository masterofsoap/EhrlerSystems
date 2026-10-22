// Plans (Free / Ehrler Pro) and monthly usage metering.
//
// Usage is measured in "units", an estimate of the AI compute a reply cost
// (roughly Cloudflare Neurons). Bigger models and longer answers cost more,
// so complex work uses more of the allowance than a quick question.
// The allowance resets at 00:00 UTC on the 1st of every month.

// Neurons per 1M tokens [input, output]. Update if Cloudflare changes pricing.
export const MODEL_COSTS = {
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast": [26668, 204805],
  "@cf/qwen/qwen2.5-coder-32b-instruct": [60000, 90910],
  "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b": [45170, 443736],
};
const DEFAULT_COST = [30000, 200000];

export function unitsFor(model, inputTokens, outputTokens) {
  const [cin, cout] = MODEL_COSTS[model] || DEFAULT_COST;
  return Math.max(1, Math.ceil((inputTokens * cin + outputTokens * cout) / 1e6));
}

export const estimateTokens = (text) => Math.ceil(String(text || "").length / 4);

export function planLimits(env) {
  return {
    free: {
      units: Number(env.FREE_MONTHLY_UNITS || 25000),
      maxTokens: 2048,
      historyMessages: 24,
      historyChars: 24000,
      modes: ["chat", "code"],
    },
    pro: {
      units: Number(env.PRO_MONTHLY_UNITS || 500000),
      maxTokens: 4096,
      thinkMaxTokens: 8192,
      historyMessages: 48,
      historyChars: 60000,
      modes: ["chat", "code", "think"],
    },
  };
}

export function startOfUtcMonth(t = Date.now()) {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
}
export function startOfNextUtcMonth(t = Date.now()) {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
}

const PRO_STATUSES = new Set(["active", "trialing", "past_due"]);

// Returns the user's plan, from their Stripe subscription (kept in sync by the webhook).
export async function getPlan(env, user) {
  const comp = String(env.COMPLIMENTARY_PRO_EMAILS || "")
    .split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  if (user.email && comp.includes(String(user.email).toLowerCase())) {
    return { plan: "pro", pro: true, status: "complimentary", pro_until: null, cancel_at_period_end: false };
  }
  const sub = await env.DB.prepare(
    `SELECT status, current_period_end, cancel_at_period_end FROM subscriptions
      WHERE user_id = ? ORDER BY CASE WHEN status IN ('active','trialing','past_due') THEN 0 ELSE 1 END, updated_at DESC LIMIT 1`
  ).bind(user.id).first();
  const pro = !!sub && PRO_STATUSES.has(sub.status);
  return {
    plan: pro ? "pro" : "free",
    pro,
    status: sub?.status || "none",
    pro_until: pro ? sub.current_period_end || null : null,
    cancel_at_period_end: pro ? !!sub.cancel_at_period_end : false,
  };
}

export async function usageThisMonth(env, userId, plan) {
  const limit = planLimits(env)[plan].units;
  const since = startOfUtcMonth();
  const row = await env.DB.prepare("SELECT COALESCE(SUM(units), 0) AS used FROM messages WHERE user_id = ? AND created_at >= ?")
    .bind(userId, since).first();
  const used = Number(row?.used || 0);
  return {
    used,
    limit,
    remaining: Math.max(0, limit - used),
    percent: Math.min(100, Math.round((used / Math.max(1, limit)) * 1000) / 10),
    resets_at: startOfNextUtcMonth(),
  };
}

// Everything the app needs to know about a user's account in one call.
export async function accountState(env, user) {
  const plan = await getPlan(env, user);
  const limits = planLimits(env)[plan.plan];
  return {
    ...plan,
    usage: await usageThisMonth(env, user.id, plan.plan),
    modes: limits.modes,
    pro_price: env.PRO_PRICE_LABEL || "$12/month",
    billing_enabled: !!(env.STRIPE_SECRET_KEY && env.STRIPE_PRICE_ID),
  };
}
