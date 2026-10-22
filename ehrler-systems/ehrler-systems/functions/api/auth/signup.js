import { createSession, hashPassword, publicUser, recordAttempt, throttle, validatePassword } from "../../../lib/auth.js";
import { clientIp, EMAIL_RE, handler, HttpError, json, newId, now, readJson } from "../../../lib/util.js";

export const onRequestPost = handler(async ({ request, env }) => {
  if (String(env.SIGNUPS_OPEN ?? "true") === "false") throw new HttpError(403, "New sign-ups are closed right now.", "signups_closed");

  const body = await readJson(request);
  const email = String(body.email || "").trim().toLowerCase();
  const name = String(body.name || "").trim().slice(0, 60);
  const password = body.password;

  if (!EMAIL_RE.test(email) || email.length > 200) throw new HttpError(400, "Enter a valid email address.", "bad_email");
  if (!name) throw new HttpError(400, "Enter your name.", "bad_name");
  validatePassword(password);

  const ipKey = `signup-ip:${clientIp(request)}`;
  await throttle(env, ipKey, 10, 60 * 60 * 1000);

  const exists = await env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(email).first();
  if (exists) throw new HttpError(409, "An account with that email already exists. Try signing in.", "email_taken");

  const id = newId("usr");
  const t = now();
  await env.DB.prepare("INSERT INTO users (id, email, name, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, email, name, await hashPassword(password), t, t)
    .run();
  await recordAttempt(env, ipKey);

  const cookie = await createSession(env, request, id);
  return json({ user: publicUser({ id, email, name, created_at: t }) }, { status: 201, headers: { "set-cookie": cookie } });
});
