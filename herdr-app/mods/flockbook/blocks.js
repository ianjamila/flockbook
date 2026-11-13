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
// to a fresh session, as written, or null. The prompt is a quote (every "> " line of it; blank lines between quoted
// lines kept, one "> " taken off each) or a code fence (its body). A block counts when:
//  (1) a line just above it names it ("Re-entry prompt (`--effort high`):", "**Resume prompt:**", "a prompt for a fresh
//      session:"), or
//  (2) a line just below it speaks of the prompt ("The prompt is ready to paste.", "Paste this into the new session"), or
//  (3) it reads like one: starts with "Continue"/"Resume"/"Pick up"/"Finish" and is at least 200 characters, or
//  (4) `ask` (the owner's message the reply answers) asked for a re-entry / resume / hand-off prompt.
// Owner 11-13 follow-up: a reply that was only a fenced prompt + "The prompt is ready to paste" had no button. The
// last block that counts wins; a later "the re-entry prompt above" names nothing below it and is passed over.
const PROMPT_NAME = /\bre-?entry prompt\b|\bresume prompt\b|\bhand-?off prompt\b|\bprompt for (?:a |the )?(?:fresh|new|next) session\b/i;
const PROMPT_AFTER = /\bprompt\b.*\b(?:paste|ready|copy|fresh|new session|re-?entry|resume)|\bpaste (?:it|this|that)\b.*\b(?:session|terminal|claude)/i;
const PROMPT_START = /^(?:\*\*)?(?:continue|resume|pick up|finish)\s+[a-z]/i;
const QUOTED = /^\s{0,3}>/;
// The quote or fence starting at line `i`: { body (as written), end (the line after it) }, or null.
function blockAt(lines, i) {
  const f = OPEN.exec(lines[i]) ?? TILDE_OPEN.exec(lines[i]);
  if (f) {
    const body = [];
    let j = i + 1;
    for (; j < lines.length && !closes(lines[j], f[1]); j++) body.push(lines[j]);
    return { body: body.join("\n").trim(), end: Math.min(j + 1, lines.length) };
  }
  if (!QUOTED.test(lines[i])) return null;
  const body = [];
  let j = i;
  for (; j < lines.length; j++) {
    if (QUOTED.test(lines[j])) { body.push(lines[j].replace(/^\s{0,3}> ?/, "")); continue; }
    let k = j;
    while (k < lines.length && !lines[k].trim()) k++;
    if (k > j && k < lines.length && QUOTED.test(lines[k])) { for (; j < k; j++) body.push(""); j--; continue; }
    break;
  }
  return { body: body.join("\n").trim(), end: j };
}
const nonBlank = (lines, i, step) => { while (i >= 0 && i < lines.length && !lines[i].trim()) i += step; return i >= 0 && i < lines.length ? lines[i] : null; };
export function reentryPrompt(text, ask = null) {
  const lines = String(text ?? "").replace(/\r/g, "").split("\n");
  const asked = PROMPT_NAME.test(String(ask ?? "")) || /\b(?:re-?entry|resume|hand-?off)\b.*\bprompt\b|\bprompt\b.*\b(?:re-?entry|fresh session|new session)\b/i.test(String(ask ?? ""));
  let found = null;
  for (let i = 0; i < lines.length; i++) {
    const b = blockAt(lines, i);
    if (!b) continue;
    const above = nonBlank(lines, i - 1, -1), below = nonBlank(lines, b.end, 1);
    const named = above != null && PROMPT_NAME.test(above) && !QUOTED.test(above);
    const after = below != null && !QUOTED.test(below) && PROMPT_AFTER.test(below);
    const looks = PROMPT_START.test(b.body) && b.body.length >= 200;
    if (b.body && (named || after || looks || asked)) found = b.body;
    i = Math.max(i, b.end - 1);
  }
  return found;
}

