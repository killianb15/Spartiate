# =====================================================================
#  Petite bibliothèque pour générer des modèles au style Kenney avec Blender (sans interface).
#
#  - Les couleurs viennent de la palette Kenney (assets/characters/Textures/colormap.png) :
#    chaque pièce a toutes ses coordonnées UV sur une case de la palette, exactement comme les
#    modèles Kenney. Les modèles générés ont donc les mêmes teintes que le reste du jeu.
#  - Pièces : boîtes (arrondies), cylindres, cônes, tubes, prismes ; les arêtes sont adoucies
#    par un modificateur Bevel, puis les pièces sont fusionnées en un seul maillage.
#  - Toutes les positions et rotations s'écrivent dans le repère du JEU (three.js : +Y en haut,
#    rotations en radians, ordre XYZ) ; la conversion vers Blender (+Z en haut) est faite ici,
#    et l'export glTF (+Y up) remet tout à l'endroit.
#  - Personnages : kenney_rig() reprend le squelette et les animations d'un personnage Kenney,
#    attach() accroche une pièce à un os (elle suit alors toutes les animations).
#
#  Utilisé par les scripts de ce dossier (weapons.py, archer.py…), lancés par :
#    blender -b --factory-startup -P tools/blender/<script>.py
# =====================================================================
import bpy
import bmesh
import os
from mathutils import Vector, Matrix

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
COLORMAP = os.path.join(ROOT, 'assets', 'characters', 'Textures', 'colormap.png')

# Cases unies de la palette : (colonne, bloc de lignes). Les colonnes impaires sont des dégradés.
_CELLS = {
    'blue': (0, 4), 'sky': (2, 4), 'purple': (4, 4), 'pink': (6, 4), 'rose': (8, 4),
    'salmon': (0, 8), 'brown': (2, 8), 'skin': (4, 8), 'cream': (6, 8), 'green': (8, 8),
    'yellow': (10, 8), 'orange': (12, 8), 'red': (14, 8),
    'gold': (0, 12), 'slate': (2, 12), 'lavender': (4, 12), 'dark': (6, 12), 'grey': (8, 12),
    'iron': (10, 12), 'steel': (12, 12), 'white': (14, 12),
}
# nuances prises dans les colonnes en dégradé : (colonne, ligne) ; plus bas = plus foncé
_SHADES = {
    'wood': (3, 10), 'woodDark': (3, 11), 'leather': (1, 10), 'steelDark': (13, 14),
    'goldDark': (1, 15), 'redDark': (15, 11), 'greenMid': (9, 9), 'greenDeep': (9, 10), 'greenDark': (9, 11),
    'skinDark': (5, 10), 'orangeDark': (15, 9), 'slateDark': (3, 14),
}


def uv_of(color):
    """Coordonnées UV du centre de la case de palette (origine des UV en bas à gauche)."""
    if color in _CELLS:
        col, row = _CELLS[color]
        y = row * 32 + 64             # milieu du bloc de 4 cases
    else:
        col, row = _SHADES[color]
        y = row * 32 + 16
    return ((col * 32 + 16) / 512, 1 - y / 512)


def P(x, y, z):
    """Position du jeu (+Y en haut) -> position Blender (+Z en haut)."""
    return Vector((x, -z, y))


# passage du repère du jeu à celui de Blender : (x, y, z) -> (x, -z, y)
_C = Matrix(((1, 0, 0), (0, 0, -1), (0, 1, 0)))


def R(rx=0, ry=0, rz=0):
    """Rotation écrite comme dans three.js (radians, ordre XYZ, repère du jeu) -> matrice Blender 3x3."""
    g = Matrix.Rotation(rx, 3, 'X') @ Matrix.Rotation(ry, 3, 'Y') @ Matrix.Rotation(rz, 3, 'Z')
    return _C @ g @ _C.transposed()


# ---------------------------------------------------------------------
#  Scène
# ---------------------------------------------------------------------
def reset():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    _mat.cache = None


def _mat():
    if _mat.cache:
        return _mat.cache
    m = bpy.data.materials.new('colormap')
    m.use_nodes = True
    nt = m.node_tree
    bsdf = nt.nodes['Principled BSDF']
    bsdf.inputs['Roughness'].default_value = 0.8
    tex = nt.nodes.new('ShaderNodeTexImage')
    tex.image = bpy.data.images.load(COLORMAP)
    tex.interpolation = 'Closest'
    nt.links.new(tex.outputs['Color'], bsdf.inputs['Base Color'])
    _mat.cache = m
    return m
_mat.cache = None


class Model:
    """Un modèle en cours de construction : une liste de pièces fusionnées par build()."""

    def __init__(self, name):
        self.name = name
        self.parts = []

    def _add(self, bm, color, pos, rot, bevel, scale=(1, 1, 1), seg=2):
        uv = uv_of(color)
        layer = bm.loops.layers.uv.verify()
        for f in bm.faces:
            for l in f.loops:
                l[layer].uv = uv
        me = bpy.data.meshes.new(self.name + '-part')
        bm.to_mesh(me)
        bm.free()
        me.materials.append(_mat())
        ob = bpy.data.objects.new(self.name + '-part', me)
        bpy.context.scene.collection.objects.link(ob)
        sx, sy, sz = scale
        ob.matrix_world = Matrix.Translation(P(*pos)) @ R(*rot).to_4x4() @ Matrix.Diagonal((sx, sz, sy, 1))
        if bevel > 0:
            b = ob.modifiers.new('bevel', 'BEVEL')
            b.width = bevel
            b.segments = seg
            b.limit_method = 'ANGLE'
        self.parts.append(ob)
        return ob

    # boîte de dimensions (w, h, d) en unités du jeu (x, y, z)
    def box(self, w, h, d, color, pos=(0, 0, 0), rot=(0, 0, 0), bevel=0.01, taper=None, seg=None):
        bm = bmesh.new()
        bmesh.ops.create_cube(bm, size=1)
        bmesh.ops.scale(bm, vec=Vector((w, d, h)), verts=bm.verts)
        if taper:   # (sx, sz) : rétrécit le haut de la boîte (lames, têtes de hache…)
            for v in bm.verts:
                if v.co.z > 0:
                    v.co.x *= taper[0]
                    v.co.y *= taper[1]
        bevel = max(0, min(bevel, w / 2 - 0.001, h / 2 - 0.001, d / 2 - 0.001))
        return self._add(bm, color, pos, rot, bevel, seg=seg or (3 if bevel > 0.03 else 2))

    # boîte très arrondie (comme RoundedBoxGeometry de three.js)
    def rbox(self, w, h, d, color, pos=(0, 0, 0), r=0.03, rot=(0, 0, 0)):
        return self.box(w, h, d, color, pos, rot, bevel=r, seg=3)

    # cylindre vertical (axe Y du jeu)
    def cyl(self, r, h, color, pos=(0, 0, 0), rot=(0, 0, 0), seg=8, r2=None, bevel=0.006, scale=(1, 1, 1)):
        bm = bmesh.new()
        bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=r, radius2=r if r2 is None else r2, depth=h)
        return self._add(bm, color, pos, rot, max(0, min(bevel, h / 2 - 0.001)), scale)

    def cone(self, r, h, color, pos=(0, 0, 0), rot=(0, 0, 0), seg=8, scale=(1, 1, 1)):
        return self.cyl(r, h, color, pos, rot, seg, r2=0, bevel=0, scale=scale)

    # cylindre d'un point à un autre (positions du jeu)
    def rod(self, a, b, r, color, seg=6):
        a, b = P(*a), P(*b)
        d = b - a
        bm = bmesh.new()
        bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=r, radius2=r, depth=d.length)
        ob = self._add(bm, color, (0, 0, 0), (0, 0, 0), 0)
        ob.matrix_world = Matrix.Translation((a + b) / 2) @ d.to_track_quat('Z', 'Y').to_matrix().to_4x4()
        return ob

    # tube le long d'une ligne brisée (positions du jeu), articulations arrondies
    def tube(self, pts, r, color, seg=6):
        for p, q in zip(pts, pts[1:]):
            self.rod(p, q, r, color, seg)
        for p in pts[1:-1]:
            bm = bmesh.new()
            bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=4, radius=r)
            self._add(bm, color, p, (0, 0, 0), 0)

    # sphère à facettes (style low poly)
    def ball(self, r, color, pos=(0, 0, 0), seg=8, rings=6, scale=(1, 1, 1)):
        bm = bmesh.new()
        bmesh.ops.create_uvsphere(bm, u_segments=seg, v_segments=rings, radius=r)
        return self._add(bm, color, pos, (0, 0, 0), 0, scale)

    # prisme : profil polygonal (liste de (x, y)) extrudé sur l'épaisseur d (axe z du jeu)
    def prism(self, pts, d, color, pos=(0, 0, 0), rot=(0, 0, 0), bevel=0.006):
        bm = bmesh.new()
        vs = [bm.verts.new((x, 0, y)) for x, y in pts]
        f = bm.faces.new(vs)
        bmesh.ops.translate(bm, vec=Vector((0, d / 2, 0)), verts=vs)
        ext = bmesh.ops.extrude_face_region(bm, geom=[f])
        bmesh.ops.translate(bm, vec=Vector((0, -d, 0)), verts=[e for e in ext['geom'] if isinstance(e, bmesh.types.BMVert)])
        bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
        return self._add(bm, color, pos, rot, bevel)

    # ---------- finalisation ----------
    def build(self):
        """Applique les biseaux, fusionne les pièces et renvoie l'objet final (origine au 0 du monde)."""
        ctx = bpy.context
        for ob in self.parts:
            ctx.view_layer.objects.active = ob
            for m in list(ob.modifiers):
                bpy.ops.object.modifier_apply(modifier=m.name)
        bpy.ops.object.select_all(action='DESELECT')
        for ob in self.parts:
            ob.select_set(True)
        ctx.view_layer.objects.active = self.parts[0]
        bpy.ops.object.join()
        ob = ctx.view_layer.objects.active
        ob.name = ob.data.name = self.name
        bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
        bpy.ops.object.shade_flat()
        self.parts = []
        return ob


def set_origin(ob, pos):
    """Déplace l'origine de ob en pos (position du jeu) sans bouger sa géométrie."""
    o = P(*pos)
    ob.data.transform(Matrix.Translation(-o))
    ob.matrix_world = Matrix.Translation(o) @ ob.matrix_world
    return ob


# ---------------------------------------------------------------------
#  Personnages : squelette et animations d'un personnage Kenney
# ---------------------------------------------------------------------
def kenney_rig(path, name):
    """Importe un personnage Kenney, garde son armature (os + animations) et jette son corps.
    Renvoie l'armature, renommée name. Os : root, leg-left, leg-right, torso, arm-left, arm-right, head."""
    bpy.ops.import_scene.gltf(filepath=path)
    arm = next(o for o in bpy.data.objects if o.type == 'ARMATURE')
    for o in list(bpy.data.objects):
        if o.type == 'MESH':
            bpy.data.objects.remove(o)
    arm.name = arm.data.name = name
    # pas d'animations de fauteuil roulant dans le jeu
    if arm.animation_data:
        for t in list(arm.animation_data.nla_tracks):
            if t.name.startswith('wheelchair'):
                arm.animation_data.nla_tracks.remove(t)
    for a in list(bpy.data.actions):
        if a.name.startswith('wheelchair'):
            bpy.data.actions.remove(a)
    return arm


def kenney_character(path, name):
    """Importe un personnage Kenney COMPLET (corps et tête skinnés + squelette + animations).
    Renvoie (armature, {nom du maillage: objet}). Animations de fauteuil roulant retirées."""
    before = set(bpy.data.objects)
    bpy.ops.import_scene.gltf(filepath=path)
    new = [o for o in bpy.data.objects if o not in before]
    arm = next(o for o in new if o.type == 'ARMATURE')
    meshes = {}
    for o in new:
        if o.type == 'MESH':
            if o.parent is None:          # forme d'os (Icosphere) créée par l'import
                bpy.data.objects.remove(o)
            else:
                o.data.materials.clear()
                o.data.materials.append(_mat())
                meshes[o.name.split('.')[0]] = o
    arm.name = arm.data.name = name
    if arm.animation_data:
        for t in list(arm.animation_data.nla_tracks):
            if t.name.startswith('wheelchair'):
                arm.animation_data.nla_tracks.remove(t)
    for a in list(bpy.data.actions):
        if a.name.startswith('wheelchair'):
            bpy.data.actions.remove(a)
    return arm, meshes


# Familles de couleurs de la palette : (paire de colonnes, bloc de 4 lignes). Une famille =
# une teinte et son dégradé d'ombre ; les modèles Kenney piochent dedans pour l'ombrage.
FAMILY = {
    'blue': (0, 1), 'sky': (1, 1), 'purple': (2, 1), 'pink': (3, 1), 'rose': (4, 1),
    'salmon': (0, 2), 'brown': (1, 2), 'skin': (2, 2), 'cream': (3, 2), 'green': (4, 2),
    'yellow': (5, 2), 'orange': (6, 2), 'red': (7, 2),
    'gold': (0, 3), 'slate': (1, 3), 'lavender': (2, 3), 'dark': (3, 3), 'grey': (4, 3),
    'iron': (5, 3), 'steel': (6, 3), 'white': (7, 3),
}


def recolor(ob, mapping):
    """Change des familles de couleurs d'un maillage Kenney : mapping {'dark': 'green', …}.
    Chaque face garde sa nuance (position dans le dégradé) dans la nouvelle famille."""
    uv = ob.data.uv_layers.active.data
    moves = {FAMILY[a]: FAMILY[b] for a, b in mapping.items()}
    for p in ob.data.polygons:
        u, v = uv[p.loop_start].uv
        col, row = int(u * 16), int((1 - v) * 16)
        fam = (col // 2, row // 4)
        if fam not in moves:
            continue
        to = moves[fam]
        du, dv = (to[0] - fam[0]) * 2 / 16, -(to[1] - fam[1]) * 4 / 16
        for li in p.loop_indices:
            uv[li].uv = (uv[li].uv[0] + du, uv[li].uv[1] + dv)


def bounds(ob):
    """Boîte englobante (min, max) du maillage au repos, en coordonnées du jeu."""
    pts = [ob.matrix_world @ v.co for v in ob.data.vertices]
    g = [(p.x, p.z, -p.y) for p in pts]
    return tuple(min(c[i] for c in g) for i in range(3)), tuple(max(c[i] for c in g) for i in range(3))


def bone_head(arm, bone):
    """Position de repos de l'os, en coordonnées du jeu."""
    h = arm.matrix_world @ arm.data.bones[bone].head_local
    return (h.x, h.z, -h.y)


def attach(ob, arm, bone, name=None):
    """Accroche ob à l'os (il suit ses animations) sans le déplacer."""
    mw = ob.matrix_world.copy()
    ob.parent = arm
    ob.parent_type = 'BONE'
    ob.parent_bone = bone
    ob.matrix_world = mw
    if name:
        ob.name = ob.data.name = name
    return ob


def parent_keep(child, parent, name=None):
    """child devient enfant de parent sans bouger."""
    mw = child.matrix_world.copy()
    child.parent = parent
    child.matrix_world = mw
    if name:
        child.name = child.data.name = name
    return child


# ---------------------------------------------------------------------
#  Export et aperçu
# ---------------------------------------------------------------------
def export_glb(ob, path, animations=False):
    """Exporte ob et tous ses descendants (avec les animations de l'armature si demandé)."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    bpy.ops.object.select_all(action='DESELECT')
    for o in [ob, *ob.children_recursive]:
        o.select_set(True)
    bpy.ops.export_scene.gltf(filepath=path, export_format='GLB', use_selection=True, export_yup=True,
                              export_image_format='AUTO', export_apply=True, export_animations=animations,
                              export_animation_mode='ACTIONS')
    print('EXPORT', path, os.path.getsize(path), 'octets')


def preview(objs, path, size=512, dist=1.6, target=(0, 0.15, 0), w=None, yaw=None, height=0.45):
    """yaw : angle de la caméra autour de la cible (0 = de face, côté +z du jeu) ; sinon vue par défaut."""
    """Rendu PNG rapide (Workbench, couleurs de la texture) pour vérifier le modèle."""
    scn = bpy.context.scene
    scn.render.engine = 'BLENDER_WORKBENCH'
    scn.display.shading.light = 'STUDIO'
    scn.display.shading.color_type = 'TEXTURE'
    scn.display.shading.show_shadows = True
    scn.display.shading.show_cavity = True
    scn.render.resolution_x = w or size
    scn.render.resolution_y = size
    scn.render.film_transparent = False
    scn.world = scn.world or bpy.data.worlds.new('w')
    scn.world.color = (0.17, 0.16, 0.2)
    cam = bpy.data.objects.new('cam', bpy.data.cameras.new('cam'))
    scn.collection.objects.link(cam)
    scn.camera = cam
    tgt = P(*target)
    if yaw is None:
        cam.location = tgt + Vector((dist * 0.75, -dist, dist * 0.45))
    else:
        import math
        cam.location = tgt + P(math.sin(yaw) * dist, dist * height, math.cos(yaw) * dist)
    cam.rotation_euler = (tgt - cam.location).to_track_quat('-Z', 'Y').to_euler()
    scn.render.filepath = path
    bpy.ops.render.render(write_still=True)
    bpy.data.objects.remove(cam)
    print('APERCU', path)
