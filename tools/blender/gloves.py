# =====================================================================
#  Gant de boxe (arme « gants de boxe ») → assets/weapons/weapon-glove.glb
#  + aperçus sur un personnage Kenney dans tools/blender/previews/gloves*.png
#
#    "C:\Program Files\Blender Foundation\Blender 5.3\blender.exe" -b --factory-startup -P tools/blender/gloves.py
#
#  Le jeu charge ce GLB (FILES.glove dans game.js, gloveModel()).
#
#  Un seul modèle : le gant GAUCHE, poing centré sur la main (origine), dans le repère du personnage :
#  jointures vers l'avant (+z), manchette vers le bas (-y), pouce vers le milieu du corps (-x).
#  Le jeu le redresse à chaque image (comme un bouclier) et le retourne en miroir (x → -x) à droite.
# =====================================================================
import os
import sys
import bpy

sys.path.insert(0, os.path.dirname(__file__))
import kenney as K

OUT = os.path.join(K.ROOT, 'assets', 'weapons')
PREV = os.path.join(K.ROOT, 'tools', 'blender', 'previews')
S = 1.05          # échelle du gant dans le jeu (game.js : equipModel)
HAND = 0.28       # distance de la main au départ du bras (game.js : equipModel)


def glove():
    m = K.Model('weapon-glove')
    m.rbox(0.15, 0.15, 0.16, 'red', pos=(0, 0.02, 0.01), r=0.045)              # poing
    m.rbox(0.13, 0.1, 0.05, 'red', pos=(0, 0.035, 0.09), r=0.022)              # bourrelet des jointures
    m.rbox(0.05, 0.1, 0.07, 'red', pos=(-0.08, -0.01, 0.03), r=0.022)          # pouce, collé au poing
    m.cyl(0.07, 0.09, 'white', pos=(0, -0.085, -0.02), seg=10, r2=0.064)       # manchette
    m.cyl(0.074, 0.02, 'redDark', pos=(0, -0.05, -0.02), seg=10, bevel=0.004)  # liseré
    return m.build()


def main():
    K.reset()
    g = glove()
    K.export_glb(g, os.path.join(OUT, 'weapon-glove.glb'))
    # gros plans du gant seul (avant d'importer le personnage)
    K.preview([g], os.path.join(PREV, 'glove.png'), dist=0.55, target=(0, 0, 0), yaw=0.7, height=0.3)
    K.preview([g], os.path.join(PREV, 'glove-front.png'), dist=0.55, target=(0, 0, 0), yaw=0.0, height=0.1)
    # aperçu : un gladiateur Kenney au repos (bras à l'horizontale), un gant au bout de chaque bras
    arm, meshes = K.kenney_character(os.path.join(K.ROOT, 'assets', 'arena', 'Models', 'GLB format', 'character-soldier.glb'), 'soldier')
    hl, hr = K.bone_head(arm, 'arm-left'), K.bone_head(arm, 'arm-right')
    g2 = g.copy()
    bpy.context.scene.collection.objects.link(g2)
    g.scale = (S, S, S)
    g.location = K.P(hl[0] + HAND, hl[1], hl[2] + 0.03)
    g2.scale = (-S, S, S)
    g2.location = K.P(hr[0] - HAND, hr[1], hr[2] + 0.03)
    objs = [arm, *meshes.values(), g, g2]
    K.preview(objs, os.path.join(PREV, 'gloves.png'), dist=1.6, target=(0, 0.45, 0), yaw=0.5)
    K.preview(objs, os.path.join(PREV, 'gloves-side.png'), dist=1.6, target=(0, 0.45, 0), yaw=1.6)


main()
