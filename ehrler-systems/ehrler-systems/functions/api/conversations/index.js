// GET /api/conversations — the signed-in user's conversations, newest first.
import { requireUser } from "../../../lib/auth.js";
import { handler, json } from "../../../lib/util.js";

export const onRequestGet = handler(async ({ request, env }) => {
  const user = await requireUser(env, request);
  const q = new URL(request.url).searchParams.get("q")?.trim();
  const stmt = q
    ? env.DB.prepare(
        `SELECT id, title, mode, created_at, updated_at FROM conversations
          WHERE user_id = ? AND (title LIKE ? OR id IN (SELECT conversation_id FROM messages WHERE user_id = ? AND content LIKE ?))
          ORDER BY updated_at DESC LIMIT 100`
      ).bind(user.id, `%${q}%`, user.id, `%${q}%`)
    : env.DB.prepare("SELECT id, title, mode, created_at, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC LIMIT 200").bind(user.id);
  const { results } = await stmt.all();
  return json({ conversations: results });
});
