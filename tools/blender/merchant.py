# =====================================================================
#  Génère le vieux marchand d'armes de la salle d'armes (assets/npc/merchant.glb), son étal
#  (assets/npc/stall.glb) et des aperçus dans tools/blender/previews/merchant*.png.
#
#    "C:\Program Files\Blender Foundation\Blender 5.3\blender.exe" -b --factory-startup -P tools/blender/merchant.py
#
#  Le marchand part d'un corps Kenney (tools/blender/sources/character-male-b.glb, CC0 : chauve et
#  barbu) : on garde son maillage, son squelette et ses animations, on change ses couleurs (robe
#  violette, barbe blanche) et on ALLONGE sa barbe en déplaçant les sommets de la barbe d'origine.
#  Couronne de cheveux blancs PEINTE sur le crâne (faces des côtés et de l'arrière), ajouts dans le
#  même style : gros sourcils, bourse à la ceinture.
#  L'étal est un comptoir de bois avec un auvent rayé (repère du jeu, échelle 1 : le jeu ne le
#  redimensionne pas) ; le marchand se tient derrière (côté −z), le client devant (+z).
# =====================================================================
import math
import os
import sys
import bpy
from mathutils import Matrix

sys.path.insert(0, os.path.dirname(__file__))
import kenney as K

OUT = os.path.join(K.ROOT, 'assets', 'npc')
PREV = os.path.join(K.ROOT, 'tools', 'blender', 'previews')
BASE = os.path.join(os.path.dirname(__file__), 'sources', 'character-male-b.glb')
PI = math.pi

# chemise rouge -> robe violette, jean -> chausses brunes, chaussures/ceinture -> cuir sombre
BODY_COLORS = {'red': 'purple', 'blue': 'brown', 'salmon': 'dark'}
# barbe rousse -> blanche (le dessous en gris, pour garder l'ombrage)
HEAD_COLORS = {'salmon': 'white', 'brown': 'grey'}
HAIR = 'white'


def place(ob, pos=(0, 0, 0), rot=(0, 0, 0)):
    ob.matrix_world = Matrix.Translation(K.P(*pos)) @ K.R(*rot).to_4x4() @ ob.matrix_world
    return ob


def faces_of(ob, fam):
    """Sommets des faces d'une famille de couleurs (avant recoloration)."""
    uv = ob.data.uv_layers.active.data
    want = K.FAMILY[fam]
    vs = set()
    for p in ob.data.polygons:
        u, v = uv[p.loop_start].uv
        if (int(u * 16) // 2, int((1 - v) * 16) // 4) == want:
            vs.update(p.vertices)
    return vs


def long_beard(head):
    """Étire vers le bas la barbe du modèle Kenney (sommets des faces 'salmon'/'brown' qui
    n'appartiennent qu'à la barbe) : plus longue, un peu pointue et légèrement en avant."""
    beard = faces_of(head, 'salmon') | faces_of(head, 'brown')
    other = set()
    uv = head.data.uv_layers.active.data
    bf = {K.FAMILY['salmon'], K.FAMILY['brown']}
    for p in head.data.polygons:
        u, v = uv[p.loop_start].uv
        if (int(u * 16) // 2, int((1 - v) * 16) // 4) not in bf:
            other.update(p.vertices)
    only = beard - other
    ys = [head.data.vertices[i].co.z for i in only]       # y du jeu = z de Blender
    top, bot = max(ys), min(ys)
    newbot = bot - 0.15
    for i in only:
        v = head.data.vertices[i].co
        y = v.z
        t = (top - y) / (top - bot)                        # 0 en haut de la barbe, 1 en bas
        if t < 0.35:
            continue                                      # moustache et joues : inchangées
        k = (t - 0.35) / 0.65
        v.z = y + (newbot - bot) * k
        v.x *= 1 - 0.45 * k * k                            # pointe
        v.y -= 0.035 * k                                   # un peu en avant (+z du jeu = −y Blender)
    print('BARBE', len(only), 'sommets, bas', round(bot, 3), '->', round(min(head.data.vertices[i].co.z for i in only), 3))
    assert len(only) > 20, 'barbe du modèle Kenney introuvable'


def hair_crown(head):
    """Couronne de cheveux PEINTE sur le crâne Kenney (pas de pièce ajoutée) : les faces de peau
    des côtés et de l'arrière de la tête (et leurs biseaux du bas) passent en blanc ; le dessus,
    le biseau du haut, le visage et les oreilles restent en peau -> calvitie sur le dessus."""
    uv = head.data.uv_layers.active.data
    mw = head.matrix_world
    skin, to = K.FAMILY['skin'], K.FAMILY[HAIR]
    du, dv = (to[0] - skin[0]) * 2 / 16, -(to[1] - skin[1]) * 4 / 16
    n_done = 0
    for p in head.data.polygons:
        u, v = uv[p.loop_start].uv
        if (int(u * 16) // 2, int((1 - v) * 16) // 4) != skin:
            continue
        n = (mw.to_3x3() @ p.normal).normalized()
        ny, nz = n.z, -n.y                                   # repère du jeu
        xs = [abs((mw @ head.data.vertices[i].co).x) for i in p.vertices]
        if max(xs) > 0.1605 or abs(ny) > 0.5 or nz > 0.3:   # oreilles, dessus/dessous, visage
            continue
        for li in p.loop_indices:
            uv[li].uv = (uv[li].uv[0] + du, uv[li].uv[1] + dv)
        n_done += 1
    print('CHEVEUX', n_done, 'faces')
    assert n_done >= 20, 'crâne du modèle Kenney introuvable'


def build():
    K.reset()
    rig, meshes = K.kenney_character(BASE, 'merchant')
    head, body = meshes['head-mesh'], meshes['body-mesh']
    long_beard(head)
    K.recolor(body, BODY_COLORS)
    hair_crown(head)                                       # avant recolor : on repère la peau
    K.recolor(head, HEAD_COLORS)

    # ----- gros sourcils blancs -----
    h = K.Model('hair')
    for s in (-1, 1):
        h.rbox(0.09, 0.035, 0.035, HAIR, pos=(s * 0.075, 0.545, 0.165), r=0.012, rot=(0, 0, -s * 0.18))
    K.attach(h.build(), rig, 'head', 'hair')

    # ----- bourse de cuir à la ceinture, tablier de marchand -----
    b = K.Model('purse')
    b.rbox(0.08, 0.09, 0.05, 'brown', pos=(0.12, 0.16, 0.11), r=0.025)
    b.cyl(0.03, 0.02, 'gold', pos=(0.12, 0.215, 0.11), seg=8)
    b.box(0.17, 0.13, 0.015, 'cream', pos=(-0.02, 0.13, 0.118), bevel=0.006)
    K.attach(b.build(), rig, 'torso', 'purse')
    return rig, meshes


def stall():
    """Comptoir de bois (2,3 × 0,6, haut de 0,58) et auvent rayé porté par deux poteaux à l'arrière."""
    m = K.Model('stall')
    W, D, H = 2.3, 0.6, 0.58
    m.box(W, H - 0.06, D - 0.08, 'wood', pos=(0, (H - 0.06) / 2, 0), bevel=0.02)
    m.box(W + 0.1, 0.07, D + 0.04, 'woodDark', pos=(0, H - 0.035, 0), bevel=0.02)          # plateau
    for x in (-W / 2 + 0.06, W / 2 - 0.06):                                                   # montants
        m.box(0.1, H - 0.06, 0.1, 'woodDark', pos=(x, (H - 0.06) / 2, D / 2 - 0.03), bevel=0.015)
    for k in range(4):                                                                        # draperie
        m.box(W / 4 - 0.04, 0.28, 0.02, 'red' if k % 2 == 0 else 'cream',
              pos=(-W / 2 + W / 8 + k * W / 4, H - 0.19, D / 2 - 0.02), bevel=0.006)
    m.box(W - 0.1, 0.04, 0.03, 'gold', pos=(0, H - 0.06, D / 2 - 0.01), bevel=0.008)
    PY = 1.95
    for x in (-W / 2 + 0.05, W / 2 - 0.05):                                                   # poteaux
        m.box(0.09, PY, 0.09, 'woodDark', pos=(x, PY / 2, -D / 2 - 0.55), bevel=0.015)
        m.box(0.07, 0.07, 1.1, 'woodDark', pos=(x, PY - 0.1, -D / 2 - 0.05), rot=(0.2, 0, 0), bevel=0.012)
    n = 6
    for k in range(n):                                                                        # auvent rayé
        x = -W / 2 + (k + 0.5) * W / n
        m.box(W / n + 0.002, 0.04, 1.2, 'red' if k % 2 == 0 else 'cream', pos=(x, PY - 0.02, -D / 2 - 0.02), rot=(0.2, 0, 0), bevel=0.008)
        m.prism([(-W / (2 * n), 0), (W / (2 * n), 0), (0, -0.12)], 0.02, 'red' if k % 2 == 0 else 'cream',
                pos=(x, PY - 0.14, D / 2 + 0.06), rot=(0, 0, 0))
    return m.build()


def main():
    K.reset()
    s = stall()
    K.export_glb(s, os.path.join(OUT, 'stall.glb'))
    K.preview([s], os.path.join(PREV, 'stall.png'), size=420, dist=3.6, target=(0, 0.8, 0), yaw=0.5, height=0.4)
    bpy.data.objects.remove(s)

    rig, meshes = build()
    K.export_glb(rig, os.path.join(OUT, 'merchant.glb'), animations=True)
    if rig.animation_data:
        rig.animation_data.action = None
        for t in rig.animation_data.nla_tracks:
            t.mute = True
    K.preview([rig], os.path.join(PREV, 'merchant.png'), size=520, dist=1.9, target=(0, 0.33, 0), yaw=0.45, height=0.3)
    K.preview([rig], os.path.join(PREV, 'merchant-dos.png'), size=360, dist=1.9, target=(0, 0.33, 0), yaw=PI - 0.6, height=0.35)


main()
