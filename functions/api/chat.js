// POST /api/chat — one user turn.
// Request:  { conversation_id?, message, mode?: "chat"|"code"|"think", attachments?: [file ids], timezone? }
// Response: NDJSON events (see lib/agent.js). Chat and Code use the agent with tools; Think streams a reasoning model.
import { requireUser } from "../../lib/auth.js";
import { agentSystemPrompt, availableTools, driveTurn, makeContext, newRunState } from "../../lib/agent.js";
import { getFileMeta } from "../../lib/files.js";
import { ndjsonStream } from "../../lib/ndjson.js";
import { accountState, estimateTokens, getPlan, planLimits, unitsFor, usageThisMonth } from "../../lib/plans.js";
import { stripThinking, systemPrompt } from "../../lib/prompts.js";
import { streamReply } from "../../lib/stream.js";
import { validTimeZone } from "../../lib/time.js";
import { handler, HttpError, newId, now, readJson } from "../../lib/util.js";

const MAX_INPUT = 16000;

export const onRequestPost = handler(async ({ request, env, waitUntil }) => {
  const user = await requireUser(env, request);
  const body = await readJson(request);
  const message = String(body.message || "").trim();
  const mode = ["chat", "code", "think"].includes(body.mode) ? body.mode : "chat";
  const timezone = validTimeZone(body.timezone) ? body.timezone : "UTC";
  const attachmentIds = Array.isArray(body.attachments) ? body.attachments.slice(0, 10).map(String) : [];
  if (!message && !attachmentIds.length) throw new HttpError(400, "Message is empty.", "empty_message");
  if (message.length > MAX_INPUT) throw new HttpError(413, `Message is too long (max ${MAX_INPUT.toLocaleString()} characters).`, "too_long");

  const plan = await getPlan(env, user);
  const limits = planLimits(env)[plan.plan];
  if (!limits.modes.includes(mode)) throw new HttpError(402, "Think mode is part of Ehrler Pro.", "pro_required");
  const usage = await usageThisMonth(env, user.id, plan.plan);
  if (usage.remaining <= 0) {
    const resets = new Date(usage.resets_at).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
    throw new HttpError(402, plan.pro
      ? `You've used all of this month's Ehrler Pro usage. It resets on ${resets}.`
      : `You've used this month's free usage. Upgrade to Ehrler Pro to keep going, or wait until it resets on ${resets}.`, "usage_exhausted");
  }

  // Attachments must belong to this user.
  const attachments = [];
  for (const id of attachmentIds) {
    const f = await getFileMeta(env, user.id, id);
    if (!f) throw new HttpError(400, "One of the attached files wasn't found.", "bad_attachment");
    attachments.push({ type: "file", file_id: f.id, name: f.name, mime: f.mime, size: f.size, url: `/api/files/${f.id}` });
  }

  // Conversation
  let conversation;
  if (body.conversation_id) {
    conversation = await env.DB.prepare("SELECT id, title, mode FROM conversations WHERE id = ? AND user_id = ?").bind(String(body.conversation_id), user.id).first();
    if (!conversation) throw new HttpError(404, "Conversation not found.", "not_found");
  } else {
    conversation = { id: newId("cnv"), title: makeTitle(message || attachments[0].name), mode };
    const t = now();
    await env.DB.prepare("INSERT INTO conversations (id, user_id, title, mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(conversation.id, user.id, conversation.title, mode, t, t).run();
  }

  // History (newest first, trimmed to the plan's budget)
  const { results: recent } = await env.DB.prepare(
    "SELECT role, content, parts FROM messages WHERE conversation_id = ? AND content != '' ORDER BY created_at DESC LIMIT ?"
  ).bind(conversation.id, limits.historyMessages).all();
  const history = [];
  let budget = limits.historyChars - message.length;
  for (const m of recent) {
    const content = m.role === "assistant" ? stripThinking(m.content) + describeParts(m.parts) : m.content + describeAttachments(m.parts);
    if (budget - content.length < 0) break;
    budget -= content.length;
    history.unshift({ role: m.role, content });
  }

  const userContent = (message || "(see attached files)") + describeAttachments(JSON.stringify(attachments));
  const userMsgId = newId("msg");
  const asstMsgId = newId("msg");
  const t = now();
  const model = mode === "think" ? env.THINK_MODEL : mode === "code" ? env.CODE_MODEL : env.AGENT_MODEL || env.CHAT_MODEL;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO messages (id, conversation_id, user_id, role, content, model, created_at, units, parts) VALUES (?, ?, ?, 'user', ?, NULL, ?, 0, ?)")
      .bind(userMsgId, conversation.id, user.id, message || "(attached files)", t, attachments.length ? JSON.stringify(attachments) : null),
    env.DB.prepare("INSERT INTO messages (id, conversation_id, user_id, role, content, model, created_at, units, parts) VALUES (?, ?, ?, 'assistant', '', ?, ?, 0, '[]')")
      .bind(asstMsgId, conversation.id, user.id, model, t + 1),
    env.DB.prepare("UPDATE conversations SET updated_at = ?, mode = ? WHERE id = ?").bind(t, mode, conversation.id),
  ]);

  return ndjsonStream(waitUntil, async (send) => {
    await send({ t: "meta", conversation_id: conversation.id, title: conversation.title, model, mode, user_message_id: userMsgId, message_id: asstMsgId });

    if (mode === "think" || !env.AI) {
      const maxTokens = mode === "think" ? limits.thinkMaxTokens || limits.maxTokens : limits.maxTokens;
      const messages = [{ role: "system", content: systemPrompt(mode) }, ...history, { role: "user", content: userContent }];
      let text = "";
      let failed = null;
      let reported = null;
      try {
        const r = await streamReply(env, model, messages, maxTokens, send);
        text = r.text;
        reported = r.usage;
      } catch (e) {
        console.error("AI error", e);
        failed = "The AI service had a problem. Please try again.";
      }
      const units = text.trim() ? unitsFor(model, reported?.prompt_tokens ?? estimateTokens(JSON.stringify(messages)), reported?.completion_tokens ?? estimateTokens(text)) : 0;
      await env.DB.prepare("UPDATE messages SET content = ?, units = ? WHERE id = ?").bind(text, units, asstMsgId).run();
      const account = await accountState(env, user);
      if (failed || !text.trim()) await send({ t: "error", message: failed || "The model returned an empty reply. Try again.", account });
      else await send({ t: "done", message_id: asstMsgId, units, account });
      return;
    }

    const ctx = makeContext({ env, user, plan, mode, timezone, conversationId: conversation.id });
    const tools = await availableTools(ctx);
    const messages = [{ role: "system", content: await agentSystemPrompt(ctx, tools) }, ...history, { role: "user", content: userContent }];
    const state = newRunState({ messages, model, mode, messageId: asstMsgId });
    state.timezone = timezone;
    ctx._state = state;
    await driveTurn(state, ctx, send);
  });
});

function makeTitle(message) {
  const clean = String(message).replace(/```[\s\S]*?```/g, " [code] ").replace(/\s+/g, " ").trim();
  return clean.length > 60 ? clean.slice(0, 57).trimEnd() + "…" : clean || "New conversation";
}

function describeAttachments(partsJson) {
  let parts = [];
  try { parts = JSON.parse(partsJson || "[]") || []; } catch {}
  const files = parts.filter((p) => p.type === "file");
  if (!files.length) return "";
  return "\n\n[Attached files]\n" + files.map((f) => `- ${f.name} (id ${f.file_id}, ${f.mime}, ${Math.round(f.size / 1024)} KB)`).join("\n");
}

function describeParts(partsJson) {
  let parts = [];
  try { parts = JSON.parse(partsJson || "[]") || []; } catch {}
  const imgs = parts.filter((p) => p.type === "image");
  return imgs.length ? "\n\n[Images shown: " + imgs.map((i) => `${i.name} (id ${i.file_id})`).join(", ") + "]" : "";
}
