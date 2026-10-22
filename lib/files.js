// Uploaded and generated files. Metadata in D1, bytes in KV (binding FILES).
import { HttpError, newId, now } from "./util.js";

export const MAX_UPLOAD = 20 * 1024 * 1024; // KV values can be up to 25 MB

export function filesEnabled(env) {
  return !!env.FILES;
}

export function fileUrl(id) {
  return `/api/files/${id}`;
}

export function sniffMime(bytes, fallback = "application/octet-stream") {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45) return "image/webp";
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return "image/gif";
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return "application/pdf";
  return fallback;
}

export async function saveFile(env, userId, { name, mime, bytes, kind = "upload" }) {
  if (!env.FILES) throw new HttpError(503, "File storage isn't set up yet (missing FILES binding).", "files_disabled");
  const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (data.byteLength > MAX_UPLOAD) throw new HttpError(413, "That file is too large (max 20 MB).", "too_large");
  const id = newId("fil");
  const safeName = String(name || "file").replace(/[\\/\r\n"]/g, "_").slice(0, 120);
  await env.FILES.put(`file:${id}`, data, { metadata: { user_id: userId, mime } });
  await env.DB.prepare("INSERT INTO files (id, user_id, name, mime, size, kind, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, userId, safeName, mime, data.byteLength, kind, now())
    .run();
  return { id, name: safeName, mime, size: data.byteLength, kind, url: fileUrl(id) };
}

export async function getFileMeta(env, userId, id) {
  return env.DB.prepare("SELECT id, name, mime, size, kind, text_cache, created_at FROM files WHERE id = ? AND user_id = ?")
    .bind(String(id || ""), userId).first();
}

export async function getFileBytes(env, id) {
  if (!env.FILES) return null;
  const buf = await env.FILES.get(`file:${id}`, "arrayBuffer");
  return buf ? new Uint8Array(buf) : null;
}

export async function deleteFile(env, userId, id) {
  const meta = await getFileMeta(env, userId, id);
  if (!meta) return false;
  await env.DB.prepare("DELETE FROM files WHERE id = ?").bind(id).run();
  if (env.FILES) await env.FILES.delete(`file:${id}`);
  return true;
}

export const isImage = (mime) => /^image\/(png|jpe?g|webp|gif)$/.test(mime || "");
export const isText = (mime, name = "") =>
  /^text\//.test(mime || "") || /json|xml|javascript|csv|yaml|toml|x-sh|x-python/.test(mime || "") ||
  /\.(txt|md|csv|json|js|mjs|ts|tsx|jsx|py|html?|css|sql|ya?ml|toml|sh|rb|go|rs|java|c|cpp|h|cs|php|swift|kt|xml|ini|env|log)$/i.test(name);
