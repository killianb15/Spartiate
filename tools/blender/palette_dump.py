# Affiche la couleur au centre de chaque case de la palette Kenney (grille 16 x 16 de 32 px)
#   blender -b --factory-startup -P tools/blender/palette_dump.py -- <chemin absolu du png>
import bpy, sys
img = bpy.data.images.load(sys.argv[sys.argv.index('--') + 1])
w, h = img.size
px = img.pixels[:]
for row in range(16):          # row 0 = haut de l'image
    out = []
    for col in range(16):
        x, y = col * 32 + 16, h - 1 - (row * 32 + 16)   # pixels Blender : origine en bas
        i = (y * w + x) * 4
        out.append('#%02x%02x%02x' % tuple(round(v * 255) for v in px[i:i + 3]))
    print('ROW', row, ' '.join(out))
