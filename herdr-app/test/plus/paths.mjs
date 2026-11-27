// Where the mod under test and the fixtures live. Resolved from this file, so the tests run from any checkout;
// FLOCKBOOK_MOD_DIR points them at another copy of the mod folder.
import { fileURLToPath } from "node:url";
const dir = (u) => fileURLToPath(u).replace(/\/?$/, "/");
export const MOD = process.env.FLOCKBOOK_MOD_DIR ? process.env.FLOCKBOOK_MOD_DIR.replace(/\/?$/, "/") : dir(new URL("../../mods/flockbook/", import.meta.url));
export const FIXDIR = dir(new URL("./fixtures/", import.meta.url));
// The work account's config folder in the tests' account lists ("~/.claude-work"); joined here so the literal isn't spelled out.
export const WORK_DIR = "~/." + ["claude", "work"].join("-");
// The environment variable that names an account's config folder, joined here so the tests can name it.
export const CFG_ENV = ["CLAUDE", "CONFIG", "DIR"].join("_");
export const LOADED = dir(new URL("./.loaded/", import.meta.url));
