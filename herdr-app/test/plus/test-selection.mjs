// Owner 11-12 s14 ("highlighting here still doesn't work"): the kit draws selected text in its `accent`, which Herdr
// fills from the theme's hover grey; selection.js makes it the theme's selection blue. Run: node test-selection.mjs
import { loadMod } from "./loadmod.mjs";
let bad = 0;
const eq = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) bad++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : `→ ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };
const sets = [];
let herdrSel = "#264f78";
const m = await loadMod("selection.js", { "gpui-base": { set_theme: (t) => sets.push(t) }, herdr: { theme: () => ({ selection: herdrSel }), setShared: () => {} } });
const kit = { appearance: "dark", is_dark: true, colors: { accent: "#2e2e2e", accent_foreground: "#ededed", muted: "#262626", selection: "#264f78" }, spacing: { md: 8 }, radius: { md: 6 } };
eq("fix: accent becomes the selection blue, other colours kept", m.accentFix(kit, "#264f78"), { appearance: "dark", tokens: { colors: { ...kit.colors, accent: "#264f78" }, spacing: kit.spacing, radius: kit.radius } });
eq("already blue (any case): nothing to do", m.accentFix({ ...kit, colors: { ...kit.colors, accent: "#264F78" } }, "#264f78"), null);
eq("no kit theme: nothing", m.accentFix(null, "#264f78"), null);
eq("no selection colour: nothing", m.accentFix(kit, null), null);
eq("appearance from is_dark when missing", m.accentFix({ ...kit, appearance: undefined, is_dark: false }, "#add6ff").appearance, "light");
m.keepSelectionAccent({ theme: () => kit });
eq("keep: sets once when grey", sets.length, 1);
m.keepSelectionAccent({ theme: () => ({ ...kit, colors: { ...kit.colors, accent: "#264f78" } }) });
eq("keep: no set when already blue", sets.length, 1);
herdrSel = "#add6ff";
m.keepSelectionAccent({ theme: () => ({ ...kit, appearance: "light", colors: { ...kit.colors, accent: "#264f78" } }) });
eq("keep: follows a switch to the light theme", sets.at(-1)?.tokens.colors.accent, "#add6ff");
m.keepSelectionAccent({ theme: () => { throw new Error("no"); } });
eq("keep: an error is swallowed", sets.length, 2);
process.exit(bad ? 1 : 0);
