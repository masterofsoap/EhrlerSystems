// GET /api/files/:id  → the file (owner only).  ?download=1 forces a download.
// DELETE /api/files/:id
import { requireUser } from "../../../lib/auth.js";
import { deleteFile, getFileBytes, getFileMeta, isImage } from "../../../lib/files.js";
import { handler, HttpError, json, readJson } from "../../../lib/util.js";

export const onRequestGet = handler(async ({ request, env, params }) => {
  const user = await requireUser(env, request);
  const meta = await getFileMeta(env, user.id, params.id);
  if (!meta) throw new HttpError(404, "File not found.", "not_found");
  const bytes = await getFileBytes(env, meta.id);
  if (!bytes) throw new HttpError(404, "File contents are missing.", "not_found");
  const download = new URL(request.url).searchParams.get("download") === "1";
  // Only images and PDFs render inline; everything else downloads, so uploaded HTML can't run on this origin.
  const inline = !download && (isImage(meta.mime) || meta.mime === "application/pdf");
  return new Response(bytes, {
    headers: {
      "content-type": inline ? meta.mime : "application/octet-stream",
      "content-disposition": `${inline ? "inline" : "attachment"}; filename="${meta.name.replace(/"/g, "")}"`,
      "cache-control": "private, max-age=86400",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox",
    },
  });
});

export const onRequestDelete = handler(async ({ request, env, params }) => {
  const user = await requireUser(env, request);
  await readJson(request);
  if (!(await deleteFile(env, user.id, params.id))) throw new HttpError(404, "File not found.", "not_found");
  return json({ ok: true });
});
