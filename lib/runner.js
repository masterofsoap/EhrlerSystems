// Runs a scheduled task headlessly: the agent does the work, the result is saved
// to the task's conversation and (optionally) emailed to the user.
import { agentSystemPrompt, availableTools, makeContext, newRunState, runLoop } from "./agent.js";
import { isConnected } from "./connections.js";
import { getPlan, usageThisMonth } from "./plans.js";
import { describeSchedule, localNowString, nextRun } from "./time.js";
import { sendToSelf } from "./tools/google.js";
import { newId, now } from "./util.js";

export async function runTask(env, task, { manual = false } = {}) {
  const user = await env.DB.prepare("SELECT id, email, name FROM users WHERE id = ?").bind(task.user_id).first();
  if (!user) return { ok: false, status: "user missing" };
  const schedule = JSON.parse(task.schedule);
  const finish = async (status) => {
    const next = manual ? task.next_run_at : nextRun(schedule, now());
    await env.DB.prepare("UPDATE tasks SET last_run_at = ?, last_status = ?, next_run_at = ?, enabled = ? WHERE id = ?")
      .bind(now(), status.slice(0, 300), next, next || manual ? task.enabled : 0, task.id).run();
    return status;
  };

  const plan = await getPlan(env, user);
  const usage = await usageThisMonth(env, user.id, plan.plan);
  if (usage.remaining <= 0) return { ok: false, status: await finish("Skipped: this month's usage is used up") };

  // One conversation per task, created on first run.
  let conversationId = task.conversation_id;
  const exists = conversationId && (await env.DB.prepare("SELECT 1 FROM conversations WHERE id = ? AND user_id = ?").bind(conversationId, user.id).first());
  if (!exists) {
    conversationId = newId("cnv");
    await env.DB.prepare("INSERT INTO conversations (id, user_id, title, mode, created_at, updated_at) VALUES (?, ?, ?, 'chat', ?, ?)")
      .bind(conversationId, user.id, `⏱ ${task.title}`.slice(0, 80), now(), now()).run();
    await env.DB.prepare("UPDATE tasks SET conversation_id = ? WHERE id = ?").bind(conversationId, task.id).run();
  }

  const tz = schedule.tz || "UTC";
  const ctx = makeContext({ env, user, plan, mode: "chat", timezone: tz, conversationId, scheduled: true });
  const tools = await availableTools(ctx);
  const prompt = `Scheduled task "${task.title}" (${describeSchedule(schedule)}), running ${localNowString(tz)}.\n\n${task.prompt}\n\nThis runs automatically with no one watching: do the work with your tools and reply with a clear, concise report. You can't send emails to others, change calendars or push code during scheduled runs; if the task needs that, prepare it (e.g. a Gmail draft) and say so.`;
  const messages = [{ role: "system", content: await agentSystemPrompt(ctx, tools) }, { role: "user", content: prompt }];

  const userMsgId = newId("msg");
  const asstMsgId = newId("msg");
  const t = now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO messages (id, conversation_id, user_id, role, content, created_at, units) VALUES (?, ?, ?, 'user', ?, ?, 0)")
      .bind(userMsgId, conversationId, user.id, `⏱ ${task.title} — ${localNowString(tz)}\n\n${task.prompt}`, t),
    env.DB.prepare("INSERT INTO messages (id, conversation_id, user_id, role, content, model, created_at, units, parts) VALUES (?, ?, ?, 'assistant', '', ?, ?, 0, '[]')")
      .bind(asstMsgId, conversationId, user.id, env.AGENT_MODEL || env.CHAT_MODEL, t + 1),
  ]);

  const state = newRunState({ messages, model: env.AGENT_MODEL || env.CHAT_MODEL, mode: "chat", messageId: asstMsgId });
  ctx._state = state;
  let text;
  try {
    const r = await runLoop(state, ctx, async () => {});
    text = r.text || "Done.";
  } catch (e) {
    console.error("task failed", task.id, e);
    text = `The scheduled task couldn't finish: ${e?.message || e}`;
  }
  await env.DB.batch([
    env.DB.prepare("UPDATE messages SET content = ?, parts = ?, units = ?, model = ? WHERE id = ?").bind(text, JSON.stringify(state.parts), state.units, state.model, asstMsgId),
    env.DB.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").bind(now(), conversationId),
  ]);

  let status = "Done";
  if (task.deliver === "email") {
    if (await isConnected(env, user.id, "google")) {
      try {
        await sendToSelf(env, user, `Ehrler Systems: ${task.title}`, `${text}\n\n—\nScheduled task · ${describeSchedule(schedule)}\nOpen in Ehrler Systems: /app?c=${conversationId}`);
        status = "Done · emailed";
      } catch (e) {
        status = `Done · email failed (${e.message})`;
      }
    } else {
      status = "Done · email skipped (connect Google)";
    }
  }
  return { ok: true, status: await finish(status), conversation_id: conversationId };
}

// Called by the scheduler every few minutes: runs tasks that are due.
export async function runDue(env, limit = 5) {
  const { results } = await env.DB.prepare("SELECT * FROM tasks WHERE enabled = 1 AND next_run_at IS NOT NULL AND next_run_at <= ? ORDER BY next_run_at LIMIT ?")
    .bind(now(), limit).all();
  const ran = [];
  for (const task of results) {
    // Claim it so overlapping scheduler calls can't run it twice.
    const claimed = await env.DB.prepare("UPDATE tasks SET next_run_at = ? WHERE id = ? AND next_run_at = ?")
      .bind(now() + 30 * 60 * 1000, task.id, task.next_run_at).run();
    if (!claimed.meta?.changes) continue;
    const r = await runTask(env, task);
    ran.push({ id: task.id, status: r.status });
  }
  return ran;
}
