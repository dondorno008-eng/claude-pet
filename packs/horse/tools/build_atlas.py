#!/usr/bin/env python3
"""Cut the horse out of the owner's art strips and pack it into one atlas.

    python3 packs/horse/tools/build_atlas.py           # writes packs/horse/spritesheet.webp + pet.json
    python3 packs/horse/tools/build_atlas.py --preview # also preview.png on a checker, for eyes

Input: packs/horse/art/*.jpg — horses in a row on a flat magenta background.
Each strip is drawn at its own scale, so frames are normalised by the area of the
yellow saddle (the same body part in every pose) and stood on one ground line.
Needs Pillow + numpy and cwebp (brew install webp).
"""
import json
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image

PACK = Path(__file__).resolve().parent.parent
ART = PACK / "art"
CELL = 256  # atlas cell, px; the overlay shows it at 0.75
PAD = 6  # free pixels kept around the horse inside a cell

# file, how many horses in the row
STRIPS = [
    ("1-lie-down.jpg", 6),  # stands, lies down, sleeps, gets up
    ("2-idle.jpg", 6),  # looks around
    ("3-gallop.jpg", 5),  # gallop cycle
    ("4-waiting.jpg", 4),  # neighs, looks at you, hangs head, looks back
    ("5-look-down.jpg", 4),  # reads what is typed: looks down, half-shut, blink, curious ear
    ("6-phone.jpg", 5),  # takes out a corded phone; listens, blinks, nods, smiles
]
# strips whose drawing hangs below the hooves (the phone cord runs off the picture):
# the ground is the lowest hoof, and what hangs below it is cut off there
HOOF_GROUND = {"6-phone.jpg"}
# strips drawn with a bigger saddle than the rest: by the saddle alone the horse came out
# ~8% smaller; this evens the rump height (ground → top of the blue rump) with 2-idle
SIZE = {"5-look-down.jpg": 145 / 133, "6-phone.jpg": 145 / 134}


def cut(path):
    """RGBA float image with the magenta key removed and the spill unmixed."""
    a = np.asarray(Image.open(path).convert("RGB")).astype(np.float32)
    border = np.concatenate([a[:4].reshape(-1, 3), a[-4:].reshape(-1, 3), a[:, :4].reshape(-1, 3), a[:, -4:].reshape(-1, 3)])
    key = np.median(border, axis=0)
    m = np.minimum(a[..., 0], a[..., 2]) - a[..., 1]  # how magenta a pixel is
    m_bg = np.minimum(key[0], key[2]) - key[1]
    lo, hi = 70.0, m_bg - 35.0
    alpha = np.clip((hi - m) / (hi - lo), 0, 1)
    # unmix: observed = alpha*fg + (1-alpha)*key
    safe = np.maximum(alpha, 1e-3)[..., None]
    rgb = np.clip((a - (1 - alpha[..., None]) * key) / safe, 0, 255)
    # despill: the horse has no purple, so any "R and B above G" is the key leaking in
    spill = np.clip(np.minimum(rgb[..., 0], rgb[..., 2]) - rgb[..., 1], 0, None)
    rgb[..., 0] -= spill
    rgb[..., 2] -= spill
    # eat one pixel off the edge: JPEG smears the key a pixel into the outline
    from PIL import ImageFilter
    eroded = np.asarray(Image.fromarray((alpha * 255).astype(np.uint8)).filter(ImageFilter.MinFilter(3))).astype(np.float32) / 255
    # …but a line thinner than three pixels would vanish (the phone cord): keep solid red as is
    red = (alpha > 0.6) & (rgb[..., 0] > 140) & (rgb[..., 1] < 90) & (rgb[..., 2] < 90)
    alpha = np.where(red, alpha, eroded) if path.name in HOOF_GROUND else eroded
    rgb[alpha < 0.02] = 0
    alpha[alpha < 0.02] = 0
    return rgb, alpha


def components(mask):
    """4-connected labels of a boolean mask (no scipy needed)."""
    from collections import deque
    lab = np.zeros(mask.shape, np.int32)
    h, w = mask.shape
    n = 0
    for y0, x0 in zip(*np.nonzero(mask)):
        if lab[y0, x0]:
            continue
        n += 1
        lab[y0, x0] = n
        q = deque([(y0, x0)])
        while q:
            y, x = q.popleft()
            for yy, xx in ((y + 1, x), (y - 1, x), (y, x + 1), (y, x - 1)):
                if 0 <= yy < h and 0 <= xx < w and mask[yy, xx] and not lab[yy, xx]:
                    lab[yy, xx] = n
                    q.append((yy, xx))
    return lab, n


def split(alpha, count):
    """One pixel mask per horse, left to right: the `count` biggest blobs, specks go to the nearest."""
    lab, n = components(alpha > 0.02)
    sizes = np.bincount(lab.ravel())[1:]
    big = sorted(np.argsort(sizes)[::-1][:count] + 1, key=lambda i: np.nonzero(lab == i)[1].mean())
    if len(big) != count or sizes[big[-1] - 1] < 2000:
        sys.exit(f"expected {count} horses, found {[int(sizes[i - 1]) for i in big]}")
    owner = {}
    cx = [np.nonzero(lab == i)[1].mean() for i in big]
    for i in range(1, n + 1):
        xs = np.nonzero(lab == i)[1].mean()
        owner[i] = min(range(count), key=lambda k: abs(cx[k] - xs))
    masks = [np.zeros(alpha.shape, bool) for _ in range(count)]
    for i, k in owner.items():
        masks[k] |= lab == i
    return masks


def yellow(rgb, alpha):
    return (alpha > 0.9) & (rgb[..., 0] > 200) & (rgb[..., 1] > 170) & (rgb[..., 2] < 110)


def frames_of(name, count):
    rgb, alpha = cut(ART / name)
    ground = int(np.where(alpha.sum(1) > 3)[0].max())  # lowest hoof of the strip
    if name in HOOF_GROUND:
        hoof = (alpha > 0.9) & (rgb[..., 0] < 110) & (rgb[..., 1] > 120) & (rgb[..., 2] > 120)
        ground = int(np.nonzero(hoof)[0].max())
        # the cord runs on past the hooves to the cell's edge: there the input bar starts,
        # and the cord looks plugged into it (the horse "listens" to the bar)
        alpha[ground + 12 :] = 0
    out = []
    for mask in split(alpha, count):
        xs_ = np.nonzero(mask)[1]
        s, e = xs_.min(), xs_.max() + 1
        al = np.where(mask, alpha, 0)[:, s:e].copy()
        r = rgb[:, s:e].copy()
        y = yellow(r, al)
        ys, xs = np.nonzero(y)
        out.append({"rgb": r, "alpha": al, "ground": ground, "saddle": int(y.sum()), "cx": float(xs.mean())})
    scale = SIZE.get(name, 1.0) / np.sqrt(np.median([f["saddle"] for f in out]))
    for f in out:
        f["unit"] = scale  # px of this strip -> "saddle units"
    return out


def place(f, k, mirror=False):
    """Render one frame into a CELL×CELL RGBA image at global scale k."""
    s = f["unit"] * k
    h, w = f["alpha"].shape
    rgba = np.dstack([f["rgb"], f["alpha"] * 255]).astype(np.uint8)
    img = Image.fromarray(rgba).convert("RGBa")
    img = img.resize((max(1, round(w * s)), max(1, round(h * s))), Image.LANCZOS).convert("RGBA")
    cx, gy = f["cx"] * s, f["ground"] * s
    if mirror:
        img = img.transpose(Image.FLIP_LEFT_RIGHT)
        cx = img.width - cx
    cell = Image.new("RGBA", (CELL, CELL))
    cell.alpha_composite(img, (round(CELL / 2 - cx), round(CELL - PAD - gy)))
    return cell


def fits(f, k):
    s = f["unit"] * k
    ys, xs = np.nonzero(f["alpha"] > 0.02)
    top = CELL - PAD - (f["ground"] - ys.min()) * s
    left = CELL / 2 - (f["cx"] - xs.min()) * s
    right = CELL / 2 + (xs.max() - f["cx"]) * s
    return top >= PAD and left >= PAD and right <= CELL - PAD


def main():
    rows = [frames_of(n, c) for n, c in STRIPS]
    # facing left: the gallop, and the two poses where the horse looks at the input bar
    # (the bar is to its left once the horse hops to the right of the window)
    look, phone = rows[4], rows[5]
    rows[4] = [dict(f, mirror=True) for f in rows[2]]  # gallop to the left
    rows[5] = [dict(f, mirror=True) for f in look]
    rows.append([dict(f, mirror=True) for f in phone])
    allf = [f for r in rows for f in r]
    k = 400.0
    while not all(fits(f, k) for f in allf):
        k -= 1
    cols = max(len(r) for r in rows)
    atlas = Image.new("RGBA", (cols * CELL, len(rows) * CELL))
    for ri, r in enumerate(rows):
        for ci, f in enumerate(r):
            atlas.alpha_composite(place(f, k, f.get("mirror", False)), (ci * CELL, ri * CELL))
    png = PACK / "spritesheet.png"
    atlas.save(png)
    subprocess.run(["cwebp", "-quiet", "-q", "90", "-alpha_q", "100", "-exact", str(png), "-o", str(PACK / "spritesheet.webp")], check=True)
    png.unlink()

    # animations: [row, col, ms] steps; "loop" = step to jump back to after the last one
    L, I, G, W, GL, LD, PH = 0, 1, 2, 3, 4, 5, 6
    pet = {
        "id": "horse",
        "displayName": "Лошадка",
        "spritesheetPath": "spritesheet.webp",
        "cell": CELL,
        "columns": cols,
        "rows": len(rows),
        "animations": {
            "idle": {"steps": [[I, 0, 2600], [I, 1, 700], [I, 0, 1600], [I, 2, 1400], [I, 0, 2000], [I, 3, 900], [I, 4, 1100], [I, 5, 1500]]},
            "working": {"steps": [[I, 2, 1600], [I, 1, 600], [I, 2, 1400], [I, 0, 800]]},
            "waiting": {"steps": [[W, 0, 900], [W, 1, 1300], [W, 3, 1300], [W, 1, 900]]},
            "done": {"steps": [[L, 0, 500], [L, 1, 600], [L, 2, 2600], [L, 3, 3400], [L, 2, 1400]], "loop": 3},
            "failed": {"steps": [[W, 2, 2200], [I, 2, 1600]]},
            "running-right": {"steps": [[G, i, 95] for i in range(5)]},
            "running-left": {"steps": [[GL, i, 95] for i in range(5)]},
            "hello": {"steps": [[W, 0, 1100]], "once": True},
            # input bar open: looks down at the text, blinks now and then, sometimes perks an ear
            "reading": {"steps": [[LD, 0, 2400], [LD, 1, 70], [LD, 2, 130], [LD, 1, 70], [LD, 0, 3200], [LD, 3, 1300], [LD, 0, 1800], [LD, 1, 70], [LD, 2, 130], [LD, 1, 70]]},
            # mic on: takes the receiver out, then listens — blinks, nods "uh-huh", smiles
            "listening": {"steps": [[PH, 0, 350], [PH, 1, 2200], [PH, 2, 140], [PH, 1, 1800], [PH, 3, 600], [PH, 1, 2000], [PH, 4, 1200], [PH, 1, 1400], [PH, 2, 140]], "loop": 1},
            # mic off: the receiver goes away, then back to reading
            "hangup": {"steps": [[PH, 0, 320]], "once": True},
        },
    }
    (PACK / "pet.json").write_text(json.dumps(pet, ensure_ascii=False, indent=2) + "\n")
    size = (PACK / "spritesheet.webp").stat().st_size
    print(f"atlas {atlas.width}x{atlas.height}, scale {k:.0f}, webp {size // 1024} KB")

    if "--preview" in sys.argv:
        chk = Image.new("RGBA", atlas.size, (236, 236, 236, 255))
        px = np.asarray(chk).copy()
        yy, xx = np.mgrid[: atlas.height, : atlas.width]
        px[((yy // 16 + xx // 16) % 2) == 0] = (200, 200, 200, 255)
        dark = Image.fromarray(px)
        dark.alpha_composite(atlas)
        dark.save(PACK / "tools" / "preview.png")


if __name__ == "__main__":
    main()
