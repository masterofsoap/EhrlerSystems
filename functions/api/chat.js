// POST /api/chat — streams a reply as NDJSON and saves both turns to D1.
//
// Request:  { conversation_id?: string, message: string, mode?: "chat" | "code" }
// Response: newline-delimited JSON events
//   {"t":"meta","conversation_id":"cnv_…","title":"…","model":"…","user_message_id":"msg_…"}
//   {"t":"delta","v":"text…"}            (many)
//   {"t":"done","message_id":"msg_…","usage":{…}}
//   {"t":"error","message":"…"}          (instead of done, on failure)
import { requireUser } from "../../lib/auth.js";
import { systemPrompt } from "../../lib/prompts.js";
import { usageToday } from "../../lib/usage.js";
import { handler, HttpError, newId, now, readJson } from "../../lib/util.js";

const MAX_INPUT = 16000;
const HISTORY_MESSAGES = 24;
const HISTORY_CHARS = 24000;

export const onRequestPost = handler(async ({ request, env, waitUntil }) => {
  const user = await requireUser(env, request);
  const body = await readJson(request);
  const message = String(body.message || "").trim();
  const mode = body.mode === "code" ? "code" : "chat";
  if (!message) throw new HttpError(400, "Message is empty.", "empty_message");
  if (message.length > MAX_INPUT) throw new HttpError(413, `Message is too long (max ${MAX_INPUT.toLocaleString()} characters).`, "too_long");

  const usage = await usageToday(env, user.id);
  if (usage.remaining <= 0)
    throw new HttpError(429, "You've hit today's message limit. It resets at midnight UTC.", "daily_limit");

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

  // Load recent history (newest first, then trim to a character budget).
  const { results: recent } = await env.DB.prepare(
    "SELECT role, content FROM messages WHERE conversation_id = ? ORDER BY created_at DESC LIMIT ?"
  ).bind(conversation.id, HISTORY_MESSAGES).all();
  const history = [];
  let budget = HISTORY_CHARS - message.length;
  for (const m of recent) {
    if (budget - m.content.length < 0) break;
    budget -= m.content.length;
    history.unshift({ role: m.role, content: m.content });
  }

  const userMsgId = newId("msg");
  const userAt = now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO messages (id, conversation_id, user_id, role, content, model, created_at) VALUES (?, ?, ?, 'user', ?, NULL, ?)")
      .bind(userMsgId, conversation.id, user.id, message, userAt),
    env.DB.prepare("UPDATE conversations SET updated_at = ?, mode = ? WHERE id = ?").bind(userAt, mode, conversation.id),
  ]);

  const model = mode === "code" ? env.CODE_MODEL : env.CHAT_MODEL;
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
      clientGone = true; // keep generating so the reply is still saved
    }
  };

  const run = (async () => {
    await send({ t: "meta", conversation_id: conversation.id, title: conversation.title, model, mode, user_message_id: userMsgId });
    let text = "";
    let failed = null;
    try {
      const upstream = await runModel(env, model, messages);
      for await (const piece of parseModelStream(upstream)) {
        text += piece;
        await send({ t: "delta", v: piece });
      }
    } catch (e) {
      console.error("AI error", e);
      failed = friendlyAiError(e);
    }

    if (text.trim()) {
      const id = newId("msg");
      const t = now();
      await env.DB.batch([
        env.DB.prepare("INSERT INTO messages (id, conversation_id, user_id, role, content, model, created_at) VALUES (?, ?, ?, 'assistant', ?, ?, ?)")
          .bind(id, conversation.id, user.id, text, model, t),
        env.DB.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").bind(t, conversation.id),
      ]);
      if (failed) await send({ t: "error", message: failed, message_id: id });
      else await send({ t: "done", message_id: id, usage: await usageToday(env, user.id) });
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

async function runModel(env, model, messages) {
  if (!env.AI) {
    // Local development without an AI binding: stream a canned reply.
    return devStream(messages[messages.length - 1].content);
  }
  return env.AI.run(model, { messages, stream: true, max_tokens: 2048, temperature: 0.6 });
}

// Workers AI streams Server-Sent Events. Older models send {"response":"…"},
// OpenAI-style models send {"choices":[{"delta":{"content":"…"}}]}; handle both.
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
        const piece = obj.response ?? obj.choices?.[0]?.delta?.content ?? "";
        if (piece) yield piece;
      } catch {
        /* partial or non-JSON line; ignore */
      }
    }
  }
}

function friendlyAiError(e) {
  const msg = String(e?.message || e);
  if (/neuron|quota|limit|429|capacity/i.test(msg)) return "The AI is at capacity for today. Please try again later.";
  if (/model|not found|deprecat/i.test(msg)) return "The configured model isn't available. The site owner needs to update the model name.";
  return "The AI service had a problem. Please try again.";
}

function devStream(prompt) {
  const reply =
    "**Dev mode** — no AI binding is connected, so this is a canned reply.\n\n" +
    `You said: _${prompt.slice(0, 120).replace(/[_*`]/g, "")}_\n\n` +
    "Here is a runnable example to try the Workbench:\n\n" +
    "```html\n<!doctype html>\n<html>\n<body style=\"font-family:system-ui;background:#111;color:#eee;display:grid;place-items:center;height:100vh\">\n  <button id=\"b\">Clicked 0 times</button>\n  <script>\n    let n = 0;\n    b.onclick = () => { b.textContent = `Clicked ${++n} times`; console.log('click', n); };\n  </script>\n</body>\n</html>\n```\n\n" +
    "```python\ndef fib(n):\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a  # 55 for n=10\n```\n";
  const enc = new TextEncoder();
  const chunks = reply.match(/[\s\S]{1,12}/g);
  return new ReadableStream({
    async start(controller) {
      for (const c of chunks) {
        controller.enqueue(enc.encode(`data: ${JSON.stringify({ response: c })}\n\n`));
        await new Promise((r) => setTimeout(r, 8));
      }
      controller.enqueue(enc.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}
