# =====================================================================
#  Décors des biomes du donjon (assets/biomes/*.glb) et aperçus (tools/blender/previews/biome-*.png).
#
#    "C:\Program Files\Blender Foundation\Blender 5.3\blender.exe" -b --factory-startup -P tools/blender/biomes.py [-- mine ruins forge]
#
#  Repère et taille : 1 unité = 1 tuile Kenney (le jeu multiplie tout par S = 1,5) ; sol à y = 0.
#  Murs : 1 × 1,65 × 1 (même hauteur finale que les murs du donjon : 2,475), murets 0,55 de haut,
#  portails : trou de 0,72 × 1,49 au milieu (la herse du donjon s'y loge).
#  Obstacles (mêmes rayons de collision que ceux du donjon, voir OBS_R dans dungeon.js) :
#    column -> pilier (rayon ~0,27, haut ~1,2), barrel -> objet bas (~0,3, ~0,5), rocks -> amas (~0,43, ~0,5).
#  Les parties lumineuses sont un enfant nommé « glow-… » : le jeu leur donne une matière qui brille.
#  Biomes : mine (Mines de cristal), ruins (Ruines envahies), forge (Forge volcanique).
# =====================================================================
import math
import os
import random
import sys
import bpy

sys.path.insert(0, os.path.dirname(__file__))
import kenney as K

OUT = os.path.join(K.ROOT, 'assets', 'biomes')
PREV = os.path.join(K.ROOT, 'tools', 'blender', 'previews')
PI = math.pi
WALL_H, LOW_H = 1.65, 0.55
HOLE_W, HOLE_H = 0.36, 1.49        # demi-largeur et hauteur du trou des portails


class Asset:
    """Un modèle (pièces mates) + éventuellement des pièces lumineuses (enfant glow-<nom>)."""

    def __init__(self, name, seed=None):
        self.name = name
        self.m = K.Model(name)
        self.g = K.Model('glow-' + name)
        self.rng = random.Random(seed if seed is not None else name)

    def r(self, a, b):
        return self.rng.uniform(a, b)

    def pick(self, seq):
        return self.rng.choice(seq)

    def build(self):
        ob = self.m.build()
        if self.g.parts:
            K.parent_keep(self.g.build(), ob, 'glow-' + self.name)
        return ob


def lump(m, w, h, d, color, pos, rot=(0, 0, 0)):
    """Rocher à facettes : boîte chanfreinée (biseau à un segment), comme les rochers Kenney."""
    return m.box(w, h, d, color, pos=pos, rot=rot, bevel=min(w, h, d) * 0.28, seg=1)


# ---------------------------------------------------------------------
#  Mines de cristal
# ---------------------------------------------------------------------
ROCK = ('grey', 'iron', 'slate')


def rock_faces(a, h, y0=0.0, rows=3, cols=2):
    """Couvre les deux grandes faces (±z) et le dessus d'un bloc de rochers irréguliers."""
    m = a.m
    for s in (-1, 1):
        for i in range(rows):
            for j in range(cols):
                w = 1.0 / cols + a.r(0.02, 0.12)
                hh = h / rows + a.r(0.02, 0.1)
                x = -0.5 + (j + 0.5) / cols + a.r(-0.05, 0.05)
                y = y0 + (i + 0.5) * h / rows + a.r(-0.04, 0.04)
                x = max(-0.5 + w / 2 - 0.03, min(0.5 - w / 2 + 0.03, x))
                y = min(y, y0 + h - hh / 2)
                lump(m, w, hh, 0.22, a.pick(ROCK), (x, y, s * (0.4 + a.r(0, 0.05))),
                     rot=(a.r(-0.08, 0.08), a.r(-0.1, 0.1), a.r(-0.12, 0.12)))
    for j in range(cols):                                              # dessus
        w = 1.0 / cols + a.r(0, 0.06)
        lump(m, w, 0.12, 0.9, a.pick(ROCK), (-0.5 + (j + 0.5) / cols, y0 + h - 0.06, a.r(-0.04, 0.04)),
             rot=(0, a.r(-0.1, 0.1), a.r(-0.06, 0.06)))


def mine_wall(name, ore=False):
    a = Asset(name)
    a.m.box(0.94, WALL_H - 0.02, 0.86, 'dark', pos=(0, (WALL_H - 0.02) / 2, 0), bevel=0.02)
    rock_faces(a, WALL_H, rows=3, cols=2)
    if ore:                                                            # filon : éclats de cristal
        for s in (-1, 1):
            for k in range(3):
                x, y = a.r(-0.32, 0.32), a.r(0.35, 1.25)
                a.g.cyl(0.055, 0.24, a.pick(('blue', 'purple')), pos=(x, y, s * 0.55), rot=(s * 1.1, 0, a.r(-0.6, 0.6)), seg=6, bevel=0)
    return a.build()


def mine_low(name):
    a = Asset(name)
    a.m.box(0.94, LOW_H - 0.06, 0.86, 'dark', pos=(0, (LOW_H - 0.06) / 2, 0), bevel=0.02)
    rock_faces(a, LOW_H - 0.02, rows=1, cols=3)
    return a.build()


def mine_floor(name, stones=False):
    a = Asset(name)
    a.m.box(1.0, 0.06, 1.0, 'brown', pos=(0, -0.03, 0), bevel=0.012)
    # terre tassée : quelques plaques plus sombres et cailloux
    for k in range(2):
        a.m.box(a.r(0.2, 0.35), 0.01, a.r(0.15, 0.3), 'woodDark', pos=(a.r(-0.3, 0.3), 0.0, a.r(-0.3, 0.3)), rot=(0, a.r(0, PI), 0), bevel=0.003)
    for k in range(5 if stones else 2):
        s = a.r(0.04, 0.09 if stones else 0.06)
        lump(a.m, s, s * 0.6, s * a.r(0.8, 1.2), a.pick(ROCK), (a.r(-0.42, 0.42), s * 0.2, a.r(-0.42, 0.42)), rot=(0, a.r(0, PI), 0))
    return a.build()


def portal_frame(a, side):
    """Deux montants + linteau autour du trou (side(m, x0, x1, y0, y1) remplit un pan)."""
    side(-0.5, -HOLE_W, 0, WALL_H)
    side(HOLE_W, 0.5, 0, WALL_H)
    side(-HOLE_W, HOLE_W, HOLE_H, WALL_H)


def mine_portal(name):
    a = Asset(name)

    def side(x0, x1, y0, y1):
        a.m.box(x1 - x0, y1 - y0, 0.86, 'iron', pos=((x0 + x1) / 2, (y0 + y1) / 2, 0), bevel=0.015)
        n = max(1, round((y1 - y0) / 0.5))
        for s in (-1, 1):
            for i in range(n):
                hh = (y1 - y0) / n
                lump(a.m, x1 - x0 + 0.04, hh + 0.04, 0.2, a.pick(ROCK), ((x0 + x1) / 2, y0 + (i + 0.5) * hh, s * 0.42),
                     rot=(0, 0, a.r(-0.08, 0.08)))
    portal_frame(a, side)
    for x in (-HOLE_W - 0.02, HOLE_W + 0.02):                           # boisage de la galerie
        a.m.box(0.1, HOLE_H + 0.04, 1.04, 'wood', pos=(x, (HOLE_H + 0.04) / 2, 0), bevel=0.012)
    a.m.box(2 * HOLE_W + 0.3, 0.12, 1.06, 'wood', pos=(0, HOLE_H + 0.04, 0), bevel=0.014)
    for s in (-1, 1):                                                  # lanternes de part et d'autre
        a.g.box(0.08, 0.1, 0.08, 'yellow', pos=(s * (HOLE_W + 0.08), 1.2, 0.57), bevel=0.01)
        a.m.box(0.1, 0.025, 0.1, 'dark', pos=(s * (HOLE_W + 0.08), 1.265, 0.57), bevel=0.005)
        a.m.box(0.1, 0.02, 0.1, 'dark', pos=(s * (HOLE_W + 0.08), 1.14, 0.57), bevel=0.005)
    return a.build()


def minecart(name):
    """Wagonnet de minerai sur un bout de rails (remplace le tonneau)."""
    a = Asset(name)
    m = a.m
    for z in (-0.15, 0.15):                                            # rails
        m.box(0.98, 0.035, 0.035, 'steel', pos=(0, 0.035, z), bevel=0.006)
    for x in (-0.36, -0.12, 0.12, 0.36):                               # traverses
        m.box(0.07, 0.03, 0.44, 'wood', pos=(x, 0.015, 0), bevel=0.006)
    m.box(0.46, 0.26, 0.32, 'iron', pos=(0, 0.26, 0), bevel=0.02, taper=(1.12, 1.15))
    for s in (-1, 1):                                                  # rebords et renforts
        m.box(0.54, 0.035, 0.035, 'steelDark', pos=(0, 0.39, s * 0.185), bevel=0.006)
        m.box(0.035, 0.035, 0.4, 'steelDark', pos=(s * 0.265, 0.39, 0), bevel=0.006)
        m.box(0.03, 0.24, 0.34, 'steelDark', pos=(s * 0.12, 0.26, 0), bevel=0.005)
    for x in (-0.15, 0.15):                                            # roues
        for z in (-0.17, 0.17):
            m.cyl(0.07, 0.04, 'dark', pos=(x, 0.1, z), rot=(PI / 2, 0, 0), seg=8, bevel=0.008)
    for k in range(7):                                                 # minerai
        r = a.r(0.06, 0.09)
        lump(m, r * 2, r * 1.4, r * 2, a.pick(('dark', 'iron', 'gold')), (a.r(-0.16, 0.16), 0.41 + a.r(0, 0.05), a.r(-0.08, 0.08)),
             rot=(a.r(0, 1), a.r(0, PI), a.r(0, 1)))
    for k in range(2):
        a.g.cyl(0.035, 0.18, 'sky', pos=(a.r(-0.12, 0.12), 0.5, a.r(-0.05, 0.05)), rot=(a.r(-0.5, 0.5), 0, a.r(-0.5, 0.5)), seg=6, bevel=0)
    return a.build()


def crystal(a, x, z, r, h, tilt, yaw, color, y=0.0):
    """Prisme hexagonal à pointe, penché de tilt vers la direction yaw (pièce lumineuse)."""
    rx, rz = tilt * math.cos(yaw), -tilt * math.sin(yaw)
    # axe du prisme après la rotation (ordre XYZ de three.js : Rz d'abord, puis Rx)
    d = (-math.sin(rz), math.cos(rz) * math.cos(rx), math.cos(rz) * math.sin(rx))
    at = lambda t: (x + d[0] * t, y + d[1] * t, z + d[2] * t)
    a.g.cyl(r, h, color, pos=at(h / 2), rot=(rx, 0, rz), seg=6, bevel=0)
    a.g.cone(r, r * 1.6, color, pos=at(h + r * 0.8), rot=(rx, 0, rz), seg=6)


def crystals(name):
    """Amas de cristaux luisants sur un socle de roche (remplace les rochers)."""
    a = Asset(name)
    for k in range(4):
        ang = k * PI / 2 + a.r(-0.4, 0.4)
        lump(a.m, a.r(0.25, 0.34), a.r(0.14, 0.22), a.r(0.25, 0.34), a.pick(ROCK),
             (math.sin(ang) * 0.18, 0.08, math.cos(ang) * 0.18), rot=(0, a.r(0, PI), 0))
    lump(a.m, 0.36, 0.2, 0.36, 'iron', (0, 0.1, 0), rot=(0, 0.4, 0))
    crystal(a, 0, 0, 0.09, 0.42, 0.05, 0, 'blue', y=0.12)
    for k in range(5):
        yaw = k * 2 * PI / 5 + a.r(-0.3, 0.3)
        d = a.r(0.12, 0.24)
        crystal(a, math.sin(yaw) * d, math.cos(yaw) * d, a.r(0.05, 0.075), a.r(0.18, 0.32), a.r(0.35, 0.6), yaw,
                a.pick(('blue', 'purple', 'sky')), y=0.08)
    return a.build()


def mine_pillar(name):
    """Pilier de roche cerclé de bois (remplace la colonne)."""
    a = Asset(name)
    y = 0
    for i, (w, h) in enumerate([(0.5, 0.42), (0.42, 0.42), (0.36, 0.38)]):
        lump(a.m, w + a.r(-0.03, 0.03), h, w + a.r(-0.03, 0.03), ROCK[i], (a.r(-0.02, 0.02), y + h / 2, a.r(-0.02, 0.02)),
             rot=(0, a.r(0, PI), 0))
        y += h - 0.03
    for s in (-1, 1):                                                  # étais
        a.m.box(0.08, 1.2, 0.08, 'wood', pos=(s * 0.25, 0.6, 0.0), bevel=0.01)
    a.m.box(0.66, 0.09, 0.12, 'wood', pos=(0, 1.17, 0), bevel=0.012)
    # lanterne accrochée au linteau
    a.m.box(0.012, 0.12, 0.012, 'dark', pos=(0.18, 1.06, 0.08), bevel=0)
    a.g.box(0.08, 0.1, 0.08, 'yellow', pos=(0.18, 0.95, 0.08), bevel=0.01)
    a.m.box(0.1, 0.025, 0.1, 'dark', pos=(0.18, 1.01, 0.08), bevel=0.005)
    a.m.box(0.1, 0.02, 0.1, 'dark', pos=(0.18, 0.895, 0.08), bevel=0.005)
    return a.build()


def lantern(name):
    """Lanterne murale (le mur est à z = 0, la lanterne pend côté +z)."""
    a = Asset(name)
    a.m.box(0.12, 0.16, 0.03, 'dark', pos=(0, 0.3, 0.015), bevel=0.008)        # platine
    a.m.box(0.03, 0.03, 0.2, 'dark', pos=(0, 0.36, 0.11), bevel=0.006)         # potence
    a.m.box(0.012, 0.06, 0.012, 'dark', pos=(0, 0.32, 0.2), bevel=0)
    a.m.cone(0.09, 0.07, 'dark', pos=(0, 0.3, 0.2), seg=4)
    a.m.box(0.13, 0.02, 0.13, 'dark', pos=(0, 0.27, 0.2), bevel=0.004)
    a.m.box(0.13, 0.025, 0.13, 'dark', pos=(0, 0.1, 0.2), bevel=0.004)
    for sx in (-1, 1):
        for sz in (-1, 1):
            a.m.box(0.018, 0.17, 0.018, 'dark', pos=(sx * 0.055, 0.185, 0.2 + sz * 0.055), bevel=0)
    a.g.box(0.1, 0.15, 0.1, 'yellow', pos=(0, 0.185, 0.2), bevel=0.01)
    return a.build()


# ---------------------------------------------------------------------
#  Ruines envahies (le sol et une partie des obstacles viennent du pack Kenney Arena)
# ---------------------------------------------------------------------
STONE = ('cream', 'cream', 'skin')


def masonry(a, x0, x1, y0, y1, depth=0.8, broken=0.0, ivy=0):
    """Pan de mur en pierres de taille ; broken > 0 : le haut s'effrite (pierres manquantes)."""
    m = a.m
    m.box(x1 - x0 - 0.04, (y1 - y0) * (1 - broken * 0.5) - 0.02, depth - 0.08, 'skin',
          pos=((x0 + x1) / 2, y0 + (y1 - y0) * (1 - broken * 0.5) / 2, 0), bevel=0.01)
    rows = max(1, round((y1 - y0) / 0.22))
    hh = (y1 - y0) / rows
    for i in range(rows):
        y = y0 + (i + 0.5) * hh
        x = x0 - (0.12 if i % 2 else 0) + a.r(0, 0.05)
        while x < x1 - 0.02:
            w = a.r(0.24, 0.4)
            xa, xb = max(x, x0), min(x + w, x1)
            gone = broken > 0 and i >= rows * (1 - broken) and a.r(0, 1) < (i - rows * (1 - broken) + 1) / (rows * broken + 1) * 0.9
            if xb - xa > 0.06 and not gone:
                m.box(xb - xa - 0.02, hh - 0.025, depth + a.r(-0.02, 0.03), a.pick(STONE), pos=((xa + xb) / 2, y, a.r(-0.01, 0.01)),
                      bevel=0.018, seg=1)
            x += w
    for k in range(ivy):                                               # lierre sur les deux faces
        s = a.pick((-1, 1))
        x = a.r(x0 + 0.1, x1 - 0.1)
        top = y1 * (1 - broken * 0.4)
        h = a.r(0.35, min(0.9, top - y0 - 0.05))
        m.box(a.r(0.1, 0.2), h, 0.03, a.pick(('green', 'greenMid')), pos=(x, top - h / 2, s * (depth / 2 + 0.02)), bevel=0.01)
        for j in range(3):
            a.m.box(0.09, 0.07, 0.04, a.pick(('green', 'greenMid', 'greenDark')),
                    pos=(x + a.r(-0.09, 0.09), top - a.r(0.05, h), s * (depth / 2 + 0.035)), rot=(0, 0, a.r(-0.5, 0.5)), bevel=0.012)


def ruin_wall(name, broken):
    a = Asset(name)
    masonry(a, -0.5, 0.5, 0, WALL_H, broken=broken, ivy=3)
    a.m.box(1.0, 0.07, 0.86, 'skinDark', pos=(0, 0.035, 0), bevel=0.01)              # soubassement
    return a.build()


def ruin_low(name):
    a = Asset(name)
    masonry(a, -0.5, 0.5, 0, LOW_H, broken=0.4, ivy=1)
    for k in range(3):                                                 # pierres tombées
        lump(a.m, a.r(0.1, 0.16), 0.08, a.r(0.1, 0.16), a.pick(STONE), (a.r(-0.4, 0.4), 0.04, a.pick((-1, 1)) * a.r(0.5, 0.6)), rot=(0, a.r(0, PI), 0))
    return a.build()


def ruin_portal(name):
    a = Asset(name)
    masonry(a, -0.5, -HOLE_W, 0, WALL_H, ivy=1)
    masonry(a, HOLE_W, 0.5, 0, WALL_H, ivy=1)
    a.m.box(2 * HOLE_W + 0.32, 0.2, 0.9, 'cream', pos=(0, HOLE_H + 0.08, 0), bevel=0.03, seg=1)      # linteau
    a.m.box(2 * HOLE_W + 0.4, 0.06, 0.96, 'cream', pos=(0, HOLE_H + 0.21, 0), bevel=0.015)
    for x in (-HOLE_W - 0.07, HOLE_W + 0.07):                          # pilastres
        a.m.box(0.16, HOLE_H, 0.92, 'cream', pos=(x, HOLE_H / 2, 0), bevel=0.02, seg=1)
    for s in (-1, 1):                                                  # lierre qui retombe du linteau
        for k in range(4):
            x = a.r(-0.45, 0.45)
            h = a.r(0.12, 0.35)
            a.m.box(0.07, h, 0.03, a.pick(('green', 'greenMid')), pos=(x, HOLE_H + 0.1 - h / 2, s * 0.47), bevel=0.01)
    return a.build()


def grass_floor(name, flowers=False):
    a = Asset(name)
    a.m.box(1.0, 0.06, 1.0, 'green', pos=(0, -0.03, 0), bevel=0.012)
    for k in range(2):
        a.m.box(a.r(0.25, 0.4), 0.01, a.r(0.2, 0.35), 'greenMid', pos=(a.r(-0.25, 0.25), 0.0, a.r(-0.25, 0.25)), rot=(0, a.r(0, PI), 0), bevel=0.003)
    for k in range(4 if flowers else 2):                               # touffes
        x, z = a.r(-0.4, 0.4), a.r(-0.4, 0.4)
        for j in range(3):
            a.m.box(0.025, a.r(0.06, 0.1), 0.012, 'greenMid', pos=(x + (j - 1) * 0.025, 0.04, z), rot=(0, a.r(0, PI), (j - 1) * 0.35), bevel=0, taper=(0.3, 0.3))
    if flowers:
        for k in range(4):
            x, z = a.r(-0.4, 0.4), a.r(-0.4, 0.4)
            a.m.box(0.01, 0.07, 0.01, 'greenMid', pos=(x, 0.035, z), bevel=0)
            a.m.box(0.04, 0.02, 0.04, a.pick(('yellow', 'pink', 'white')), pos=(x, 0.075, z), rot=(0, a.r(0, PI), 0), bevel=0.006)
    return a.build()


def bush(name):
    """Buisson fleuri (remplace les rochers)."""
    a = Asset(name)
    for k in range(6):
        ang = k * PI / 3 + a.r(-0.3, 0.3)
        d = a.r(0.12, 0.24) if k else 0
        r = a.r(0.16, 0.22)
        a.m.ball(r, a.pick(('green', 'greenMid')), pos=(math.sin(ang) * d, r * 0.8 + a.r(0, 0.08), math.cos(ang) * d), seg=7, rings=5, scale=(1, 0.85, 1))
    a.m.ball(0.2, 'green', pos=(0, 0.36, 0), seg=7, rings=5)
    for k in range(9):
        ang, h = a.r(0, 2 * PI), a.r(0.15, 0.45)
        rr = 0.3 * math.sqrt(max(0.0, 1 - ((h - 0.2) / 0.35) ** 2)) + 0.06
        a.m.box(0.045, 0.045, 0.045, a.pick(('pink', 'yellow', 'white')), pos=(math.sin(ang) * rr, h, math.cos(ang) * rr), rot=(a.r(0, 1), a.r(0, 1), 0), bevel=0.008)
    return a.build()


# ---------------------------------------------------------------------
#  Forge volcanique
# ---------------------------------------------------------------------
def basalt_block(a, h0, h1, glow=0):
    """Orgues de basalte : colonnes hexagonales serrées, de hauteurs h0..h1, sur une tuile."""
    pts = [(-0.31, -0.3), (0.0, -0.33), (0.31, -0.29), (-0.33, 0.0), (0.0, 0.0), (0.32, 0.02), (-0.3, 0.31), (0.02, 0.32), (0.32, 0.32)]
    for x, z in pts:
        x, z = x + a.r(-0.02, 0.02), z + a.r(-0.02, 0.02)
        h = a.r(h0, h1)
        r = a.r(0.18, 0.21)
        a.m.cyl(r, h, a.pick(('dark', 'dark', 'iron')), pos=(x, h / 2, z), rot=(0, a.r(0, PI), 0), seg=6, bevel=0.012)
        a.m.cyl(r - 0.015, 0.02, 'slateDark', pos=(x, h + 0.005, z), rot=(0, a.r(0, PI), 0), seg=6, bevel=0.004)
    for k in range(glow):                                              # fissures de magma
        s = a.pick((-1, 1))
        a.g.box(0.03, a.r(0.25, 0.55), 0.03, a.pick(('orange', 'yellow')), pos=(a.r(-0.3, 0.3), a.r(0.15, 0.45), s * 0.5), rot=(0, 0, a.r(-0.3, 0.3)), bevel=0)


def basalt_wall(name):
    a = Asset(name)
    basalt_block(a, 1.35, WALL_H, glow=2)
    return a.build()


def basalt_low(name):
    a = Asset(name)
    basalt_block(a, 0.38, LOW_H)
    return a.build()


def basalt_portal(name):
    a = Asset(name)
    for x0, x1 in ((-0.5, -HOLE_W), (HOLE_W, 0.5)):
        for z in (-0.32, 0.0, 0.32):
            h = a.r(1.5, WALL_H)
            a.m.cyl(0.13, h, a.pick(('dark', 'iron')), pos=((x0 + x1) / 2 - 0.02 * (1 if x0 < 0 else -1), h / 2, z), rot=(0, a.r(0, PI), 0), seg=6, bevel=0.01)
    a.m.box(2 * HOLE_W + 0.36, 0.2, 0.96, 'dark', pos=(0, HOLE_H + 0.1, 0), bevel=0.03, seg=1)      # linteau
    for s in (-1, 1):                                                  # braseros de part et d'autre
        a.m.box(0.12, 0.05, 0.1, 'iron', pos=(s * (HOLE_W + 0.12), 1.0, 0.55), bevel=0.01)
        a.g.box(0.08, 0.04, 0.06, 'orange', pos=(s * (HOLE_W + 0.12), 1.04, 0.55), bevel=0.008)
    a.g.box(2 * HOLE_W, 0.025, 0.02, 'orange', pos=(0, HOLE_H + 0.02, 0.49), bevel=0)               # fissure du linteau
    return a.build()


def basalt_floor(name, cracks):
    """Dalles de basalte ; cracks : du magma luit entre les dalles."""
    a = Asset(name)
    a.m.box(1.0, 0.04, 1.0, 'dark', pos=(0, -0.04, 0), bevel=0.006)
    if cracks:
        a.g.box(0.98, 0.01, 0.98, 'orange', pos=(0, -0.022, 0), bevel=0)
    cx, cz = a.r(-0.12, 0.12), a.r(-0.12, 0.12)
    g = 0.035 if cracks else 0.02
    for x0, x1 in ((-0.5, cx), (cx, 0.5)):
        for z0, z1 in ((-0.5, cz), (cz, 0.5)):
            a.m.box(x1 - x0 - g, 0.035, z1 - z0 - g, a.pick(('iron', 'slateDark', 'iron')), pos=((x0 + x1) / 2, -0.0175, (z0 + z1) / 2), bevel=0.008, seg=1)
    return a.build()


def lava(name):
    """Tuile de lave (hors de l'aire de jeu) avec des croûtes noires qui flottent."""
    a = Asset(name)
    a.g.box(1.0, 0.04, 1.0, 'orange', pos=(0, -0.1, 0), bevel=0)
    for k in range(3):
        a.g.box(a.r(0.12, 0.25), 0.01, a.r(0.1, 0.2), 'yellow', pos=(a.r(-0.35, 0.35), -0.078, a.r(-0.35, 0.35)), rot=(0, a.r(0, PI), 0), bevel=0)
    for k in range(2):
        lump(a.m, a.r(0.12, 0.22), 0.04, a.r(0.1, 0.2), 'dark', (a.r(-0.35, 0.35), -0.075, a.r(-0.35, 0.35)), rot=(0, a.r(0, PI), 0))
    return a.build()


def anvil(name):
    """Enclume sur une souche, marteau posé, lingot chauffé au rouge (remplace le tonneau)."""
    a = Asset(name)
    m = a.m
    m.cyl(0.21, 0.28, 'woodDark', pos=(0, 0.14, 0), seg=8, bevel=0.015)
    m.cyl(0.19, 0.02, 'wood', pos=(0, 0.285, 0), seg=8, bevel=0.004)
    m.box(0.28, 0.05, 0.18, 'iron', pos=(0, 0.32, 0), bevel=0.01)
    m.box(0.14, 0.08, 0.1, 'iron', pos=(0, 0.38, 0), bevel=0.008)
    m.box(0.36, 0.09, 0.15, 'iron', pos=(-0.02, 0.46, 0), bevel=0.012)
    m.box(0.34, 0.015, 0.13, 'steel', pos=(-0.02, 0.51, 0), bevel=0.004)
    m.cone(0.065, 0.16, 'iron', pos=(0.23, 0.465, 0), rot=(0, 0, -PI / 2), seg=6)
    a.g.box(0.12, 0.03, 0.05, 'orange', pos=(-0.06, 0.53, 0.01), rot=(0, 0.3, 0), bevel=0.006)
    m.box(0.035, 0.035, 0.3, 'wood', pos=(0.06, 0.53, -0.02), rot=(0, -0.5, 0), bevel=0.006)        # marteau
    m.box(0.1, 0.06, 0.06, 'steelDark', pos=(-0.01, 0.54, 0.11), rot=(0, -0.5, 0), bevel=0.008)
    return a.build()


def obsidian(name):
    """Aiguilles d'obsidienne sur un socle fissuré de magma (remplace la colonne)."""
    a = Asset(name)
    lump(a.m, 0.56, 0.22, 0.52, 'iron', (0, 0.11, 0), rot=(0, 0.3, 0))
    a.m.box(0.26, 1.1, 0.24, 'dark', pos=(0, 0.6, 0), rot=(0.04, 0.5, -0.05), bevel=0.02, seg=1, taper=(0.15, 0.2))
    a.m.box(0.17, 0.7, 0.16, 'dark', pos=(0.15, 0.4, 0.06), rot=(0.1, 0.2, -0.35), bevel=0.015, seg=1, taper=(0.15, 0.2))
    a.m.box(0.15, 0.55, 0.14, 'lavender', pos=(-0.14, 0.34, -0.05), rot=(-0.15, 0.9, 0.35), bevel=0.015, seg=1, taper=(0.15, 0.2))
    a.m.box(0.12, 0.45, 0.12, 'dark', pos=(0.0, 0.3, -0.17), rot=(-0.4, 0.1, 0.0), bevel=0.012, seg=1, taper=(0.15, 0.2))
    for k in range(4):                                                 # fissures de magma du socle
        ang = k * PI / 2 + 0.4
        a.g.box(0.18, 0.03, 0.03, 'orange', pos=(math.sin(ang) * 0.24, 0.09, math.cos(ang) * 0.22), rot=(0, ang + PI / 2, a.r(-0.3, 0.3)), bevel=0)
    return a.build()


def lava_rocks(name):
    """Amas de basalte veiné de magma (remplace les rochers)."""
    a = Asset(name)
    for k in range(4):
        ang = k * PI / 2 + a.r(-0.4, 0.4)
        d = 0.2 if k else 0.0
        w = a.r(0.28, 0.38)
        h = a.r(0.22, 0.4) if k else 0.48
        lump(a.m, w, h, w * a.r(0.8, 1.1), a.pick(('dark', 'iron')), (math.sin(ang) * d, h / 2, math.cos(ang) * d), rot=(a.r(-0.1, 0.1), a.r(0, PI), a.r(-0.1, 0.1)))
    for k in range(5):
        ang = a.r(0, 2 * PI)
        a.g.box(0.03, a.r(0.12, 0.25), 0.03, a.pick(('orange', 'yellow')), pos=(math.sin(ang) * 0.3, a.r(0.08, 0.2), math.cos(ang) * 0.3), rot=(0, ang, a.r(-0.6, 0.6)), bevel=0)
    a.g.box(0.5, 0.012, 0.5, 'orange', pos=(0, 0.006, 0), rot=(0, 0.4, 0), bevel=0)
    return a.build()


# ---------------------------------------------------------------------
BIOMES = {
    'mine': [('mine-wall', lambda n: mine_wall(n)), ('mine-wall-ore', lambda n: mine_wall(n, ore=True)), ('mine-low', mine_low),
             ('mine-portal', mine_portal), ('mine-floor', lambda n: mine_floor(n)), ('mine-floor-stones', lambda n: mine_floor(n, True)),
             ('minecart', minecart), ('crystals', crystals), ('mine-pillar', mine_pillar), ('lantern', lantern)],
    'ruins': [('ruin-wall', lambda n: ruin_wall(n, 0.0)), ('ruin-wall-broken', lambda n: ruin_wall(n, 0.45)), ('ruin-low', ruin_low),
              ('ruin-portal', ruin_portal), ('grass-floor', lambda n: grass_floor(n)), ('grass-floor-flowers', lambda n: grass_floor(n, True)),
              ('bush', bush)],
    'forge': [('basalt-wall', basalt_wall), ('basalt-low', basalt_low), ('basalt-portal', basalt_portal),
              ('basalt-floor', lambda n: basalt_floor(n, False)), ('basalt-floor-cracks', lambda n: basalt_floor(n, True)),
              ('lava', lava), ('anvil', anvil), ('obsidian', obsidian), ('lava-rocks', lava_rocks)],
}


def run(biome):
    K.reset()
    obs = []
    for name, fn in BIOMES[biome]:
        ob = fn(name)
        K.export_glb(ob, os.path.join(OUT, name + '.glb'))
        obs.append(ob)
    # planche d'aperçu : les pièces en ligne
    n = len(obs)
    for i, ob in enumerate(obs):
        ob.location.x += (i - (n - 1) / 2) * 1.25
    K.preview(obs, os.path.join(PREV, 'biome-' + biome + '.png'), size=520, w=1400, dist=n * 1.45, target=(0, 0.5, 0), yaw=0.3, height=0.55)
    K.preview(obs, os.path.join(PREV, 'biome-' + biome + '-dos.png'), size=360, w=1000, dist=n * 1.45, target=(0, 0.5, 0), yaw=PI + 0.3, height=0.55)


args = sys.argv[sys.argv.index('--') + 1:] if '--' in sys.argv else list(BIOMES)
for b in args:
    run(b)
