// Copies the horse pack (packs/horse) into the window's files before a build.
// No pack yet = the window shows its stand-in SVG horse.
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const from = join(root, "packs", "horse");
const to = join(root, "overlay", "src", "pack");
mkdirSync(to, { recursive: true });
let n = 0;
for (const f of ["spritesheet.webp", "pet.json"]) {
  if (!existsSync(join(from, f))) continue;
  copyFileSync(join(from, f), join(to, f));
  n += 1;
}
console.log(n ? `pack: copied ${n} file(s) from packs/horse` : "pack: none yet, stand-in horse");
