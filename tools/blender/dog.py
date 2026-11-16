# =====================================================================
#  Génère le chien invoqué par le grimoire (assets/summons/dog.glb) + aperçu tools/blender/previews/dog.png
#
#    "C:\Program Files\Blender Foundation\Blender 5.3\blender.exe" -b --factory-startup -P tools/blender/dog.py
#
#  Style Kenney (blocs arrondis, palette Kenney). Le squelette Kenney étant humanoïde, le chien est
#  fait de pièces articulées que le jeu anime lui-même (marche, morsure, chute) :
#    'dog' (racine) > 'body' > 'head', 'tail', 'leg-fl', 'leg-fr', 'leg-bl', 'leg-br', 'glow'
#  Chaque pièce a son origine sur son articulation (cou, base de la queue, haut des pattes).
#  Le museau regarde +z. 'glow' : la pierre du collier, que le jeu fait briller (chien magique).
# =====================================================================
import os
import sys
import bpy

sys.path.insert(0, os.path.dirname(__file__))
import kenney as K

OUT = os.path.join(K.ROOT, 'assets', 'summons', 'dog.glb')
PREV = os.path.join(K.ROOT, 'tools', 'blender', 'previews', 'dog.png')
FUR, FUR2, LIGHT, DARK, EAR, COLLAR = 'brown', 'woodDark', 'cream', 'dark', 'woodDark', 'purple'

BODY_Y, LEG_H = 0.25, 0.17          # centre du corps, hauteur des pattes
HIP_Y = BODY_Y - 0.06               # articulation des pattes


def part(name, build, pivot):
    """Construit une pièce (positions du jeu, au repos) et place son origine sur son articulation."""
    m = K.Model(name)
    build(m)
    ob = m.build()
    K.set_origin(ob, pivot)
    ob.name = ob.data.name = name
    return ob


def main():
    K.reset()

    def body(m):
        m.rbox(0.22, 0.2, 0.36, FUR, (0, BODY_Y, 0), r=0.06)
        m.rbox(0.16, 0.06, 0.28, LIGHT, (0, BODY_Y - 0.085, 0.01), r=0.025)    # ventre clair
        m.rbox(0.235, 0.05, 0.08, COLLAR, (0, BODY_Y + 0.03, 0.16), r=0.02)    # collier magique
        m.rbox(0.23, 0.09, 0.1, FUR2, (0, BODY_Y + 0.07, -0.05), r=0.03)       # tache sur le dos

    def head(m):
        m.rbox(0.2, 0.18, 0.18, FUR, (0, BODY_Y + 0.13, 0.24), r=0.05)
        m.rbox(0.12, 0.08, 0.1, LIGHT, (0, BODY_Y + 0.09, 0.35), r=0.025)     # museau
        m.rbox(0.05, 0.035, 0.03, DARK, (0, BODY_Y + 0.12, 0.395), r=0.012)   # truffe
        m.rbox(0.05, 0.012, 0.02, DARK, (0, BODY_Y + 0.065, 0.392), r=0.004)  # gueule
        for s in (-1, 1):
            m.rbox(0.03, 0.045, 0.015, DARK, (s * 0.05, BODY_Y + 0.17, 0.333), r=0.008)   # yeux
            m.rbox(0.06, 0.1, 0.04, EAR, (s * 0.1, BODY_Y + 0.2, 0.2), r=0.018, rot=(0.2, 0, s * 0.35))   # oreilles tombantes

    def tail(m):
        # de la base (haut de l'arrière-train) vers le haut et l'arrière
        m.rbox(0.05, 0.05, 0.17, FUR, (0, BODY_Y + 0.13, -0.225), r=0.02, rot=(0.7, 0, 0))
        m.rbox(0.058, 0.058, 0.05, LIGHT, (0, BODY_Y + 0.185, -0.29), r=0.02, rot=(0.7, 0, 0))

    def leg(x, z):
        def b(m):
            m.rbox(0.07, LEG_H, 0.07, FUR, (x, HIP_Y - LEG_H / 2 + 0.02, z), r=0.022)
            m.rbox(0.08, 0.04, 0.09, LIGHT, (x, 0.02, z + 0.01), r=0.015)        # patte claire
        return b

    root = bpy.data.objects.new('dog', None)
    bpy.context.scene.collection.objects.link(root)
    b = part('body', body, (0, BODY_Y, 0))
    K.parent_keep(b, root, 'body')
    K.parent_keep(part('head', head, (0, BODY_Y + 0.08, 0.16)), b, 'head')
    K.parent_keep(part('tail', tail, (0, BODY_Y + 0.08, -0.17)), b, 'tail')
    for name, x, z in (('leg-fl', 0.07, 0.12), ('leg-fr', -0.07, 0.12), ('leg-bl', 0.07, -0.12), ('leg-br', -0.07, -0.12)):
        K.parent_keep(part(name, leg(x, z), (x, HIP_Y, z)), b, name)
    gem = part('glow', lambda m: m.ball(0.022, 'pink', (0, BODY_Y + 0.03, 0.205), seg=6, rings=4), (0, BODY_Y + 0.03, 0.205))
    K.parent_keep(gem, b, 'glow')

    K.export_glb(root, OUT)
    K.preview([root], PREV, size=420, dist=1.15, target=(0, 0.22, 0), yaw=0.7, height=0.45)


main()
