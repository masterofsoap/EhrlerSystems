import { api, esc, setBusy, toast } from "./common.js";
import { extensionFor, highlight, normalizeLang, renderMarkdown, RUNNABLE } from "./markdown.js";
import { addPart, ensureAgentSlots, fileChipHtml, renderParts, runCode, setApprovalStatus, setCodeStatus, uploadFile } from "./agent-ui.js";

const $ = (id) => document.getElementById(id);
const root = document.documentElement;
const ICON = {
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="m5 12 5 5 9-10"/></svg>',
  dots: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>',
  edit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 1 1 3 3L7 19l-4 1 1-4z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>',
  send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M5 12h13M13 6l6 6-6 6"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
};

const SUGGESTIONS = {
  chat: [
    ["Make an ad", "Create a bold Instagram ad for a neighborhood coffee shop called Ember Roast: moody lighting, latte art, the headline \"Wake Up Warm\". Square format."],
    ["Read a page", "Read https://developers.cloudflare.com/workers-ai/ and give me the 5 most useful things it can do, in plain English."],
    ["Run some code", "Write a JavaScript function that checks if a word is a palindrome, test it on 5 examples, and show me the results."],
    ["Every morning", "Every weekday at 7:30am, read https://news.ycombinator.com and give me the 5 most interesting stories in one line each."],
  ],
  code: [
    ["Build a UI", "Build a single-file HTML page with a glowing, animated countdown timer I can start and pause."],
    ["Fix my bug", "Why does `for (var i = 0; i < 3; i++) setTimeout(() => console.log(i))` print 3 three times? Show a fix."],
    ["Write SQL", "Write a SQLite schema for a hockey league: teams, players, games and scores, plus a standings query."],
    ["Explain code", "Explain async/await in JavaScript with a runnable example that logs each step."],
  ],
  think: [
    ["Plan a launch", "I'm launching a $12/month subscription for my apps. Work out a 30-day launch plan with milestones and risks."],
    ["Solve it step by step", "A league has 10 teams. Each plays every other team twice. How many games, and how would you schedule them over 9 weeks?"],
    ["Debug the logic", "My standings show a team with more wins ranked below one with fewer. List every likely cause and how to check each."],
    ["Weigh a decision", "Should I build my app as one big site or several small ones that share a login? Reason through the trade-offs."],
  ],
};

const state = {
  user: null,
  usage: null,
  models: {},
  conversations: [],
  currentId: null,
  mode: "chat",
  streaming: null, // AbortController while a reply streams
  search: "",
  attachments: [], // {id?, name, mime, url, uploading, progress, error, local}
  timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
};

/* ───────────────────────── Boot ───────────────────────── */

async function boot() {
  try {
    const me = await api("/api/auth/me");
    state.user = me.user;
    state.account = me.account;
    state.models = me.models || {};
  } catch {
    location.replace("/?next=" + encodeURIComponent(location.pathname + location.search));
    return;
  }
  renderUser();
  renderAccount();
  let saved = "chat";
  try { saved = localStorage.getItem("es-mode") || "chat"; } catch {}
  setMode(["chat", "code", "think"].includes(saved) && canUse(saved) ? saved : "chat", false);
  await loadConversations();
  const params = new URLSearchParams(location.search);
  if (params.get("upgraded")) finishUpgrade();
  if (params.get("upgrade")) { history.replaceState(null, "", "/app"); openUpgrade(); }
  if (params.get("billing") === "cancelled") { toast("Checkout cancelled — you're still on Free."); history.replaceState(null, "", "/app"); }
  if (params.get("connected")) { toast(`${params.get("connected") === "google" ? "Google" : "GitHub"} connected.`); history.replaceState(null, "", "/app"); openAccount("connections"); }
  if (params.get("connect_error")) {
    const why = { not_configured: "That connection isn't set up on this site yet.", cancelled: "Connection cancelled.", bad_state: "That link expired — try again." }[params.get("connect_error")] || "Couldn't connect that account. Try again.";
    toast(why, "error");
    history.replaceState(null, "", "/app");
  }
  const c = params.get("c");
  if (c) openConversation(c);
  else showEmpty();
  $("input").focus();
}

function renderUser() {
  const u = state.user;
  $("userName").textContent = u.name;
  $("userEmail").textContent = u.email;
  $("avatar").textContent = (u.name || u.email).trim().charAt(0).toUpperCase();
}

const fmtDate = (ms) => new Date(ms).toLocaleDateString(undefined, { month: "long", day: "numeric", timeZone: "UTC" });
const isPro = () => !!state.account?.pro;
const canUse = (mode) => (state.account?.modes || ["chat", "code"]).includes(mode);

// Plan, usage meter, Pro badges and the out-of-usage banner.
function renderAccount() {
  const a = state.account;
  if (!a) return;
  const u = a.usage;
  document.body.classList.toggle("is-pro", a.pro);
  $("proBadge").hidden = !a.pro;
  $("upsell").hidden = a.pro || !a.billing_enabled;
  document.querySelectorAll(".price-label").forEach((el) => (el.textContent = a.pro_price));

  const pct = Math.min(100, u.percent);
  const meter = $("usage");
  meter.classList.toggle("warn", pct >= 80 && pct < 100);
  meter.classList.toggle("out", u.remaining <= 0);
  $("usageText").textContent = u.remaining <= 0 ? "0% left" : `${Math.max(0, Math.round(100 - pct))}% left`;
  $("usageBar").style.width = `${Math.max(0, 100 - pct)}%`;
  meter.title = `${a.pro ? "Ehrler Pro" : "Free"} plan · ${Math.round(pct)}% of this month's usage used · resets ${fmtDate(u.resets_at)}`;

  const out = u.remaining <= 0;
  $("limitBanner").hidden = !out;
  $("composer").classList.toggle("locked", out);
  if (out) {
    $("lbTitle").textContent = a.pro ? "You've used all of this month's Pro usage" : "You've used this month's free usage";
    $("lbSub").textContent = a.pro
      ? `It resets on ${fmtDate(u.resets_at)}.`
      : `Upgrade to Ehrler Pro to keep going, or wait until it resets on ${fmtDate(u.resets_at)}.`;
    $("lbUpgrade").hidden = a.pro || !a.billing_enabled;
  }
}

/* ───────────────────────── Mode ───────────────────────── */

const PLACEHOLDER = {
  chat: "Message Ehrler Systems…",
  code: "Describe what to build, paste code, or ask about a bug…",
  think: "Give it a hard problem — it will reason step by step…",
};

function setMode(mode, persist = true) {
  if (!canUse(mode)) {
    openUpgrade("Think mode is part of Ehrler Pro. It reasons step by step through complex, multi-step tasks.");
    return;
  }
  state.mode = mode;
  root.dataset.mode = mode;
  for (const m of ["chat", "code", "think"]) $("mode" + m[0].toUpperCase() + m.slice(1)).setAttribute("aria-pressed", mode === m);
  $("input").placeholder = PLACEHOLDER[mode];
  const model = state.models[mode] || "";
  $("modelHint").textContent = model ? model.split("/").pop() : "";
  if (persist) try { localStorage.setItem("es-mode", mode); } catch {}
  if (!state.currentId) showEmpty();
}
$("modeChat").onclick = () => setMode("chat");
$("modeCode").onclick = () => setMode("code");
$("modeThink").onclick = () => setMode("think");

/* ───────────────────────── Conversations ───────────────────────── */

async function loadConversations() {
  const q = state.search ? `?q=${encodeURIComponent(state.search)}` : "";
  try {
    const data = await api(`/api/conversations${q}`);
    state.conversations = data.conversations;
  } catch (e) {
    toast(e.message, "error");
  }
  renderConversations();
}

function groupLabel(t) {
  const d = new Date(t);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = (today - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000;
  if (diff <= 0) return "Today";
  if (diff === 1) return "Yesterday";
  if (diff < 7) return "Previous 7 days";
  if (diff < 30) return "Previous 30 days";
  return "Older";
}

function renderConversations() {
  const nav = $("convos");
  nav.innerHTML = "";
  if (!state.conversations.length) {
    nav.innerHTML = `<div class="convo-empty">${state.search ? "No matches." : "No conversations yet.<br>Start one — it'll be saved here."}</div>`;
    return;
  }
  let last = "";
  for (const c of state.conversations) {
    const g = groupLabel(c.updated_at);
    if (g !== last) {
      nav.insertAdjacentHTML("beforeend", `<div class="convo-group">${g}</div>`);
      last = g;
    }
    const el = document.createElement("div");
    el.className = `convo${c.id === state.currentId ? " active" : ""}`;
    el.dataset.id = c.id;
    el.setAttribute("role", "button");
    el.tabIndex = 0;
    const tag = { code: "&lt;/&gt;", think: "∴" }[c.mode] || "AI";
    el.innerHTML = `<span class="tag ${c.mode}">${tag}</span><span class="title">${esc(c.title)}</span><button class="icon-btn more" aria-label="More options">${ICON.dots}</button>`;
    el.onclick = (e) => {
      if (e.target.closest(".more")) return openConvoMenu(e, c);
      openConversation(c.id);
    };
    el.onkeydown = (e) => { if (e.key === "Enter") openConversation(c.id); };
    nav.append(el);
  }
}

let searchTimer;
$("search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => { state.search = e.target.value.trim(); loadConversations(); }, 220);
});

function openConvoMenu(e, c) {
  e.stopPropagation();
  closeMenu();
  const m = document.createElement("div");
  m.className = "menu";
  m.innerHTML = `<button data-a="rename">${ICON.edit}Rename</button><button data-a="delete" class="danger">${ICON.trash}Delete</button>`;
  document.body.append(m);
  const r = e.target.closest(".more").getBoundingClientRect();
  m.style.left = `${Math.min(r.left, innerWidth - 180)}px`;
  m.style.top = `${r.bottom + 4}px`;
  m.onclick = async (ev) => {
    const a = ev.target.closest("button")?.dataset.a;
    closeMenu();
    if (a === "rename") {
      const title = prompt("Rename conversation", c.title);
      if (title && title.trim()) await renameConversation(c.id, title.trim());
    } else if (a === "delete") {
      if (!confirm(`Delete “${c.title}”? This can't be undone.`)) return;
      try {
        await api(`/api/conversations/${c.id}`, { method: "DELETE", body: {} });
        state.conversations = state.conversations.filter((x) => x.id !== c.id);
        if (state.currentId === c.id) newChat();
        renderConversations();
        toast("Conversation deleted");
      } catch (err) { toast(err.message, "error"); }
    }
  };
  setTimeout(() => document.addEventListener("click", closeMenu, { once: true }), 0);
}
function closeMenu() { document.querySelectorAll(".menu").forEach((m) => m.remove()); }

async function renameConversation(id, title) {
  try {
    await api(`/api/conversations/${id}`, { method: "PATCH", body: { title } });
    const c = state.conversations.find((x) => x.id === id);
    if (c) c.title = title;
    if (state.currentId === id) $("convTitle").textContent = title;
    renderConversations();
  } catch (e) { toast(e.message, "error"); }
}

$("convTitle").onclick = () => {
  if (!state.currentId) return;
  const h1 = $("convTitle");
  const input = document.createElement("input");
  input.value = h1.textContent;
  input.maxLength = 80;
  h1.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    input.replaceWith(h1);
    const v = input.value.trim();
    if (save && v && v !== h1.textContent) await renameConversation(state.currentId, v);
  };
  input.onkeydown = (e) => { if (e.key === "Enter") finish(true); if (e.key === "Escape") finish(false); };
  input.onblur = () => finish(true);
};

async function openConversation(id) {
  if (state.streaming) stopStreaming();
  closeSidebar();
  try {
    const data = await api(`/api/conversations/${id}`);
    state.currentId = id;
    history.replaceState(null, "", `/app?c=${id}`);
    $("convTitle").textContent = data.conversation.title;
    document.title = `${data.conversation.title} · Ehrler Systems`;
    const m = data.conversation.mode;
    setMode(["code", "think"].includes(m) && canUse(m) ? m : "chat", false);
    const inner = $("threadInner");
    inner.innerHTML = "";
    for (const m of data.messages) {
      let parts = null;
      try { parts = m.parts ? JSON.parse(m.parts) : null; } catch {}
      if (m.role === "assistant" && !m.content && !parts?.length) continue;
      addMessage(m.role, m.content, { model: m.model, animate: false, parts });
    }
    markLast();
    renderConversations();
    scrollToBottom(true);
  } catch (e) {
    toast(e.status === 404 ? "That conversation doesn't exist anymore." : e.message, "error");
    newChat();
  }
}

function newChat() {
  if (state.streaming) stopStreaming();
  state.currentId = null;
  history.replaceState(null, "", "/app");
  document.title = "Ehrler Systems";
  $("convTitle").textContent = "New conversation";
  showEmpty();
  renderConversations();
  closeSidebar();
  $("input").focus();
}
$("newChat").onclick = newChat;
$("homeLink").onclick = (e) => { e.preventDefault(); newChat(); };

function showEmpty() {
  if (state.currentId) return;
  const hour = new Date().getHours();
  const greet = hour < 5 ? "Burning the midnight oil" : hour < 12 ? "Good morning" : hour < 18 ? "Good afternoon" : "Good evening";
  const first = (state.user?.name || "").split(" ")[0];
  const intro = {
    chat: "Ask anything. Switch to Code mode for a model tuned for programming, or Think mode for hard, multi-step problems.",
    code: "Code mode is on. Ask for anything from a quick fix to a full page — HTML, CSS and JavaScript run live in the Workbench.",
    think: "Think mode is on. It reasons step by step before answering — best for planning, math, debugging and tricky decisions.",
  }[state.mode];
  $("threadInner").innerHTML = `
    <div class="empty">
      <div class="mark"><img class="logo" src="/assets/logo.png" alt=""></div>
      <h2>${esc(greet)}${first ? `, <em>${esc(first)}</em>` : ""}.</h2>
      <p>${intro}</p>
      <div class="suggestions">${SUGGESTIONS[state.mode].map(([t, p]) => `<button class="suggestion" data-p="${esc(p)}"><b>${esc(t)}</b>${esc(p)}</button>`).join("")}</div>
    </div>`;
  $("threadInner").querySelectorAll(".suggestion").forEach((b) => (b.onclick = () => { $("input").value = b.dataset.p; autosize(); send(); }));
}

/* ───────────────────────── Messages ───────────────────────── */

function addMessage(role, content, { model, animate = true, parts = null } = {}) {
  const inner = $("threadInner");
  inner.querySelector(".empty")?.remove();
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  if (!animate) el.style.animation = "none";
  if (role === "user") {
    el.innerHTML = `<div class="who"></div><div><div class="bubble"></div><div class="meta" style="justify-content:flex-end"><button data-act="copy-msg">${ICON.copy}Copy</button></div></div>`;
    el.querySelector(".bubble").textContent = content;
    const files = (parts || []).filter((p) => p.type === "file");
    if (files.length) {
      const strip = document.createElement("div");
      strip.className = "bubble-files";
      strip.innerHTML = files.map((f) => `<a class="file-chip" href="${esc(f.url)}" target="_blank" rel="noopener">${fileChipHtml(f)}</a>`).join("");
      el.querySelector(".bubble").before(strip);
      if (content === "(attached files)") el.querySelector(".bubble").remove();
    }
  } else {
    el.innerHTML = `<div class="who"><img class="logo" src="/assets/logo.png" alt="Ehrler Systems"></div>
      <div><div class="prose"></div><div class="meta"><button data-act="copy-msg">${ICON.copy}Copy</button><span class="model"></span></div></div>`;
    el.querySelector(".model").textContent = model ? model.split("/").pop() : "";
  }
  el._content = content;
  inner.append(el);
  if (role === "assistant") {
    if (parts?.length) renderParts(el, parts, agentHandlers(el));
    renderAssistant(el, content, false);
  }
  return el;
}

function renderAssistant(el, content, streaming) {
  const prose = el.querySelector(".prose");
  if (!content && streaming) {
    prose.innerHTML = '<div class="thinking" aria-label="Thinking"><i></i><i></i><i></i></div>';
    return;
  }
  // Think mode: show the model's reasoning in a collapsible panel above the answer.
  const think = el._think || content.includes("</think>") ? splitThinking(content, streaming) : null;
  const answer = think ? think.answer : content;
  let pre = "";
  if (think && think.thought) {
    // Open while thinking; collapsed once the answer starts, unless the reader opened it.
    const open = think.done ? !!el._reasonOpen : true;
    pre = `<details class="reasoning${think.done ? "" : " live"}"${open ? " open" : ""}><summary>${think.done ? "Reasoning" : '<span class="spinner"></span>Thinking…'}</summary><div class="thought"></div></details>`;
  }
  const { html, blocks } = renderMarkdown(answer);
  prose.innerHTML = pre + html;
  if (pre) {
    const t = prose.querySelector(".thought");
    t.textContent = think.thought;
    if (!think.done) t.scrollTop = t.scrollHeight;
    else prose.querySelector("details.reasoning").addEventListener("toggle", (e) => (el._reasonOpen = e.target.open));
  }
  el._blocks = blocks;
  const lastBlockOpen = blocks.length && blocks[blocks.length - 1].open;
  if (streaming && !lastBlockOpen && !(think && !think.done)) {
    const target = prose.lastElementChild && /^(P|LI|UL|OL|H\d|BLOCKQUOTE)$/.test(prose.lastElementChild.tagName)
      ? deepestLast(prose.lastElementChild) : prose;
    target.insertAdjacentHTML("beforeend", '<span class="caret"></span>');
  }
}
function splitThinking(content, live) {
  const s = content.replace(/^\s*<think>\s*/, "");
  const end = s.indexOf("</think>");
  if (end !== -1) return { thought: s.slice(0, end).trim(), answer: s.slice(end + 8).replace(/^\s+/, ""), done: true };
  if (live) return { thought: s.trim(), answer: "", done: false };
  return { thought: "", answer: content, done: true };
}
const answerOnly = (content) => {
  const end = content.lastIndexOf("</think>");
  return end === -1 ? content : content.slice(end + 8).trim();
};
function deepestLast(node) {
  while (node.lastElementChild && /^(UL|OL|LI|P|BLOCKQUOTE)$/.test(node.lastElementChild.tagName)) node = node.lastElementChild;
  return node;
}
function markLast() {
  const all = $("threadInner").querySelectorAll(".msg");
  all.forEach((m) => m.classList.remove("last"));
  all[all.length - 1]?.classList.add("last");
}

function nearBottom() {
  const t = $("thread");
  return t.scrollHeight - t.scrollTop - t.clientHeight < 140;
}
function scrollToBottom(force = false) {
  const t = $("thread");
  if (force || nearBottom()) {
    t.style.scrollBehavior = "auto";
    t.scrollTop = t.scrollHeight;
    t.style.scrollBehavior = "";
  }
}

// Code-block + message actions (delegated)
$("thread").addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-act]");
  if (!btn) return;
  const msg = btn.closest(".msg");
  const act = btn.dataset.act;
  if (act === "copy-msg") {
    await copyText(answerOnly(msg._content || ""));
    flash(btn);
    return;
  }
  const fig = btn.closest(".cb");
  const block = msg?._blocks?.[+fig?.dataset.block];
  if (!block) return;
  if (act === "copy") { await copyText(block.code); flash(btn); }
  if (act === "download") downloadText(block.filename || `ehrler-snippet.${extensionFor(block.lang)}`, block.code);
  if (act === "run") { loadIntoWorkbench(block); runWorkbench(); showPane("preview"); }
  if (act === "workbench") { loadIntoWorkbench(block); showPane("code"); }
});

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); }
  catch {
    const ta = document.createElement("textarea");
    ta.value = text; document.body.append(ta); ta.select();
    try { document.execCommand("copy"); } catch {}
    ta.remove();
  }
}
function flash(btn) {
  const old = btn.innerHTML;
  btn.innerHTML = `${ICON.check}<span>Copied</span>`;
  setTimeout(() => (btn.innerHTML = old), 1400);
}
function downloadText(name, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "text/plain;charset=utf-8" }));
  a.download = name.split("/").pop();
  document.body.append(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 500);
}

/* ───────────────────────── Sending ───────────────────────── */

const input = $("input");
function autosize() {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 280) + "px";
}
input.addEventListener("input", autosize);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(); }
});
$("composer").onsubmit = (e) => { e.preventDefault(); state.streaming ? stopStreaming() : send(); };

function setSending(on) {
  const b = $("sendBtn");
  b.innerHTML = on ? ICON.stop : ICON.send;
  b.classList.toggle("stop", on);
  b.setAttribute("aria-label", on ? "Stop generating" : "Send");
}

function stopStreaming() {
  state.streaming?.abort();
}

async function send() {
  const text = input.value.trim();
  const ready = state.attachments.filter((a) => a.id && !a.error);
  if ((!text && !ready.length) || state.streaming) return;
  if (state.attachments.some((a) => a.uploading)) { toast("Wait for the upload to finish."); return; }
  if (state.account && state.account.usage.remaining <= 0) {
    renderAccount();
    if (!isPro()) openUpgrade("You've used this month's free usage. Ehrler Pro gives you about 20× more every month.");
    return;
  }
  const sentAttachments = ready.map((a) => ({ type: "file", file_id: a.id, name: a.name, mime: a.mime, url: a.url }));
  input.value = "";
  autosize();
  clearAttachments();

  const userEl = addMessage("user", text || "(attached files)", { parts: sentAttachments });
  const el = addMessage("assistant", "", { model: state.models[state.mode] });
  el._think = state.mode === "think";
  renderAssistant(el, "", true);
  markLast();
  scrollToBottom(true);

  const body = { conversation_id: state.currentId, message: text, mode: state.mode, attachments: sentAttachments.map((a) => a.file_id), timezone: state.timezone };
  await streamInto("/api/chat", body, el, {
    onRejected: async (data) => {
      if (data.error === "usage_exhausted" || data.error === "pro_required") {
        el.remove();
        userEl.remove();
        input.value = text;
        autosize();
        if (!$("threadInner").querySelector(".msg")) showEmpty();
        await refreshAccount();
        if (!isPro()) openUpgrade(data.message);
        else toast(data.message, "error");
        return true;
      }
      return false;
    },
  });
}

// POSTs and consumes an NDJSON stream into an assistant message element.
async function streamInto(url, body, el, { onRejected } = {}) {
  const ctrl = new AbortController();
  state.streaming = ctrl;
  setSending(true);
  let content = el._content || "";
  let raf = 0;
  let gotAccount = false;
  let paused = false;
  const paint = () => { raf = 0; renderAssistant(el, content, true); scrollToBottom(); };
  const handlers = agentHandlers(el);

  try {
    const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctrl.signal });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) return location.replace("/?next=/app");
      if (onRejected && (await onRejected(data))) { gotAccount = true; return; }
      throw new Error(data.message || `Request failed (${res.status})`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    const clientJobs = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const ev = JSON.parse(line);
        if (ev.t === "meta") onMeta(ev);
        else if (ev.t === "delta") { content += ev.v; el._content = content; if (!raf) raf = requestAnimationFrame(paint); }
        else if (ev.t === "tool") { addPart(el, { type: "tool", ...ev }, handlers); scrollToBottom(); }
        else if (ev.t === "part") { addPart(el, ev.part, handlers); scrollToBottom(); }
        else if (ev.t === "approval") {
          paused = true;
          addPart(el, { type: "approval", run_id: ev.run_id, call_id: ev.call_id, name: ev.name, label: ev.label, preview: ev.preview, status: "pending" }, handlers);
          scrollToBottom(true);
        } else if (ev.t === "client_tool") {
          paused = true;
          const part = { type: "client_tool", run_id: ev.run_id, call_id: ev.call_id, name: ev.name, label: ev.label, args: ev.args, status: "running" };
          const card = addPart(el, part, handlers);
          clientJobs.push(() => handlers.onRunClientTool(part, card || el.querySelector(`.code-run[data-call="${CSS.escape(ev.call_id)}"]`)));
          scrollToBottom(true);
        } else if (ev.t === "resolved") {
          const card = el.querySelector(`.approval[data-call="${CSS.escape(ev.call_id)}"]`);
          if (card) setApprovalStatus(card, { status: ev.status }, handlers);
        } else if (ev.t === "done" || ev.t === "error") {
          if (ev.account) { state.account = ev.account; renderAccount(); gotAccount = true; }
          if (ev.t === "error") showMsgError(el, ev.message);
        }
      }
    }
    if (paused && !content) el.querySelector(".prose").innerHTML = "";
    // Code the agent asked the browser to run: run it after the stream closes.
    for (const job of clientJobs) setTimeout(job, 0);
  } catch (e) {
    if (e.name === "AbortError") {
      if (!content && !el.querySelector(".activity")?.children.length) el.remove();
      else el.querySelector(".prose").insertAdjacentHTML("afterend", `<div class="muted" style="margin-top:8px;font-size:12px">Stopped.</div>`);
    } else {
      if (!content) el.querySelector(".prose").innerHTML = "";
      showMsgError(el, e.message);
    }
  } finally {
    if (raf) cancelAnimationFrame(raf);
    if (el.isConnected && content) renderAssistant(el, content, false);
    state.streaming = null;
    setSending(false);
    markLast();
    if (!gotAccount) refreshAccount();
    bumpConversation();
  }
}

// Callbacks for interactive parts of an assistant message.
function agentHandlers(el) {
  return {
    onDecision: async (runId, callId, decision, card) => {
      if (state.streaming) { toast("Wait for the current reply to finish."); return false; }
      setApprovalStatus(card, { status: decision === "approve" ? "approved" : "declined" });
      el.querySelector(".prose").innerHTML = '<div class="thinking" aria-label="Working"><i></i><i></i><i></i></div>';
      await streamInto("/api/chat/resume", { run_id: runId, call_id: callId, decision }, el);
    },
    onRunClientTool: async (part, card) => {
      if (card) setCodeStatus(card, { ...part, status: "running" });
      el.querySelector(".prose").innerHTML = '<div class="thinking" aria-label="Working"><i></i><i></i><i></i></div>';
      const result = await runCode(part.args || {});
      if (card) setCodeStatus(card, { ...part, status: result.error ? "error" : "done", output: result.stdout + (result.value ? `\n→ ${result.value}` : ""), error: result.error });
      while (state.streaming) await new Promise((r) => setTimeout(r, 100));
      await streamInto("/api/chat/resume", { run_id: part.run_id, call_id: part.call_id, result }, el);
    },
    onEditImage: (p) => {
      addExistingAttachment({ id: p.file_id, name: p.name, mime: "image/png", url: p.url });
      if (state.mode === "think") setMode("chat");
      input.value = input.value || "Edit this image: ";
      autosize();
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    },
  };
}

/* ───────────────────────── Attachments ───────────────────────── */

const fileInput = document.createElement("input");
fileInput.type = "file";
fileInput.multiple = true;
fileInput.hidden = true;
document.body.append(fileInput);
$("attachBtn").onclick = () => fileInput.click();
fileInput.onchange = () => { addFiles([...fileInput.files]); fileInput.value = ""; };

function addFiles(files) {
  for (const file of files.slice(0, 10)) {
    if (state.attachments.length >= 10) { toast("Up to 10 files per message."); break; }
    if (file.size > 20 * 1024 * 1024) { toast(`${file.name} is over 20 MB.`, "error"); continue; }
    const a = { name: file.name || "pasted-image.png", mime: file.type || "application/octet-stream", uploading: true, progress: 0, local: /^image\//.test(file.type) ? URL.createObjectURL(file) : null };
    state.attachments.push(a);
    renderAttachments();
    uploadFile(file, (p) => { a.progress = p; renderAttachments(); })
      .then((f) => { Object.assign(a, { id: f.id, url: f.url, mime: f.mime, uploading: false }); renderAttachments(); })
      .catch((e) => { a.uploading = false; a.error = e.message; renderAttachments(); toast(e.message, "error"); });
  }
}
function addExistingAttachment(f) {
  if (state.attachments.some((a) => a.id === f.id)) return;
  state.attachments.push({ ...f, uploading: false });
  renderAttachments();
}
function clearAttachments() {
  state.attachments.forEach((a) => a.local && URL.revokeObjectURL(a.local));
  state.attachments = [];
  renderAttachments();
}
function renderAttachments() {
  const box = $("attachments");
  box.hidden = !state.attachments.length;
  box.innerHTML = "";
  state.attachments.forEach((a, i) => {
    const chip = document.createElement("div");
    chip.className = `file-chip${a.error ? " err" : ""}${a.uploading ? " busy" : ""}`;
    chip.innerHTML = fileChipHtml({ ...a, url: a.local || a.url || "" }) +
      (a.uploading ? `<span class="fc-progress"><i style="width:${Math.round((a.progress || 0) * 100)}%"></i></span>` : "") +
      `<button type="button" class="fc-x" aria-label="Remove">✕</button>`;
    chip.querySelector(".fc-x").onclick = () => { if (a.local) URL.revokeObjectURL(a.local); state.attachments.splice(i, 1); renderAttachments(); };
    box.append(chip);
  });
}
input.addEventListener("paste", (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); addFiles(files); }
});
const dropZone = document.querySelector(".main");
dropZone.addEventListener("dragover", (e) => { if ([...(e.dataTransfer?.types || [])].includes("Files")) { e.preventDefault(); dropZone.classList.add("dropping"); } });
dropZone.addEventListener("dragleave", (e) => { if (e.target === dropZone || !dropZone.contains(e.relatedTarget)) dropZone.classList.remove("dropping"); });
dropZone.addEventListener("drop", (e) => {
  if (!e.dataTransfer?.files?.length) return;
  e.preventDefault();
  dropZone.classList.remove("dropping");
  addFiles([...e.dataTransfer.files]);
});

function onMeta(ev) {
  if (!state.currentId) {
    state.currentId = ev.conversation_id;
    history.replaceState(null, "", `/app?c=${ev.conversation_id}`);
    $("convTitle").textContent = ev.title;
    document.title = `${ev.title} · Ehrler Systems`;
    state.conversations.unshift({ id: ev.conversation_id, title: ev.title, mode: ev.mode, created_at: Date.now(), updated_at: Date.now() });
    renderConversations();
  }
}

function bumpConversation() {
  const c = state.conversations.find((x) => x.id === state.currentId);
  if (!c) return;
  c.updated_at = Date.now();
  c.mode = state.mode;
  state.conversations = [c, ...state.conversations.filter((x) => x !== c)];
  renderConversations();
}

async function refreshAccount() {
  try { const me = await api("/api/auth/me"); state.account = me.account; renderAccount(); } catch {}
}

function showMsgError(el, message) {
  const box = document.createElement("div");
  box.className = "msg-error";
  box.textContent = message;
  el.querySelector(".prose").after(box);
}

/* ───────────────────────── Workbench ───────────────────────── */

const wb = {
  lang: "html",
  filename: "",
  runId: null,
  logs: 0,
  blobUrl: null,
};

function toggleWorkbench(open) {
  const el = $("workbench");
  const want = open ?? !el.classList.contains("open");
  el.classList.toggle("open", want);
  $("toggleWb").classList.toggle("active", want);
}
$("toggleWb").onclick = () => toggleWorkbench();
$("wbClose").onclick = () => toggleWorkbench(false);

function showPane(name) {
  toggleWorkbench(true);
  document.querySelectorAll(".wb-tabs button").forEach((b) => b.setAttribute("aria-selected", b.dataset.pane === name));
  document.querySelectorAll(".wb-pane").forEach((p) => p.classList.toggle("show", p.dataset.pane === name));
  if (name === "code") $("wbEditor").focus();
}
document.querySelectorAll(".wb-tabs button").forEach((b) => (b.onclick = () => showPane(b.dataset.pane)));

function wbLangOf(lang) {
  const l = normalizeLang(lang);
  if (l === "html") return "html";
  if (l === "css") return "css";
  if (l === "js") return "js";
  return "html";
}

function loadIntoWorkbench(block) {
  wb.lang = wbLangOf(block.lang);
  wb.filename = block.filename || "";
  $("wbLang").value = wb.lang;
  $("wbFile").textContent = wb.filename;
  $("wbEditor").value = block.code;
  syncEditor();
  if (!RUNNABLE.has(String(block.lang).toLowerCase()))
    setWbStatus(`${block.lang || "This"} code can be edited and saved here; only HTML, CSS and JavaScript run in the preview.`);
}

const editor = $("wbEditor");
function syncEditor() {
  $("wbHighlight").innerHTML = highlight(editor.value, wb.lang) + "\n";
  const pre = $("wbHighlight").parentElement;
  pre.scrollTop = editor.scrollTop;
  pre.scrollLeft = editor.scrollLeft;
}
editor.addEventListener("input", syncEditor);
editor.addEventListener("scroll", () => {
  const pre = $("wbHighlight").parentElement;
  pre.scrollTop = editor.scrollTop;
  pre.scrollLeft = editor.scrollLeft;
});
editor.addEventListener("keydown", (e) => {
  if (e.key === "Tab") {
    e.preventDefault();
    const s = editor.selectionStart;
    editor.setRangeText("  ", s, editor.selectionEnd, "end");
    syncEditor();
  }
  if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runWorkbench(); showPane("preview"); }
});
$("wbLang").onchange = (e) => { wb.lang = e.target.value; syncEditor(); };
$("wbRun").onclick = () => { runWorkbench(); showPane("preview"); };
$("wbSave").onclick = () => downloadText(wb.filename || `workbench.${wb.lang === "js" ? "js" : wb.lang}`, editor.value);
$("wbOpen").onclick = () => {
  if (!editor.value.trim()) return toast("Nothing to open yet.");
  if (wb.blobUrl) URL.revokeObjectURL(wb.blobUrl);
  wb.blobUrl = URL.createObjectURL(new Blob([buildDocument(editor.value, wb.lang, null)], { type: "text/html" }));
  window.open(wb.blobUrl, "_blank", "noopener");
};

// Console bridge injected into the sandboxed preview.
function bridge(runId) {
  return `<script>(function(){var R=${JSON.stringify(runId)};function f(a){try{if(a instanceof Error)return a.stack||String(a);if(typeof a==='object'&&a!==null)return JSON.stringify(a,null,2);return String(a)}catch(e){return String(a)}}
function s(l,a){try{parent.postMessage({__es:R,level:l,args:Array.prototype.map.call(a,f)},'*')}catch(e){}}
['log','info','warn','error','debug'].forEach(function(l){var o=console[l];console[l]=function(){s(l,arguments);o&&o.apply(console,arguments)}});
addEventListener('error',function(e){s('error',[e.message+(e.lineno?' (line '+e.lineno+')':'')])});
addEventListener('unhandledrejection',function(e){s('error',['Unhandled promise rejection: '+f(e.reason)])});})();<\/script>`;
}

function buildDocument(code, lang, runId) {
  const head = runId ? bridge(runId) : "";
  const base = `<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">`;
  if (lang === "js") {
    const safe = code.replace(/<\/script/gi, "<\\/script");
    return `<!doctype html><html><head>${base}${head}<style>body{font:15px system-ui,sans-serif;background:#0b0d10;color:#e8eaed;padding:16px}</style></head><body><script>${safe}<\/script></body></html>`;
  }
  if (lang === "css") {
    return `<!doctype html><html><head>${base}${head}<style>${code.replace(/<\/style/gi, "<\\/style")}</style></head><body>
<h1>Heading One</h1><h2>Heading Two</h2><p>A paragraph with <a href="#">a link</a>, <strong>bold</strong> and <em>italic</em> text.</p>
<button>Button</button> <input placeholder="Input"> <ul><li>List item one</li><li>List item two</li></ul>
<div class="card box container"><p>.card .box .container</p></div></body></html>`;
  }
  // HTML / SVG
  let doc = code;
  if (!/<html[\s>]/i.test(doc) && !/<body[\s>]/i.test(doc)) doc = `<!doctype html><html><head>${base}</head><body>${doc}</body></html>`;
  if (/<head[^>]*>/i.test(doc)) return doc.replace(/<head[^>]*>/i, (m) => m + head);
  if (/<html[^>]*>/i.test(doc)) return doc.replace(/<html[^>]*>/i, (m) => m + `<head>${head}</head>`);
  return head + doc;
}

function runWorkbench() {
  const code = editor.value;
  if (!code.trim()) { setWbStatus("Nothing to run — add some code first."); return; }
  wb.runId = Math.random().toString(36).slice(2);
  clearConsole();
  logLine("sys", `▶ Run ${new Date().toLocaleTimeString()} · ${wb.lang.toUpperCase()}`);
  $("wbPlaceholder").hidden = true;
  $("wbFrameWrap").hidden = false;
  $("wbFrame").srcdoc = buildDocument(code, wb.lang, wb.runId);
  setWbStatus("Running in a sandbox");
}

window.addEventListener("message", (e) => {
  const d = e.data;
  if (!d || d.__es !== wb.runId || e.source !== $("wbFrame").contentWindow) return;
  logLine(d.level === "debug" ? "log" : d.level, (d.args || []).join(" "));
});

function clearConsole() {
  wb.logs = 0;
  $("wbConsole").innerHTML = "";
  $("consoleCount").hidden = true;
}
function logLine(level, text) {
  const line = document.createElement("div");
  line.className = `line ${level}`;
  line.textContent = text;
  $("wbConsole").append(line);
  if (level !== "sys") {
    wb.logs++;
    $("consoleCount").textContent = wb.logs > 99 ? "99+" : wb.logs;
    $("consoleCount").hidden = false;
  }
  $("wbConsole").scrollTop = $("wbConsole").scrollHeight;
}
function setWbStatus(t) { $("wbStatus").textContent = t; }

/* ───────────────────────── Sidebar (mobile) ───────────────────────── */

function openSidebar() { $("sidebar").classList.add("open"); $("scrim").classList.add("open"); $("closeSidebar").hidden = false; }
function closeSidebar() { $("sidebar").classList.remove("open"); $("scrim").classList.remove("open"); $("closeSidebar").hidden = true; }
$("openSidebar").onclick = openSidebar;
$("closeSidebar").onclick = closeSidebar;
$("scrim").onclick = closeSidebar;

/* ───────────────────────── Account ───────────────────────── */

const modal = $("accountModal");
$("userChip").onclick = openAccount;
modal.addEventListener("click", (e) => { if (e.target === modal || e.target.closest("[data-close]")) modal.classList.remove("open"); });

async function openAccount(section) {
  closeSidebar();
  $("profName").value = state.user.name;
  $("profEmail").value = state.user.email;
  renderPlanCard();
  modal.classList.add("open");
  loadApps();
  loadConnections();
  loadTasks();
  if (typeof section === "string") setTimeout(() => $(`${section}Section`)?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
}

const CONN_INFO = {
  google: { badge: "G", desc: "Gmail and Google Calendar: read, draft, send email; check and add events." },
  github: { badge: "⌥", desc: "Read your repositories and push code or open pull requests." },
};

async function loadConnections() {
  const list = $("connList");
  try {
    const { connections, capabilities } = await api("/api/connections");
    list.innerHTML = "";
    for (const c of connections) {
      const row = document.createElement("div");
      row.className = "app-row";
      const info = CONN_INFO[c.provider] || { badge: c.name[0], desc: "" };
      row.innerHTML = `<div class="app-badge">${esc(info.badge)}</div><div class="info"><b>${esc(c.name)}</b><small>${c.connected ? `Connected as ${esc(c.account || "your account")}` : esc(info.desc)}</small></div>`;
      const b = document.createElement(c.connected ? "button" : "a");
      if (c.connected) {
        b.className = "btn btn-danger btn-sm";
        b.textContent = "Disconnect";
        b.onclick = async () => {
          if (!confirm(`Disconnect ${c.name}?`)) return;
          try { await api(`/api/connections/${c.provider}`, { method: "DELETE", body: {} }); toast(`${c.name} disconnected`); loadConnections(); }
          catch (e) { toast(e.message, "error"); }
        };
      } else if (c.available) {
        b.className = "btn btn-primary btn-sm";
        b.textContent = "Connect";
        b.href = `/api/connect/${c.provider}/start`;
      } else {
        b.className = "muted";
        b.textContent = "Not set up yet";
        b.style.fontSize = "12px";
      }
      row.append(b);
      list.append(row);
    }
    const caps = [
      ["Files & images", capabilities.files],
      ["Image generation", capabilities.images],
      ["Real browser", capabilities.browser],
      ["Web search", capabilities.web_search],
    ];
    const capRow = document.createElement("p");
    capRow.className = "muted caps";
    capRow.innerHTML = caps.map(([n, on]) => `<span class="cap ${on ? "on" : ""}">${on ? "●" : "○"} ${esc(n)}</span>`).join("");
    list.append(capRow);
  } catch (e) { list.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}

async function loadTasks() {
  const list = $("taskList");
  try {
    const { tasks } = await api("/api/tasks");
    if (!tasks.length) { list.innerHTML = '<p class="muted" style="margin:0">No scheduled tasks yet.</p>'; return; }
    list.innerHTML = "";
    for (const t of tasks) {
      const row = document.createElement("div");
      row.className = "app-row task-row";
      const next = t.enabled && t.next_run_at ? `Next ${new Date(t.next_run_at).toLocaleString(undefined, { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}` : "Paused";
      row.innerHTML = `<div class="app-badge">⏱</div><div class="info"><b>${esc(t.title)}</b><small>${esc(t.schedule_text)} · ${t.deliver === "email" ? "app + email" : "in app"} · ${esc(next)}${t.last_status ? ` · Last: ${esc(t.last_status)}` : ""}</small></div>
        <div class="task-actions"><button class="btn btn-ghost btn-sm" data-a="run">Run now</button><button class="btn btn-ghost btn-sm" data-a="toggle">${t.enabled ? "Pause" : "Resume"}</button><button class="btn btn-danger btn-sm" data-a="delete">Delete</button></div>`;
      row.querySelector('[data-a="run"]').onclick = async (e) => {
        setBusy(e.currentTarget, true);
        try {
          const r = await api(`/api/tasks/${t.id}`, { method: "POST", body: {} });
          toast(`Ran “${t.title}”: ${r.status}`);
          modal.classList.remove("open");
          await loadConversations();
          if (r.conversation_id) openConversation(r.conversation_id);
        } catch (err) { toast(err.message, "error"); setBusy(e.currentTarget, false); }
      };
      row.querySelector('[data-a="toggle"]').onclick = async () => {
        try { await api(`/api/tasks/${t.id}`, { method: "PATCH", body: { enabled: !t.enabled } }); loadTasks(); } catch (err) { toast(err.message, "error"); }
      };
      row.querySelector('[data-a="delete"]').onclick = async () => {
        if (!confirm(`Delete “${t.title}”?`)) return;
        try { await api(`/api/tasks/${t.id}`, { method: "DELETE", body: {} }); loadTasks(); } catch (err) { toast(err.message, "error"); }
      };
      list.append(row);
    }
  } catch (e) { list.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}

function renderPlanCard() {
  const a = state.account;
  const u = a.usage;
  const card = $("planCard");
  const used = Math.round(Math.min(100, u.percent));
  let status = "";
  if (a.pro && a.status === "complimentary") status = "Complimentary Pro";
  else if (a.pro && a.cancel_at_period_end && a.pro_until) status = `Ends ${fmtDate(a.pro_until)}`;
  else if (a.pro && a.status === "past_due") status = "Payment failed — update your card";
  else if (a.pro && a.pro_until) status = `Renews ${fmtDate(a.pro_until)}`;
  card.innerHTML = `
    <div class="plan-row"><span class="plan-name ${a.pro ? "pro" : ""}">${a.pro ? "Ehrler Pro" : "Free"}</span><small>${esc(status)}</small></div>
    <div class="meter-lg"><i style="width:${used}%"></i></div>
    <small>${used}% of this month's usage used · resets ${fmtDate(u.resets_at)}</small>
    <div class="plan-row"></div>`;
  const row = card.lastElementChild;
  if (a.pro && a.status !== "complimentary") {
    const b = document.createElement("button");
    b.className = "btn btn-ghost btn-sm";
    b.textContent = "Manage billing";
    b.onclick = () => openPortal(b);
    row.append(b);
  } else if (!a.pro && a.billing_enabled) {
    const b = document.createElement("button");
    b.className = "btn btn-primary btn-sm";
    b.textContent = `Upgrade to Pro · ${a.pro_price}`;
    b.onclick = () => { modal.classList.remove("open"); openUpgrade(); };
    row.append(b);
  }
  if (a.pro) {
    const note = document.createElement("small");
    note.textContent = "Pro is active in every Ehrler app you sign into.";
    row.append(note);
  }
}

/* ───────────────────────── Ehrler Pro ───────────────────────── */

const upgradeModal = $("upgradeModal");
upgradeModal.addEventListener("click", (e) => { if (e.target === upgradeModal || e.target.closest("[data-close]")) upgradeModal.classList.remove("open"); });
document.addEventListener("click", (e) => { if (e.target.closest("[data-upgrade]")) openUpgrade(); });
$("usage").onclick = () => (isPro() ? openAccount() : openUpgrade());

function openUpgrade(reason) {
  const a = state.account;
  if (a?.pro) { openAccount(); return; }
  if (a && !a.billing_enabled) { toast("Ehrler Pro isn't available yet.", "error"); return; }
  $("upgradeReason").textContent = reason || "One subscription. The Pro version of every Ehrler product.";
  closeSidebar();
  upgradeModal.classList.add("open");
}

$("checkoutBtn").onclick = async () => {
  const b = $("checkoutBtn");
  setBusy(b, true, "Opening checkout");
  try {
    const { url } = await api("/api/billing/checkout", { method: "POST", body: {} });
    location.assign(url);
  } catch (e) {
    setBusy(b, false);
    if (e.code === "already_pro") { await refreshAccount(); upgradeModal.classList.remove("open"); toast("You already have Ehrler Pro."); }
    else toast(e.message, "error");
  }
};

async function openPortal(btn) {
  setBusy(btn, true);
  try {
    const { url } = await api("/api/billing/portal", { method: "POST", body: {} });
    location.assign(url);
  } catch (e) {
    setBusy(btn, false);
    toast(e.message, "error");
  }
}

// Back from Stripe Checkout: confirm the subscription (the webhook may be a moment behind).
async function finishUpgrade() {
  history.replaceState(null, "", "/app");
  toast("Activating Ehrler Pro…");
  for (let i = 0; i < 8; i++) {
    try {
      const { account } = await api("/api/billing/sync", { method: "POST", body: {} });
      state.account = account;
      renderAccount();
      if (account.pro) { toast("Welcome to Ehrler Pro. Think mode and Pro usage are unlocked."); return; }
    } catch {}
    await new Promise((r) => setTimeout(r, 2000));
  }
  toast("Payment received — Pro may take a minute to appear. Refresh shortly.", "error");
}

async function loadApps() {
  const list = $("appsList");
  try {
    const { apps } = await api("/api/apps");
    if (!apps.length) { list.innerHTML = '<p class="muted" style="margin:0">No connected apps yet. When you sign into an app like GoVariety with Ehrler Systems, it shows up here.</p>'; return; }
    list.innerHTML = "";
    for (const a of apps) {
      const row = document.createElement("div");
      row.className = "app-row";
      row.innerHTML = `<div class="app-badge">${esc(a.name.charAt(0))}</div><div class="info"><b>${esc(a.name)}</b><small>Can see: ${esc(a.scope.split(" ").join(", "))} · Last used ${new Date(a.last_used).toLocaleDateString()}</small></div><button class="btn btn-danger btn-sm">Disconnect</button>`;
      row.querySelector("button").onclick = async () => {
        if (!confirm(`Disconnect ${a.name}? It will lose access to your Ehrler Systems account.`)) return;
        try { await api(`/api/apps/${encodeURIComponent(a.id)}`, { method: "DELETE", body: {} }); toast(`${a.name} disconnected`); loadApps(); }
        catch (e) { toast(e.message, "error"); }
      };
      list.append(row);
    }
  } catch (e) { list.innerHTML = `<p class="muted">${esc(e.message)}</p>`; }
}

$("profileForm").onsubmit = async (e) => {
  e.preventDefault();
  try {
    const { user } = await api("/api/auth/account", { method: "PATCH", body: { name: $("profName").value } });
    state.user = { ...state.user, ...user };
    renderUser();
    toast("Name saved");
    if (!state.currentId) showEmpty();
  } catch (err) { toast(err.message, "error"); }
};

$("passwordForm").onsubmit = async (e) => {
  e.preventDefault();
  const n = $("pwNotice");
  try {
    await api("/api/auth/account", { method: "PATCH", body: { current_password: $("pwCurrent").value, new_password: $("pwNew").value } });
    n.className = "notice ok show";
    n.textContent = "Password changed. Other devices were signed out.";
    e.target.reset();
  } catch (err) {
    n.className = "notice error show";
    n.textContent = err.message;
  }
};

$("signOut").onclick = async () => {
  try { await api("/api/auth/logout", { method: "POST", body: {} }); } catch {}
  location.replace("/");
};

$("deleteAccount").onclick = async () => {
  const pw = prompt("This permanently deletes your account, conversations and app connections.\n\nEnter your password to confirm:");
  if (!pw) return;
  try {
    await api("/api/auth/account", { method: "DELETE", body: { password: pw } });
    location.replace("/");
  } catch (e) { toast(e.message, "error"); }
};

/* ───────────────────────── Shortcuts ───────────────────────── */

document.addEventListener("keydown", (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); newChat(); }
  else if (mod && e.key === "/") { e.preventDefault(); setMode(state.mode === "chat" ? "code" : "chat"); }
  else if (mod && e.key.toLowerCase() === "b") { e.preventDefault(); toggleWorkbench(); }
  else if (e.key === "Escape") {
    if (state.streaming) stopStreaming();
    else if (upgradeModal.classList.contains("open")) upgradeModal.classList.remove("open");
    else if (modal.classList.contains("open")) modal.classList.remove("open");
    else if ($("sidebar").classList.contains("open")) closeSidebar();
    else if ($("workbench").classList.contains("open") && innerWidth <= 980) toggleWorkbench(false);
  }
});

boot();
