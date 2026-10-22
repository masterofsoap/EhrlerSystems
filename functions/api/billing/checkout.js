// POST /api/billing/checkout → { url } of a Stripe Checkout page for Ehrler Pro.
import { requireUser } from "../../../lib/auth.js";
import { getPlan } from "../../../lib/plans.js";
import { stripe } from "../../../lib/stripe.js";
import { handler, HttpError, json, readJson } from "../../../lib/util.js";

export const onRequestPost = handler(async ({ request, env }) => {
  const user = await requireUser(env, request);
  await readJson(request);
  if (!env.STRIPE_PRICE_ID) throw new HttpError(503, "Billing isn't set up yet.", "billing_disabled");
  const origin = new URL(request.url).origin;

  const plan = await getPlan(env, user);
  if (plan.pro) throw new HttpError(409, "You already have Ehrler Pro.", "already_pro");

  // One Stripe customer per Ehrler account.
  const row = await env.DB.prepare("SELECT stripe_customer_id FROM users WHERE id = ?").bind(user.id).first();
  let customer = row?.stripe_customer_id;
  if (!customer) {
    const c = await stripe(env, "POST", "/customers", {
      email: user.email,
      name: user.name,
      metadata: { user_id: user.id, app: "ehrler-systems" },
    });
    customer = c.id;
    await env.DB.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ?").bind(customer, user.id).run();
  }

  const session = await stripe(env, "POST", "/checkout/sessions", {
    mode: "subscription",
    customer,
    client_reference_id: user.id,
    line_items: [{ price: env.STRIPE_PRICE_ID, quantity: 1 }],
    allow_promotion_codes: "true",
    subscription_data: { metadata: { user_id: user.id, app: "ehrler-systems" } },
    metadata: { user_id: user.id, app: "ehrler-systems" },
    success_url: `${origin}/app?upgraded=1`,
    cancel_url: `${origin}/app?billing=cancelled`,
  });
  return json({ url: session.url });
});
