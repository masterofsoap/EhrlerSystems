// Ehrler Systems scheduler — a tiny Cloudflare Worker whose only job is to wake the
// site every 5 minutes so scheduled tasks run on time.
// Deploy: Cloudflare dashboard → Workers & Pages → Create → Worker → paste this file,
// then Settings → Triggers → Cron Triggers → add "*/5 * * * *".
const SITE = "https://ehrlersystems.pages.dev";

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(
      fetch(`${SITE}/api/tasks/run-due`, {
        method: "POST",
        headers: env.SCHEDULER_KEY ? { "x-scheduler-key": env.SCHEDULER_KEY } : {},
      }).then((r) => r.text()).then((t) => console.log("run-due:", t))
    );
  },
  async fetch() {
    return new Response("Ehrler Systems scheduler is running.");
  },
};
