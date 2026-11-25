# =====================================================================
#  Cerbère, boss du donjon (assets/summons/cerbere.glb) + aperçus tools/blender/previews/cerbere*.png
#
#    "C:\Program Files\Blender Foundation\Blender 5.3\blender.exe" -b --factory-startup -P tools/blender/cerbere.py
#
#  Même construction que le chien du grimoire (dog.py) : pièces articulées animées par le jeu (DogView),
#    'cerbere' (racine) > 'body' > 'head-l', 'head-c', 'head-r', 'tail', 'leg-fl', 'leg-fr', 'leg-bl', 'leg-br'
#  Chaque tête porte ses yeux, nœud 'eyes-*', que le jeu fait rougeoyer. Museaux vers +z.
#  Plus massif que le chien : poitrail large, pelage sombre, collier à pointes, crête dorsale.
# =====================================================================
import math
import os
import sys
import bpy

sys.path.insert(0, os.path.dirname(__file__))
import kenney as K

OUT = os.path.join(K.ROOT, 'assets', 'summons', 'cerbere.glb')
PREV = os.path.join(K.ROOT, 'tools', 'blender', 'previews')
FUR, FUR2, BELLY, DARK, HORN, COLLAR, SPIKE, EYE = 'slate', 'dark', 'slateDark', 'dark', 'cream', 'iron', 'steel', 'red'

BODY_Y, LEG_H = 0.3, 0.2            # centre du corps, hauteur des pattes
HIP_Y = BODY_Y - 0.08               # articulation des pattes
NECK_Y, NECK_Z = BODY_Y + 0.08, 0.2  # base des cous


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
        m.rbox(0.3, 0.24, 0.42, FUR, (0, BODY_Y, 0), r=0.07)                    # tronc
        m.rbox(0.34, 0.26, 0.16, FUR, (0, BODY_Y + 0.02, 0.15), r=0.07)         # poitrail large (trois cous)
        m.rbox(0.2, 0.06, 0.32, BELLY, (0, BODY_Y - 0.11, 0.02), r=0.025)       # ventre
        m.rbox(0.36, 0.06, 0.1, COLLAR, (0, BODY_Y + 0.07, 0.2), r=0.02)        # collier de fer
        for k in range(5):                                                       # pointes du collier
            x = -0.14 + k * 0.07
            m.cone(0.016, 0.05, SPIKE, pos=(x, BODY_Y + 0.07, 0.26), rot=(math.pi / 2, 0, 0), seg=4)
        for k in range(4):                                                       # crête le long du dos
            m.cone(0.024, 0.07, FUR2, pos=(0, BODY_Y + 0.14, 0.06 - k * 0.09), rot=(-0.35, 0, 0), seg=4)

    def head(x, ry):
        """Tête sur son cou, tournée de ry vers l'extérieur ; pivot à la base du cou."""
        c, s = math.cos(ry), math.sin(ry)

        def at(px, py, pz):          # position dans le repère de la tête (tournée de ry autour de y)
            return (x + px * c + pz * s, py, NECK_Z + pz * c - px * s)

        def b(m):
            m.rbox(0.1, 0.16, 0.1, FUR, at(0, NECK_Y + 0.06, 0.05), r=0.035, rot=(0.5, ry, 0))     # cou
            m.rbox(0.17, 0.15, 0.17, FUR, at(0, NECK_Y + 0.15, 0.13), r=0.045, rot=(0, ry, 0))     # crâne
            m.rbox(0.11, 0.07, 0.1, FUR2, at(0, NECK_Y + 0.11, 0.24), r=0.022, rot=(0, ry, 0))     # museau
            m.rbox(0.045, 0.03, 0.03, DARK, at(0, NECK_Y + 0.135, 0.29), r=0.01, rot=(0, ry, 0))   # truffe
            m.rbox(0.1, 0.03, 0.08, HORN, at(0, NECK_Y + 0.075, 0.23), r=0.01, rot=(0, ry, 0))     # mâchoire (crocs)
            for sx in (-1, 1):
                m.cone(0.012, 0.035, HORN, pos=at(sx * 0.03, NECK_Y + 0.06, 0.27), rot=(math.pi, 0, 0), seg=4)   # crocs
                m.rbox(0.035, 0.09, 0.035, FUR2, at(sx * 0.065, NECK_Y + 0.25, 0.1), r=0.012, rot=(0, ry, sx * 0.25))  # oreilles pointues
        return b

    def eyes(x, ry):
        c, s = math.cos(ry), math.sin(ry)

        def at(px, py, pz):
            return (x + px * c + pz * s, py, NECK_Z + pz * c - px * s)

        def b(m):
            for sx in (-1, 1):
                m.rbox(0.03, 0.025, 0.012, EYE, at(sx * 0.045, NECK_Y + 0.175, 0.218), r=0.006, rot=(0, ry, 0))
        return b

    def tail(m):
        m.rbox(0.06, 0.06, 0.2, FUR, (0, BODY_Y + 0.12, -0.28), r=0.022, rot=(0.6, 0, 0))
        m.cone(0.04, 0.09, FUR2, pos=(0, BODY_Y + 0.21, -0.36), rot=(-0.95, 0, 0), seg=4)    # pointe en flèche

    def leg(x, z):
        def b(m):
            m.rbox(0.09, LEG_H, 0.09, FUR, (x, HIP_Y - LEG_H / 2 + 0.02, z), r=0.028)
            m.rbox(0.1, 0.045, 0.11, FUR2, (x, 0.024, z + 0.012), r=0.018)          # patte
            for sx in (-1, 0, 1):
                m.cone(0.01, 0.03, HORN, pos=(x + sx * 0.028, 0.02, z + 0.075), rot=(math.pi / 2, 0, 0), seg=4)   # griffes
        return b

    root = bpy.data.objects.new('cerbere', None)
    bpy.context.scene.collection.objects.link(root)
    bd = part('body', body, (0, BODY_Y, 0))
    K.parent_keep(bd, root, 'body')
    for name, x, ry in (('l', 0.12, 0.35), ('c', 0.0, 0.0), ('r', -0.12, -0.35)):
        h = part('head-' + name, head(x, ry), (x, NECK_Y, NECK_Z))
        K.parent_keep(h, bd, 'head-' + name)
        K.parent_keep(part('eyes-' + name, eyes(x, ry), (x, NECK_Y + 0.175, NECK_Z + 0.2)), h, 'eyes-' + name)
    K.parent_keep(part('tail', tail, (0, BODY_Y + 0.08, -0.2)), bd, 'tail')
    for name, x, z in (('leg-fl', 0.1, 0.14), ('leg-fr', -0.1, 0.14), ('leg-bl', 0.1, -0.15), ('leg-br', -0.1, -0.15)):
        K.parent_keep(part(name, leg(x, z), (x, HIP_Y, z)), bd, name)

    K.export_glb(root, OUT)
    K.preview([root], os.path.join(PREV, 'cerbere.png'), size=480, dist=1.35, target=(0, 0.3, 0), yaw=0.7, height=0.4)
    K.preview([root], os.path.join(PREV, 'cerbere-face.png'), size=480, dist=1.2, target=(0, 0.35, 0), yaw=0.0, height=0.15)
    # à côté du chien du grimoire, pour comparer
    bpy.ops.import_scene.gltf(filepath=os.path.join(K.ROOT, 'assets', 'summons', 'dog.glb'))
    dog = next(o for o in bpy.context.selected_objects if o.parent is None)
    dog.location = K.P(0.55, 0, 0)
    K.preview([root, dog, *dog.children_recursive], os.path.join(PREV, 'cerbere-chien.png'), size=480, dist=1.6, target=(0.25, 0.25, 0), yaw=0.6, height=0.4)


main()
