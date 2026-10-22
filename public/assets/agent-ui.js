// Agent UI: tool activity, approvals, images, attachments and the in-browser code runner.
import { esc } from "./common.js";
import { highlight } from "./markdown.js";

const ICONS = {
  read_webpage: "🌐", web_search: "🔎", browse: "🧭", read_file: "📄", generate_image: "🎨", run_code: "▶",
  gmail_search: "✉", gmail_read: "✉", gmail_create_draft: "✉", gmail_send: "✉",
  calendar_list_events: "📅", calendar_create_event: "📅", calendar_update_event: "📅", calendar_delete_event: "📅",
  github_list_repos: "⌥", github_list_files: "⌥", github_read_file: "⌥", github_push: "⇡", github_create_pull_request: "⇄",
  schedule_task: "⏱", list_tasks: "⏱", cancel_task: "⏱",
};

/* ── Message structure ─────────────────────────────── */

export function ensureAgentSlots(el) {
  const body = el.querySelector(".prose").parentElement;
  if (!body.querySelector(".activity")) {
    const act = document.createElement("div");
    act.className = "activity";
    const gal = document.createElement("div");
    gal.className = "gallery";
    body.insertBefore(gal, body.firstChild);
    body.insertBefore(act, body.firstChild);
  }
  return { activity: body.querySelector(".activity"), gallery: body.querySelector(".gallery") };
}

export function renderParts(el, parts, handlers) {
  if (!parts?.length) return;
  const { activity, gallery } = ensureAgentSlots(el);
  activity.innerHTML = "";
  gallery.innerHTML = "";
  for (const p of parts) addPart(el, p, handlers, { replay: true });
}

export function addPart(el, p, handlers, opts = {}) {
  const { activity, gallery } = ensureAgentSlots(el);
  if (p.type === "tool") return upsertStep(activity, p);
  const node =
    p.type === "image" ? imageCard(p, handlers) :
    p.type === "link" ? linkChip(p) :
    p.type === "task" ? taskChip(p) :
    p.type === "approval" ? approvalCard(p, handlers) :
    p.type === "client_tool" ? codeCard(p, handlers, opts) : null;
  if (!node) return null;
  (p.type === "image" ? gallery : activity).append(node);
  return node;
}

function upsertStep(activity, p) {
  let row = activity.querySelector(`.step[data-id="${CSS.escape(p.id)}"]`);
  if (!row) {
    row = document.createElement("div");
    row.className = "step";
    row.dataset.id = p.id;
    activity.append(row);
  }
  row.dataset.status = p.status;
  row.innerHTML = `<span class="step-ico">${p.status === "running" ? '<span class="spinner"></span>' : ICONS[p.name] || "•"}</span>
    <span class="step-label">${esc(p.status === "running" ? p.label + "…" : p.summary || p.label)}</span>
    ${p.status === "error" ? '<span class="step-err">failed</span>' : p.status === "done" ? '<span class="step-ok">✓</span>' : ""}`;
  if (p.status === "error" && p.summary) row.title = p.summary;
  return row;
}

function linkChip(p) {
  const a = document.createElement("a");
  a.className = "link-chip";
  a.href = p.url;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.innerHTML = `<span>↗</span><b>${esc(p.title || p.url)}</b><small>${esc(host(p.url))}</small>`;
  return a;
}

function taskChip(p) {
  const d = document.createElement("div");
  d.className = "link-chip task-chip";
  d.innerHTML = `<span>⏱</span><b>${esc(p.title)}</b><small>${esc(p.when || "")}</small>`;
  return d;
}

function imageCard(p, handlers) {
  const fig = document.createElement("figure");
  fig.className = "img-card";
  fig.innerHTML = `<button class="img-open" type="button" aria-label="Open full size"><img src="${esc(p.url)}" alt="${esc(p.caption || p.name || "Generated image")}" loading="lazy"></button>
    <figcaption><span>${esc(p.caption ? p.caption.slice(0, 140) : p.name || "")}</span>
      <span class="img-actions">
        <button type="button" data-img="edit" title="Edit or make variations">Edit</button>
        <a href="${esc(p.url)}?download=1" download="${esc(p.name || "image.png")}">Save</a>
      </span></figcaption>`;
  fig.querySelector(".img-open").onclick = () => openLightbox(p);
  fig.querySelector('[data-img="edit"]').onclick = () => handlers?.onEditImage?.(p);
  return fig;
}

function openLightbox(p) {
  const box = document.createElement("div");
  box.className = "lightbox";
  box.innerHTML = `<img src="${esc(p.url)}" alt=""><button class="icon-btn" aria-label="Close">✕</button>`;
  box.onclick = () => box.remove();
  document.body.append(box);
}

/* ── Approvals ─────────────────────────────── */

function approvalCard(p, handlers) {
  const pv = p.preview || {};
  const card = document.createElement("div");
  card.className = `approval ${pv.danger ? "danger" : ""}`;
  card.dataset.call = p.call_id;
  const fields = (pv.fields || []).map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
  const files = (pv.files || []).map((f) => `<details class="ap-file"><summary>${esc(f.path)}</summary><pre><code>${highlight(f.content, (f.path.split(".").pop() || ""))}</code></pre></details>`).join("");
  card.innerHTML = `<div class="ap-head"><span class="ap-ico">${ICONS[p.name] || "!"}</span><b>${esc(pv.title || "Approve this action?")}</b></div>
    ${fields ? `<dl>${fields}</dl>` : ""}
    ${pv.body ? `<div class="ap-body"></div>` : ""}
    ${files}
    <div class="ap-actions"></div>`;
  if (pv.body) card.querySelector(".ap-body").textContent = pv.body;
  setApprovalStatus(card, p, handlers);
  return card;
}

export function setApprovalStatus(card, p, handlers) {
  const actions = card.querySelector(".ap-actions");
  card.dataset.status = p.status;
  if (p.status === "pending") {
    actions.innerHTML = `<button class="btn btn-ghost btn-sm" data-d="decline">Cancel</button><button class="btn btn-primary btn-sm" data-d="approve">${esc(p.preview?.action || "Approve")}</button>`;
    actions.querySelectorAll("button").forEach((b) => (b.onclick = async () => {
      actions.querySelectorAll("button").forEach((x) => (x.disabled = true));
      const ok = await handlers?.onDecision?.(p.run_id, p.call_id, b.dataset.d, card);
      if (ok === false) actions.querySelectorAll("button").forEach((x) => (x.disabled = false));
    }));
  } else {
    actions.innerHTML = `<span class="ap-status ${p.status}">${p.status === "approved" ? "✓ Approved" : p.status === "declined" ? "Cancelled" : esc(p.status)}</span>`;
  }
}

/* ── Code runs (client tool) ─────────────────────────────── */

function codeCard(p, handlers, { replay }) {
  const card = document.createElement("div");
  card.className = "code-run";
  card.dataset.call = p.call_id;
  const lang = p.args?.language === "python" ? "python" : "js";
  card.innerHTML = `<div class="cr-head"><span>${lang === "python" ? "🐍 Python" : "⚡ JavaScript"}</span><b>${esc(p.label || "Running code")}</b><span class="cr-status"></span></div>
    <details class="cr-code"><summary>Code</summary><pre><code>${highlight(String(p.args?.code || ""), lang)}</code></pre></details>
    <pre class="cr-out" hidden></pre>`;
  setCodeStatus(card, p);
  if (p.status === "pending" && replay) {
    const b = document.createElement("button");
    b.className = "btn btn-primary btn-sm";
    b.textContent = "Run code";
    b.onclick = () => { b.remove(); handlers?.onRunClientTool?.(p, card); };
    card.querySelector(".cr-head").append(b);
  }
  return card;
}

export function setCodeStatus(card, p) {
  const st = card.querySelector(".cr-status");
  card.dataset.status = p.status;
  st.innerHTML = p.status === "running" ? '<span class="spinner"></span> running' : p.status === "done" ? "✓ done" : p.status === "error" ? "error" : "waiting";
  const out = card.querySelector(".cr-out");
  const text = [p.output, p.error ? `Error: ${p.error}` : ""].filter(Boolean).join("\n");
  out.hidden = !text;
  out.textContent = text;
  out.classList.toggle("err", !!p.error);
}

/* ── In-browser code runner ─────────────────────────────── */

const PYODIDE = "https://cdn.jsdelivr.net/pyodide/v0.26.4/full/";
const RUNNER = `<!doctype html><html><body><script>
let py = null;
async function loadPy(){ if (py) return py; await new Promise((ok, bad) => { const s = document.createElement('script'); s.src = ${JSON.stringify(PYODIDE)} + 'pyodide.js'; s.onload = ok; s.onerror = () => bad(new Error('Could not load Python')); document.head.append(s); }); py = await loadPyodide({ indexURL: ${JSON.stringify(PYODIDE)} }); return py; }
const fmt = (a) => { try { if (a instanceof Error) return a.stack || String(a); if (typeof a === 'object' && a !== null) return JSON.stringify(a, null, 2); return String(a); } catch { return String(a); } };
addEventListener('message', async (e) => {
  const { id, language, code } = e.data || {};
  if (!id) return;
  let out = ''; const t0 = performance.now(); let value, error;
  try {
    if (language === 'python') {
      const p = await loadPy();
      p.setStdout({ batched: (s) => out += s + '\\n' }); p.setStderr({ batched: (s) => out += s + '\\n' });
      await p.loadPackagesFromImports(code);
      const r = await p.runPythonAsync(code);
      if (r !== undefined && r !== null) value = String(r);
    } else {
      const log = (...a) => out += a.map(fmt).join(' ') + '\\n';
      const timers = {}, counts = {};
      const con = { log, info: log, warn: log, error: log, debug: log, table: log, dir: log, trace: log, group: log, groupCollapsed: log, groupEnd() {},
        assert: (ok, ...a) => { if (!ok) out += 'Assertion failed' + (a.length ? ': ' + a.map(fmt).join(' ') : '') + '\\n'; },
        count: (l = 'default') => log(l + ': ' + (counts[l] = (counts[l] || 0) + 1)),
        time: (l = 'default') => { timers[l] = performance.now(); },
        timeEnd: (l = 'default') => log(l + ': ' + (performance.now() - (timers[l] || 0)).toFixed(1) + 'ms') };
      const fn = new Function('console', '"use strict"; return (async () => {\\n' + code + '\\n})()');
      const r = await fn(con);
      if (r !== undefined) value = fmt(r);
    }
  } catch (err) { error = String(err && (err.stack || err.message) || err); }
  parent.postMessage({ id, stdout: out.slice(0, 20000), value, error, ms: performance.now() - t0 }, '*');
});
parent.postMessage({ ready: true }, '*');
<\/script></body></html>`;

let frame = null;
let ready = null;
function getFrame() {
  if (frame && document.body.contains(frame)) return ready;
  frame = document.createElement("iframe");
  frame.setAttribute("sandbox", "allow-scripts");
  frame.style.display = "none";
  ready = new Promise((ok) => {
    const on = (e) => { if (e.source === frame.contentWindow && e.data?.ready) { removeEventListener("message", on); ok(); } };
    addEventListener("message", on);
  });
  frame.srcdoc = RUNNER;
  document.body.append(frame);
  return ready;
}

export async function runCode({ language, code }) {
  await getFrame();
  const id = Math.random().toString(36).slice(2);
  const limit = language === "python" ? 90000 : 20000;
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      removeEventListener("message", on);
      frame.remove();
      frame = null;
      resolve({ stdout: "", error: `Timed out after ${limit / 1000}s`, ms: limit });
    }, limit);
    const on = (e) => {
      if (e.source !== frame?.contentWindow || e.data?.id !== id) return;
      clearTimeout(timer);
      removeEventListener("message", on);
      resolve(e.data);
    };
    addEventListener("message", on);
    frame.contentWindow.postMessage({ id, language, code }, "*");
  });
}

/* ── Attachments ─────────────────────────────── */

export function uploadFile(file, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/files");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
    xhr.onload = () => {
      let data = {};
      try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300) resolve(data.file);
      else reject(new Error(data.message || `Upload failed (${xhr.status})`));
    };
    xhr.onerror = () => reject(new Error("Upload failed — check your connection."));
    const fd = new FormData();
    fd.append("file", file, file.name || "pasted-image.png");
    xhr.send(fd);
  });
}

export function fileChipHtml(f) {
  const img = /^image\//.test(f.mime);
  return `${img ? `<img src="${esc(f.url)}" alt="">` : `<span class="fc-ico">${fileIcon(f)}</span>`}<span class="fc-name">${esc(f.name)}</span>`;
}

export function fileIcon(f) {
  const n = (f.name || "").toLowerCase();
  if (/pdf$/.test(n) || f.mime === "application/pdf") return "PDF";
  if (/\.(docx?|odt|rtf)$/.test(n)) return "DOC";
  if (/\.(xlsx?|csv|ods)$/.test(n)) return "XLS";
  if (/\.(js|ts|py|html|css|json|go|rs|java|c|cpp|rb|php|sh|sql)$/.test(n)) return "</>";
  return "FILE";
}

function host(u) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } }
