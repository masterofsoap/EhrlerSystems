// POST /api/chat/resume — continue a paused agent run.
// Body: { run_id, call_id, decision: "approve"|"decline" }   (approval cards)
//    or { run_id, call_id, result: { stdout, error, value, ms } } (code the browser ran)
import { requireUser } from "../../../lib/auth.js";
import { deleteRun, driveTurn, loadRun, makeContext, persistMessage, TOOLS } from "../../../lib/agent.js";
import { ndjsonStream } from "../../../lib/ndjson.js";
import { getPlan } from "../../../lib/plans.js";
import { handler, HttpError, readJson } from "../../../lib/util.js";

export const onRequestPost = handler(async ({ request, env, waitUntil }) => {
  const user = await requireUser(env, request);
  const body = await readJson(request);
  const loaded = await loadRun(env, user.id, body.run_id);
  if (!loaded) throw new HttpError(404, "This step expired. Please ask again.", "run_not_found");
  const { row, state } = loaded;
  const pending = state.pending;
  if (!pending || pending.call.id !== body.call_id) throw new HttpError(409, "This step was already handled.", "stale");

  // Claim the run so a double-click can't execute twice.
  const claim = await env.DB.prepare("DELETE FROM agent_runs WHERE id = ? AND user_id = ?").bind(row.id, user.id).run();
  if (!claim.meta?.changes) throw new HttpError(409, "This step was already handled.", "stale");
  state.run_id = null;

  const plan = await getPlan(env, user);
  const ctx = makeContext({ env, user, plan, mode: state.mode, timezone: state.timezone, conversationId: row.conversation_id });
  ctx._state = state;
  const tool = TOOLS.find((t) => t.name === pending.call.name);
  const part = [...state.parts].reverse().find((p) => (p.type === "approval" || p.type === "client_tool") && p.call_id === pending.call.id);
  state.pending = null;

  return ndjsonStream(waitUntil, async (send) => {
    await send({ t: "meta", conversation_id: row.conversation_id, message_id: state.message_id, resumed: true });

    if (pending.kind === "approval") {
      const approved = body.decision === "approve";
      if (part) part.status = approved ? "approved" : "declined";
      await send({ t: "resolved", call_id: pending.call.id, status: part?.status });
      if (approved) {
        const label = tool.label ? tool.label(pending.call.args, ctx) : tool.name;
        await send({ t: "tool", id: pending.call.id, name: tool.name, label, status: "running" });
        let content;
        const tpart = { type: "tool", id: pending.call.id, name: tool.name, label, status: "done" };
        try {
          const r = await tool.run(pending.call.args || {}, ctx);
          content = r.content;
          tpart.summary = r.summary;
          state.parts.push(tpart);
          if (r.part) { state.parts.push(r.part); await send({ t: "part", part: r.part }); }
        } catch (e) {
          content = `Error: ${e?.message || e}`;
          tpart.status = "error";
          tpart.summary = String(e?.message || e).slice(0, 200);
          state.parts.push(tpart);
        }
        await send({ t: "tool", id: pending.call.id, name: tool.name, label, status: tpart.status, summary: tpart.summary });
        state.messages.push({ role: "tool", call_id: pending.call.id, name: tool.name, content: String(content).slice(0, 14000) });
      } else {
        state.messages.push({ role: "tool", call_id: pending.call.id, name: tool.name, content: "The user declined this action. Do not retry it unless they ask; offer an alternative if useful." });
      }
    } else {
      const r = body.result || {};
      const out = [
        r.stdout ? `Output:\n${String(r.stdout).slice(0, 10000)}` : "Output: (nothing printed)",
        r.value !== undefined && r.value !== null && r.value !== "" ? `Return value: ${String(r.value).slice(0, 2000)}` : null,
        r.error ? `Error:\n${String(r.error).slice(0, 4000)}` : null,
        r.ms != null ? `Ran in ${Math.round(r.ms)} ms` : null,
      ].filter(Boolean).join("\n\n");
      if (part) {
        part.status = r.error ? "error" : "done";
        part.output = String(r.stdout || "").slice(0, 4000);
        part.error = r.error ? String(r.error).slice(0, 2000) : undefined;
      }
      await send({ t: "resolved", call_id: pending.call.id, status: part?.status });
      state.messages.push({ role: "tool", call_id: pending.call.id, name: pending.call.name, content: out });
    }
    await persistMessage(state, ctx, "");
    await driveTurn(state, ctx, send);
  });
});

export { deleteRun };
