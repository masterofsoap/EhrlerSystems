// Gmail + Google Calendar tools (need the user's Google connection).
import { accessToken, isConnected, ToolError } from "../connections.js";

async function g(ctx, url, init = {}) {
  const token = await accessToken(ctx.env, ctx.user.id, "google");
  const res = await fetch(url, {
    ...init,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers || {}) },
  });
  if (res.status === 204) return {};
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ToolError(`Google said: ${data.error?.message || res.status}`);
  return data;
}

const googleOk = async (ctx) => isConnected(ctx.env, ctx.user.id, "google");

/* ── Gmail ─────────────────────────────── */

const header = (msg, name) => (msg.payload?.headers || []).find((h) => h.name.toLowerCase() === name.toLowerCase())?.value || "";
function b64urlToText(s) {
  const bin = atob(String(s).replace(/-/g, "+").replace(/_/g, "/"));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}
function bodyText(payload) {
  if (!payload) return "";
  if (payload.mimeType === "text/plain" && payload.body?.data) return b64urlToText(payload.body.data);
  for (const p of payload.parts || []) {
    const t = bodyText(p);
    if (t) return t;
  }
  if (payload.mimeType === "text/html" && payload.body?.data)
    return b64urlToText(payload.body.data).replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  return "";
}
function encodeHeader(v) {
  return /[^\x20-\x7e]/.test(v) ? `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(v)))}?=` : v;
}
function rawMessage({ to, cc, subject, body, from }) {
  const lines = [
    from ? `From: ${from}` : null,
    `To: ${to}`,
    cc ? `Cc: ${cc}` : null,
    `Subject: ${encodeHeader(subject || "")}`,
    "MIME-Version: 1.0",
    'Content-Type: text/plain; charset="UTF-8"',
    "Content-Transfer-Encoding: 8bit",
    "",
    body || "",
  ].filter((l) => l !== null);
  const bytes = new TextEncoder().encode(lines.join("\r\n"));
  let bin = "";
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
const emailRe = /^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]{2,}$/;
function checkRecipients(list) {
  const all = String(list || "").split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  if (!all.length) throw new ToolError("No recipient given.");
  for (const a of all) if (!emailRe.test(a.replace(/^.*<|>$/g, ""))) throw new ToolError(`"${a}" isn't a valid email address.`);
  return all.join(", ");
}

export const gmailSearch = {
  name: "gmail_search",
  description: "Search the user's Gmail. Uses Gmail search syntax (e.g. 'is:unread newer_than:2d', 'from:boss@x.com subject:invoice'). Returns sender, subject, date, snippet and id.",
  parameters: { type: "object", properties: { query: { type: "string" }, max_results: { type: "number", description: "1-25, default 10" } }, required: ["query"] },
  available: googleOk,
  scheduledOk: true,
  label: (a) => `Searching Gmail: ${String(a.query).slice(0, 50)}`,
  async run(args, ctx) {
    const n = Math.min(25, Math.max(1, Number(args.max_results) || 10));
    const list = await g(ctx, `https://gmail.googleapis.com/gmail/v1/users/me/messages?${new URLSearchParams({ q: String(args.query || ""), maxResults: String(n) })}`);
    const ids = (list.messages || []).map((m) => m.id);
    const msgs = await Promise.all(ids.map((id) =>
      g(ctx, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`)));
    const lines = msgs.map((m) => `• id ${m.id} | ${header(m, "Date")}\n  From: ${header(m, "From")}\n  Subject: ${header(m, "Subject")}\n  ${m.snippet || ""}${(m.labelIds || []).includes("UNREAD") ? " [unread]" : ""}`);
    return { content: lines.join("\n") || "No emails matched.", summary: `Found ${lines.length} emails` };
  },
};

export const gmailRead = {
  name: "gmail_read",
  description: "Read one email in full by its id (from gmail_search).",
  parameters: { type: "object", properties: { message_id: { type: "string" } }, required: ["message_id"] },
  available: googleOk,
  scheduledOk: true,
  label: () => "Reading an email",
  async run(args, ctx) {
    const m = await g(ctx, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(args.message_id)}?format=full`);
    const text = bodyText(m.payload).slice(0, 12000);
    return {
      content: `From: ${header(m, "From")}\nTo: ${header(m, "To")}\nDate: ${header(m, "Date")}\nSubject: ${header(m, "Subject")}\nThread: ${m.threadId}\n\n${text}`,
      summary: `Read “${header(m, "Subject").slice(0, 60)}”`,
    };
  },
};

export const gmailDraft = {
  name: "gmail_create_draft",
  description: "Save an email as a draft in the user's Gmail (not sent). Prefer this when the user wants to review before sending.",
  parameters: { type: "object", properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" }, cc: { type: "string" } }, required: ["to", "subject", "body"] },
  available: googleOk,
  scheduledOk: true,
  label: (a) => `Drafting email to ${a.to}`,
  async run(args, ctx) {
    const raw = rawMessage({ ...args, to: checkRecipients(args.to), cc: args.cc ? checkRecipients(args.cc) : null });
    const d = await g(ctx, "https://gmail.googleapis.com/gmail/v1/users/me/drafts", { method: "POST", body: JSON.stringify({ message: { raw } }) });
    return { content: `Draft saved (id ${d.id}). The user can review and send it from Gmail.`, summary: `Saved draft to ${args.to}` };
  },
};

export const gmailSend = {
  name: "gmail_send",
  description: "Send an email from the user's Gmail. The user is always asked to approve before it sends.",
  parameters: {
    type: "object",
    properties: { to: { type: "string" }, subject: { type: "string" }, body: { type: "string" }, cc: { type: "string" }, reply_to_message_id: { type: "string", description: "Optional: id of an email this replies to" } },
    required: ["to", "subject", "body"],
  },
  available: googleOk,
  approval: (a) => ({ title: "Send this email?", action: "Send", fields: [["To", a.to], a.cc ? ["Cc", a.cc] : null, ["Subject", a.subject]].filter(Boolean), body: a.body }),
  label: (a) => `Sending email to ${a.to}`,
  async run(args, ctx) {
    const to = checkRecipients(args.to);
    const cc = args.cc ? checkRecipients(args.cc) : null;
    let threadId;
    let subject = args.subject;
    const extra = {};
    if (args.reply_to_message_id) {
      const orig = await g(ctx, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(args.reply_to_message_id)}?format=metadata&metadataHeaders=Message-ID&metadataHeaders=Subject`);
      threadId = orig.threadId;
      extra.inReplyTo = header(orig, "Message-ID");
    }
    let raw = rawMessage({ to, cc, subject, body: args.body });
    if (extra.inReplyTo) {
      const txt = b64urlToText(raw).replace("MIME-Version: 1.0", `In-Reply-To: ${extra.inReplyTo}\r\nReferences: ${extra.inReplyTo}\r\nMIME-Version: 1.0`);
      let bin = "";
      new TextEncoder().encode(txt).forEach((b) => (bin += String.fromCharCode(b)));
      raw = btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    }
    const sent = await g(ctx, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { method: "POST", body: JSON.stringify(threadId ? { raw, threadId } : { raw }) });
    return { content: `Email sent (id ${sent.id}) to ${to}.`, summary: `Sent email to ${to}` };
  },
};

/* ── Calendar ─────────────────────────────── */

const CAL = "https://www.googleapis.com/calendar/v3/calendars/primary/events";
function fmtEvent(e) {
  const s = e.start?.dateTime || e.start?.date;
  const en = e.end?.dateTime || e.end?.date;
  return `• id ${e.id} | ${e.summary || "(no title)"}\n  ${s} → ${en}${e.location ? `\n  Location: ${e.location}` : ""}${e.attendees?.length ? `\n  Attendees: ${e.attendees.map((a) => a.email).join(", ")}` : ""}`;
}
function eventTimes(args, tz) {
  const allDay = /^\d{4}-\d{2}-\d{2}$/.test(String(args.start || ""));
  if (allDay) return { start: { date: args.start }, end: { date: args.end || args.start } };
  return { start: { dateTime: args.start, timeZone: args.timezone || tz }, end: { dateTime: args.end, timeZone: args.timezone || tz } };
}

export const calendarList = {
  name: "calendar_list_events",
  description: "List events on the user's Google Calendar between two times (ISO 8601, e.g. 2026-10-22T00:00:00-06:00). Optional text query.",
  parameters: { type: "object", properties: { time_min: { type: "string" }, time_max: { type: "string" }, query: { type: "string" }, max_results: { type: "number" } }, required: ["time_min", "time_max"] },
  available: googleOk,
  scheduledOk: true,
  label: () => "Checking your calendar",
  async run(args, ctx) {
    const p = new URLSearchParams({ timeMin: new Date(args.time_min).toISOString(), timeMax: new Date(args.time_max).toISOString(), singleEvents: "true", orderBy: "startTime", maxResults: String(Math.min(50, Number(args.max_results) || 25)), timeZone: ctx.timezone });
    if (args.query) p.set("q", args.query);
    const data = await g(ctx, `${CAL}?${p}`);
    const items = (data.items || []).map(fmtEvent);
    return { content: items.join("\n") || "No events in that range.", summary: `Found ${items.length} events` };
  },
};

export const calendarCreate = {
  name: "calendar_create_event",
  description: "Create an event on the user's Google Calendar. start/end as ISO 8601 date-times in the user's time zone (or YYYY-MM-DD for all-day). The user approves first. Invites are emailed to attendees.",
  parameters: {
    type: "object",
    properties: {
      summary: { type: "string" }, start: { type: "string" }, end: { type: "string" }, timezone: { type: "string" },
      description: { type: "string" }, location: { type: "string" }, attendees: { type: "array", items: { type: "string" } },
    },
    required: ["summary", "start", "end"],
  },
  available: googleOk,
  approval: (a, ctx) => ({
    title: "Add this to your calendar?", action: "Create event",
    fields: [["Event", a.summary], ["Starts", a.start], ["Ends", a.end], a.location ? ["Where", a.location] : null, a.attendees?.length ? ["Invites", a.attendees.join(", ")] : null].filter(Boolean),
    body: a.description || "",
  }),
  label: (a) => `Creating “${a.summary}”`,
  async run(args, ctx) {
    const body = { summary: args.summary, description: args.description, location: args.location, ...eventTimes(args, ctx.timezone) };
    if (args.attendees?.length) body.attendees = args.attendees.map((email) => ({ email }));
    const e = await g(ctx, `${CAL}?sendUpdates=${args.attendees?.length ? "all" : "none"}`, { method: "POST", body: JSON.stringify(body) });
    return { content: `Event created: ${fmtEvent(e)}\nLink: ${e.htmlLink}`, summary: `Created “${args.summary}”`, part: { type: "link", url: e.htmlLink, title: args.summary } };
  },
};

export const calendarUpdate = {
  name: "calendar_update_event",
  description: "Change an existing calendar event (by id from calendar_list_events). Only include fields to change. The user approves first.",
  parameters: {
    type: "object",
    properties: { event_id: { type: "string" }, summary: { type: "string" }, start: { type: "string" }, end: { type: "string" }, timezone: { type: "string" }, description: { type: "string" }, location: { type: "string" } },
    required: ["event_id"],
  },
  available: googleOk,
  approval: (a) => ({ title: "Update this event?", action: "Update", fields: Object.entries(a).filter(([k]) => k !== "event_id").map(([k, v]) => [k, String(v)]) }),
  label: () => "Updating an event",
  async run(args, ctx) {
    const body = {};
    for (const k of ["summary", "description", "location"]) if (args[k] != null) body[k] = args[k];
    if (args.start && args.end) Object.assign(body, eventTimes(args, ctx.timezone));
    const e = await g(ctx, `${CAL}/${encodeURIComponent(args.event_id)}`, { method: "PATCH", body: JSON.stringify(body) });
    return { content: `Updated: ${fmtEvent(e)}`, summary: `Updated “${e.summary}”` };
  },
};

export const calendarDelete = {
  name: "calendar_delete_event",
  description: "Delete a calendar event by id. The user approves first.",
  parameters: { type: "object", properties: { event_id: { type: "string" }, title: { type: "string", description: "Event title, shown in the approval" } }, required: ["event_id"] },
  available: googleOk,
  approval: (a) => ({ title: "Delete this event?", action: "Delete", danger: true, fields: [["Event", a.title || a.event_id]] }),
  label: () => "Deleting an event",
  async run(args, ctx) {
    await g(ctx, `${CAL}/${encodeURIComponent(args.event_id)}`, { method: "DELETE" });
    return { content: "Event deleted.", summary: "Deleted event" };
  },
};

// Used by scheduled tasks to deliver results to the user's own inbox.
export async function sendToSelf(env, user, subject, body) {
  const ctx = { env, user };
  const raw = rawMessage({ to: user.email, subject, body });
  await g(ctx, "https://gmail.googleapis.com/gmail/v1/users/me/messages/send", { method: "POST", body: JSON.stringify({ raw }) });
}
