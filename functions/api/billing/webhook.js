// POST /api/billing/webhook — Stripe events that keep Ehrler Pro status in sync.
import { saveSubscription, stripe, verifyWebhook } from "../../../lib/stripe.js";
import { now } from "../../../lib/util.js";

const ok = () => new Response(JSON.stringify({ received: true }), { headers: { "content-type": "application/json" } });

export async function onRequestPost({ request, env }) {
  const payload = await request.text();
  const valid = await verifyWebhook(env.STRIPE_WEBHOOK_SECRET, payload, request.headers.get("stripe-signature"));
  if (!valid) return new Response("Invalid signature", { status: 400 });

  const event = JSON.parse(payload);
  const seen = await env.DB.prepare("SELECT 1 FROM stripe_events WHERE id = ?").bind(event.id).first();
  if (seen) return ok();

  try {
    const obj = event.data?.object || {};
    switch (event.type) {
      case "checkout.session.completed": {
        if (obj.mode === "subscription" && obj.subscription && obj.metadata?.app === "ehrler-systems") {
          const userId = obj.client_reference_id || obj.metadata?.user_id;
          if (userId && obj.customer) {
            await env.DB.prepare("UPDATE users SET stripe_customer_id = ? WHERE id = ? AND stripe_customer_id IS NULL").bind(obj.customer, userId).run();
          }
          const sub = await stripe(env, "GET", `/subscriptions/${obj.subscription}`);
          await saveSubscription(env, sub, userId);
        }
        break;
      }
      case "customer.subscription.created":
      case "customer.subscription.updated":
      case "customer.subscription.deleted":
        await saveSubscription(env, obj);
        break;
      case "invoice.paid":
      case "invoice.payment_failed": {
        const subId = obj.parent?.subscription_details?.subscription || obj.subscription;
        if (subId) await saveSubscription(env, await stripe(env, "GET", `/subscriptions/${subId}`));
        break;
      }
    }
  } catch (e) {
    console.error("Webhook handling failed", event.type, e);
    return new Response("Webhook handler error", { status: 500 }); // Stripe will retry
  }

  await env.DB.prepare("INSERT OR IGNORE INTO stripe_events (id, type, received_at) VALUES (?, ?, ?)").bind(event.id, event.type, now()).run();
  return ok();
}
