// POST /api/billing/sync — refresh the signed-in user's Pro status from Stripe.
// Called right after checkout so Pro turns on even if the webhook is a few seconds behind.
import { requireUser } from "../../../lib/auth.js";
import { accountState } from "../../../lib/plans.js";
import { syncCustomer } from "../../../lib/stripe.js";
import { handler, json, readJson } from "../../../lib/util.js";

export const onRequestPost = handler(async ({ request, env }) => {
  const user = await requireUser(env, request);
  await readJson(request);
  const row = await env.DB.prepare("SELECT stripe_customer_id FROM users WHERE id = ?").bind(user.id).first();
  if (row?.stripe_customer_id && env.STRIPE_SECRET_KEY) await syncCustomer(env, user.id, row.stripe_customer_id);
  return json({ account: await accountState(env, user) });
});
