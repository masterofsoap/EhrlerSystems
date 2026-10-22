// read_file: documents become text (Markdown); images are described by a vision model.
import { getFileBytes, getFileMeta, isImage, isText } from "../files.js";
import { ToolError } from "../connections.js";

export const readFile = {
  name: "read_file",
  description:
    "Read a file the user uploaded (or one you generated) by its id (fil_...). Documents (PDF, Word, Excel, CSV, code, text) return their text. Images are looked at by a vision model; pass a question to ask about the image.",
  parameters: {
    type: "object",
    properties: {
      file_id: { type: "string" },
      question: { type: "string", description: "For images: what to look for or describe" },
      offset: { type: "number", description: "For long documents: character offset to continue from" },
    },
    required: ["file_id"],
  },
  scheduledOk: true,
  label: (a, ctx) => `Reading ${ctx?.fileName?.(a.file_id) || "file"}`,
  async run(args, ctx) {
    const meta = await getFileMeta(ctx.env, ctx.user.id, args.file_id);
    if (!meta) throw new ToolError("No file with that id belongs to this user.");
    const bytes = await getFileBytes(ctx.env, meta.id);
    if (!bytes) throw new ToolError("That file's contents are missing.");

    if (isImage(meta.mime)) {
      const question = String(args.question || "Describe this image in detail, including any text in it.");
      const out = await ctx.env.AI.run(ctx.env.VISION_MODEL || "@cf/meta/llama-3.2-11b-vision-instruct", {
        messages: [{ role: "user", content: question }],
        image: [...bytes],
        max_tokens: 700,
      });
      ctx.addUnits(400);
      const text = out?.response || out?.description || "";
      return { content: `Image "${meta.name}" (${meta.id}):\n${text}`, summary: `Looked at ${meta.name}` };
    }

    let text = meta.text_cache;
    if (text == null) {
      if (isText(meta.mime, meta.name)) {
        text = new TextDecoder().decode(bytes);
      } else if (ctx.env.AI?.toMarkdown) {
        const r = await ctx.env.AI.toMarkdown({ name: meta.name, blob: new Blob([bytes], { type: meta.mime }) });
        if (r?.format === "error") throw new ToolError(`Couldn't read ${meta.name}: ${r.error}`);
        text = r?.data || "";
        ctx.addUnits(100);
      } else {
        throw new ToolError(`Can't read ${meta.mime} files here.`);
      }
      await ctx.env.DB.prepare("UPDATE files SET text_cache = ? WHERE id = ?").bind(text.slice(0, 900000), meta.id).run();
    }
    const offset = Math.max(0, Number(args.offset) || 0);
    const LIMIT = 16000;
    const more = text.length > offset + LIMIT;
    return {
      content: `File "${meta.name}" (${meta.mime}, ${text.length} characters):\n\n${text.slice(offset, offset + LIMIT)}${more ? `\n\n[Continues — call read_file with offset ${offset + LIMIT}]` : ""}`,
      summary: `Read ${meta.name}`,
    };
  },
};
