// POST /api/files  (multipart: file)  → upload;  GET /api/files → recent files
import { requireUser } from "../../../lib/auth.js";
import { MAX_UPLOAD, saveFile, sniffMime } from "../../../lib/files.js";
import { handler, HttpError, json } from "../../../lib/util.js";

const MAX_FILES_PER_DAY = 200;

export const onRequestPost = handler(async ({ request, env }) => {
  const user = await requireUser(env, request);
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) throw new HttpError(403, "Cross-origin upload blocked", "bad_origin");
  const ct = request.headers.get("content-type") || "";
  if (!ct.includes("multipart/form-data")) throw new HttpError(415, "Upload a file with multipart/form-data.", "bad_content_type");
  const len = Number(request.headers.get("content-length") || 0);
  if (len > MAX_UPLOAD + 100000) throw new HttpError(413, "That file is too large (max 20 MB).", "too_large");

  const since = Date.now() - 86400000;
  const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM files WHERE user_id = ? AND created_at > ?").bind(user.id, since).first();
  if ((count?.n || 0) >= MAX_FILES_PER_DAY) throw new HttpError(429, "Daily upload limit reached.", "rate_limited");

  const form = await request.formData();
  const file = form.get("file");
  if (!file || typeof file === "string") throw new HttpError(400, "No file in the upload.", "no_file");
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mime = sniffMime(bytes, file.type || "application/octet-stream");
  const saved = await saveFile(env, user.id, { name: file.name, mime, bytes, kind: "upload" });
  return json({ file: saved }, { status: 201 });
});

export const onRequestGet = handler(async ({ request, env }) => {
  const user = await requireUser(env, request);
  const { results } = await env.DB.prepare("SELECT id, name, mime, size, kind, created_at FROM files WHERE user_id = ? ORDER BY created_at DESC LIMIT 100").bind(user.id).all();
  return json({ files: results.map((f) => ({ ...f, url: `/api/files/${f.id}` })) });
});
