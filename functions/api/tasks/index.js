// GET /api/tasks — the user's scheduled tasks.   POST /api/tasks — create one from the UI.
import { requireUser } from "../../../lib/auth.js";
import { ToolError } from "../../../lib/connections.js";
import { createTask, listTasks, normalizeSchedule } from "../../../lib/tasks.js";
import { handler, HttpError, json, readJson } from "../../../lib/util.js";

export const onRequestGet = handler(async ({ request, env }) => {
  const user = await requireUser(env, request);
  return json({ tasks: await listTasks(env, user.id) });
});

export const onRequestPost = handler(async ({ request, env }) => {
  const user = await requireUser(env, request);
  const b = await readJson(request);
  if (!String(b.title || "").trim() || !String(b.prompt || "").trim()) throw new HttpError(400, "Give the task a title and instructions.", "bad_task");
  try {
    const schedule = normalizeSchedule(b, b.timezone);
    const t = await createTask(env, user.id, { title: b.title, prompt: b.prompt, schedule, deliver: b.deliver });
    return json({ task: t }, { status: 201 });
  } catch (e) {
    if (e instanceof ToolError) throw new HttpError(400, e.message, "bad_task");
    throw e;
  }
});
