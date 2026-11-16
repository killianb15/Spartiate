# =====================================================================
#  Génère les armes originales du jeu dans assets/weapons/ (+ aperçus PNG dans tools/blender/previews/).
#
#    "C:\Program Files\Blender Foundation\Blender 5.3\blender.exe" -b --factory-startup -P tools/blender/weapons.py
#
#  Même convention que l'épée Kenney (weapon-sword.glb) : la main tient l'arme à l'origine,
#  l'arme monte le long de +Y, le plat de la lame est dans le plan XY. Une unité = celle de Kenney.
# =====================================================================
import math
import os
import sys
import bpy

sys.path.insert(0, os.path.dirname(__file__))
import kenney as K

OUT = os.path.join(K.ROOT, 'assets', 'weapons')
PREV = os.path.join(K.ROOT, 'tools', 'blender', 'previews')


def grip(m, y0, y1, r=0.022):
    """Manche en bois avec poignée de cuir et pommeau."""
    m.cyl(r, y1 - y0, 'wood', pos=(0, (y0 + y1) / 2, 0), seg=8)
    m.cyl(r + 0.006, 0.11, 'leather', pos=(0, -0.02, 0), seg=8)          # poignée
    for y in (-0.075, 0.035):
        m.cyl(r + 0.009, 0.014, 'iron', pos=(0, y, 0), seg=8)            # bagues
    m.cyl(r + 0.012, 0.03, 'iron', pos=(0, y0 - 0.01, 0), seg=8, r2=r + 0.004)   # pommeau


def axe():
    m = K.Model('weapon-axe')
    grip(m, -0.1, 0.44)
    # tête : lame en éventail (profil x/y) côté +x, talon côté -x
    m.prism([(0.02, 0.30), (0.10, 0.27), (0.17, 0.22), (0.19, 0.335), (0.17, 0.45), (0.10, 0.40), (0.02, 0.38)],
            0.035, 'steel', bevel=0.008)
    m.prism([(0.165, 0.215), (0.19, 0.205), (0.215, 0.335), (0.19, 0.465), (0.165, 0.455), (0.188, 0.335)],
            0.02, 'white', bevel=0.004)                                    # fil de la lame
    m.box(0.07, 0.11, 0.06, 'iron', pos=(0, 0.34, 0), bevel=0.01)       # douille
    m.prism([(-0.03, 0.31), (-0.11, 0.33), (-0.03, 0.37)], 0.03, 'iron', bevel=0.005)   # pointe arrière
    m.box(0.05, 0.03, 0.05, 'gold', pos=(0, 0.405, 0), bevel=0.008)     # capuchon
    return m.build()


def hammer():
    m = K.Model('weapon-hammer')
    grip(m, -0.1, 0.46, r=0.024)
    m.box(0.21, 0.105, 0.105, 'steelDark', pos=(0, 0.40, 0), bevel=0.015)   # tête
    for x in (-0.11, 0.11):
        m.box(0.03, 0.125, 0.125, 'steel', pos=(x, 0.40, 0), bevel=0.01)   # faces de frappe
    m.box(0.055, 0.12, 0.12, 'gold', pos=(0, 0.40, 0), bevel=0.01)        # bande dorée
    m.box(0.035, 0.03, 0.035, 'gold', pos=(0, 0.47, 0), bevel=0.007)
    m.cone(0.025, 0.05, 'iron', pos=(0, 0.5, 0), seg=4)                  # pointe du dessus
    return m.build()


def staff():
    """Sceptre de feu : manche en bois, couronne dorée à quatre griffes qui tient un orbe de feu.
    L'orbe est un nœud à part ('orb') : le jeu le fait briller."""
    m = K.Model('weapon-staff')
    m.cyl(0.02, 0.74, 'wood', pos=(0, 0.07, 0), seg=8, r2=0.024)          # manche (de -0.3 à 0.44)
    m.cyl(0.026, 0.1, 'leather', pos=(0, 0.0, 0), seg=8)                    # poignée
    m.cone(0.03, 0.06, 'gold', pos=(0, -0.33, 0), rot=(math.pi, 0, 0), seg=6)   # pointe du bas
    for y in (-0.06, 0.06, 0.3):
        m.cyl(0.03, 0.016, 'gold', pos=(0, y, 0), seg=8, bevel=0)           # bagues
    m.cyl(0.05, 0.05, 'gold', pos=(0, 0.465, 0), seg=8, r2=0.032)          # coupe de la couronne
    for k in range(4):                                                      # griffes autour de l'orbe
        a = k * math.pi / 2 + math.pi / 4
        x, z = math.cos(a), math.sin(a)
        m.rod((x * 0.035, 0.48, z * 0.035), (x * 0.07, 0.54, z * 0.07), 0.011, 'gold')
        m.rod((x * 0.07, 0.54, z * 0.07), (x * 0.035, 0.61, z * 0.035), 0.009, 'gold')
    m.box(0.03, 0.03, 0.012, 'red', pos=(0, 0.3, 0.032), rot=(0, 0, math.pi / 4), bevel=0.004)   # gemme
    ob = m.build()
    o = K.Model('orb')
    o.ball(0.06, 'orange', seg=10, rings=7)
    orb = o.build()
    orb.matrix_world = K.Matrix.Translation(K.P(0, 0.545, 0))
    K.parent_keep(orb, ob, 'orb')
    return ob


def tome():
    """Grimoire (main gauche, tenu comme un bouclier : couverture vers l'avant +z, centré sur la main).
    'rune' : l'œil magique de la couverture, que le jeu fait briller pendant l'invocation."""
    m = K.Model('weapon-tome')
    W, H, D = 0.2, 0.26, 0.075
    m.rbox(W, H, D, 'purple', r=0.012)                                         # couverture
    m.rbox(W - 0.012, H - 0.025, D - 0.022, 'cream', pos=(0.008, 0, 0), r=0.004)   # tranche des pages (côté ouverture)
    m.rbox(0.03, H + 0.004, D + 0.006, 'slate', pos=(-W / 2 + 0.012, 0, 0), r=0.01)   # dos
    for sx in (-1, 1):
        for sy in (-1, 1):                                                     # coins dorés
            m.rbox(0.045, 0.045, D + 0.008, 'gold', pos=(sx * (W / 2 - 0.018), sy * (H / 2 - 0.018), 0), r=0.008)
    m.rbox(0.03, 0.05, D + 0.014, 'gold', pos=(W / 2 - 0.004, 0, 0), r=0.008)   # fermoir
    m.rbox(0.085, 0.085, 0.012, 'gold', pos=(0, 0.005, D / 2 + 0.004), r=0.006, rot=(0, 0, math.pi / 4))   # cadre de la rune
    ob = m.build()
    r = K.Model('rune')
    r.box(0.05, 0.03, 0.012, 'pink', bevel=0.004)
    r.box(0.022, 0.022, 0.016, 'dark', bevel=0.003)                            # pupille
    rune = r.build()
    rune.matrix_world = K.Matrix.Translation(K.P(0, 0.005, D / 2 + 0.01))
    K.parent_keep(rune, ob, 'rune')
    return ob


def main():
    K.reset()
    built = []
    for make, file in ((axe, 'weapon-axe.glb'), (hammer, 'weapon-hammer.glb'), (staff, 'weapon-staff.glb'), (tome, 'weapon-tome.glb')):
        ob = make()
        K.export_glb(ob, os.path.join(OUT, file))
        built.append(ob)
    # aperçu : les armes côte à côte avec l'épée Kenney pour comparer l'échelle
    bpy.ops.import_scene.gltf(filepath=os.path.join(K.ROOT, 'assets', 'dungeon', 'Models', 'GLB format', 'weapon-sword.glb'))
    ref = bpy.context.selected_objects[0]
    ref.location = K.P(-0.45, 0, 0)
    built[0].location = K.P(0, 0, 0)
    built[1].location = K.P(0.45, 0, 0)
    built[2].location = K.P(0.9, 0, 0)
    built[3].location = K.P(1.3, 0.2, 0)
    K.preview(built + [ref], os.path.join(PREV, 'weapons.png'), dist=2.1, target=(0.42, 0.2, 0))


main()
