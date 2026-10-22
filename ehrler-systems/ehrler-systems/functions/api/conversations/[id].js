// GET / PATCH / DELETE /api/conversations/:id
import { requireUser } from "../../../lib/auth.js";
import { handler, HttpError, json, readJson } from "../../../lib/util.js";

async function own(env, userId, id) {
  const c = await env.DB.prepare("SELECT id, title, mode, created_at, updated_at FROM conversations WHERE id = ? AND user_id = ?").bind(id, userId).first();
  if (!c) throw new HttpError(404, "Conversation not found.", "not_found");
  return c;
}

export const onRequestGet = handler(async ({ request, env, params }) => {
  const user = await requireUser(env, request);
  const conversation = await own(env, user.id, params.id);
  const { results } = await env.DB.prepare("SELECT id, role, content, model, created_at FROM messages WHERE conversation_id = ? ORDER BY created_at ASC")
    .bind(conversation.id)
    .all();
  return json({ conversation, messages: results });
});

export const onRequestPatch = handler(async ({ request, env, params }) => {
  const user = await requireUser(env, request);
  const conversation = await own(env, user.id, params.id);
  const body = await readJson(request);
  const title = String(body.title || "").trim().slice(0, 80);
  if (!title) throw new HttpError(400, "Title can't be empty.", "bad_title");
  await env.DB.prepare("UPDATE conversations SET title = ? WHERE id = ?").bind(title, conversation.id).run();
  return json({ conversation: { ...conversation, title } });
});

export const onRequestDelete = handler(async ({ request, env, params }) => {
  const user = await requireUser(env, request);
  const conversation = await own(env, user.id, params.id);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM messages WHERE conversation_id = ?").bind(conversation.id),
    env.DB.prepare("DELETE FROM conversations WHERE id = ?").bind(conversation.id),
  ]);
  return json({ ok: true });
});
