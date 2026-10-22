// Per-user daily message cap. Workers AI's free allowance resets at 00:00 UTC,
// so the cap does too.
export function startOfUtcDay(t = Date.now()) {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

export async function usageToday(env, userId) {
  const limit = Number(env.DAILY_MESSAGE_LIMIT || 75);
  const since = startOfUtcDay();
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM messages WHERE user_id = ? AND role = 'user' AND created_at >= ?")
    .bind(userId, since)
    .first();
  const used = row?.n || 0;
  return { used, limit, remaining: Math.max(0, limit - used), resets_at: since + 86400000 };
}
