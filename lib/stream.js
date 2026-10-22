// Plain streaming chat (used by Think mode): token-by-token from a reasoning model.

export async function* parseModelStream(stream) {
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
        yield {
          reasoning: delta.reasoning_content || delta.reasoning || "",
          text: obj.response ?? delta.content ?? "",
          usage: obj.usage && (obj.usage.prompt_tokens || obj.usage.completion_tokens) ? obj.usage : null,
        };
      } catch {
        /* partial line */
      }
    }
  }
}

// Streams a reply, wrapping separately-streamed reasoning in <think> tags.
export async function streamReply(env, model, messages, maxTokens, send) {
  let text = "";
  let reported = null;
  let inReasoning = false;
  const emit = async (piece) => { text += piece; await send({ t: "delta", v: piece }); };
  const upstream = env.AI
    ? await env.AI.run(model, { messages, stream: true, max_tokens: maxTokens, temperature: 0.6 })
    : devStream(messages[messages.length - 1].content, model);
  for await (const ev of parseModelStream(upstream)) {
    if (ev.usage) reported = ev.usage;
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
  return { text, usage: reported };
}

function devStream(prompt, model) {
  const thinking = /deepseek-r1|qwq/i.test(model) ? "Let me break this down step by step.\n</think>\n\n" : "";
  const reply = thinking + `**Dev mode** — no AI binding is connected, so this is a canned reply.\n\nYou said: _${prompt.slice(0, 120).replace(/[_*`]/g, "")}_\n`;
  const enc = new TextEncoder();
  const chunks = reply.match(/[\s\S]{1,12}/g);
  return new ReadableStream({
    async start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(`data: ${JSON.stringify({ response: ch })}\n\n`));
      c.enqueue(enc.encode(`data: ${JSON.stringify({ response: "", usage: { prompt_tokens: 400, completion_tokens: 300 } })}\n\n`));
      c.enqueue(enc.encode("data: [DONE]\n\n"));
      c.close();
    },
  });
}
