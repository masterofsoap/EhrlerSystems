// Web tools: read a page, search (optional), and a real headless browser (optional).
import { saveFile } from "../files.js";
import { ToolError } from "../connections.js";

const MAX_PAGE = 3 * 1024 * 1024;

function checkUrl(raw) {
  let u;
  try { u = new URL(String(raw || "").trim()); } catch { throw new ToolError("That isn't a valid URL."); }
  if (!/^https?:$/.test(u.protocol)) throw new ToolError("Only http and https pages can be read.");
  const h = u.hostname.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".internal") || /^(127\.|10\.|192\.168\.|169\.254\.|0\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h === "[::1]")
    throw new ToolError("Private and local addresses can't be read.");
  return u;
}

function htmlToText(html) {
  const title = (html.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || "";
  let s = html
    .replace(/<(script|style|noscript|svg|iframe|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)[^>]*>/gi, "\n")
    .replace(/<li[^>]*>/gi, "\n• ")
    .replace(/<h([1-6])[^>]*>/gi, (_, n) => "\n" + "#".repeat(+n) + " ")
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => `${text.replace(/<[^>]+>/g, "")} (${href})`)
    .replace(/<[^>]+>/g, " ");
  s = s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  s = s.replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim();
  return { title: title.replace(/\s+/g, " ").trim(), text: s };
}

export const readWebpage = {
  name: "read_webpage",
  description: "Open a web page by URL and return its readable text (as Markdown). Use it to read articles, docs, product pages, or any link the user shares.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string", description: "Full http(s) URL" },
      offset: { type: "number", description: "Character offset to continue reading a long page (default 0)" },
    },
    required: ["url"],
  },
  scheduledOk: true,
  label: (a) => `Reading ${hostOf(a.url)}`,
  async run(args, ctx) {
    const u = checkUrl(args.url);
    const res = await fetch(u.toString(), {
      headers: { "user-agent": "Mozilla/5.0 (compatible; EhrlerSystemsBot/1.0; +https://ehrlersystems.pages.dev)", accept: "text/html,application/xhtml+xml,application/pdf,text/plain;q=0.9,*/*;q=0.5" },
      redirect: "follow",
      cf: { cacheTtl: 300 },
    }).catch((e) => { throw new ToolError(`Couldn't reach ${u.hostname}: ${e.message}`); });
    if (!res.ok) throw new ToolError(`${u.hostname} answered with HTTP ${res.status}.`);
    const type = res.headers.get("content-type") || "";
    const buf = new Uint8Array(await res.arrayBuffer());
    if (buf.byteLength > MAX_PAGE) throw new ToolError("That page is too large to read.");

    let title = "";
    let text = "";
    if (/pdf|officedocument|msword|ms-excel/.test(type) && ctx.env.AI?.toMarkdown) {
      const name = u.pathname.split("/").pop() || "document";
      const r = await ctx.env.AI.toMarkdown({ name, blob: new Blob([buf], { type }) });
      text = r?.data || "";
    } else if (/html|xml/.test(type) || !type) {
      const html = new TextDecoder().decode(buf);
      const out = htmlToText(html);
      title = out.title;
      text = out.text;
    } else if (/^text\/|json/.test(type)) {
      text = new TextDecoder().decode(buf);
    } else {
      throw new ToolError(`That link is a ${type} file, not a page I can read.`);
    }
    const offset = Math.max(0, Number(args.offset) || 0);
    const LIMIT = 14000;
    const chunk = text.slice(offset, offset + LIMIT);
    const more = text.length > offset + LIMIT;
    return {
      content: `URL: ${res.url}\nTitle: ${title}\n\n${chunk}${more ? `\n\n[Page continues — ${text.length - offset - LIMIT} more characters. Call read_webpage again with offset ${offset + LIMIT}.]` : ""}`,
      summary: `Read ${title || hostOf(res.url)}`,
      part: { type: "link", url: res.url, title: title || hostOf(res.url) },
    };
  },
};

export const webSearch = {
  name: "web_search",
  description: "Search the web and return the top results (title, URL, snippet). Then use read_webpage on the best results.",
  parameters: {
    type: "object",
    properties: { query: { type: "string" }, count: { type: "number", description: "1-10, default 6" } },
    required: ["query"],
  },
  available: (ctx) => !!ctx.env.BRAVE_API_KEY,
  scheduledOk: true,
  label: (a) => `Searching “${String(a.query).slice(0, 60)}”`,
  async run(args, ctx) {
    const n = Math.min(10, Math.max(1, Number(args.count) || 6));
    const res = await fetch(`https://api.search.brave.com/res/v1/web/search?${new URLSearchParams({ q: String(args.query), count: String(n) })}`, {
      headers: { accept: "application/json", "x-subscription-token": ctx.env.BRAVE_API_KEY },
    });
    if (!res.ok) throw new ToolError(`Search failed (HTTP ${res.status}).`);
    const data = await res.json();
    const items = (data.web?.results || []).slice(0, n).map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${(r.description || "").replace(/<[^>]+>/g, "")}`);
    return { content: items.join("\n\n") || "No results.", summary: `Found ${items.length} results` };
  },
};

// Real headless browser via Cloudflare Browser Rendering (REST quick actions).
async function browserApi(env, action, body) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/browser-rendering/${action}`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.CF_BROWSER_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (res.status === 429) throw new ToolError("The browser's daily free time is used up. Use read_webpage instead.");
  if (!res.ok) throw new ToolError(`The browser couldn't load that page (HTTP ${res.status}).`);
  return res;
}

export const browse = {
  name: "browse",
  description:
    "Open a page in a real headless Chrome browser (runs JavaScript). Use for sites that need JavaScript, to take a screenshot, or to list the links on a page. action: 'read' (rendered text), 'screenshot' (image of the page), or 'links'.",
  parameters: {
    type: "object",
    properties: {
      url: { type: "string" },
      action: { type: "string", enum: ["read", "screenshot", "links"] },
      full_page: { type: "boolean", description: "Screenshot the whole page (default false)" },
    },
    required: ["url", "action"],
  },
  available: (ctx) => !!(ctx.env.CF_ACCOUNT_ID && ctx.env.CF_BROWSER_TOKEN),
  scheduledOk: true,
  label: (a) => `${a.action === "screenshot" ? "Screenshotting" : "Browsing"} ${hostOf(a.url)}`,
  async run(args, ctx) {
    const u = checkUrl(args.url).toString();
    const goto = { waitUntil: "networkidle2", timeout: 25000 };
    if (args.action === "screenshot") {
      const res = await browserApi(ctx.env, "screenshot", { url: u, gotoOptions: goto, screenshotOptions: { fullPage: !!args.full_page }, viewport: { width: 1280, height: 800 } });
      const bytes = new Uint8Array(await res.arrayBuffer());
      const file = await saveFile(ctx.env, ctx.user.id, { name: `screenshot-${hostOf(u)}.png`, mime: "image/png", bytes, kind: "generated" });
      ctx.addUnits(50);
      return {
        content: `Screenshot saved as file ${file.id} (shown to the user). Use read_file with this id to look at it.`,
        summary: `Screenshot of ${hostOf(u)}`,
        part: { type: "image", file_id: file.id, url: file.url, name: file.name, caption: `Screenshot of ${u}` },
      };
    }
    if (args.action === "links") {
      const res = await browserApi(ctx.env, "links", { url: u, gotoOptions: goto, visibleLinksOnly: true });
      const data = await res.json();
      const links = (data.result || []).slice(0, 150);
      return { content: links.join("\n") || "No links found.", summary: `Found ${links.length} links` };
    }
    const res = await browserApi(ctx.env, "markdown", { url: u, gotoOptions: goto });
    const data = await res.json();
    const md = String(data.result || "");
    return { content: md.slice(0, 16000) + (md.length > 16000 ? "\n\n[Truncated]" : ""), summary: `Browsed ${hostOf(u)}`, part: { type: "link", url: u, title: hostOf(u) } };
  },
};

export function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return String(u || "").slice(0, 40); }
}
