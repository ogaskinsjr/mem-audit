// Splits a markdown memory file into auditable entries: headings, list items
// (with their continuation lines), paragraphs, table rows and code fences.

export function parseMarkdown(text, file) {
  const lines = text.split(/\r?\n/);
  const entries = [];
  const headings = [];
  let cur = null;
  let table = null;
  let fence = null;

  const section = () => headings.map((h) => h.text);
  const flush = () => {
    if (!cur) return;
    const body = cur.lines.join("\n").trim();
    delete cur.lines;
    if (body) entries.push({ ...cur, text: body });
    cur = null;
  };
  const start = (kind, i, line) => {
    flush();
    cur = { file, line: i + 1, kind, section: section(), lines: [line] };
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (fence) {
      cur.lines.push(line);
      if (line.trim().startsWith(fence)) { fence = null; flush(); }
      continue;
    }
    const fm = line.match(/^\s*(```+|~~~+)/);
    if (fm) { table = null; start("code", i, line); fence = fm[1]; continue; }

    if (!line.trim()) { flush(); table = null; continue; }

    const h = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      flush();
      table = null;
      const level = h[1].length;
      while (headings.length && headings[headings.length - 1].level >= level) headings.pop();
      entries.push({ file, line: i + 1, kind: "heading", level, section: section(), text: h[2] });
      headings.push({ level, text: h[2] });
      continue;
    }

    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
      if (!table) { flush(); table = { headers: cells, sepSeen: false }; continue; }
      if (!table.sepSeen && cells.every((c) => /^:?-{2,}:?$/.test(c))) { table.sepSeen = true; continue; }
      flush();
      entries.push({ file, line: i + 1, kind: "table-row", section: section(), text: line.trim(), table: { headers: table.headers, cells } });
      continue;
    }
    table = null;

    if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) { start("list-item", i, line); continue; }
    if (cur && (cur.kind === "list-item" || cur.kind === "paragraph")) { cur.lines.push(line); continue; }
    start("paragraph", i, line);
  }
  flush();
  return entries;
}
