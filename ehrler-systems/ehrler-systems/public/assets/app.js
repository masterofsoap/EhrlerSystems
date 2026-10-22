import { api, esc, toast } from "./common.js";
import { extensionFor, highlight, normalizeLang, renderMarkdown, RUNNABLE } from "./markdown.js";

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
    ["Explain it simply", "How does a heat pump work, and is it worth it in a cold climate?"],
    ["Plan something", "Plan a 3-day weekend trip on a $400 budget with a packing list."],
    ["Write for me", "Write a friendly but firm email asking a client to pay an overdue invoice."],
    ["Think it through", "Help me decide between two job offers. Ask me questions first."],
  ],
  code: [
    ["Build a UI", "Build a single-file HTML page with a glowing, animated countdown timer I can start and pause."],
    ["Fix my bug", "Why does `for (var i = 0; i < 3; i++) setTimeout(() => console.log(i))` print 3 three times? Show a fix."],
    ["Write SQL", "Write a SQLite schema for a hockey league: teams, players, games and scores, plus a standings query."],
    ["Explain code", "Explain async/await in JavaScript with a runnable example that logs each step."],
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
};

/* ───────────────────────── Boot ───────────────────────── */

async function boot() {
  try {
    const me = await api("/api/auth/me");
    state.user = me.user;
    state.usage = me.usage;
    state.models = me.models || {};
  } catch {
    location.replace("/?next=" + encodeURIComponent(location.pathname + location.search));
    return;
  }
  renderUser();
  renderUsage();
  try { setMode(localStorage.getItem("es-mode") === "code" ? "code" : "chat", false); } catch { setMode("chat", false); }
  await loadConversations();
  const c = new URLSearchParams(location.search).get("c");
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

function renderUsage() {
  const u = state.usage;
  if (!u) return;
  $("usageText").textContent = `${u.remaining}/${u.limit}`;
  $("usageBar").style.width = `${(u.remaining / Math.max(1, u.limit)) * 100}%`;
  $("usage").title = `${u.remaining} of ${u.limit} messages left today (resets at midnight UTC)`;
}

/* ───────────────────────── Mode ───────────────────────── */

function setMode(mode, persist = true) {
  state.mode = mode;
  root.dataset.mode = mode;
  $("modeChat").setAttribute("aria-pressed", mode === "chat");
  $("modeCode").setAttribute("aria-pressed", mode === "code");
  $("input").placeholder = mode === "code" ? "Describe what to build, paste code, or ask about a bug…" : "Message Ehrler Systems…";
  const model = (mode === "code" ? state.models.code : state.models.chat) || "";
  $("modelHint").textContent = model ? model.split("/").pop() : "";
  if (persist) try { localStorage.setItem("es-mode", mode); } catch {}
  if (!state.currentId) showEmpty();
}
$("modeChat").onclick = () => setMode("chat");
$("modeCode").onclick = () => setMode("code");

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
    el.innerHTML = `<span class="tag ${c.mode === "code" ? "code" : ""}">${c.mode === "code" ? "&lt;/&gt;" : "AI"}</span><span class="title">${esc(c.title)}</span><button class="icon-btn more" aria-label="More options">${ICON.dots}</button>`;
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
    setMode(data.conversation.mode === "code" ? "code" : "chat", false);
    const inner = $("threadInner");
    inner.innerHTML = "";
    for (const m of data.messages) addMessage(m.role, m.content, { model: m.model, animate: false });
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
  const code = state.mode === "code";
  $("threadInner").innerHTML = `
    <div class="empty">
      <div class="mark"><img class="logo" src="/assets/logo.png" alt=""></div>
      <h2>${esc(greet)}${first ? `, <em>${esc(first)}</em>` : ""}.</h2>
      <p>${code
        ? "Code mode is on. Ask for anything from a quick fix to a full page — HTML, CSS and JavaScript run live in the Workbench."
        : "Ask anything. Switch to Code mode for a model tuned for programming."}</p>
      <div class="suggestions">${SUGGESTIONS[state.mode].map(([t, p]) => `<button class="suggestion" data-p="${esc(p)}"><b>${esc(t)}</b>${esc(p)}</button>`).join("")}</div>
    </div>`;
  $("threadInner").querySelectorAll(".suggestion").forEach((b) => (b.onclick = () => { $("input").value = b.dataset.p; autosize(); send(); }));
}

/* ───────────────────────── Messages ───────────────────────── */

function addMessage(role, content, { model, animate = true } = {}) {
  const inner = $("threadInner");
  inner.querySelector(".empty")?.remove();
  const el = document.createElement("div");
  el.className = `msg ${role}`;
  if (!animate) el.style.animation = "none";
  if (role === "user") {
    el.innerHTML = `<div class="who"></div><div><div class="bubble"></div><div class="meta" style="justify-content:flex-end"><button data-act="copy-msg">${ICON.copy}Copy</button></div></div>`;
    el.querySelector(".bubble").textContent = content;
  } else {
    el.innerHTML = `<div class="who"><img class="logo" src="/assets/logo.png" alt="Ehrler Systems"></div>
      <div><div class="prose"></div><div class="meta"><button data-act="copy-msg">${ICON.copy}Copy</button><span class="model"></span></div></div>`;
    el.querySelector(".model").textContent = model ? model.split("/").pop() : "";
  }
  el._content = content;
  inner.append(el);
  if (role === "assistant") renderAssistant(el, content, false);
  return el;
}

function renderAssistant(el, content, streaming) {
  const prose = el.querySelector(".prose");
  if (!content && streaming) {
    prose.innerHTML = '<div class="thinking" aria-label="Thinking"><i></i><i></i><i></i></div>';
    return;
  }
  const { html, blocks } = renderMarkdown(content);
  prose.innerHTML = html;
  el._blocks = blocks;
  const lastBlockOpen = blocks.length && blocks[blocks.length - 1].open;
  if (streaming && !lastBlockOpen) {
    const target = prose.lastElementChild && /^(P|LI|UL|OL|H\d|BLOCKQUOTE)$/.test(prose.lastElementChild.tagName)
      ? deepestLast(prose.lastElementChild) : prose;
    target.insertAdjacentHTML("beforeend", '<span class="caret"></span>');
  }
}
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
    await copyText(msg._content || "");
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
  if (!text || state.streaming) return;
  input.value = "";
  autosize();

  addMessage("user", text);
  const el = addMessage("assistant", "", { model: state.mode === "code" ? state.models.code : state.models.chat });
  renderAssistant(el, "", true);
  markLast();
  scrollToBottom(true);

  const ctrl = new AbortController();
  state.streaming = ctrl;
  setSending(true);
  let content = "";
  let raf = 0;
  let gotUsage = false;
  const paint = () => { raf = 0; renderAssistant(el, content, true); scrollToBottom(); };

  try {
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ conversation_id: state.currentId, message: text, mode: state.mode }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) return location.replace("/?next=/app");
      throw new Error(data.message || `Request failed (${res.status})`);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
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
        else if (ev.t === "done") { if (ev.usage) { state.usage = ev.usage; renderUsage(); gotUsage = true; } }
        else if (ev.t === "error") showMsgError(el, ev.message);
      }
    }
  } catch (e) {
    if (e.name === "AbortError") {
      if (!content) el.remove();
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
    if (!gotUsage) refreshUsage();
    bumpConversation();
  }
}

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

async function refreshUsage() {
  try { const me = await api("/api/auth/me"); state.usage = me.usage; renderUsage(); } catch {}
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

async function openAccount() {
  closeSidebar();
  $("profName").value = state.user.name;
  $("profEmail").value = state.user.email;
  modal.classList.add("open");
  loadApps();
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
    else if (modal.classList.contains("open")) modal.classList.remove("open");
    else if ($("sidebar").classList.contains("open")) closeSidebar();
    else if ($("workbench").classList.contains("open") && innerWidth <= 980) toggleWorkbench(false);
  }
});

boot();
