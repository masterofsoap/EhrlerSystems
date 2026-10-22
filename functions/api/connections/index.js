// GET /api/connections — which accounts are connected / available.
import { requireUser } from "../../../lib/auth.js";
import { listConnections } from "../../../lib/connections.js";
import { handler, json } from "../../../lib/util.js";

export const onRequestGet = handler(async ({ request, env }) => {
  const user = await requireUser(env, request);
  return json({
    connections: await listConnections(env, user.id),
    capabilities: {
      files: !!env.FILES,
      browser: !!(env.CF_ACCOUNT_ID && env.CF_BROWSER_TOKEN),
      web_search: !!env.BRAVE_API_KEY,
      images: !!env.AI,
    },
  });
});
