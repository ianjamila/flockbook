// Flockbook for herdr-app: one mod, four views. The layout picks the view with props.view
// ("top", "side", "chat", "needs", "overview", "tabs"; "settings" is the settings dialog). One folder, because a mod cannot import another mod's files.
import { View, div } from "gpui-kit";
import { theme, props } from "herdr";
import { TopView } from "./top.js";
import { SideView } from "./side.js";
import { ChatView } from "./chat.js";
import { NeedsView } from "./needs.js";
import { TermBar } from "./termbar.js";
import { TermGrip, TermResize } from "./termresize.js";
import { OverviewView } from "./overview.js";
import { MenuView } from "./menu.js";
import { SettingsView } from "./settings.js";
import { TabsView } from "./tabs.js";
import { SummaryView } from "./summary.js";
import { keepSelectionAccent } from "./selection.js";

const VIEWS = { top: TopView, side: SideView, chat: ChatView, needs: NeedsView, termbar: TermBar, termgrip: TermGrip, termresize: TermResize, overview: OverviewView, menu: MenuView, settings: SettingsView, tabs: TabsView, summary: SummaryView };

export default class Flockbook extends View {
  // The block's props come from props(); init's first argument is not them.
  init(_props, cx) {
    const name = props()?.view;
    const Impl = VIEWS[name];
    this.name = name;
    this.view = Impl ? new Impl(cx) : null;
    // Selected text in the kit's boxes drawn in the theme's selection blue (selection.js; owner 11-12 s14). The kit
    // palette is the app's, so the top bar's copy keeps it; Herdr resets it on a theme change, hence the timer.
    if (name === "top") {
      cx?.spawn?.(async (cx) => keepSelectionAccent(cx));
      cx?.timer?.every(3000, (cx) => keepSelectionAccent(cx));
    }
  }

  async close(cx) { await this.view?.close?.(cx); }

  render(cx) {
    if (this.view) return this.view.render(cx);
    const t = theme();
    return div().size_full().p(12).text_color(t.muted)
      .child(`Flockbook: unknown view "${this.name}". Use one of ${Object.keys(VIEWS).join(", ")}.`);
  }
}
