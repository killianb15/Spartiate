# Spartiate Arènes

Jeu de combat 3D dans le navigateur, avec un mode en ligne (internet ou réseau local).

## Lancer le jeu

Seul prérequis : **Python 3.7 ou plus récent** (aucune bibliothèque à installer)
et une connexion Internet (Three.js et les polices sont chargés depuis un CDN).

| Système          | Commande                                         |
|------------------|--------------------------------------------------|
| Windows          | double-clic sur `jouer.bat`                      |
| Linux / macOS    | `./jouer.sh` (ou double-clic → « Exécuter »)     |
| N'importe où     | `python3 serveur.py`                             |

Le navigateur s'ouvre tout seul sur <http://localhost:8123>. Laisse la fenêtre
du terminal ouverte pendant la partie ; `Ctrl+C` (ou fermer la fenêtre) arrête le jeu.

Options :

- un autre port : `jouer.bat 9000`, `./jouer.sh 9000` ou `python3 serveur.py 9000`
- sans ouvrir le navigateur : `--no-browser`

> Ouvrir `index.html` directement (double-clic) ne marche pas : le navigateur
> bloque le chargement des modèles 3D hors d'un serveur.

### Installer Python

- **Windows** : <https://www.python.org/downloads/> (cocher « Add python.exe to PATH »),
  ou `winget install Python.Python.3.12`
- **Debian / Ubuntu** : `sudo apt install python3`
- **Fedora** : `sudo dnf install python3`
- **Arch** : `sudo pacman -S python`

## Touches

Bouton **Configurer les touches** dans le menu (ou **Touches** dans le menu pause) :
clique sur une case puis appuie sur la touche voulue. Chaque action a deux touches
possibles par joueur ; `Suppr` vide une case, `Échap` annule. Les réglages sont
gardés dans le navigateur. En solo et en ligne, les touches des deux joueurs
contrôlent ton personnage.

## Jouer en ligne

Par internet : ouvrez tous les deux https://combat.gashrod.lol, l'hôte crée la partie,
l'invité entre le code à 4 lettres.

En réseau local, sans internet :

1. Celui qui crée la partie lance le jeu ; le terminal affiche une adresse du type
   `http://192.168.1.42:8123`.
2. L'autre joueur, sur le même Wi-Fi / réseau, ouvre cette adresse dans son navigateur
   (il n'a rien à installer).
3. L'hôte crée la partie, l'invité entre le code à 4 lettres.

Si l'ami n'arrive pas à se connecter, c'est presque toujours le pare-feu du PC hôte :

- **Windows** : à la première ouverture, accepter la fenêtre du pare-feu pour Python
  (cocher « Réseaux privés »).
- **Linux** : ouvrir le port, par exemple `sudo ufw allow 8123/tcp`
  ou `sudo firewall-cmd --add-port=8123/tcp`.

## Netcode

Le combat est conçu pour rester précis en ligne :

- **Simulation déterministe** (`sim.js`) : pas fixe de 1/60 s, maths sans fonction
  approximée par le navigateur. Les mêmes touches donnent le même résultat bit pour bit
  dans Chrome et Firefox (vérifié : `tests/fingerprint.js`).
- **Rollback** (`rollback.js`) : ses propres touches agissent tout de suite ; celles de
  l'adversaire sont prédites puis corrigées en revenant en arrière. Les corrections sont
  lissées à l'affichage, et les animations recalées sur la simulation.
- **Synchronisation des horloges** : le joueur en avance ralentit de quelques %, pour que
  les deux voient le moins de corrections possible.
- **Délai d'entrée adaptatif** : 2 images (33 ms), 3 si le ping dépasse ~70 ms.
- **WebRTC** (`net.js`) : connexion directe entre navigateurs ; le serveur ne sert qu'à se
  trouver. Repli automatique par le serveur si la connexion directe est impossible.

L'indicateur en bas à gauche montre la liaison (`direct` / `relais`), le ping, le délai et
le nombre de corrections (↺).

Tests : `node --test tests/*.test.js` et `python3 -m unittest discover -s tests`.
