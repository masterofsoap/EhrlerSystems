import { publicUser, requireUser } from "../../../lib/auth.js";
import { handler, json } from "../../../lib/util.js";
import { usageToday } from "../../../lib/usage.js";

export const onRequestGet = handler(async ({ request, env }) => {
  const user = await requireUser(env, request);
  return json({
    user: publicUser(user),
    usage: await usageToday(env, user.id),
    models: { chat: env.CHAT_MODEL, code: env.CODE_MODEL },
  });
});
