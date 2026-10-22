// Scheduled tasks: create/list/delete, and the tools the agent uses to manage them.
import { ToolError } from "./connections.js";
import { describeSchedule, nextRun, validTimeZone } from "./time.js";
import { newId, now } from "./util.js";

export const MAX_TASKS = 20;

export function normalizeSchedule(input, fallbackTz) {
  const freq = ["daily", "weekly", "hourly", "once"].includes(input.frequency || input.freq) ? input.frequency || input.freq : "daily";
  const tz = validTimeZone(input.timezone || input.tz) ? input.timezone || input.tz : validTimeZone(fallbackTz) ? fallbackTz : "UTC";
  const time = /^\d{1,2}:\d{2}$/.test(String(input.time || "")) ? String(input.time).padStart(5, "0") : "08:00";
  const s = { freq, time, tz };
  if (freq === "weekly") {
    const days = (input.days || []).map(Number).filter((d) => d >= 1 && d <= 7);
    s.days = days.length ? [...new Set(days)].sort() : [1];
  }
  if (freq === "once") {
    const at = Date.parse(input.at || "");
    if (!at) throw new ToolError("A one-time task needs an 'at' date-time.");
    s.at = at;
  }
  return s;
}

export async function createTask(env, userId, { title, prompt, schedule, deliver }) {
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM tasks WHERE user_id = ?").bind(userId).first();
  if ((count?.n || 0) >= MAX_TASKS) throw new ToolError(`You can have up to ${MAX_TASKS} scheduled tasks.`);
  const next = nextRun(schedule);
  if (!next) throw new ToolError("That schedule never runs (is the time in the past?).");
  const id = newId("tsk");
  await env.DB.prepare(
    "INSERT INTO tasks (id, user_id, title, prompt, schedule, deliver, enabled, next_run_at, created_at) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)"
  ).bind(id, userId, String(title).slice(0, 80), String(prompt).slice(0, 4000), JSON.stringify(schedule), deliver === "email" ? "email" : "app", next, now()).run();
  return { id, next_run_at: next };
}

export async function listTasks(env, userId) {
  const { results } = await env.DB.prepare(
    "SELECT id, title, prompt, schedule, deliver, enabled, next_run_at, last_run_at, last_status, conversation_id, created_at FROM tasks WHERE user_id = ? ORDER BY created_at DESC"
  ).bind(userId).all();
  return results.map((t) => {
    const schedule = JSON.parse(t.schedule);
    return { ...t, schedule, schedule_text: describeSchedule(schedule), enabled: !!t.enabled };
  });
}

export const scheduleTask = {
  name: "schedule_task",
  description:
    "Create a recurring (or one-time) task that Ehrler Systems runs automatically, e.g. 'every weekday at 7:30 summarize my unread email and today's calendar'. The prompt is what you will be asked to do each time. deliver: 'app' (saved as a conversation) or 'email' (also emailed to the user; needs Google connected). The user approves first.",
  parameters: {
    type: "object",
    properties: {
      title: { type: "string" },
      prompt: { type: "string", description: "Self-contained instructions for each run" },
      frequency: { type: "string", enum: ["daily", "weekly", "hourly", "once"] },
      time: { type: "string", description: "HH:MM in 24h, user's local time" },
      days: { type: "array", items: { type: "number" }, description: "For weekly: 1=Mon … 7=Sun" },
      at: { type: "string", description: "For once: ISO date-time" },
      timezone: { type: "string" },
      deliver: { type: "string", enum: ["app", "email"] },
    },
    required: ["title", "prompt", "frequency"],
  },
  approval: (a, ctx) => {
    const s = normalizeSchedule(a, ctx.timezone);
    return { title: "Create this scheduled task?", action: "Create task", fields: [["Task", a.title], ["When", describeSchedule(s)], ["Deliver", a.deliver === "email" ? "In the app + email" : "In the app"]], body: a.prompt };
  },
  label: (a) => `Scheduling “${a.title}”`,
  async run(args, ctx) {
    const schedule = normalizeSchedule(args, ctx.timezone);
    const t = await createTask(ctx.env, ctx.user.id, { title: args.title, prompt: args.prompt, schedule, deliver: args.deliver });
    return {
      content: `Task created (${t.id}): ${describeSchedule(schedule)}. First run: ${new Date(t.next_run_at).toISOString()}.`,
      summary: `Scheduled “${args.title}”`,
      part: { type: "task", task_id: t.id, title: args.title, when: describeSchedule(schedule) },
    };
  },
};

export const listTasksTool = {
  name: "list_tasks",
  description: "List the user's scheduled tasks.",
  parameters: { type: "object", properties: {} },
  scheduledOk: true,
  label: () => "Checking scheduled tasks",
  async run(_args, ctx) {
    const tasks = await listTasks(ctx.env, ctx.user.id);
    return {
      content: tasks.map((t) => `• ${t.id} | ${t.title} | ${t.schedule_text} | ${t.enabled ? "on" : "paused"} | next ${t.next_run_at ? new Date(t.next_run_at).toISOString() : "—"}`).join("\n") || "No scheduled tasks.",
      summary: `${tasks.length} scheduled tasks`,
    };
  },
};

export const cancelTask = {
  name: "cancel_task",
  description: "Delete one of the user's scheduled tasks by id.",
  parameters: { type: "object", properties: { task_id: { type: "string" } }, required: ["task_id"] },
  label: () => "Removing a scheduled task",
  async run(args, ctx) {
    const r = await ctx.env.DB.prepare("DELETE FROM tasks WHERE id = ? AND user_id = ?").bind(String(args.task_id), ctx.user.id).run();
    if (!r.meta?.changes) throw new ToolError("No task with that id.");
    return { content: "Task deleted.", summary: "Deleted scheduled task" };
  },
};
