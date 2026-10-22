// POST /api/billing/portal → { url } of the Stripe customer portal (cancel, card, invoices).
import { requireUser } from "../../../lib/auth.js";
import { stripe } from "../../../lib/stripe.js";
import { handler, HttpError, json, readJson } from "../../../lib/util.js";

export const onRequestPost = handler(async ({ request, env }) => {
  const user = await requireUser(env, request);
  await readJson(request);
  const row = await env.DB.prepare("SELECT stripe_customer_id FROM users WHERE id = ?").bind(user.id).first();
  if (!row?.stripe_customer_id) throw new HttpError(404, "There's no billing account yet. Upgrade to Pro first.", "no_customer");
  const session = await stripe(env, "POST", "/billing_portal/sessions", {
    customer: row.stripe_customer_id,
    return_url: `${new URL(request.url).origin}/app`,
  });
  return json({ url: session.url });
});
