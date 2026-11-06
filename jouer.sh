#!/usr/bin/env sh
# Lance Spartiate Arènes (Linux / macOS) : ./jouer.sh  [port]
cd "$(dirname "$0")" || exit 1

for py in python3 python; do
    if command -v "$py" >/dev/null 2>&1 &&
       "$py" -c 'import sys; sys.exit(sys.version_info < (3, 7))' 2>/dev/null; then
        exec "$py" serveur.py "$@"
    fi
done

echo "Python 3.7 ou plus récent est nécessaire pour lancer le jeu."
echo "  Debian/Ubuntu : sudo apt install python3"
echo "  Fedora        : sudo dnf install python3"
echo "  Arch          : sudo pacman -S python"
echo "  macOS         : brew install python"
exit 1
