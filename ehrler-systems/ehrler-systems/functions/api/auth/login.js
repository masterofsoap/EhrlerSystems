import { clearAttempts, createSession, dummyVerify, publicUser, recordAttempt, throttle, verifyPassword } from "../../../lib/auth.js";
import { clientIp, handler, HttpError, json, readJson } from "../../../lib/util.js";

export const onRequestPost = handler(async ({ request, env }) => {
  const body = await readJson(request);
  const email = String(body.email || "").trim().toLowerCase();
  const password = String(body.password || "");
  if (!email || !password) throw new HttpError(400, "Enter your email and password.", "missing_fields");

  const emailKey = `login-email:${email}`;
  const ipKey = `login-ip:${clientIp(request)}`;
  await throttle(env, emailKey, 8, 15 * 60 * 1000);
  await throttle(env, ipKey, 30, 15 * 60 * 1000);

  const user = await env.DB.prepare("SELECT id, email, name, password_hash, created_at FROM users WHERE email = ?").bind(email).first();
  const ok = user ? await verifyPassword(password, user.password_hash) : (await dummyVerify(password), false);

  if (!ok) {
    await recordAttempt(env, emailKey);
    await recordAttempt(env, ipKey);
    throw new HttpError(401, "That email and password don't match.", "bad_credentials");
  }

  await clearAttempts(env, emailKey);
  const cookie = await createSession(env, request, user.id);
  return json({ user: publicUser(user) }, { headers: { "set-cookie": cookie } });
});
