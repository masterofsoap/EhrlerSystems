// Update profile / change password / delete account.
import { hashPassword, publicUser, requireUser, sessionCookie, validatePassword, verifyPassword } from "../../../lib/auth.js";
import { stripe } from "../../../lib/stripe.js";
import { handler, HttpError, json, now, readJson } from "../../../lib/util.js";

export const onRequestPatch = handler(async ({ request, env }) => {
  const user = await requireUser(env, request);
  const body = await readJson(request);

  if (body.name !== undefined) {
    const name = String(body.name).trim().slice(0, 60);
    if (!name) throw new HttpError(400, "Name can't be empty.", "bad_name");
    await env.DB.prepare("UPDATE users SET name = ?, updated_at = ? WHERE id = ?").bind(name, now(), user.id).run();
    user.name = name;
  }

  if (body.new_password !== undefined) {
    const row = await env.DB.prepare("SELECT password_hash FROM users WHERE id = ?").bind(user.id).first();
    if (!(await verifyPassword(String(body.current_password || ""), row.password_hash)))
      throw new HttpError(401, "Current password is incorrect.", "bad_credentials");
    validatePassword(body.new_password);
    await env.DB.batch([
      env.DB.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?").bind(await hashPassword(body.new_password), now(), user.id),
      // Sign out every other device.
      env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash != ?").bind(user.id, user.session),
    ]);
  }

  return json({ user: publicUser(user) });
});

export const onRequestDelete = handler(async ({ request, env }) => {
  const user = await requireUser(env, request);
  const body = await readJson(request);
  const row = await env.DB.prepare("SELECT password_hash FROM users WHERE id = ?").bind(user.id).first();
  if (!(await verifyPassword(String(body.password || ""), row.password_hash)))
    throw new HttpError(401, "Password is incorrect.", "bad_credentials");

  // Stop billing before the account disappears.
  const { results: subs } = await env.DB.prepare(
    "SELECT id FROM subscriptions WHERE user_id = ? AND status IN ('active','trialing','past_due','incomplete')"
  ).bind(user.id).all();
  if (subs.length && env.STRIPE_SECRET_KEY) {
    for (const s of subs) await stripe(env, "DELETE", `/subscriptions/${s.id}`);
  }

  // Remove stored file contents (KV isn't covered by database cascades).
  if (env.FILES) {
    const { results: files } = await env.DB.prepare("SELECT id FROM files WHERE user_id = ?").bind(user.id).all();
    for (const f of files) await env.FILES.delete(`file:${f.id}`);
  }

  // D1 enforces foreign keys, so these cascade, but delete explicitly to be safe.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM files WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM connections WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM tasks WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM agent_runs WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM subscriptions WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM messages WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM conversations WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM oauth_tokens WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM oauth_codes WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM oauth_grants WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM sessions WHERE user_id = ?").bind(user.id),
    env.DB.prepare("DELETE FROM users WHERE id = ?").bind(user.id),
  ]);
  return json({ ok: true }, { headers: { "set-cookie": sessionCookie(request, "", 0) } });
});
