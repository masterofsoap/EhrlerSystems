// POST /api/chat — streams a reply as NDJSON and saves both turns to D1.
//
// Request:  { conversation_id?: string, message: string, mode?: "chat" | "code" | "think" }
// Response: newline-delimited JSON events
//   {"t":"meta","conversation_id":"cnv_…","title":"…","model":"…","mode":"…","user_message_id":"msg_…"}
//   {"t":"delta","v":"text…"}            (many)
//   {"t":"done","message_id":"msg_…","units":123,"account":{…}}
//   {"t":"error","message":"…"}          (instead of done, on failure)
import { requireUser } from "../../lib/auth.js";
import { accountState, estimateTokens, getPlan, planLimits, unitsFor, usageThisMonth } from "../../lib/plans.js";
import { stripThinking, systemPrompt } from "../../lib/prompts.js";
import { handler, HttpError, newId, now, readJson } from "../../lib/util.js";

const MAX_INPUT = 16000;

export const onRequestPost = handler(async ({ request, env, waitUntil }) => {
  const user = await requireUser(env, request);
  const body = await readJson(request);
  const message = String(body.message || "").trim();
  const mode = ["chat", "code", "think"].includes(body.mode) ? body.mode : "chat";
  if (!message) throw new HttpError(400, "Message is empty.", "empty_message");
  if (message.length > MAX_INPUT) throw new HttpError(413, `Message is too long (max ${MAX_INPUT.toLocaleString()} characters).`, "too_long");

  const plan = await getPlan(env, user);
  const limits = planLimits(env)[plan.plan];
  if (!limits.modes.includes(mode)) throw new HttpError(402, "Think mode is part of Ehrler Pro.", "pro_required");

  const usage = await usageThisMonth(env, user.id, plan.plan);
  if (usage.remaining <= 0) {
    const resets = new Date(usage.resets_at).toLocaleDateString("en-US", { month: "long", day: "numeric", timeZone: "UTC" });
    throw new HttpError(
      402,
      plan.pro
        ? `You've used all of this month's Ehrler Pro usage. It resets on ${resets}.`
        : `You've used this month's free usage. Upgrade to Ehrler Pro to keep going, or wait until it resets on ${resets}.`,
      "usage_exhausted"
    );
  }

  // Find or create the conversation.
  let conversation;
  if (body.conversation_id) {
    conversation = await env.DB.prepare("SELECT id, title, mode FROM conversations WHERE id = ? AND user_id = ?")
      .bind(String(body.conversation_id), user.id)
      .first();
    if (!conversation) throw new HttpError(404, "Conversation not found.", "not_found");
  } else {
    conversation = { id: newId("cnv"), title: makeTitle(message), mode };
    const t = now();
    await env.DB.prepare("INSERT INTO conversations (id, user_id, title, mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(conversation.id, user.id, conversation.title, mode, t, t)
      .run();
  }

  // Recent history (newest first), trimmed to the plan's budget. Reasoning is dropped.
  const { results: recent } = await env.DB.prepare(
    "SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?"
  ).bind(conversation.id, limits.historyMessages).all();
  const history = [];
  let budget = limits.historyChars - message.length;
  for (const m of recent) {
    const content = m.role === "assistant" ? stripThinking(m.content) : m.content;
    if (budget - content.length < 0) break;
    budget -= content.length;
    history.unshift({ role: m.role, content });
  }

  const userMsgId = newId("msg");
  const userAt = now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO messages (id, conversation_id, user_id, role, content, model, created_at, units) VALUES (?, ?, ?, 'user', ?, NULL, ?, 0)")
      .bind(userMsgId, conversation.id, user.id, message, userAt),
    env.DB.prepare("UPDATE conversations SET updated_at = ?, mode = ? WHERE id = ?").bind(userAt, mode, conversation.id),
  ]);

  const model = mode === "think" ? env.THINK_MODEL : mode === "code" ? env.CODE_MODEL : env.CHAT_MODEL;
  const maxTokens = mode === "think" ? limits.thinkMaxTokens || limits.maxTokens : limits.maxTokens;
  const messages = [{ role: "system", content: systemPrompt(mode) }, ...history, { role: "user", content: message }];

  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();
  let clientGone = false;
  const send = async (obj) => {
    if (clientGone) return;
    try {
      await writer.write(encoder.encode(JSON.stringify(obj) + "\n"));
    } catch {
      clientGone = true; // keep generating so the reply is still saved and metered
    }
  };

  const run = (async () => {
    await send({ t: "meta", conversation_id: conversation.id, title: conversation.title, model, mode, user_message_id: userMsgId });
    let text = "";
    let reported = null;
    let failed = null;
    try {
      const upstream = await runModel(env, model, messages, maxTokens);
      let inReasoning = false;
      const emit = async (piece) => { text += piece; await send({ t: "delta", v: piece }); };
      for await (const ev of parseModelStream(upstream)) {
        if (ev.usage) reported = ev.usage;
        // Models that stream reasoning separately get wrapped in <think> tags,
        // the same format DeepSeek-R1 style models use inline.
        if (ev.reasoning) {
          if (!inReasoning) { inReasoning = true; await emit("<think>\n"); }
          await emit(ev.reasoning);
        }
        if (ev.text) {
          if (inReasoning) { inReasoning = false; await emit("\n</think>\n\n"); }
          await emit(ev.text);
        }
      }
      if (inReasoning) await emit("\n</think>\n\n");
    } catch (e) {
      console.error("AI error", e);
      failed = friendlyAiError(e);
    }

    // Meter the reply: use the model's reported token counts when available.
    const inTok = reported?.prompt_tokens ?? estimateTokens(messages.map((m) => m.content).join("\n"));
    const outTok = reported?.completion_tokens ?? estimateTokens(text);
    const units = text.trim() ? unitsFor(model, inTok, outTok) : 0;

    if (text.trim()) {
      const id = newId("msg");
      const t = now();
      await env.DB.batch([
        env.DB.prepare("INSERT INTO messages (id, conversation_id, user_id, role, content, model, created_at, units) VALUES (?, ?, ?, 'assistant', ?, ?, ?, ?)")
          .bind(id, conversation.id, user.id, text, model, t, units),
        env.DB.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").bind(t, conversation.id),
      ]);
      const account = await accountState(env, user);
      if (failed) await send({ t: "error", message: failed, message_id: id, account });
      else await send({ t: "done", message_id: id, units, account });
    } else {
      await send({ t: "error", message: failed || "The model returned an empty reply. Try again." });
    }
    try { await writer.close(); } catch {}
  })();

  waitUntil(run);

  return new Response(readable, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
});

function makeTitle(message) {
  const clean = message.replace(/```[\s\S]*?```/g, " [code] ").replace(/\s+/g, " ").trim();
  return clean.length > 60 ? clean.slice(0, 57).trimEnd() + "…" : clean || "New conversation";
}

async function runModel(env, model, messages, maxTokens) {
  if (!env.AI) return devStream(messages[messages.length - 1].content, model); // local dev without AI
  return env.AI.run(model, { messages, stream: true, max_tokens: maxTokens, temperature: 0.6 });
}

// Workers AI streams Server-Sent Events. Older models send {"response":"…"},
// OpenAI-style models send {"choices":[{"delta":{"content":"…"}}]}. The last
// event often carries {"usage":{prompt_tokens, completion_tokens}}.
async function* parseModelStream(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      try {
        const obj = JSON.parse(data);
        const delta = obj.choices?.[0]?.delta || {};
        const reasoning = delta.reasoning_content || delta.reasoning || "";
        const piece = obj.response ?? delta.content ?? "";
        yield {
          reasoning,
          text: piece || "",
          usage: obj.usage && (obj.usage.prompt_tokens || obj.usage.completion_tokens) ? obj.usage : null,
        };
      } catch {
        /* partial or non-JSON line; ignore */
      }
    }
  }
}

function friendlyAiError(e) {
  const msg = String(e?.message || e);
  if (/neuron|quota|limit|429|capacity/i.test(msg)) return "The AI is at capacity right now. Please try again in a little while.";
  if (/model|not found|deprecat/i.test(msg)) return "The configured model isn't available. The site owner needs to update the model name.";
  return "The AI service had a problem. Please try again.";
}

function devStream(prompt, model) {
  const thinking = /deepseek-r1|qwq/i.test(model) ? "Let me break this down step by step. First I'll consider the question, then check edge cases.\n</think>\n\n" : "";
  const reply =
    thinking +
    "**Dev mode** — no AI binding is connected, so this is a canned reply.\n\n" +
    `You said: _${prompt.slice(0, 120).replace(/[_*`]/g, "")}_\n\n` +
    "Here is a runnable example to try the Workbench:\n\n" +
    "```html\n<!doctype html>\n<html>\n<body style=\"font-family:system-ui;background:#111;color:#eee;display:grid;place-items:center;height:100vh\">\n  <button id=\"b\">Clicked 0 times</button>\n  <script>\n    let n = 0;\n    b.onclick = () => { b.textContent = `Clicked ${++n} times`; console.log('click', n); };\n  </script>\n</body>\n</html>\n```\n";
  const enc = new TextEncoder();
  const chunks = reply.match(/[\s\S]{1,12}/g);
  return new ReadableStream({
    async start(controller) {
      for (const c of chunks) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ response: c })}\n\n`));
        await new Promise((r) => setTimeout(r, 5));
      }
      controller.enqueue(enc.encode(`data: ${JSON.stringify({ response: "", usage: { prompt_tokens: 400, completion_tokens: 300 } })}\n\n`));
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}
