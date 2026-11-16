# =====================================================================
#  Génère l'archère elfe (assets/archer/archer.glb), la flèche (assets/archer/arrow.glb) et l'arc
#  seul pour les autres personnages (assets/weapons/weapon-bow.glb), + un aperçu dans
#  tools/blender/previews/archer.png.
#
#    "C:\Program Files\Blender Foundation\Blender 5.3\blender.exe" -b --factory-startup -P tools/blender/archer.py
#
#  Pour avoir exactement le style des personnages Kenney, l'archère part d'un corps Kenney
#  (tools/blender/sources/character-female-f.glb, CC0) : on garde son maillage, son squelette et
#  ses animations, on change ses familles de couleurs (tunique verte, cheveux blancs…) et on ajoute
#  des pièces dans le même style : oreilles d'elfe, carquois.
#  L'arc est un fichier à part (weapon-bow.glb, nœuds 'bow' > 'nocked') que le jeu met dans la main
#  gauche de qui le choisit, archère comprise. Au repos les bras sont à l'horizontale, le visage regarde +z.
# =====================================================================
import math
import os
import sys
import bpy
from mathutils import Matrix

sys.path.insert(0, os.path.dirname(__file__))
import kenney as K

OUT = os.path.join(K.ROOT, 'assets', 'archer')
WEAPONS = os.path.join(K.ROOT, 'assets', 'weapons')
PREV = os.path.join(K.ROOT, 'tools', 'blender', 'previews')
BASE = os.path.join(os.path.dirname(__file__), 'sources', 'character-female-f.glb')
PI = math.pi

# nouvelles couleurs du corps Kenney (familles de la palette, voir kenney.FAMILY)
BODY_COLORS = {'dark': 'green', 'blue': 'slate', 'purple': 'brown', 'white': 'brown'}
# cheveux (et frange) blancs comme ceux d'un elfe, sans fard
HEAD_COLORS = {'brown': 'white', 'salmon': 'white', 'purple': 'skin'}

WOOD, WOOD2, LEATHER, LEATHER2 = 'wood', 'leather', 'brown', 'woodDark'
TRIM, STRING, STEEL, SKIN = 'gold', 'cream', 'steel', 'skin'


def place(ob, pos=(0, 0, 0), rot=(0, 0, 0)):
    """Pose un objet construit autour de l'origine en pos/rot (repère du jeu)."""
    ob.matrix_world = Matrix.Translation(K.P(*pos)) @ K.R(*rot).to_4x4() @ ob.matrix_world
    return ob


def join(obs, name):
    bpy.ops.object.select_all(action='DESELECT')
    for o in obs:
        o.select_set(True)
    bpy.context.view_layer.objects.active = obs[0]
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    bpy.ops.object.join()
    ob = bpy.context.view_layer.objects.active
    ob.name = ob.data.name = name
    return ob


def arrow(length=0.62, r=0.011, name='arrow'):
    """Flèche le long de +z (pointe vers +z), centrée à l'origine."""
    m = K.Model(name)
    m.cyl(r, length, WOOD2, rot=(PI / 2, 0, 0), seg=6, bevel=0)
    m.cone(r * 3.2, length * 0.15, STEEL, pos=(0, 0, length / 2 + length * 0.07), rot=(PI / 2, 0, 0), seg=4)
    m.cyl(r * 1.6, length * 0.04, LEATHER2, pos=(0, 0, -length / 2 + length * 0.22), rot=(PI / 2, 0, 0), seg=6, bevel=0)
    for k in range(3):
        a = k * 2.094
        m.box(0.004, r * 5, length * 0.2, 'white' if k else 'red', pos=(math.cos(a) * r * 2.6, math.sin(a) * r * 2.6, -length / 2 + length * 0.1),
              rot=(0, 0, a + PI / 2), bevel=0)
    return m.build()


def bow(H=0.37):
    """Arc à double courbure : branches vers l'avant (+z), pointes recourbées vers l'arrière ;
    poignée à l'origine. Enfant 'nocked' : la flèche encochée."""
    m = K.Model('bow')
    for s in (-1, 1):
        m.tube([(0, 0, 0.075), (0, s * 0.12, 0.1), (0, s * 0.25, 0.085), (0, s * 0.33, 0.04), (0, s * H, 0.035)], 0.016, WOOD, seg=7)
        m.cone(0.02, 0.05, TRIM, pos=(0, s * (H + 0.02), 0.035), rot=(PI if s < 0 else 0, 0, 0), seg=6, scale=(1, 1, 0.7))
        m.cyl(0.02, 0.015, TRIM, pos=(0, s * 0.2, 0.097), rot=(0.15 * s, 0, 0), seg=8, bevel=0)
    m.cyl(0.026, 0.11, LEATHER2, pos=(0, 0, 0.078), seg=8)                        # poignée gainée de cuir
    for y in (0.06, -0.06):
        m.cyl(0.029, 0.014, TRIM, pos=(0, y, 0.078), seg=8, bevel=0)
    m.cyl(0.0045, H * 2 + 0.01, STRING, pos=(0, 0, 0.03), seg=4, bevel=0)       # corde
    b = m.build()
    nock = place(arrow(), (0.03, 0, 0.12))
    K.parent_keep(nock, b, 'nocked')
    return b


# Oreilles du corps Kenney : un petit losange de 6 sommets de chaque côté de la tête (repère du jeu,
# côté +x ; l'autre côté est symétrique). On déplace ces sommets pour en faire une oreille d'elfe
# longue et pointue, qui sort de la mèche de cheveux vers le haut et l'arrière.
EAR_MOVES = {
    (0.2001, 0.5078, 0.0060): (0.300, 0.640, -0.045),   # haut de l'oreille -> pointe
    (0.2168, 0.4842, -0.0107): (0.305, 0.535, -0.005),  # bord extérieur haut
    (0.1834, 0.4842, -0.0441): (0.255, 0.540, -0.075),  # bord arrière haut
    (0.2168, 0.4370, -0.0107): (0.250, 0.445, 0.000),   # bord extérieur bas
    (0.1834, 0.4370, -0.0441): (0.200, 0.440, -0.050),  # bord arrière bas (base)
    (0.2001, 0.4134, 0.0060): (0.200, 0.413, 0.006),    # lobe (base)
}


def elf_ears(head):
    """Déforme les oreilles du maillage de tête Kenney (les sommets gardent leur lien à l'os de la tête)."""
    moved = 0
    for v in head.data.vertices:
        x, y, z = v.co.x, v.co.z, -v.co.y          # repère du jeu
        for (ex, ey, ez), (nx, ny, nz) in EAR_MOVES.items():
            if abs(abs(x) - ex) < 0.002 and abs(y - ey) < 0.002 and abs(z - ez) < 0.002:
                sx = 1 if x > 0 else -1
                v.co.x, v.co.y, v.co.z = sx * nx, -nz, ny
                moved += 1
                break
    print('OREILLES', moved, 'sommets déplacés')
    assert moved >= 12, 'oreilles du modèle Kenney introuvables'


def build():
    K.reset()
    rig, meshes = K.kenney_character(BASE, 'character-archer')
    K.recolor(meshes['body-mesh'], BODY_COLORS)
    K.recolor(meshes['head-mesh'], HEAD_COLORS)
    H = {b: K.bone_head(rig, b) for b in ('torso', 'arm-left', 'head')}

    # ----- oreilles d'elfe : on étire les oreilles du modèle Kenney (cachées dans les mèches) -----
    elf_ears(meshes['head-mesh'])

    # ----- carquois dans le dos, plumes qui dépassent -----
    tx, ty, tz = H['torso']
    q = K.Model('quiver')
    q.rbox(0.1, 0.24, 0.09, LEATHER, r=0.03)
    q.rbox(0.11, 0.035, 0.1, TRIM, pos=(0, 0.1, 0), r=0.012)
    q.rbox(0.11, 0.03, 0.1, LEATHER2, pos=(0, -0.06, 0), r=0.01)
    for k, (x, z) in enumerate(((-0.025, 0.012), (0.022, -0.01), (0.0, 0.02))):
        q.cyl(0.008, 0.08, WOOD2, pos=(x, 0.15, z), seg=5, bevel=0)
        q.box(0.035, 0.06, 0.008, 'white' if k % 2 else 'red', pos=(x, 0.2, z), bevel=0.004)
    quiver = place(q.build(), (tx - 0.04, ty + 0.12, tz - 0.14), (-0.12, 0, 0.45))
    K.attach(quiver, rig, 'torso', 'quiver')

    # (l'arc n'est pas dans le modèle : comme les autres héros, elle le prend en main dans le jeu)
    return rig, meshes


def export_bow():
    """L'arc seul (les autres personnages le prennent dans la main gauche) : 'bow' > 'nocked'."""
    b = bow()
    K.export_glb(b, os.path.join(WEAPONS, 'weapon-bow.glb'))
    for o in [*b.children, b]:
        bpy.data.objects.remove(o)


def export_arrow():
    """Flèche seule (projectile) : 'arrow-root' > 'arrow', pointe vers +z."""
    a = arrow()
    root = bpy.data.objects.new('arrow-root', None)
    bpy.context.scene.collection.objects.link(root)
    K.parent_keep(a, root, 'arrow')
    K.export_glb(root, os.path.join(OUT, 'arrow.glb'))
    bpy.data.objects.remove(a)
    bpy.data.objects.remove(root)


def main():
    K.reset()
    export_bow()          # dans une scène vide : ses nœuds gardent les noms 'bow' et 'nocked'
    rig, meshes = build()
    K.export_glb(rig, os.path.join(OUT, 'archer.glb'), animations=True)
    export_arrow()
    # aperçu : de face (repos, bras à l'horizontale), puis de dos
    if rig.animation_data:
        rig.animation_data.action = None
        for t in rig.animation_data.nla_tracks:
            t.mute = True
    b = place(bow(), (0.255 + 0.1, 0.288, 0.05 - 0.017))    # arc en main, pour l'aperçu seulement
    K.attach(b, rig, 'arm-left')
    K.preview([rig], os.path.join(PREV, 'archer.png'), size=520, dist=1.9, target=(0, 0.33, 0), yaw=0.55, height=0.35)
    K.preview([rig], os.path.join(PREV, 'archer-dos.png'), size=520, dist=1.9, target=(0, 0.33, 0), yaw=PI - 0.6, height=0.35)
    if os.environ.get('ARCHER_HEAD'):   # gros plans de la tête (réglage des oreilles)
        for n, y in (('face', 0.0), ('profil', PI / 2)):
            K.preview([rig], os.path.join(PREV, f'archer-{n}.png'), size=360, dist=1.1, target=(0, 0.5, 0), yaw=y, height=0.1)


main()
