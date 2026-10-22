// PATCH /api/tasks/:id {enabled} — pause/resume.   DELETE /api/tasks/:id   POST /api/tasks/:id?run=1 — run now.
import { requireUser } from "../../../lib/auth.js";
import { nextRun } from "../../../lib/time.js";
import { handler, HttpError, json, readJson } from "../../../lib/util.js";
import { runTask } from "../../../lib/runner.js";

async function own(env, userId, id) {
  const t = await env.DB.prepare("SELECT * FROM tasks WHERE id = ? AND user_id = ?").bind(id, userId).first();
  if (!t) throw new HttpError(404, "Task not found.", "not_found");
  return t;
}

export const onRequestPatch = handler(async ({ request, env, params }) => {
  const user = await requireUser(env, request);
  const t = await own(env, user.id, params.id);
  const b = await readJson(request);
  const enabled = !!b.enabled;
  const next = enabled ? nextRun(JSON.parse(t.schedule)) : t.next_run_at;
  await env.DB.prepare("UPDATE tasks SET enabled = ?, next_run_at = ? WHERE id = ?").bind(enabled ? 1 : 0, next, t.id).run();
  return json({ ok: true, enabled, next_run_at: next });
});

export const onRequestDelete = handler(async ({ request, env, params }) => {
  const user = await requireUser(env, request);
  await readJson(request);
  await own(env, user.id, params.id);
  await env.DB.prepare("DELETE FROM tasks WHERE id = ?").bind(params.id).run();
  return json({ ok: true });
});

export const onRequestPost = handler(async ({ request, env, params, waitUntil }) => {
  const user = await requireUser(env, request);
  await readJson(request);
  const t = await own(env, user.id, params.id);
  const result = await runTask(env, t, { manual: true });
  return json(result);
});
