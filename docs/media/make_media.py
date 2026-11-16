"""Builds the README pictures from the pet packs: animated WebP with real transparency.

    python3 docs/media/make_media.py

Each pet.json step is [row, col, ms] in its atlas; the pictures replay those steps,
so they always match what the app shows.
"""
import json
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[2]
PACKS = ROOT / "packs"
OUT = Path(__file__).resolve().parent
ORDER = ["horse", "druzok-basic", "druzok-ny", "gusik-basic", "gusik-ny"]


def load(pid):
    p = json.loads((PACKS / pid / "pet.json").read_text())
    sheet = Image.open(PACKS / pid / p["spritesheetPath"]).convert("RGBA")
    return p, sheet


def cell(p, sheet, r, c):
    n = p["cell"]
    return sheet.crop((c * n, r * n, c * n + n, r * n + n))


def frames(p, sheet, anim, loops=1, max_ms=None, speed=1.0):
    out = []
    for _ in range(loops):
        for r, c, ms in p["animations"][anim]["steps"]:
            ms = int(ms * speed)
            if max_ms:
                ms = min(ms, max_ms)
            out.append((cell(p, sheet, r, c), max(ms, 40)))
    return out


def save(path, seq, size):
    imgs = [f.resize((size, size), Image.LANCZOS) for f, _ in seq]
    imgs[0].save(path, save_all=True, append_images=imgs[1:], duration=[d for _, d in seq],
                 loop=0, lossless=False, quality=88, method=6)
    print(path.relative_to(ROOT), f"{path.stat().st_size // 1024} KB")


def showreel(p, sheet):
    """a short loop per pet: runs in, looks at the input, listens on the phone, rests"""
    seq = frames(p, sheet, "running-right", loops=8)
    seq += frames(p, sheet, "reading", max_ms=900)
    seq += frames(p, sheet, "listening", max_ms=900)
    seq += frames(p, sheet, "idle", max_ms=900)
    return seq


def cast():
    """all pets side by side, running in place — the hero picture"""
    size, gap = 200, 8
    pets = [load(pid) for pid in ORDER]
    tick, total = 40, 2400
    strip = []
    for t in range(0, total, tick):
        canvas = Image.new("RGBA", (len(pets) * size + (len(pets) - 1) * gap, size), (0, 0, 0, 0))
        for i, (p, sheet) in enumerate(pets):
            steps = p["animations"]["running-right"]["steps"]
            loop = sum(s[2] for s in steps)
            at, acc = t % loop, 0
            for r, c, ms in steps:
                acc += ms
                if at < acc:
                    break
            canvas.alpha_composite(cell(p, sheet, r, c).resize((size, size), Image.LANCZOS), (i * (size + gap), 0))
        strip.append(canvas)
    strip[0].save(OUT / "cast.webp", save_all=True, append_images=strip[1:], duration=tick,
                  loop=0, quality=85, method=6)
    print("docs/media/cast.webp", f"{(OUT / 'cast.webp').stat().st_size // 1024} KB")


def main():
    cast()
    for pid in ORDER:
        p, sheet = load(pid)
        save(OUT / f"pet-{pid}.webp", showreel(p, sheet), 180)
    p, sheet = load("horse")
    states = {
        "working": frames(p, sheet, "working", speed=0.7),
        "waiting": frames(p, sheet, "waiting", speed=0.7),
        "done": frames(p, sheet, "done", speed=0.6),
        "failed": frames(p, sheet, "failed", speed=0.7),
        "listening": frames(p, sheet, "listening", speed=0.6),
    }
    for name, seq in states.items():
        save(OUT / f"state-{name}.webp", seq, 140)


if __name__ == "__main__":
    main()
