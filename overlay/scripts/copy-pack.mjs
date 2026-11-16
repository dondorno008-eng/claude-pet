// Copies every pet pack (packs/<id>/pet.json + its atlas) into the window's files before a build:
// overlay/src/pack/<id>/… and pack/index.json, the list the window picks from (the horse first).
// No pack yet = the window shows its stand-in SVG horse.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const packs = join(root, "packs");
const to = join(root, "overlay", "src", "pack");
rmSync(to, { recursive: true, force: true });
mkdirSync(to, { recursive: true });

const list = [];
for (const dir of readdirSync(packs).sort()) {
  const json = join(packs, dir, "pet.json");
  if (!existsSync(json)) continue;
  const p = JSON.parse(readFileSync(json, "utf8"));
  const sheet = join(packs, dir, p.spritesheetPath);
  if (!existsSync(sheet) || p.id !== dir) {
    console.warn(`pack: skipped ${dir} (no atlas, or id ≠ folder name)`);
    continue;
  }
  mkdirSync(join(to, dir));
  copyFileSync(json, join(to, dir, "pet.json"));
  copyFileSync(sheet, join(to, dir, p.spritesheetPath));
  list.push({ id: p.id, name: p.displayName || p.id });
}
list.sort((a, b) => (b.id === "horse") - (a.id === "horse"));
writeFileSync(join(to, "index.json"), JSON.stringify(list));
console.log(list.length ? `pack: ${list.map((p) => p.id).join(", ")}` : "pack: none yet, stand-in horse");
