// Selected text in the kit's text boxes (the reply box, the question card's answer box, Settings' inputs) is drawn
// in the kit's `accent` colour, which Herdr fills from the theme's `hover` grey (#2e2e2e on the flockbook dark
// theme: barely lighter than the box, owner 11-12 "highlighting here still doesn't work"). The theme's own
// `selection` (#264f78 dark, #add6ff light) reaches the kit unused. Owner 11-12 s14: blue like VS Code — so the
// kit's accent becomes the theme's selection colour. Only the kit's palette changes (its menus' hover tint turns
// blue too); the mod's own rows keep using theme().hover.
import { set_theme } from "gpui-base";
import { theme, setShared } from "herdr";

// <selection-pure>
// The kit theme to set so its accent is the selection colour, or null when it already is (or nothing to go on).
export function accentFix(kit, selection) {
  if (!kit?.colors || !selection) return null;
  if (String(kit.colors.accent).toLowerCase() === String(selection).toLowerCase()) return null;
  return {
    appearance: kit.appearance ?? (kit.is_dark ? "dark" : "light"),
    tokens: { colors: { ...kit.colors, accent: selection }, spacing: kit.spacing, radius: kit.radius },
  };
}
// </selection-pure>

// Called from a timer: Herdr sets the kit palette again on a theme or appearance change, so this keeps checking.
// The last change or failure is kept in shared state (KEY_STATE) to check it from outside.
const KEY_STATE = "flockbook.selection.state";
let checked = false;
export function keepSelectionAccent(cx) {
  try {
    const fix = accentFix(cx?.theme?.(), theme()?.selection);
    if (!fix) { if (!checked) { checked = true; setShared(KEY_STATE, { at: Date.now(), accent: String(cx?.theme?.()?.colors?.accent ?? "?"), already: true }); } return; }
    set_theme(fix);
    setShared(KEY_STATE, { at: Date.now(), accent: String(cx?.theme?.()?.colors?.accent ?? "?") });
  } catch (e) { setShared(KEY_STATE, { at: Date.now(), error: String(e?.message ?? e) }); }
}
