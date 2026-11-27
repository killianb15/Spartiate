# =====================================================================
#  Génère le sorcier de la salle d'armes (assets/npc/sorcerer.glb), sa petite tente (assets/npc/tent.glb),
#  son chaudron (assets/npc/cauldron.glb) et des aperçus dans tools/blender/previews/sorcier*.png.
#
#    blender -b --factory-startup -P tools/blender/sorcier.py
#
#  Le sorcier part du même corps Kenney que le marchand (tools/blender/sources/character-male-b.glb, CC0) :
#  on garde maillage, squelette et animations ; robe bleu nuit (couleurs changées), barbe grise ALLONGÉE
#  en déplaçant les sommets de la barbe d'origine (plus longue et plus pointue que celle du marchand).
#  Ajouts dans le même style : chapeau pointu à bord (pointe pliée), étoiles dorées, ceinture de corde.
#  Tente et chaudron : repère du jeu, échelle 1 (le jeu ne les redimensionne pas), ouverture vers +z.
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

# chemise rouge -> robe bleu nuit, jean -> bas de robe bleu, chaussures/ceinture -> cuir sombre
BODY_COLORS = {'red': 'blue', 'blue': 'slate', 'salmon': 'dark'}
# barbe rousse -> grise (le dessous plus sombre, pour garder l'ombrage)
HEAD_COLORS = {'salmon': 'grey', 'brown': 'slate'}
HAT = 'blue'


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


def long_beard(head, extra=0.17, point=0.75):
    """Étire vers le bas la barbe du modèle Kenney (sommets qui n'appartiennent qu'à la barbe)."""
    beard = faces_of(head, 'salmon') | faces_of(head, 'brown')
    other = set()
    uv = head.data.uv_layers.active.data
    bf = {K.FAMILY['salmon'], K.FAMILY['brown']}
    for p in head.data.polygons:
        u, v = uv[p.loop_start].uv
        if (int(u * 16) // 2, int((1 - v) * 16) // 4) not in bf:
            other.update(p.vertices)
    only = beard - other
    assert len(only) > 20, 'barbe du modèle Kenney introuvable'
    ys = [head.data.vertices[i].co.z for i in only]
    top, bot = max(ys), min(ys)
    for i in only:
        v = head.data.vertices[i].co
        t = (top - v.z) / (top - bot)
        if t < 0.3:
            continue
        k = (t - 0.3) / 0.7
        v.z -= extra * k
        v.x *= 1 - point * k * k
        v.y -= 0.05 * k
    print('BARBE', len(only), 'sommets')


def hat(rig, head):
    """Chapeau pointu à large bord : cônes empilés de plus en plus penchés vers l'arrière (pointe pliée)."""
    (x0, y0, z0), (x1, y1, z1) = K.bounds(head)
    cx, cz = (x0 + x1) / 2, (z0 + z1) / 2
    w = (x1 - x0) / 2                  # demi-largeur de la tête
    top = y1
    h = K.Model('hat')
    h.cyl(w * 1.55, 0.03, HAT, pos=(cx, top - 0.035, cz), seg=12)                   # bord
    h.cyl(w * 1.02, 0.05, 'gold', pos=(cx, top + 0.005, cz), r2=w * 0.95, seg=10)   # ruban
    # cône droit, puis pointe pliée vers l'arrière (sa base posée sur le haut du cône)
    hb, ht, tilt = 0.24, 0.17, -0.85
    h.cyl(w * 0.98, hb, HAT, pos=(cx, top + 0.02 + hb / 2, cz), r2=w * 0.46, seg=10)
    yb = top + 0.02 + hb - 0.045
    h.cyl(w * 0.5, ht, HAT, pos=(cx, yb + ht / 2 * math.cos(tilt), cz + ht / 2 * math.sin(tilt)), r2=0, rot=(tilt, 0, 0), seg=10, bevel=0)
    # étoiles dorées sur le devant du chapeau
    for (dx, dy, s) in ((-0.04, 0.07, 1), (0.05, 0.13, 0.75)):
        star = [(math.sin(a) * (0.03 if k % 2 == 0 else 0.013) * s, math.cos(a) * (0.03 if k % 2 == 0 else 0.013) * s)
                for k, a in enumerate(i * PI / 5 for i in range(10))]
        h.prism(star, 0.012, 'yellow', pos=(cx + dx, top + dy, cz + w * 0.86 - dy * 0.32), rot=(-0.25, 0, 0))
    K.attach(h.build(), rig, 'head', 'hat')


def build():
    K.reset()
    rig, meshes = K.kenney_character(BASE, 'sorcerer')
    head, body = meshes['head-mesh'], meshes['body-mesh']
    long_beard(head)
    K.recolor(body, BODY_COLORS)
    K.recolor(head, HEAD_COLORS)
    hat(rig, head)
    # gros sourcils gris, ceinture de corde dorée avec une fiole
    s = K.Model('brows')
    for sg in (-1, 1):
        s.rbox(0.095, 0.035, 0.035, 'grey', pos=(sg * 0.075, 0.545, 0.165), r=0.012, rot=(0, 0, -sg * 0.25))
    K.attach(s.build(), rig, 'head', 'brows')
    b = K.Model('belt')
    b.box(0.3, 0.035, 0.24, 'gold', pos=(0, 0.13, 0), bevel=0.01)
    b.cyl(0.035, 0.07, 'green', pos=(-0.11, 0.09, 0.12), seg=8)
    b.cyl(0.012, 0.03, 'wood', pos=(-0.11, 0.135, 0.12), seg=6)
    K.attach(b.build(), rig, 'torso', 'belt')
    return rig, meshes


def tent():
    """Petite tente pointue : toile à rayes violettes et lavande, porte ouverte (rabats repliés), mâts, cordes, fanion."""
    m = K.Model('tent')
    W, D, H = 1.9, 1.4, 1.45
    n = 5
    for k in range(n):                                                     # toile (prisme en A), par bandes
        z = -D / 2 + (k + 0.5) * D / n
        m.prism([(-W / 2, 0), (W / 2, 0), (0, H)], D / n + 0.002, 'purple' if k % 2 == 0 else 'lavender', pos=(0, 0, z), bevel=0.012)
    # porte : ouverture sombre et rabats repliés de chaque côté
    m.prism([(-0.42, 0), (0.42, 0), (0, 0.98)], 0.02, 'dark', pos=(0, 0.005, D / 2 + 0.006), bevel=0.004)
    for sg in (-1, 1):
        m.prism([(0, 0), (sg * 0.3, 0), (0, 0.9)], 0.03, 'lavender', pos=(sg * 0.43, 0.01, D / 2 + 0.03), rot=(0, sg * 0.35, 0), bevel=0.006)
    # liseré doré le long du faîte et en bas de la toile
    m.box(0.06, 0.06, D + 0.08, 'gold', pos=(0, H + 0.005, 0), bevel=0.015)
    # mâts dépassant devant et derrière, fanion
    for zz in (D / 2 + 0.02, -D / 2 - 0.02):                              # bouts des mâts au-dessus du faîte
        m.cyl(0.035, 0.4, 'woodDark', pos=(0, H + 0.07, zz), seg=6)
    m.prism([(0, 0), (0.32, -0.08), (0, -0.18)], 0.02, 'yellow', pos=(0.02, H + 0.25, D / 2 + 0.04))
    m.ball(0.045, 'gold', pos=(0, H + 0.27, D / 2 + 0.04), seg=8, rings=5)
    # lune dorée au-dessus de la porte
    moon = [(math.cos(a) * 0.12, math.sin(a) * 0.12) for a in [PI * (0.3 + 1.4 * i / 10) for i in range(11)]]
    moon += [(math.cos(a) * 0.09 + 0.04, math.sin(a) * 0.09) for a in [PI * (1.7 - 1.4 * i / 10) for i in range(11)]]
    m.prism(moon, 0.02, 'yellow', pos=(0, 1.13, D / 2 + 0.01), rot=(0, 0, 0.3))
    # cordes et piquets
    for sg in (-1, 1):
        for zz in (D / 2 - 0.15, -D / 2 + 0.15):
            m.rod((sg * W * 0.3, H * 0.62, zz), (sg * (W / 2 + 0.32), 0.03, zz), 0.012, 'cream', seg=4)
            m.box(0.05, 0.12, 0.05, 'woodDark', pos=(sg * (W / 2 + 0.32), 0.05, zz), bevel=0.01)
    # bâton noueux appuyé contre la tente, cristal bleu au sommet
    m.tube([(W / 2 + 0.05, 0.0, D / 2 - 0.05), (W / 2 - 0.02, 0.6, D / 2 - 0.02), (W / 2 - 0.12, 1.2, D / 2 + 0.02)], 0.03, 'wood', seg=6)
    m.ball(0.07, 'sky', pos=(W / 2 - 0.13, 1.27, D / 2 + 0.03), seg=6, rings=4)
    # tapis devant l'entrée
    m.box(0.9, 0.012, 0.5, 'red', pos=(0, 0.006, D / 2 + 0.3), bevel=0.004)
    m.box(0.7, 0.014, 0.36, 'yellow', pos=(0, 0.008, D / 2 + 0.3), bevel=0.003)
    return m.build()


def cauldron():
    """Chaudron de fonte sur trois pieds, bûches dessous ; la potion (nœud 'brew') brille dans le jeu."""
    m = K.Model('cauldron')
    m.ball(0.3, 'iron', pos=(0, 0.33, 0), seg=10, rings=7, scale=(1, 0.82, 1))
    m.cyl(0.27, 0.06, 'iron', pos=(0, 0.53, 0), seg=10, r2=0.29)
    for k in range(3):
        a = k * 2 * PI / 3 + 0.4
        m.box(0.06, 0.16, 0.06, 'dark', pos=(math.sin(a) * 0.2, 0.06, math.cos(a) * 0.2), bevel=0.012)
    for sg in (-1, 1):                                                       # anses
        m.box(0.04, 0.1, 0.04, 'iron', pos=(sg * 0.31, 0.5, 0), bevel=0.01)
    for a in (0.3, 1.9):                                                     # bûches
        m.cyl(0.04, 0.42, 'wood', pos=(0, 0.04, 0), rot=(PI / 2, 0, a), seg=6)
    body = m.build()
    b = K.Model('brew')
    b.cyl(0.25, 0.02, 'green', pos=(0, 0.55, 0), seg=10)
    for (x, z, r) in ((0.08, 0.05, 0.035), (-0.09, -0.04, 0.03), (0.0, -0.1, 0.025)):
        b.ball(r, 'green', pos=(x, 0.565, z), seg=6, rings=4)
    brew = b.build()
    K.parent_keep(brew, body, 'brew')
    return body


def totem():
    """Totem de vie (sort) : mât de bois sculpté de deux visages, ailes de feuilles, cristal vert au sommet
    (nœud 'gem', qui brille dans le jeu). Hauteur ≈ 1,15, posé au sol en (0, 0, 0), visages vers +z."""
    m = K.Model('totem')
    m.box(0.5, 0.1, 0.5, 'grey', pos=(0, 0.05, 0), bevel=0.02)                       # socle de pierre
    m.box(0.36, 0.06, 0.36, 'slate', pos=(0, 0.13, 0), bevel=0.015)
    for k, (col, y) in enumerate((('wood', 0.33), ('woodDark', 0.63))):              # deux blocs sculptés
        m.box(0.3, 0.3, 0.28, col, pos=(0, y, 0), bevel=0.02)
        for sg in (-1, 1):                                                           # yeux
            m.box(0.07, 0.05 if k else 0.035, 0.03, 'dark', pos=(sg * 0.07, y + 0.05, 0.14), bevel=0.008)
        if k == 0:                                                                   # bouche ouverte
            m.box(0.14, 0.07, 0.03, 'dark', pos=(0, y - 0.07, 0.14), bevel=0.01)
            m.box(0.04, 0.03, 0.03, 'cream', pos=(0, y - 0.045, 0.15), bevel=0.006)
        else:                                                                        # nez et sourire
            m.box(0.05, 0.08, 0.05, col, pos=(0, y - 0.01, 0.16), bevel=0.01)
            m.box(0.12, 0.025, 0.03, 'dark', pos=(0, y - 0.09, 0.14), bevel=0.006)
        m.box(0.32, 0.03, 0.3, 'green', pos=(0, y + 0.15, 0), bevel=0.008)            # bandeau
    for sg in (-1, 1):                                                               # ailes de feuilles
        m.prism([(0, 0), (sg * 0.32, 0.12), (sg * 0.26, -0.02), (sg * 0.18, -0.1)], 0.04, 'green', pos=(sg * 0.14, 0.72, 0), bevel=0.006)
    m.box(0.22, 0.08, 0.22, 'woodDark', pos=(0, 0.83, 0), bevel=0.015)              # chapiteau
    body = m.build()
    g = K.Model('gem')
    g.cone(0.1, 0.16, 'green', pos=(0, 1.03, 0), seg=6)
    g.cone(0.1, 0.1, 'green', pos=(0, 0.92, 0), rot=(math.pi, 0, 0), seg=6)
    gem = g.build()
    K.parent_keep(gem, body, 'gem')
    return body


def main():
    K.reset()
    tt = totem()
    K.export_glb(tt, os.path.join(K.ROOT, 'assets', 'summons', 'totem.glb'))
    K.preview([tt], os.path.join(PREV, 'totem.png'), size=360, dist=2.0, target=(0, 0.55, 0), yaw=0.5, height=0.35)
    for o in [tt, *tt.children_recursive]:
        bpy.data.objects.remove(o)
    t = tent()
    K.export_glb(t, os.path.join(OUT, 'tent.glb'))
    K.preview([t], os.path.join(PREV, 'tent.png'), size=460, dist=4.2, target=(0, 0.7, 0), yaw=0.55, height=0.45)
    bpy.data.objects.remove(t)

    c = cauldron()
    K.export_glb(c, os.path.join(OUT, 'cauldron.glb'))
    K.preview([c], os.path.join(PREV, 'cauldron.png'), size=360, dist=1.6, target=(0, 0.3, 0), yaw=0.5, height=0.6)
    for o in [c, *c.children_recursive]:
        bpy.data.objects.remove(o)

    rig, meshes = build()
    K.export_glb(rig, os.path.join(OUT, 'sorcerer.glb'), animations=True)
    if rig.animation_data:
        rig.animation_data.action = None
        for tr in rig.animation_data.nla_tracks:
            tr.mute = True
    K.preview([rig], os.path.join(PREV, 'sorcier.png'), size=520, dist=2.1, target=(0, 0.4, 0), yaw=0.45, height=0.3)
    K.preview([rig], os.path.join(PREV, 'sorcier-dos.png'), size=360, dist=2.1, target=(0, 0.4, 0), yaw=PI - 0.6, height=0.35)


main()
