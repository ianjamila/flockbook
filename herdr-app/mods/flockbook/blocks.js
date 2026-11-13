// Markdown split into the blocks the chat draws on its own: code fences and tables. One parser for both
// sides: mdblocks.js draws these blocks and estimate.js guesses their heights, so the two always see the
// same code boxes and tables. Pure (no gpui): the node tests import it as it is.

// A fence, as in CommonMark: ``` or ~~~ (3 or more), then an info string. The language is the info's first
// word ("```js title=a.js" is js). A backtick fence's info has no backtick.
const OPEN = /^\s*(`{3,}|~{3,})\s*([^`\s]*)[^`]*$/;
const TILDE_OPEN = /^\s*(~{3,})\s*(\S*).*$/;
// A closing fence: the same character, at least as many, nothing after it but spaces.
const closes = (line, fence) => {
  const m = /^\s*(`{3,}|~{3,})\s*$/.exec(line);
  return !!m && m[1][0] === fence[0] && m[1].length >= fence.length;
};

// A table's separator row: "| --- | :--: |".
export const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
// A table starts at a pipe line with a separator row under it.
export const tableStarts = (lines, i) => /^\s*\|/.test(lines[i]) && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1]);

const alignOf = (cell) => {
  const c = cell.trim();
  return c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : "left";
};

// "| a | b |" → ["a", "b"]. An escaped pipe and pipes inside `code` stay in the cell.
export function tableCells(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|") && !s.endsWith("\\|")) s = s.slice(0, -1);
  const out = []; let cur = "", code = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === "|") { cur += "|"; i++; continue; }
    if (c === "`") code = !code;
    if (c === "|" && !code) { out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  out.push(cur.trim());
  return out;
}

// [{k:"md", text}, {k:"code", lang, text, lines}, {k:"table", head, align, rows}] in order. A code block's
// `lines` are its source lines (none for an empty box; `text` cannot tell that from one empty line). An
// unclosed fence runs to the end. A markdown block of blank lines only is left out.
export function splitBlocks(text) {
  const lines = String(text ?? "").split("\n");
  const out = []; let md = [];
  const flush = () => { if (md.length && md.join("\n").trim()) out.push({ k: "md", text: md.join("\n") }); md = []; };
  for (let i = 0; i < lines.length; i++) {
    const f = OPEN.exec(lines[i]) ?? TILDE_OPEN.exec(lines[i]);
    if (f) {
      flush();
      const body = []; i++;
      while (i < lines.length && !closes(lines[i], f[1])) body.push(lines[i++]);
      out.push({ k: "code", lang: f[2] || "", text: body.join("\n"), lines: body });
      continue;
    }
    if (tableStarts(lines, i)) {
      flush();
      const head = tableCells(lines[i]);
      const align = tableCells(lines[i + 1]).map(alignOf);
      const rows = []; i += 2;
      while (i < lines.length && /^\s*\|/.test(lines[i])) rows.push(tableCells(lines[i++]));
      i--;
      out.push({ k: "table", head, align, rows });
      continue;
    }
    md.push(lines[i]);
  }
  flush();
  return out;
}

// Owner 11-13 ("when an re entry prompt like this appears, can there be a copy all button"): the prompt a reply hands
// to a fresh session, as written, or null. A line that names it ("Re-entry prompt (`--effort high`):", "**Resume
// prompt:**", "a prompt for a fresh session:") followed, after blank lines, by a quote (every "> " line from there;
// blank lines between quoted lines kept, one "> " taken off each) or a code fence (its body). The last such line
// with a quote or fence under it wins; one without (a later "the re-entry prompt above") is passed over.
const PROMPT_NAME = /\bre-?entry prompt\b|\bresume prompt\b|\bhand-?off prompt\b|\bprompt for (?:a |the )?(?:fresh|new|next) session\b/i;
const QUOTED = /^\s{0,3}>/;
export function reentryPrompt(text) {
  const lines = String(text ?? "").replace(/\r/g, "").split("\n");
  for (let h = lines.length - 1; h >= 0; h--) {
    if (!PROMPT_NAME.test(lines[h]) || QUOTED.test(lines[h])) continue;
    let i = h + 1;
    while (i < lines.length && !lines[i].trim()) i++;
    if (i >= lines.length) continue;
    const f = OPEN.exec(lines[i]) ?? TILDE_OPEN.exec(lines[i]);
    let body = null;
    if (f) {
      body = [];
      for (i++; i < lines.length && !closes(lines[i], f[1]); i++) body.push(lines[i]);
    } else if (QUOTED.test(lines[i])) {
      body = [];
      for (; i < lines.length; i++) {
        if (QUOTED.test(lines[i])) { body.push(lines[i].replace(/^\s{0,3}> ?/, "")); continue; }
        let j = i;
        while (j < lines.length && !lines[j].trim()) j++;
        if (j > i && j < lines.length && QUOTED.test(lines[j])) { for (; i < j; i++) body.push(""); i--; continue; }
        break;
      }
    }
    const out = body?.join("\n").trim();
    if (out) return out;
  }
  return null;
}
