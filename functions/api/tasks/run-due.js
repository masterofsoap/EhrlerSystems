// POST /api/tasks/run-due — called every few minutes by the scheduler Worker (see scheduler/).
// Only runs tasks whose time has come, so calling it early is harmless.
// If SCHEDULER_KEY is set, the caller must send it in the x-scheduler-key header.
import { runDue } from "../../../lib/runner.js";
import { json, timingSafeEqual } from "../../../lib/util.js";

export async function onRequestPost({ request, env, waitUntil }) {
  if (env.SCHEDULER_KEY && !timingSafeEqual(request.headers.get("x-scheduler-key") || "", env.SCHEDULER_KEY)) {
    return json({ error: "forbidden" }, { status: 403 });
  }
  const work = runDue(env, 5);
  waitUntil(work.catch((e) => console.error("run-due failed", e)));
  const ran = await work.catch(() => []);
  return json({ ran });
}
