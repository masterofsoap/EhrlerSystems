// Ehrler Systems — dependency-free Markdown renderer + syntax highlighter.
// Safe by construction: all text is HTML-escaped before any markup is added,
// and links are limited to http(s) and mailto.

const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);

/* ───────────────────────────── Highlighter ───────────────────────────── */

const words = (s) => new Set(s.split(/\s+/).filter(Boolean));

const JS_KW = words(`break case catch class const continue debugger default delete do else export extends finally for from function
  if import in instanceof let new of return static super switch this throw try typeof var void while with yield async await
  as implements interface type enum public private protected readonly declare namespace abstract keyof satisfies get set`);
const JS_LIT = words("true false null undefined NaN Infinity");
const JS_BUILTIN = words(`console window document Math JSON Object Array String Number Boolean Promise Map Set Date RegExp Error
  fetch setTimeout setInterval clearTimeout clearInterval require module exports process globalThis Symbol BigInt Intl`);

const PY_KW = words(`and as assert async await break class continue def del elif else except finally for from global if import in is
  lambda nonlocal not or pass raise return try while with yield match case`);
const PY_LIT = words("True False None");
const PY_BUILTIN = words(`print len range enumerate zip map filter sorted reversed sum min max abs open int float str list dict set
  tuple bool type isinstance super object input round any all iter next repr format self cls`);

const C_KW = words(`auto break case char const continue default do double else enum extern float for goto if inline int long register
  return short signed sizeof static struct switch typedef union unsigned void volatile while class namespace template typename
  public private protected virtual override new delete using try catch throw bool true false nullptr this operator friend
  package import func go chan defer fallthrough map range select var interface type fn let mut impl trait pub use mod crate
  match loop where as dyn ref move unsafe extends implements final abstract synchronized throws instanceof boolean byte
  string var val fun when object companion data sealed lateinit suspend foreach echo function elseif endif endforeach
  def end module require include unless until begin rescue ensure yield lambda proc self nil elif then fi done esac in`);
const C_LIT = words("true false null nil NULL nullptr None");

const SQL_KW = words(`select from where and or not insert into values update set delete create table drop alter add column index
  primary key foreign references join left right inner outer full cross on group by order having limit offset as distinct
  union all exists in is null like between case when then else end asc desc default unique check constraint if begin commit
  rollback transaction view trigger returning with recursive conflict do nothing replace autoincrement integer text real blob
  varchar int bigint boolean timestamp date count sum avg min max coalesce`);

const SH_KW = words(`if then else elif fi for while until do done case esac in function return local export source alias unset
  shift exit break continue echo cd ls mkdir rm cp mv cat grep sed awk curl wget sudo npm npx node git pip python docker
  wrangler chmod chown touch read printf set eval exec test`);

const LANG_ALIASES = {
  javascript: "js", jsx: "js", mjs: "js", cjs: "js", ts: "js", typescript: "js", tsx: "js",
  py: "python", python3: "python",
  htm: "html", xml: "html", svg: "html", vue: "html", svelte: "html",
  scss: "css", less: "css", sass: "css",
  sh: "bash", shell: "bash", zsh: "bash", console: "bash", terminal: "bash", ps1: "bash", powershell: "bash",
  sqlite: "sql", postgres: "sql", mysql: "sql", psql: "sql",
  jsonc: "json", json5: "json",
  c: "c", cpp: "c", "c++": "c", h: "c", cs: "c", csharp: "c", java: "c", go: "c", golang: "c", rust: "c", rs: "c",
  kotlin: "c", kt: "c", swift: "c", php: "c", rb: "c", ruby: "c", dart: "c", scala: "c",
  yml: "yaml", toml: "yaml", ini: "yaml",
};

export function normalizeLang(lang) {
  const l = String(lang || "").toLowerCase().trim();
  return LANG_ALIASES[l] || l;
}

const span = (cls, text) => `<span class="t-${cls}">${esc(text)}</span>`;

// Generic scanner driven by a language profile.
function scan(code, p) {
  let out = "";
  let i = 0;
  const n = code.length;
  const at = (re) => { re.lastIndex = i; const m = re.exec(code); return m ? m[0] : null; };
  const reNum = /(?:0[xX][\da-fA-F_]+|0[bB][01_]+|\d[\d_]*\.?\d*(?:[eE][+-]?\d+)?|\.\d+)[a-zA-Z]*/y;
  const reId = /[A-Za-z_$][\w$]*/y;
  const reWs = /\s+/y;
  const reOp = /[+\-*/%=<>!&|^~?:]+/y;

  while (i < n) {
    let m;
    // Comments
    if (p.line && p.line.some((t) => code.startsWith(t, i)) && !(p.hashNeedsSpace && code[i] === "#" && /\S/.test(code[i - 1] || " "))) {
      const end = code.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      out += span("comment", code.slice(i, stop));
      i = stop;
      continue;
    }
    const block = p.block && p.block.find(([a]) => code.startsWith(a, i));
    if (block) {
      const end = code.indexOf(block[1], i + block[0].length);
      const stop = end === -1 ? n : end + block[1].length;
      out += span("comment", code.slice(i, stop));
      i = stop;
      continue;
    }
    // Strings
    const ch = code[i];
    if (p.triple && (code.startsWith('"""', i) || code.startsWith("'''", i))) {
      const q = code.slice(i, i + 3);
      const end = code.indexOf(q, i + 3);
      const stop = end === -1 ? n : end + 3;
      out += span("string", code.slice(i, stop));
      i = stop;
      continue;
    }
    if (p.quotes.includes(ch)) {
      let j = i + 1;
      while (j < n && code[j] !== ch) {
        if (code[j] === "\\") j++;
        else if (code[j] === "\n" && ch !== "`") break;
        j++;
      }
      const stop = Math.min(n, j + 1);
      const text = code.slice(i, stop);
      if (ch === "`" && p.template) {
        // Highlight ${…} inside template literals.
        out += text.split(/(\$\{[^}]*\})/).map((part) => (part.startsWith("${") ? span("punct", "${") + scan(part.slice(2, -1), p) + span("punct", "}") : span("string", part))).join("");
      } else out += span("string", text);
      i = stop;
      continue;
    }
    // Variables like $HOME in shell
    if (p.vars && ch === "$" && (m = /\$\{?[\w@#?*!]+\}?/y) && at(m)) {
      const t = at(m);
      out += span("var", t);
      i += t.length;
      continue;
    }
    // Decorators / annotations
    if (p.decorators && ch === "@" && (m = at(/@[\w.]+/y))) {
      out += span("meta", m);
      i += m.length;
      continue;
    }
    // Numbers
    if (/[\d.]/.test(ch) && !/[\w$]/.test(code[i - 1] || "") && (m = at(reNum)) && /\d/.test(m)) {
      out += span("number", m);
      i += m.length;
      continue;
    }
    // Identifiers
    if ((m = at(reId))) {
      const lower = p.caseInsensitive ? m.toLowerCase() : m;
      const nextNonSpace = code.slice(i + m.length).match(/^\s*(\S)/)?.[1];
      let cls = null;
      if (p.kw.has(lower)) cls = "keyword";
      else if (p.lit && p.lit.has(m)) cls = "literal";
      else if (p.builtin && p.builtin.has(m)) cls = "builtin";
      else if (nextNonSpace === "(") cls = "fn";
      else if (/^[A-Z][a-z0-9]/.test(m) && p.types) cls = "type";
      else if (code[i - 1] === "." ) cls = "prop";
      out += cls ? span(cls, m) : esc(m);
      i += m.length;
      continue;
    }
    if ((m = at(reWs))) { out += m; i += m.length; continue; }
    if ((m = at(reOp))) { out += span("op", m); i += m.length; continue; }
    out += /[{}()[\];,.]/.test(ch) ? span("punct", ch) : esc(ch);
    i++;
  }
  return out;
}

const PROFILES = {
  js: { line: ["//"], block: [["/*", "*/"]], quotes: "\"'`", template: true, kw: JS_KW, lit: JS_LIT, builtin: JS_BUILTIN, types: true, decorators: true },
  python: { line: ["#"], quotes: "\"'", triple: true, kw: PY_KW, lit: PY_LIT, builtin: PY_BUILTIN, types: true, decorators: true },
  c: { line: ["//", "#"], hashNeedsSpace: false, block: [["/*", "*/"]], quotes: "\"'`", kw: C_KW, lit: C_LIT, types: true, decorators: true, vars: true },
  sql: { line: ["--"], block: [["/*", "*/"]], quotes: "'\"`", kw: SQL_KW, lit: words("TRUE FALSE NULL true false null"), caseInsensitive: true },
  bash: { line: ["#"], hashNeedsSpace: true, quotes: "\"'`", kw: SH_KW, vars: true },
  json: { quotes: '"', kw: new Set(), lit: words("true false null") },
  yaml: { line: ["#"], quotes: "\"'", kw: new Set(), lit: words("true false null yes no on off") },
  plain: { line: ["//", "#"], hashNeedsSpace: true, block: [["/*", "*/"]], quotes: "\"'`", kw: new Set(), types: false },
};

function highlightCss(code) {
  let out = "";
  let depth = 0;
  let i = 0;
  const n = code.length;
  while (i < n) {
    const rest = code.slice(i);
    let m;
    if (rest.startsWith("/*")) {
      const end = code.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      out += span("comment", code.slice(i, stop)); i = stop; continue;
    }
    if ((m = rest.match(/^(["'])(?:\\.|(?!\1).)*\1?/))) { out += span("string", m[0]); i += m[0].length; continue; }
    if ((m = rest.match(/^@[\w-]+/))) { out += span("keyword", m[0]); i += m[0].length; continue; }
    if (rest[0] === "{") { depth++; out += span("punct", "{"); i++; continue; }
    if (rest[0] === "}") { depth = Math.max(0, depth - 1); out += span("punct", "}"); i++; continue; }
    if (depth === 0 || /^[^;{}:]*\{/.test(rest.split("\n")[0]) && /^[^:;{}]*[{]/.test(rest)) {
      if ((m = rest.match(/^[^{}/@"';]+/)) ) { out += span("selector", m[0]); i += m[0].length; continue; }
    }
    if ((m = rest.match(/^--?[\w-]+(?=\s*:)/)) || (m = rest.match(/^[a-zA-Z-]+(?=\s*:)/))) { out += span("prop", m[0]); i += m[0].length; continue; }
    if ((m = rest.match(/^#[\da-fA-F]{3,8}\b/))) { out += span("number", m[0]); i += m[0].length; continue; }
    if ((m = rest.match(/^-?\d*\.?\d+(px|em|rem|%|vh|vw|vmin|vmax|s|ms|deg|fr|ch|ex|dvh|svh)?/))) { out += span("number", m[0]); i += m[0].length; continue; }
    if ((m = rest.match(/^[\w-]+(?=\()/))) { out += span("fn", m[0]); i += m[0].length; continue; }
    if ((m = rest.match(/^!important/))) { out += span("keyword", m[0]); i += m[0].length; continue; }
    if ((m = rest.match(/^[\w-]+/))) { out += span("value", m[0]); i += m[0].length; continue; }
    out += /[:;,()]/.test(rest[0]) ? span("punct", rest[0]) : esc(rest[0]);
    i++;
  }
  return out;
}

function highlightHtml(code) {
  let out = "";
  let i = 0;
  const n = code.length;
  while (i < n) {
    if (code.startsWith("<!--", i)) {
      const end = code.indexOf("-->", i);
      const stop = end === -1 ? n : end + 3;
      out += span("comment", code.slice(i, stop)); i = stop; continue;
    }
    const tag = /^<\/?([a-zA-Z][\w:-]*)|^<!doctype[^>]*>/i.exec(code.slice(i, i + 200));
    if (code[i] === "<" && tag) {
      if (tag[0].toLowerCase().startsWith("<!doctype")) { out += span("meta", tag[0]); i += tag[0].length; continue; }
      const name = tag[1].toLowerCase();
      out += span("punct", tag[0].startsWith("</") ? "</" : "<") + span("tag", tag[1]);
      i += tag[0].length;
      // attributes
      while (i < n && code[i] !== ">") {
        const rest = code.slice(i);
        let m;
        if ((m = rest.match(/^\s+/))) { out += m[0]; i += m[0].length; continue; }
        if ((m = rest.match(/^\/?>/)) ) break;
        if ((m = rest.match(/^[^\s=>/"']+/))) { out += span("attr", m[0]); i += m[0].length; continue; }
        if ((m = rest.match(/^=/))) { out += span("op", "="); i++; continue; }
        if ((m = rest.match(/^"[^"]*"?|^'[^']*'?/))) { out += span("string", m[0]); i += m[0].length; continue; }
        out += esc(rest[0]); i++;
      }
      if (code.startsWith("/>", i)) { out += span("punct", "/>"); i += 2; }
      else if (code[i] === ">") { out += span("punct", ">"); i++; }
      // Embedded script / style
      if (!tag[0].startsWith("</") && (name === "script" || name === "style")) {
        const close = code.toLowerCase().indexOf(`</${name}`, i);
        const stop = close === -1 ? n : close;
        const inner = code.slice(i, stop);
        out += name === "script" ? scan(inner, PROFILES.js) : highlightCss(inner);
        i = stop;
      }
      continue;
    }
    const next = code.indexOf("<", i + 1);
    const stop = next === -1 ? n : next;
    out += esc(code.slice(i, stop).replace(/&(?=[#\w]+;)/g, "&")).replace(/&amp;([#\w]+;)/g, '<span class="t-meta">&amp;$1</span>');
    i = stop;
  }
  return out;
}

export function highlight(code, lang) {
  const l = normalizeLang(lang);
  try {
    if (l === "html") return highlightHtml(code);
    if (l === "css") return highlightCss(code);
    if (l === "diff") {
      return code.split("\n").map((line) => {
        const c = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : line.startsWith("@@") ? "meta" : null;
        return c ? span(c, line) : esc(line);
      }).join("\n");
    }
    if (l === "md" || l === "markdown" || l === "text" || l === "txt" || l === "plaintext") return esc(code);
    return scan(code, PROFILES[l] || PROFILES.plain);
  } catch {
    return esc(code);
  }
}

/* ───────────────────────────── Markdown ───────────────────────────── */

const EXT = {
  js: "js", javascript: "js", ts: "ts", typescript: "ts", jsx: "jsx", tsx: "tsx", python: "py", py: "py", html: "html", htm: "html",
  css: "css", scss: "scss", json: "json", bash: "sh", sh: "sh", shell: "sh", zsh: "sh", sql: "sql", go: "go", rust: "rs", rs: "rs",
  java: "java", c: "c", cpp: "cpp", "c++": "cpp", cs: "cs", csharp: "cs", php: "php", ruby: "rb", rb: "rb", yaml: "yml", yml: "yml",
  toml: "toml", xml: "xml", svg: "svg", md: "md", markdown: "md", swift: "swift", kotlin: "kt", kt: "kt", dart: "dart", vue: "vue",
};
export const extensionFor = (lang) => EXT[String(lang || "").toLowerCase()] || "txt";
export const RUNNABLE = new Set(["html", "htm", "svg", "js", "javascript", "css"]);

function inline(text) {
  const stash = [];
  const keep = (html) => `\u0000${stash.push(html) - 1}\u0000`;
  let s = text;
  // code spans
  s = s.replace(/(`+)([\s\S]*?[^`])\1(?!`)/g, (_, __, c) => keep(`<code>${esc(c)}</code>`));
  // links [text](url)
  s = s.replace(/\[([^\]\n]+)\]\(\s*((?:https?:\/\/|mailto:)[^\s)]+)\s*\)/g, (_, t, u) => keep(`<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${inlineBasic(esc(t))}</a>`));
  // bare urls
  s = s.replace(/\bhttps?:\/\/[^\s<>()"']+[^\s<>()"'.,;:!?]/g, (u) => keep(`<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(u)}</a>`));
  s = inlineBasic(esc(s));
  return s.replace(/\u0000(\d+)\u0000/g, (_, k) => stash[+k]);
}

function inlineBasic(h) {
  return h
    .replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, "<strong><em>$1</em></strong>")
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, "$1<strong>$2</strong>")
    .replace(/(^|[^*\w])\*(?=[^\s*])([^*\n]*?[^\s*])\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_(?=[^\s_])([^_\n]*?[^\s_])_(?!\w)/g, "$1<em>$2</em>")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");
}

const RE = {
  fence: /^(\s{0,3})(`{3,}|~{3,})\s*([^\s`]*)\s*(.*)$/,
  heading: /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/,
  hr: /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/,
  quote: /^\s{0,3}>\s?(.*)$/,
  list: /^(\s*)([-*+•]|\d{1,3}[.)])\s+(.*)$/,
  tableSep: /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/,
  fileLabel: /^\s*(?:\*\*|`)([\w@./\\-]+\.[\w]+)(?:\*\*|`)\s*:?\s*$/,
};

function splitRow(line) {
  let l = line.trim();
  if (l.startsWith("|")) l = l.slice(1);
  if (l.endsWith("|") && !l.endsWith("\\|")) l = l.slice(0, -1);
  return l.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

function parseList(lines, start) {
  const first = RE.list.exec(lines[start]);
  const baseIndent = first[1].replace(/\t/g, "    ").length;
  const ordered = /\d/.test(first[2]);
  const startNum = ordered ? parseInt(first[2], 10) : 1;
  const items = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    const m = RE.list.exec(line);
    const indent = (line.match(/^\s*/)[0] || "").replace(/\t/g, "    ").length;
    if (m && indent === baseIndent) {
      items.push({ text: [m[3]], children: [] });
      i++;
      continue;
    }
    if (!items.length) break;
    if (m && indent > baseIndent) {
      const [html, next] = parseList(lines, i);
      items[items.length - 1].children.push(html);
      i = next;
      continue;
    }
    if (line.trim() === "") {
      // A blank line ends the list unless the next line continues it.
      const nxt = lines[i + 1];
      const nm = nxt !== undefined && RE.list.exec(nxt);
      const nIndent = nxt ? (nxt.match(/^\s*/)[0] || "").replace(/\t/g, "    ").length : 0;
      if (nm && nIndent >= baseIndent) { i++; continue; }
      if (nxt && nIndent > baseIndent && nxt.trim()) { i++; continue; }
      break;
    }
    if (indent > baseIndent) { items[items.length - 1].text.push(line.trim()); i++; continue; }
    break;
  }
  const tag = ordered ? "ol" : "ul";
  const startAttr = ordered && startNum !== 1 ? ` start="${startNum}"` : "";
  const body = items.map((it) => {
    let t = it.text.join("\n");
    let check = "";
    const cm = /^\[([ xX])\]\s+/.exec(t);
    if (cm) { check = `<span class="check ${cm[1] === " " ? "" : "on"}"></span>`; t = t.slice(cm[0].length); }
    return `<li${check ? ' class="task"' : ""}>${check}${inline(t).replace(/\n/g, "<br>")}${it.children.join("")}</li>`;
  }).join("");
  return [`<${tag}${startAttr}>${body}</${tag}>`, i];
}

function parseBlocks(lines) {
  let out = "";
  let i = 0;
  let para = [];
  const flush = () => {
    if (para.length) out += `<p>${inline(para.join("\n")).replace(/\n/g, "<br>")}</p>`;
    para = [];
  };
  while (i < lines.length) {
    const line = lines[i];
    let m;
    if (!line.trim()) { flush(); i++; continue; }
    if ((m = RE.heading.exec(line))) { flush(); const lvl = Math.min(6, m[1].length + 1); out += `<h${lvl}>${inline(m[2])}</h${lvl}>`; i++; continue; }
    if (RE.hr.test(line) && !(para.length && /^-+\s*$/.test(line))) { flush(); out += "<hr>"; i++; continue; }
    if (RE.quote.test(line)) {
      flush();
      const q = [];
      while (i < lines.length && (m = RE.quote.exec(lines[i]))) { q.push(m[1]); i++; }
      out += `<blockquote>${parseBlocks(q)}</blockquote>`;
      continue;
    }
    if (line.includes("|") && i + 1 < lines.length && lines[i + 1].includes("|") && RE.tableSep.test(lines[i + 1])) {
      flush();
      const head = splitRow(line);
      const aligns = splitRow(lines[i + 1]).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : ""));
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) { rows.push(splitRow(lines[i])); i++; }
      const al = (k) => (aligns[k] ? ` style="text-align:${aligns[k]}"` : "");
      out += `<div class="table-wrap"><table><thead><tr>${head.map((h, k) => `<th${al(k)}>${inline(h)}</th>`).join("")}</tr></thead><tbody>${rows
        .map((r) => `<tr>${head.map((_, k) => `<td${al(k)}>${inline(r[k] ?? "")}</td>`).join("")}</tr>`)
        .join("")}</tbody></table></div>`;
      continue;
    }
    if (RE.list.test(line)) {
      flush();
      const [html, next] = parseList(lines, i);
      out += html;
      i = next;
      continue;
    }
    para.push(line.trim());
    i++;
  }
  flush();
  return out;
}

/**
 * Render Markdown to HTML.
 * Returns { html, blocks } where blocks[k] = { lang, code, filename, open } for each
 * code block (the HTML has matching data-block="k" attributes).
 */
export function renderMarkdown(src) {
  const lines = String(src || "").replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let html = "";
  let text = [];

  const flushText = () => { if (text.length) html += parseBlocks(text); text = []; };

  for (let i = 0; i < lines.length; i++) {
    const m = RE.fence.exec(lines[i]);
    if (!m) { text.push(lines[i]); continue; }
    const fence = m[2];
    const lang = (m[3] || "").replace(/[{}]/g, "");
    const code = [];
    let j = i + 1;
    let closed = false;
    for (; j < lines.length; j++) {
      const close = new RegExp(`^\\s{0,3}${fence[0] === "`" ? "`" : "~"}{${fence.length},}\\s*$`);
      if (close.test(lines[j])) { closed = true; break; }
      code.push(lines[j].startsWith(m[1]) ? lines[j].slice(m[1].length) : lines[j]);
    }
    // A "**file.ext**" line just before the block becomes its file name.
    let filename = /[\w-]+\.[\w]+/.test(m[4]) ? m[4].trim() : "";
    for (let k = text.length - 1; k >= 0; k--) {
      if (!text[k].trim()) continue;
      const fm = RE.fileLabel.exec(text[k]);
      if (fm && !filename) { filename = fm[1]; text.splice(k, 1); }
      break;
    }
    flushText();
    const k = blocks.push({ lang, code: code.join("\n"), filename, open: !closed }) - 1;
    html += codeBlockHtml(blocks[k], k);
    i = closed ? j : lines.length;
  }
  flushText();
  return { html, blocks };
}

const ICONS = {
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  save: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3v12m0 0-4-4m4 4 4-4M4 17v2a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2"/></svg>',
  run: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>',
  open: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h16M4 12h10M4 17h7"/><path d="m16 15 3 3-3 3"/></svg>',
};

function codeBlockHtml(b, k) {
  const lang = b.lang || "text";
  const lineCount = b.code.split("\n").length;
  const runnable = RUNNABLE.has(lang.toLowerCase());
  return `<figure class="cb${b.open ? " streaming" : ""}" data-block="${k}">
<figcaption class="cb-head">
  <span class="cb-lang">${esc(lang)}</span>${b.filename ? `<span class="cb-file">${esc(b.filename)}</span>` : ""}
  <span class="cb-meta">${lineCount} line${lineCount === 1 ? "" : "s"}</span>
  <span class="cb-actions">
    <button type="button" data-act="workbench" title="Open in Workbench">${ICONS.open}<span>Edit</span></button>
    <button type="button" data-act="copy" title="Copy code">${ICONS.copy}<span>Copy</span></button>
    <button type="button" data-act="download" title="Download file">${ICONS.save}<span>Save</span></button>
    ${runnable ? `<button type="button" data-act="run" class="run" title="Run in Workbench">${ICONS.run}<span>Run</span></button>` : ""}
  </span>
</figcaption>
<pre><code>${highlight(b.code, lang)}${b.open ? '<span class="caret"></span>' : ""}</code></pre>
</figure>`;
}
