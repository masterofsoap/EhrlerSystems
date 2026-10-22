// The Ehrler Systems agent: a tool-calling loop on Workers AI.
//
// Events streamed to the browser (NDJSON):
//   {t:"meta", ...}                         conversation info (sent by the endpoint)
//   {t:"tool", id, name, label, status, summary?}   tool activity (running → done | error)
//   {t:"part", part}                        an image / link / task card to show
//   {t:"approval", run_id, call_id, name, preview}  paused: user must approve
//   {t:"client_tool", run_id, call_id, name, args}  paused: browser must run code
//   {t:"delta", v}                          final answer text
//   {t:"done", message_id, units, account} / {t:"error", message}
import { accessToken } from "./connections.js";
import { accountState, estimateTokens, planLimits, unitsFor } from "./plans.js";
import { listConnections } from "./connections.js";
import { localNowString } from "./time.js";
import { newId, now } from "./util.js";
import { readFile } from "./tools/files.js";
import { browse, readWebpage, webSearch } from "./tools/web.js";
import { generateImage } from "./tools/images.js";
import { runCode } from "./tools/code.js";
import { calendarCreate, calendarDelete, calendarList, calendarUpdate, gmailDraft, gmailRead, gmailSearch, gmailSend } from "./tools/google.js";
import { ghCreatePR, ghListFiles, ghListRepos, ghPush, ghReadFile } from "./tools/github.js";
import { cancelTask, listTasksTool, scheduleTask } from "./tasks.js";

export const TOOLS = [
  readWebpage, webSearch, browse, readFile, generateImage, runCode,
  gmailSearch, gmailRead, gmailDraft, gmailSend,
  calendarList, calendarCreate, calendarUpdate, calendarDelete,
  ghListRepos, ghListFiles, ghReadFile, ghPush, ghCreatePR,
  scheduleTask, listTasksTool, cancelTask,
];
const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t]));
const RUN_TTL = 24 * 60 * 60 * 1000;
const MAX_RESULT = 14000;

export async function availableTools(ctx) {
  const out = [];
  for (const t of TOOLS) {
    if (ctx.scheduled && (!t.scheduledOk || t.client || t.approval)) continue;
    if (t.available && !(await t.available(ctx))) continue;
    out.push(t);
  }
  return out;
}

export async function agentSystemPrompt(ctx, tools) {
  const conns = await listConnections(ctx.env, ctx.user.id).catch(() => []);
  const connLine = conns.map((c) => `${c.name}: ${c.connected ? `connected (${c.account || "yes"})` : c.available ? "not connected — the user can connect it in Account → Connections" : "not available on this site"}`).join("; ");
  const names = tools.map((t) => t.name).join(", ");
  const code = ctx.mode === "code";
  return `You are Ehrler Systems, a capable AI agent that gets real tasks done for the user, built by Ehrler Systems.
Current time for the user: ${localNowString(ctx.timezone)} (time zone ${ctx.timezone}).
User: ${ctx.user.name} <${ctx.user.email}>. Plan: ${ctx.plan.pro ? "Ehrler Pro" : "Free"}.
Connections: ${connLine || "none"}.
Tools you can use now: ${names || "none"}.

How to work:
- For anything beyond a quick answer, use tools to actually do the work: read pages and files, run code to calculate or test, generate images, check email/calendar, push code. Chain several tools if needed.
- Never invent tool results, email contents, events, file contents or web content. If a tool fails, say what happened and try another way.
- Actions that send, create, change or delete things (email, calendar, GitHub pushes, scheduled tasks) show the user an approval card automatically — just call the tool with complete details; don't ask "should I?" first unless key details are missing.
- If a needed connection isn't connected, tell the user to connect it in Account → Connections.
- Files the user attached are listed in their message with ids (fil_…). Use read_file to see them. To edit a user's picture, pass its id in generate_image reference_file_ids.
- Images you generate are shown automatically; describe them in a sentence, don't paste links.
- ${code ? "You are in Code mode: write complete, working code in fenced blocks with language tags. Use run_code to test JavaScript/Python before presenting it when practical. For GitHub changes, read the files first, then github_push complete file contents." : "Be direct and useful. Lead with the answer or result."}
- Final answers use Markdown. Keep them focused: what you did, the result, and any next step.`;
}

/* ── Model calls ─────────────────────────────── */

function toolSchemas(tools) {
  return tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
}

function toModelMessages(messages, style) {
  const out = [];
  for (const m of messages) {
    if (m.role === "assistant" && m.calls?.length) {
      if (style === "native") {
        out.push({
          role: "assistant",
          content: m.content || "",
          tool_calls: m.calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args || {}) } })),
        });
      } else {
        out.push({ role: "assistant", content: `${m.content ? m.content + "\n" : ""}${m.calls.map((c) => `[Calling tool ${c.name} with ${JSON.stringify(c.args || {})}]`).join("\n")}` });
      }
    } else if (m.role === "tool") {
      out.push(style === "native" ? { role: "tool", tool_call_id: m.call_id, name: m.name, content: m.content } : { role: "user", content: `[Result of ${m.name}]\n${m.content}` });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

function parseArgs(a) {
  if (a == null) return {};
  if (typeof a === "object") return a;
  try { return JSON.parse(a); } catch { return {}; }
}

export function parseModelOutput(out, toolNames) {
  const msg = out?.choices?.[0]?.message;
  let text = out?.response ?? msg?.content ?? "";
  if (typeof text !== "string") text = text == null ? "" : JSON.stringify(text);
  let raw = out?.tool_calls ?? msg?.tool_calls ?? [];
  let calls = raw.map((c) => ({ id: c.id || newId("call"), name: c.name || c.function?.name, args: parseArgs(c.arguments ?? c.function?.arguments ?? c.parameters) })).filter((c) => c.name);

  // Some models write the call as JSON or <function=…> text instead of tool_calls.
  if (!calls.length && text) {
    const t = text.trim();
    const fn = t.match(/^<function=([\w-]+)>([\s\S]*?)<\/function>$/);
    if (fn && toolNames.includes(fn[1])) {
      calls = [{ id: newId("call"), name: fn[1], args: parseArgs(fn[2]) }];
      text = "";
    } else if (/^[\[{]/.test(t)) {
      try {
        const j = JSON.parse(t.replace(/^```(?:json)?|```$/g, ""));
        const list = Array.isArray(j) ? j : [j];
        const parsed = list.map((c) => ({ id: newId("call"), name: c.name || c.function?.name, args: parseArgs(c.parameters ?? c.arguments ?? c.function?.arguments) }));
        if (parsed.length && parsed.every((c) => toolNames.includes(c.name))) { calls = parsed; text = ""; }
      } catch {}
    }
  }
  return { text, calls, usage: out?.usage || null };
}

async function callModel(state, ctx, tools) {
  const env = ctx.env;
  const toolNames = tools.map((t) => t.name);
  const attempt = async (model, style, withTools) => {
    const input = { messages: toModelMessages(state.messages, style), max_tokens: ctx.maxTokens, temperature: 0.5 };
    if (withTools && tools.length) input.tools = toolSchemas(tools);
    const out = await env.AI.run(model, input);
    return { model, ...parseModelOutput(out, toolNames) };
  };
  const tries = [
    [state.model, state.style, true],
    [state.model, "text", true],
    [env.AGENT_MODEL || state.model, "text", true],
    [env.AGENT_MODEL || state.model, "text", false],
  ];
  let lastErr;
  for (const [model, style, withTools] of tries) {
    try {
      const r = await attempt(model, style, withTools);
      if (style !== state.style) state.style = style;
      if (model !== state.model) state.model = model;
      return r;
    } catch (e) {
      lastErr = e;
      console.error("model call failed", model, style, withTools, String(e?.message || e));
    }
  }
  throw lastErr;
}

/* ── The loop ─────────────────────────────── */

export function newRunState({ messages, model, mode, messageId }) {
  return { messages, parts: [], units: 0, step: 0, style: "native", model, mode, message_id: messageId, queue: [], pending: null };
}

const clip = (s) => (s.length > MAX_RESULT ? s.slice(0, MAX_RESULT) + "\n[truncated]" : s);

async function executeTool(tool, call, state, ctx, send) {
  const label = tool.label ? tool.label(call.args, ctx) : tool.name;
  await send({ t: "tool", id: call.id, name: tool.name, label, status: "running" });
  let content;
  const part = { type: "tool", id: call.id, name: tool.name, label, status: "done" };
  try {
    const r = await tool.run(call.args || {}, ctx);
    content = r.content;
    part.summary = r.summary;
    state.parts.push(part);
    if (r.part) {
      state.parts.push(r.part);
      await send({ t: "part", part: r.part });
    }
  } catch (e) {
    console.error("tool failed", tool.name, e);
    content = `Error: ${e?.message || e}`;
    part.status = "error";
    part.summary = String(e?.message || e).slice(0, 200);
    state.parts.push(part);
  }
  await send({ t: "tool", id: call.id, name: tool.name, label, status: part.status, summary: part.summary });
  state.messages.push({ role: "tool", call_id: call.id, name: tool.name, content: clip(String(content)) });
}

// Runs until the model answers in text or a tool needs the user/browser.
// Returns {text} or {paused:true}.
export async function runLoop(state, ctx, send) {
  const maxSteps = ctx.plan.pro ? 16 : 8;
  // Finish any queued calls from a previous pause first.
  if (state.queue.length) {
    const r = await processCalls(state.queue.splice(0), state, ctx, send);
    if (r) return r;
  }
  while (state.step < maxSteps) {
    state.step++;
    const tools = await availableTools(ctx);
    const res = await callModel(state, ctx, tools);
    const inTok = res.usage?.prompt_tokens ?? estimateTokens(state.messages.map((m) => m.content || "").join("\n"));
    const outTok = res.usage?.completion_tokens ?? estimateTokens(res.text + JSON.stringify(res.calls));
    state.units += unitsFor(res.model, inTok, outTok);
    if (!res.calls.length) return { text: res.text || "Done." };
    state.messages.push({ role: "assistant", content: res.text || "", calls: res.calls });
    const r = await processCalls(res.calls, state, ctx, send);
    if (r) return r;
  }
  // Out of steps: ask for a final answer without tools.
  state.messages.push({ role: "user", content: "You've used the maximum number of steps. Summarize what you did, what you found, and what's left." });
  const res = await callModel({ ...state, style: "text" }, { ...ctx }, []);
  state.units += unitsFor(res.model, estimateTokens(JSON.stringify(state.messages)), estimateTokens(res.text));
  return { text: res.text || "I reached the step limit for this request." };
}

async function processCalls(calls, state, ctx, send) {
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i];
    const tool = byName[call.name];
    const allowed = tool && (await availableTools(ctx)).some((t) => t.name === call.name);
    if (!tool || !allowed) {
      state.messages.push({ role: "tool", call_id: call.id, name: call.name, content: `Error: the tool "${call.name}" isn't available right now.` });
      continue;
    }
    if (tool.client || (tool.approval && !ctx.scheduled)) {
      state.pending = { call, kind: tool.client ? "client" : "approval" };
      state.queue = calls.slice(i + 1);
      const runId = (state.run_id = state.run_id || newId("run"));
      const label = tool.label ? tool.label(call.args, ctx) : tool.name;
      let event;
      if (tool.client) {
        state.parts.push({ type: "client_tool", run_id: runId, call_id: call.id, name: tool.name, label, args: call.args, status: "pending" });
        event = { t: "client_tool", run_id: runId, call_id: call.id, name: tool.name, label, args: call.args };
      } else {
        let preview;
        try { preview = tool.approval(call.args || {}, ctx); } catch (e) { preview = { title: "Approve this action?", action: "Approve", fields: [["Error", e.message]] }; }
        state.parts.push({ type: "approval", run_id: runId, call_id: call.id, name: tool.name, label, preview, status: "pending" });
        event = { t: "approval", run_id: runId, call_id: call.id, name: tool.name, label, preview };
      }
      // Save the run (with its card) before telling the browser, so resume always finds it.
      await saveRun(state, ctx);
      await persistMessage(state, ctx, "");
      await send(event);
      return { paused: true };
    }
    await executeTool(tool, call, state, ctx, send);
  }
  return null;
}

/* ── Persistence ─────────────────────────────── */

async function saveRun(state, ctx) {
  const id = state.run_id || newId("run");
  state.run_id = id;
  await ctx.env.DB.prepare(
    `INSERT INTO agent_runs (id, user_id, conversation_id, mode, model, state, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET state = excluded.state, model = excluded.model, expires_at = excluded.expires_at`
  ).bind(id, ctx.user.id, ctx.conversationId, state.mode, state.model, JSON.stringify(state), now(), now() + RUN_TTL).run();
  return id;
}

export async function persistMessage(state, ctx, text) {
  await ctx.env.DB.batch([
    ctx.env.DB.prepare("UPDATE messages SET content = ?, parts = ?, units = ?, model = ? WHERE id = ?")
      .bind(text, JSON.stringify(state.parts), state.units, state.model, state.message_id),
    ctx.env.DB.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").bind(now(), ctx.conversationId),
  ]);
}

export async function loadRun(env, userId, runId) {
  const row = await env.DB.prepare("SELECT * FROM agent_runs WHERE id = ? AND user_id = ?").bind(String(runId || ""), userId).first();
  if (!row || row.expires_at < now()) return null;
  return { row, state: JSON.parse(row.state) };
}

export async function deleteRun(env, runId) {
  await env.DB.prepare("DELETE FROM agent_runs WHERE id = ?").bind(runId).run();
}

// Runs the loop and finishes the turn: streams the answer, saves it, sends done.
export async function driveTurn(state, ctx, send) {
  let result;
  try {
    result = await runLoop(state, ctx, send);
  } catch (e) {
    console.error("agent error", e);
    await persistMessage(state, ctx, "");
    await send({ t: "error", message: friendly(e), account: await accountState(ctx.env, ctx.user) });
    return;
  }
  if (result.paused) return;
  if (state.run_id) await deleteRun(ctx.env, state.run_id);
  const text = result.text;
  for (let i = 0; i < text.length; i += 32) await send({ t: "delta", v: text.slice(i, i + 32) });
  await persistMessage(state, ctx, text);
  await send({ t: "done", message_id: state.message_id, units: state.units, account: await accountState(ctx.env, ctx.user) });
}

function friendly(e) {
  const msg = String(e?.message || e);
  if (/neuron|quota|429|capacity/i.test(msg)) return "The AI is at capacity right now. Please try again in a little while.";
  if (/model|not found|deprecat/i.test(msg)) return "The configured model isn't available. The site owner needs to update the model name.";
  return "Something went wrong while working on that. Please try again.";
}

// Shared context for a turn.
export function makeContext({ env, user, plan, mode, timezone, conversationId, scheduled = false }) {
  const limits = planLimits(env)[plan.plan];
  const ctx = {
    env, user, plan, mode, scheduled, conversationId,
    timezone: timezone || "UTC",
    maxTokens: limits.maxTokens,
    addUnits: (n) => { ctx._state && (ctx._state.units += Math.max(0, Math.round(n))); },
  };
  return ctx;
}

export { accessToken };
