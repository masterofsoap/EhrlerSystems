// GitHub tools: browse repos, read code, push commits, open pull requests.
import { accessToken, ghHeaders, isConnected, ToolError } from "../connections.js";

const API = "https://api.github.com";
const repoRe = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

async function gh(ctx, path, init = {}) {
  const token = await accessToken(ctx.env, ctx.user.id, "github");
  const res = await fetch(API + path, { ...init, headers: { ...ghHeaders(token), "content-type": "application/json", ...(init.headers || {}) } });
  if (res.status === 204) return {};
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ToolError(`GitHub said: ${data.message || res.status}${res.status === 404 ? " (not found, or no access)" : ""}`);
  return data;
}
const checkRepo = (r) => { if (!repoRe.test(String(r || ""))) throw new ToolError('Repository must look like "owner/name".'); return r; };
const enc = (p) => String(p || "").split("/").map(encodeURIComponent).join("/");
const ghOk = async (ctx) => isConnected(ctx.env, ctx.user.id, "github");

export const ghListRepos = {
  name: "github_list_repos",
  description: "List the user's GitHub repositories (most recently updated first).",
  parameters: { type: "object", properties: { query: { type: "string", description: "Optional filter text" } } },
  available: ghOk,
  scheduledOk: true,
  label: () => "Listing your repositories",
  async run(args, ctx) {
    const repos = await gh(ctx, "/user/repos?sort=updated&per_page=50&affiliation=owner,collaborator,organization_member");
    const q = String(args.query || "").toLowerCase();
    const lines = repos.filter((r) => !q || r.full_name.toLowerCase().includes(q)).map((r) => `• ${r.full_name}${r.private ? " (private)" : ""} — default branch ${r.default_branch}${r.description ? ` — ${r.description}` : ""}`);
    return { content: lines.join("\n") || "No repositories.", summary: `Found ${lines.length} repos` };
  },
};

export const ghListFiles = {
  name: "github_list_files",
  description: "List files and folders in a repository path. Use path '' for the root, or recursive=true to list the whole tree.",
  parameters: { type: "object", properties: { repo: { type: "string" }, path: { type: "string" }, ref: { type: "string" }, recursive: { type: "boolean" } }, required: ["repo"] },
  available: ghOk,
  scheduledOk: true,
  label: (a) => `Browsing ${a.repo}/${a.path || ""}`,
  async run(args, ctx) {
    const repo = checkRepo(args.repo);
    if (args.recursive) {
      const info = await gh(ctx, `/repos/${repo}`);
      const tree = await gh(ctx, `/repos/${repo}/git/trees/${encodeURIComponent(args.ref || info.default_branch)}?recursive=1`);
      const lines = tree.tree.filter((t) => t.type === "blob").slice(0, 600).map((t) => `${t.path} (${t.size} B)`);
      return { content: lines.join("\n") + (tree.truncated ? "\n[truncated]" : ""), summary: `Listed ${lines.length} files` };
    }
    const q = args.ref ? `?ref=${encodeURIComponent(args.ref)}` : "";
    const items = await gh(ctx, `/repos/${repo}/contents/${enc(args.path)}${q}`);
    const list = Array.isArray(items) ? items : [items];
    return { content: list.map((i) => `${i.type === "dir" ? "📁" : "📄"} ${i.path}${i.type === "file" ? ` (${i.size} B)` : ""}`).join("\n"), summary: `Listed ${list.length} items` };
  },
};

export const ghReadFile = {
  name: "github_read_file",
  description: "Read a file from a GitHub repository.",
  parameters: { type: "object", properties: { repo: { type: "string" }, path: { type: "string" }, ref: { type: "string" } }, required: ["repo", "path"] },
  available: ghOk,
  scheduledOk: true,
  label: (a) => `Reading ${a.path}`,
  async run(args, ctx) {
    const repo = checkRepo(args.repo);
    const q = args.ref ? `?ref=${encodeURIComponent(args.ref)}` : "";
    const f = await gh(ctx, `/repos/${repo}/contents/${enc(args.path)}${q}`);
    if (Array.isArray(f) || f.type !== "file") throw new ToolError("That path is a folder, not a file.");
    let text;
    if (f.content) text = new TextDecoder().decode(Uint8Array.from(atob(f.content.replace(/\n/g, "")), (c) => c.charCodeAt(0)));
    else text = await (await fetch(f.download_url)).text();
    return { content: `${repo}/${f.path} (${f.size} B, sha ${f.sha.slice(0, 7)}):\n\n${text.slice(0, 30000)}${text.length > 30000 ? "\n[truncated]" : ""}`, summary: `Read ${f.path}` };
  },
};

export const ghPush = {
  name: "github_push",
  description:
    "Commit and push file changes to a GitHub repository in ONE commit. Give full new file contents for each changed file (set delete=true to remove a file). If the branch doesn't exist it's created from base_branch (default: the repo's default branch). The user approves first.",
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string" },
      branch: { type: "string" },
      base_branch: { type: "string" },
      message: { type: "string" },
      files: { type: "array", items: { type: "object", properties: { path: { type: "string" }, content: { type: "string" }, delete: { type: "boolean" } }, required: ["path"] } },
    },
    required: ["repo", "branch", "message", "files"],
  },
  available: ghOk,
  approval: (a) => ({
    title: `Push to ${a.repo}?`, action: "Push commit",
    fields: [["Branch", a.branch], ["Message", a.message], ["Files", (a.files || []).map((f) => `${f.delete ? "delete " : ""}${f.path}${f.content != null ? ` (${f.content.length} chars)` : ""}`).join("\n")]],
    files: (a.files || []).filter((f) => !f.delete).slice(0, 6).map((f) => ({ path: f.path, content: String(f.content || "").slice(0, 4000) })),
  }),
  label: (a) => `Pushing to ${a.repo}@${a.branch}`,
  async run(args, ctx) {
    const repo = checkRepo(args.repo);
    if (!args.files?.length) throw new ToolError("No files to commit.");
    const info = await gh(ctx, `/repos/${repo}`);
    const base = args.base_branch || info.default_branch;
    let parentSha;
    let created = false;
    try {
      parentSha = (await gh(ctx, `/repos/${repo}/git/ref/heads/${enc(args.branch)}`)).object.sha;
    } catch {
      parentSha = (await gh(ctx, `/repos/${repo}/git/ref/heads/${enc(base)}`)).object.sha;
      await gh(ctx, `/repos/${repo}/git/refs`, { method: "POST", body: JSON.stringify({ ref: `refs/heads/${args.branch}`, sha: parentSha }) });
      created = true;
    }
    const parent = await gh(ctx, `/repos/${repo}/git/commits/${parentSha}`);
    const tree = [];
    for (const f of args.files) {
      const path = String(f.path).replace(/^\/+/, "");
      if (f.delete) { tree.push({ path, mode: "100644", type: "blob", sha: null }); continue; }
      const blob = await gh(ctx, `/repos/${repo}/git/blobs`, { method: "POST", body: JSON.stringify({ content: String(f.content ?? ""), encoding: "utf-8" }) });
      tree.push({ path, mode: "100644", type: "blob", sha: blob.sha });
    }
    const newTree = await gh(ctx, `/repos/${repo}/git/trees`, { method: "POST", body: JSON.stringify({ base_tree: parent.tree.sha, tree }) });
    const commit = await gh(ctx, `/repos/${repo}/git/commits`, { method: "POST", body: JSON.stringify({ message: args.message, tree: newTree.sha, parents: [parentSha] }) });
    await gh(ctx, `/repos/${repo}/git/refs/heads/${enc(args.branch)}`, { method: "PATCH", body: JSON.stringify({ sha: commit.sha }) });
    const url = `https://github.com/${repo}/commit/${commit.sha}`;
    return {
      content: `Pushed commit ${commit.sha.slice(0, 7)} to ${repo}@${args.branch}${created ? ` (new branch from ${base})` : ""}: ${url}`,
      summary: `Pushed ${args.files.length} file${args.files.length === 1 ? "" : "s"} to ${args.branch}`,
      part: { type: "link", url, title: `${repo} · ${commit.sha.slice(0, 7)}` },
    };
  },
};

export const ghCreatePR = {
  name: "github_create_pull_request",
  description: "Open a pull request. The user approves first.",
  parameters: { type: "object", properties: { repo: { type: "string" }, head: { type: "string", description: "Branch with the changes" }, base: { type: "string" }, title: { type: "string" }, body: { type: "string" } }, required: ["repo", "head", "title"] },
  available: ghOk,
  approval: (a) => ({ title: `Open a pull request on ${a.repo}?`, action: "Open PR", fields: [["From", a.head], ["Into", a.base || "default branch"], ["Title", a.title]], body: a.body || "" }),
  label: (a) => `Opening PR on ${a.repo}`,
  async run(args, ctx) {
    const repo = checkRepo(args.repo);
    const base = args.base || (await gh(ctx, `/repos/${repo}`)).default_branch;
    const pr = await gh(ctx, `/repos/${repo}/pulls`, { method: "POST", body: JSON.stringify({ title: args.title, head: args.head, base, body: args.body || "" }) });
    return { content: `Opened PR #${pr.number}: ${pr.html_url}`, summary: `Opened PR #${pr.number}`, part: { type: "link", url: pr.html_url, title: `PR #${pr.number}: ${args.title}` } };
  },
};
