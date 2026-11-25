# Spartiate Arènes

Jeu de combat 3D dans le navigateur, avec un mode en ligne en réseau local.

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

## Comptes joueurs (facultatif)

Un compte (pseudo + mot de passe) garde ton **record et tes statistiques** de donjon, affiche ton
**pseudo en ligne** (salons, équipier) et te place au **classement**. Sans lui, tout le jeu marche pareil.

Il faut **Docker** ; une seule fois, sur le PC qui lance le serveur :

1. copier `.env.exemple` en `.env` et y mettre un mot de passe aléatoire
   (`python -c "import secrets; print(secrets.token_hex(24))"`) ;
2. `docker compose up -d --build` (la 1re fois, compile l'API : quelques minutes) ;
3. lancer le jeu comme d'habitude (`jouer.bat`) : la fenêtre indique « Comptes joueurs : activés ».

Architecture et sécurité :

- **API en Rust** (`api/` : axum + sqlx), seule à parler à la base ; mots de passe hachés en
  **Argon2id**, jetons de session aléatoires dont seule l'empreinte SHA-256 est stockée, essais de
  connexion limités par adresse, corps de requête limités à 4 Ko, requêtes SQL paramétrées ;
- **PostgreSQL** sur un réseau Docker interne, **sans aucun port publié** : inaccessible depuis le
  PC comme depuis Internet ; l'API n'écoute que sur `127.0.0.1:8124` ;
- `serveur.py` relaie seulement les routes prévues (`/api/inscription`, `connexion`, `deconnexion`,
  `profil`, `partie`, `classement`) ; il ne sert jamais les fichiers cachés (`.env`, `.git`…).
- Derrière nginx (VPS) : `SPARTIATE_PROXY=1` (déjà dans `deploy/spartiate.service`) pour lire
  l'adresse du joueur dans `X-Real-IP`.
- Tests : `cargo test` dans `api/`, et `python tests/test_comptes.py` (pile Docker de test séparée,
  détruite à la fin).

## Touches

Bouton **Configurer les touches** dans le menu (ou **Touches** dans le menu pause) :
clique sur une case puis appuie sur la touche voulue. Chaque action a deux touches
possibles par joueur ; `Suppr` vide une case, `Échap` annule. Les réglages sont
gardés dans le navigateur. En solo et en ligne, les touches des deux joueurs
contrôlent ton personnage.

## L'Archer

Personnage jouable (arène et donjon), qu'on retrouve aussi comme ennemi dans le donjon à partir de la salle 2.
**Attaquer** tire une flèche, ou donne un coup d'arc si l'adversaire est collé. On peut aussi tirer en sautant.
- Une flèche se **bloque** (au prix de la garde), s'évite d'un **pas de côté**, d'un **saut** ou d'une **roulade**,
  et une **parade** au bon moment la **renvoie** vers le tireur.
- L'archer court un peu plus vite, mais encaisse moins bien en bloquant au corps à corps.

Le modèle `assets/archer/archer.glb` (une archère elfe) est généré avec Blender par
`tools/blender/archer.py` (voir « Modèles générés avec Blender ») : il part d'un corps Kenney
(`tools/blender/sources/character-female-f.glb`, CC0) pour avoir exactement leur style et leurs
animations, recoloré (tunique verte, cheveux blancs d'elfe), avec ses propres oreilles étirées en oreilles
d'elfe et un carquois. L'arc n'est pas dans le modèle : c'est `assets/weapons/weapon-bow.glb`, que le jeu met en
main à qui le choisit (l'archère l'a par défaut).
`arrow.glb` est la flèche. L'ancien générateur `tools/archer-asset.html` n'est plus utilisé.

## Mode Donjon (rogue-like, expérimental)

Dans le menu, choisis **Jeu → Donjon (rogue-like)** (ou ouvre `http://localhost:8123/?dungeon`).
Vue isométrique, mêmes coups qu'en arène (attaque, blocage, parade, brise-garde, roulade).
Élimine les ennemis de la salle : la porte du fond s'ouvre et un coffre apparaît. Il propose
trois bénédictions (soin, force, vitalité…). Franchis ensuite la porte pour passer à la salle
suivante. Les premières salles sont bien éclairées ; plus loin, il fait plus sombre et on
trouve des estrades (on y monte par l'escalier ou en sautant) et des pièges à pics. Un chef
orc garde chaque 5ᵉ salle.

Le donjon se joue **seul**, **à deux sur le même clavier** ou **en ligne en coopération**
(mêmes étapes que pour le combat en ligne). À deux, il y a plus d'ennemis. Chacun choisit sa
bénédiction (J1 : touches `1 2 3`, J2 : `8 9 0`). Un héros tombé se relève à la salle
suivante, et la partie s'arrête quand les deux sont tombés. La logique est dans `dungeon.js`.

### Salle d'armes (choix du héros et de l'arme)

Une partie de donjon commence dans la **salle d'armes** : marche sur la dalle dorée devant une
statue pour prendre ce héros, sur la dalle bleue devant un présentoir pour prendre l'arme, puis
passe la porte. Le choix est retenu pour la partie suivante. À deux, chacun choisit le sien.

| Héros      | Talent                              | | Arme              | Effet                                         |
|------------|-------------------------------------|-|-------------------|-----------------------------------------------|
| Gladiateur | équilibré                           | | Glaive et bouclier| équilibré, enchaînement de 3 coups            |
| Mirmillon  | +10 % de dégâts                     | | Lance             | portée longue, 2 coups par enchaînement       |
| Orc        | 120 PV                              | | Épée et pavois    | bloque bien mieux, court moins vite           |
| Archère    | endurance +25 %                     | | Hache et bouclier | gros dégâts, 2 coups par enchaînement         |
| Chevalier  | −15 % de dégâts subis               | | Marteau de guerre | 1 coup écrasant qui ruine la garde, sans bouclier |
| Zombie     | chaque coup porté soigne 1 PV       | | Arc               | tire des flèches, court vite, bloque mal      |
| Automate   | 110 PV, −8 % de dégâts subis        | | Sceptre de feu    | boules de feu qui explosent en zone           |
|            |                                     | | Grimoire          | invoque des chiens qui se battent pour toi    |

**Sceptre de feu** : l'attaque lance une boule de feu, plus lente qu'une flèche. Elle explose au
contact d'un ennemi, d'un mur, d'une colonne ou en fin de course, et blesse **tous** les ennemis
dans un rayon de 1,7 (en les soufflant vers l'extérieur). On l'évite d'une roulade ; bloquer face à
l'explosion la fait encaisser par la garde ; une parade au bon moment la renvoie au lanceur.

**Grimoire** (tenu dans la main gauche) : l'attaque invoque un **chien** devant toi (30 d'endurance),
2 chiens au plus par joueur ; avec deux chiens, l'attaque devient un coup de livre. Les chiens sont
pilotés par l'IA, dans la simulation : ils attaquent les ennemis à ta place, les ennemis s'en prennent
aussi à eux, et ils disparaissent à la salle suivante (on peut les essayer dans la salle d'armes).
Un chien tombé ne compte pas comme un héros à terre.

Le chevalier, le zombie et l'automate viennent du pack Kenney *Mini Characters* (CC0,
`assets/characters/`). Des zombies apparaissent aussi comme ennemis à partir de la salle 4.
Le choix passe par la position du héros dans la simulation : il fonctionne tel quel en ligne.

Tests : `node --test tests/`. Ajouter `&debug` à l'adresse (`?dungeon&debug`) expose la simulation
dans la console du navigateur (`spartiate.sim`), pratique pour tester une salle à la main.

## Modèles générés avec Blender

La hache, le marteau, le sceptre, le grimoire (`assets/weapons/`), le chien invoqué
(`assets/summons/dog.glb`) et l'arc sont des modèles originaux générés **par script**
avec Blender, sans interface. Ils utilisent la palette Kenney (`colormap.png`) : mêmes teintes
que le reste du jeu.

```
"C:\Program Files\Blender Foundation\Blender 5.3\blender.exe" -b --factory-startup -P tools/blender/weapons.py
```

- `tools/blender/kenney.py` : la boîte à outils (boîtes arrondies, cylindres, prismes, couleurs
  de la palette par leur nom, export GLB, aperçu PNG).
- `tools/blender/weapons.py` : les armes ; modifie une forme ou une couleur et relance la commande.
- `tools/blender/archer.py` : l'archère, sa flèche et l'arc (même commande, avec `archer.py`).
- `tools/blender/dog.py` : le chien invoqué. Il est fait de pièces articulées (corps, tête, queue,
  pattes) que le jeu anime lui-même (`DogView` dans `game.js`), le squelette Kenney étant humanoïde.
- `tools/blender/check_weapons.py` : vérifie la tenue des armes pendant les coups, comme dans le jeu
  (planche `previews/coups.png` : une ligne par arme, une colonne par instant du coup ; `COMBO=2`
  pour le balayage, `VIEW`/`HEIGHT`/`DIST` pour la caméra). Pendant un coup, le jeu oriente l'arme le
  long d'un arc (`swingPose` dans `game.js`) : les animations Kenney font tourner le bras sur lui-même
  et une arme simplement fixée à la main pointerait vers l'arrière au moment de l'impact.
- `tools/blender/previews/` : aperçus rendus à chaque génération, à côté de l'épée Kenney pour l'échelle.
- Convention des armes : la main tient l'arme à l'origine, l'arme monte le long de +Y.

## Jouer en ligne (réseau local)

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
