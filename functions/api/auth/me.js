import { publicUser, requireUser } from "../../../lib/auth.js";
import { accountState } from "../../../lib/plans.js";
import { handler, json } from "../../../lib/util.js";

export const onRequestGet = handler(async ({ request, env }) => {
  const user = await requireUser(env, request);
  return json({
    user: publicUser(user),
    account: await accountState(env, user),
    models: { chat: env.CHAT_MODEL, code: env.CODE_MODEL, think: env.THINK_MODEL },
  });
});
