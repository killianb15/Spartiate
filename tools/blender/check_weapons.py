# =====================================================================
#  Vérifie la tenue des armes pendant les coups, telle que le jeu l'affiche :
#  - l'arme est tenue dans la main droite comme dans game.js (heldWeapon) ;
#  - pendant le coup, elle est orientée le long de l'arc de swingPose() (game.js), avec le même
#    poids et les mêmes temps ;
#  - on rend une planche : une ligne par arme, une colonne par instant du coup.
#
#    "C:\Program Files\Blender Foundation\Blender 5.3\blender.exe" -b --factory-startup -P tools/blender/check_weapons.py
#
#  Variables d'environnement :
#    COMBO=1|2      coup 1 (de haut en bas, animation attack-melee-right) ou 2 (balayage, attack-melee-left)
#    SWING=0        sans l'arc du jeu (arme simplement fixée à la main, pour comparer)
#    VIEW=-0.9      angle de la caméra (0 = de face, négatif = côté main droite)
#    OUT=coups      nom de l'image dans tools/blender/previews/
# =====================================================================
import array
import math
import os
import sys
import bpy
from mathutils import Matrix, Vector, Quaternion

sys.path.insert(0, os.path.dirname(__file__))
import kenney as K

D = os.path.join(K.ROOT, 'assets', 'dungeon', 'Models', 'GLB format')
W = os.path.join(K.ROOT, 'assets', 'weapons')
# (nom, fichier, échelle, recul de la prise le long du manche) : comme heldWeapon(key, s, back)
ARMES = [
    ('sword', os.path.join(D, 'weapon-sword.glb'), 0.9, 0),
    ('axe', os.path.join(W, 'weapon-axe.glb'), 0.9, 0),
    ('hammer', os.path.join(W, 'weapon-hammer.glb'), 0.9, 0),
    ('spear', os.path.join(D, 'weapon-spear.glb'), 1.45, 0.3),
]
SWORD_DIR = Vector((0.65, 0, 0.76)).normalized()
HAND = Vector((-0.25, 0, 0.02))
COMBO = int(os.environ.get('COMBO', '1'))
SWING = os.environ.get('SWING', '1') != '0'
CLIP = 'attack-melee-left' if COMBO == 2 else 'attack-melee-right'
TIMES = [0.0, 0.08, 0.13, 0.18, 0.23, 0.3]     # secondes depuis le début du coup
FPS = 24
C = K._C


# ---------- copie de swingPose() / chop() / sweep() de game.js (repère du personnage) ----------
def smooth(a, b, t):
    k = min(1, max(0, (t - a) / (b - a)))
    return k * k * (3 - 2 * k)


def swing_pose(t, wpn):
    kind = 'thrust' if wpn == 'spear' else 'sweep' if COMBO == 2 else 'chop'
    left = COMBO == 2
    w = smooth(0, 0.07, t) * (1 - (smooth(0.2, 0.3, t) if left else smooth(0.3, 0.42, t)))
    k = smooth(0.06, 0.2, t) if left else smooth(0.08, 0.24, t)
    if kind == 'chop':
        a = -0.55 + k * 2.45
        fwd, edge = Vector((-0.22, math.cos(a), math.sin(a))).normalized(), Vector((0, -math.sin(a), math.cos(a)))
    elif kind == 'sweep':
        b = 1.5 - k * 1.85
        fwd, edge = Vector((-math.sin(b), 0.18, math.cos(b))).normalized(), Vector((math.cos(b), 0, math.sin(b)))
    else:
        fwd, edge = Vector((-0.08, -0.12 + 0.3 * (1 - k), 1)).normalized(), Vector((0, 1, 0))
    return w, fwd, edge


def basis_quat(fwd, edge):
    """Rotation (repère du jeu) qui envoie +Y de l'arme sur fwd et +X sur le tranchant."""
    up = fwd.normalized()
    e = (edge - up * edge.dot(up)).normalized()
    side = e.cross(up)
    return Matrix((e, up, side)).transposed().to_quaternion()


def g2b(q):
    """Rotation du repère du jeu -> rotation Blender."""
    return (C @ q.to_matrix() @ C.transposed()).to_quaternion()


def main():
    K.reset()
    scn = bpy.context.scene
    rows = []
    for i, (name, path, scale, back) in enumerate(ARMES):
        rig, meshes = K.kenney_character(os.path.join(K.ROOT, 'assets', 'characters', 'character-knight.glb'), f'perso{i}')
        before = set(bpy.data.objects)
        bpy.ops.import_scene.gltf(filepath=path)
        wpn = [o for o in bpy.data.objects if o not in before and o.type == 'MESH'][0]
        # repère « bras » du jeu : un vide accroché à l'os, sans rotation au repos, à la tête de l'os
        arm = bpy.data.objects.new(f'bras{i}', None)
        scn.collection.objects.link(arm)
        arm.matrix_world = Matrix.Translation(K.P(*K.bone_head(rig, 'arm-right')))
        K.attach(arm, rig, 'arm-right')
        act = bpy.data.actions.get(CLIP)
        ad = rig.animation_data or rig.animation_data_create()
        for t in ad.nla_tracks:
            t.mute = True
        ad.action = act
        if hasattr(ad, 'action_slot') and act.slots:
            ad.action_slot = act.slots[0]
        rows.append((name, rig, arm, wpn, scale, back))

    q_rest = Vector((0, 1, 0)).rotation_difference(SWORD_DIR)      # tenue de repos (repère du bras, jeu)
    view = float(os.environ.get('VIEW', '-0.9'))
    tiles = []
    for name, rig, arm, wpn, scale, back in rows:
        for _, r2, a2, w2, _, _ in rows:
            for o in [r2, w2, *r2.children_recursive]:
                o.hide_render = r2 is not rig
        row = []
        for k, t in enumerate(TIMES):
            scn.frame_set(int(round(t * FPS)))
            bpy.context.view_layer.update()
            ma = arm.matrix_world                        # bras (Blender)
            qa = C.transposed() @ ma.to_3x3().normalized() @ C   # rotation du bras, repère du jeu
            qa = qa.to_quaternion()
            qm = (C.transposed() @ rig.matrix_world.to_3x3().normalized() @ C).to_quaternion()   # personnage
            q_local, pos_local = q_rest.copy(), HAND - SWORD_DIR * back
            if SWING:
                w, fwd, edge = swing_pose(t, name)
                if w > 0.001:
                    q_target = qa.inverted() @ qm @ basis_quat(fwd, edge)
                    q_local = q_rest.slerp(q_target, w)
                    d = qa.inverted() @ (qm @ fwd.normalized())
                    push = 0.12 * math.sin(math.pi * min(1, max(0, (t - 0.08) / 0.22))) if name == 'spear' else 0
                    pos_local = pos_local.lerp(HAND + d * (push - back), w)
            # monde (Blender) = bras @ position locale @ rotation locale @ échelle
            wpn.matrix_world = (ma @ Matrix.Translation(C @ pos_local) @ g2b(q_local).to_matrix().to_4x4()
                                @ Matrix.Diagonal((scale, scale, scale, 1)))
            p = os.path.join(K.ROOT, 'tools', 'blender', 'previews', f'_c{name}{k}.png')
            K.preview([], p, size=240, dist=float(os.environ.get('DIST', '1.7')), target=(0, 0.4, 0), yaw=view, height=float(os.environ.get('HEIGHT', '0.3')))
            row.append(p)
        tiles.append(row)

    imgs = [[bpy.data.images.load(p) for p in row] for row in tiles]
    w, h = imgs[0][0].size
    nr, nc = len(imgs), len(imgs[0])
    big = bpy.data.images.new('coups', w * nc, h * nr)
    px = array.array('f', [0.0]) * (w * nc * h * nr * 4)
    for r, row in enumerate(imgs):
        for c, im in enumerate(row):
            src = array.array('f', im.pixels[:])
            y0 = (nr - 1 - r) * h                        # les pixels Blender commencent en bas
            for y in range(h):
                d = ((y0 + y) * w * nc + c * w) * 4
                px[d:d + w * 4] = src[y * w * 4:(y + 1) * w * 4]
    big.pixels = px
    out = os.path.join(K.ROOT, 'tools', 'blender', 'previews', os.environ.get('OUT', 'coups') + '.png')
    big.filepath_raw = out
    big.file_format = 'PNG'
    big.save()
    for row in tiles:
        for p in row:
            os.remove(p)
    print('COUPS', out, 'instants', TIMES)


main()
