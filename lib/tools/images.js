// generate_image: FLUX.2 [dev] on Workers AI. With reference images it edits / restyles them.
import { getFileBytes, getFileMeta, isImage, saveFile, sniffMime } from "../files.js";
import { ToolError } from "../connections.js";

const SIZES = new Set([512, 768, 1024, 1280, 1536]);
const clampSize = (n, d) => {
  const v = Math.round(Number(n) || d);
  return SIZES.has(v) ? v : [...SIZES].reduce((a, b) => (Math.abs(b - v) < Math.abs(a - v) ? b : a));
};

export const generateImage = {
  name: "generate_image",
  description:
    "Create a high-quality image with FLUX.2. For edits or variations of the user's pictures, pass their file ids in reference_file_ids (up to 4) and describe the change. Great for photos, product shots, ads, posters, logos ideas, social posts. Write a detailed prompt: subject, setting, style, lighting, composition, and any exact text in quotes. Use width/height for aspect ratio (e.g. 1024x1024 square, 1280x768 landscape, 768x1280 story).",
  parameters: {
    type: "object",
    properties: {
      prompt: { type: "string", description: "Detailed description of the image" },
      width: { type: "number", description: "512, 768, 1024, 1280 or 1536 (default 1024)" },
      height: { type: "number", description: "512, 768, 1024, 1280 or 1536 (default 1024)" },
      reference_file_ids: { type: "array", items: { type: "string" }, description: "Up to 4 image file ids to edit or use as references" },
    },
    required: ["prompt"],
  },
  scheduledOk: true,
  label: (a) => (a.reference_file_ids?.length ? "Editing image" : "Generating image"),
  async run(args, ctx) {
    const { env, user } = ctx;
    const prompt = String(args.prompt || "").trim().slice(0, 4000);
    if (!prompt) throw new ToolError("The image needs a prompt.");
    const width = clampSize(args.width, 1024);
    const height = clampSize(args.height, 1024);

    const form = new FormData();
    form.append("prompt", prompt);
    form.append("width", String(width));
    form.append("height", String(height));
    const refs = (args.reference_file_ids || []).slice(0, 4);
    for (let i = 0; i < refs.length; i++) {
      const meta = await getFileMeta(env, user.id, refs[i]);
      if (!meta || !isImage(meta.mime)) throw new ToolError(`Reference ${refs[i]} isn't one of the user's images.`);
      const bytes = await getFileBytes(env, meta.id);
      form.append(`input_image_${i}`, new Blob([bytes], { type: meta.mime }), meta.name);
    }

    const r = new Response(form);
    const out = await env.AI.run(env.IMAGE_MODEL || "@cf/black-forest-labs/flux-2-dev", {
      multipart: { body: r.body, contentType: r.headers.get("content-type") },
    });
    const b64 = out?.image || out?.result?.image;
    if (!b64) throw new ToolError("The image model didn't return an image.");
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const mime = sniffMime(bytes, "image/png");
    const ext = mime.split("/")[1].replace("jpeg", "jpg");
    const slug = prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "image";
    const file = await saveFile(env, user.id, { name: `${slug}.${ext}`, mime, bytes, kind: "generated" });

    const megapixels = (width * height) / 1e6;
    ctx.addUnits(Math.ceil(Number(env.IMAGE_UNITS_PER_MP || 2500) * Math.max(0.25, megapixels) * (1 + refs.length * 0.25)));
    return {
      content: `Image created: file ${file.id} (${width}x${height}). It is already shown to the user — do not repeat a link. To refine it, call generate_image again with reference_file_ids ["${file.id}"].`,
      summary: refs.length ? "Edited image" : "Generated image",
      part: { type: "image", file_id: file.id, url: file.url, name: file.name, caption: prompt, width, height },
    };
  },
};
