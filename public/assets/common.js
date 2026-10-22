// Shared browser helpers.
export async function api(path, { method = "GET", body, signal } = {}) {
  const res = await fetch(path, {
    method,
    signal,
    credentials: "same-origin",
    headers: body !== undefined ? { "content-type": "application/json" } : {},
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error(data?.message || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = data?.error;
    throw err;
  }
  return data;
}

export function toast(message, type = "") {
  let wrap = document.querySelector(".toast-wrap");
  if (!wrap) {
    wrap = document.createElement("div");
    wrap.className = "toast-wrap";
    wrap.setAttribute("role", "status");
    document.body.append(wrap);
  }
  const t = document.createElement("div");
  t.className = `toast ${type}`;
  t.textContent = message;
  wrap.append(t);
  setTimeout(() => t.remove(), 3200);
}

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function setBusy(button, busy, label) {
  if (busy) {
    button.dataset.label = button.innerHTML;
    button.disabled = true;
    button.innerHTML = `<span class="spinner"></span>${label ? `<span>${esc(label)}</span>` : ""}`;
  } else {
    button.disabled = false;
    if (button.dataset.label) button.innerHTML = button.dataset.label;
  }
}

export function showNotice(el, message, type = "error") {
  el.textContent = message;
  el.className = `notice ${type} ${message ? "show" : ""}`;
}
