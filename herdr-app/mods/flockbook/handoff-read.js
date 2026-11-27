// A tab's re-entry prompt, read without opening the tab (owner 11-27: shared by the Overview's hand-off cards and the
// Finished screen). One read of its chat through the helper (the chat's own feed call); the prompt is found the way
// the chat's Copy all finds it (blocks.js replyHandoff), with the hand-off file it names (s27).
import * as sidecar from "./sidecar.js";
import { emptyFeed, applyFeed } from "./feedstate.js";
import { replyHandoff } from "./blocks.js";
import { readFullPrompt } from "./where.js";

// { prompt, file, problem }: prompt null when the newest reply gives none; file null when it names no
// ~/claude-notes/handoffs/… file; problem: why the chat could not be read (prompt and file null then).
export async function readHandoff(address) {
  try {
    const f = emptyFeed(address);
    applyFeed(f, await sidecar.feed(address));
    if (f.error) return { prompt: null, file: null, problem: f.error.message || "the helper could not read its chat" };
    const h = replyHandoff(f.rows);
    return { prompt: h?.prompt ?? null, file: h?.file ?? null, problem: null };
  } catch (e) {
    return { prompt: null, file: null, problem: String(e?.message ?? e) };
  }
}

// The hand-off file's text, read on the tab's own machine: { text, problem } (where.js readFullPrompt).
export const readFull = (address, file) => readFullPrompt(address, file);
