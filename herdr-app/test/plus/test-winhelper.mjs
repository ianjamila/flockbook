// The helper on Windows (owner 11-14: "Install it + try a Windows helper"): the mod runs flockbook-modfeed.exe there
// (bin/flockbook-modfeed on macOS and Linux), and every call goes to that path. Run: node test-winhelper.mjs
import { loadMod } from "./loadmod.mjs";
let bad = 0;
const eq = (n, got, want) => { const ok = JSON.stringify(got) === JSON.stringify(want); if (!ok) bad++; console.log(ok ? "PASS" : "FAIL", n, ok ? "" : `→ ${JSON.stringify(got)} want ${JSON.stringify(want)}`); };

const load = async (platform) => {
  const ran = [];
  const herdr = {
    appHome: () => (platform === "windows" ? "C:\\Users\\you\\.config\\herdr-app" : "/Users/you/.config/herdr-app"),
    window: () => (platform ? { platform } : null),
    exec: async (cmd, argv) => { ran.push(cmd); return { code: 0, stdout: '{"type":"header","protocol":1}\n{"type":"end"}\n', stderr: "" }; },
    readTextFile: async () => null, writeTextFile: async () => {},
  };
  return { sc: await loadMod("sidecar.js", { herdr }), ran };
};

const win = await load("windows");
eq("windows: .exe", win.sc.sidecarPath(), "C:\\Users\\you\\.config\\herdr-app/flockbook/bin/flockbook-modfeed.exe");
await win.sc.call("version");
eq("windows: calls run the .exe", win.ran, ["C:\\Users\\you\\.config\\herdr-app/flockbook/bin/flockbook-modfeed.exe"]);
const mac = await load("macos");
eq("macos: no .exe", mac.sc.sidecarPath(), "/Users/you/.config/herdr-app/flockbook/bin/flockbook-modfeed");
const linux = await load("linux");
eq("linux: no .exe", linux.sc.sidecarPath().endsWith("/flockbook-modfeed"), true);
const none = await load(null);
eq("no window info: no .exe", none.sc.sidecarPath().endsWith("/flockbook-modfeed"), true);
process.exit(bad ? 1 : 0);
