# Spartiate — notes pour Claude

Jeu de combat 3D dans le navigateur (Three.js 0.160 par CDN, modules ES, sans build) + mode Donjon
rogue-like, jouable seul, à deux sur un clavier ou en ligne (rollback). Tout le code, les commentaires,
les textes du jeu et les échanges avec l'utilisateur sont **en français**.

## Lancer / tester
- Jeu : `python serveur.py` (port 8123) → http://localhost:8123 ; `?dungeon` lance le donjon directement,
  `&debug` expose `window.spartiate.sim` / `.views` dans la console. Ouvrir index.html en fichier ne marche pas.
- Tests : `node --test tests/*.test.js` (tous doivent passer ; ~90 tests ; `node --test tests/` échoue ici). `tests/test_server.py` pour le serveur.
- Après une modif de `game.js`, l'utilisateur doit faire **Ctrl+F5** (cache).
- Test dans un vrai navigateur (pas de Chrome/Edge connecté ici) : Chromium de Playwright présent dans
  `%LOCALAPPDATA%\ms-playwright\chromium-1217\chrome-win64\chrome.exe`, piloté par `tools/browser-test.mjs`
  (mode d'emploi en tête du fichier : serveur sur 8137, Chromium headless sur 9333, captures + ETAT + erreurs ;
  scénarios tome, staff, shop, biomes, boss). Chromium headless est lent (quelques images/s) : pour une capture
  précise, figer la simulation (`s.step = () => {}`) et appeler l'ancien step à la main.
  Il a déjà trouvé des plantages invisibles aux tests de simulation : l'utiliser après un changement d'affichage.
- Penser à arrêter ensuite le serveur et Chromium (ports 8137 / 9333).

## Architecture
- `sim.js` : simulation pure et **déterministe** (pas de Three.js/DOM/son, pas de `Math.random`, pas de
  `Math.sin/cos` : utiliser `dmath.js`). Pas fixe 1/60 s, état « plat » (save/load/hash) pour le rollback.
  Ce qui se voit/s'entend sort en événements `sim.ev` (`sfx`, `emit`, `ring`, `pop`, `fx`, `shake`…).
- `dungeon.js` : `DungeonSim extends Sim` (salles, ennemis, IA dans la sim, coffre/bénédictions,
  salle d'armes, chiens invoqués). `ai.js` : IA (vise toujours `sim.target(i)`). `rollback.js`, `net.js` : en ligne.
- `game.js` : tout l'affichage (vues, caméra, HUD, menus, sons). Il **lit** l'état de la sim, ne le modifie pas.
  Les entrées passent par `step(entrée0, entrée1)` (y compris les choix de bénédiction) pour le rollback.
- Toute nouvelle règle de jeu va dans la sim (sinon désynchronisation en ligne) et se teste dans `tests/`.

## Donjon : points clés
- **Salle d'armes** (`startHub`, phase `'hub'`, salle 0) : on change de héros en marchant sur des
  dalles (`HUB_PADS`, `hubPads`) devant les statues (mur x = -R). Les choix sont retenus dans
  `cfg.p1/w1` (localStorage). Dans le menu, le choix du perso est masqué en mode donjon.
- **Marchand d'armes** (`MERCHANT`, à droite de la porte, comptoir = 3 obstacles `kind 'counter'`) :
  la dalle `t: 'shop'` fait entrer le héros dans la boutique (`p.shop` = 1 + arme montrée, `p.shopIn`
  = anti-répétition ; 7 = attendre qu'on relâche la direction tenue en arrivant). Dans `step`, l'entrée
  d'un héros en boutique passe par `shopStep` puis devient NEUTRAL : ← → (mx) font défiler, attaque/saut
  achète, reculer (mz > 0) / bloquer / roulade s'en va ; `shopInput(n)` (mx = 110 + n) prend l'arme n
  directement (clic, touches 1 à 8). Affichage (`buildMerchant`, `shopSync`) : la caméra passe derrière
  le héros local en boutique (`camAng = 0`, donc les flèches suivent l'écran), bulle `#talk`, panneau
  `#shop`, carrousel d'armes sur le comptoir, réactions du marchand déduites de l'état (pas d'événements).
- **Héros** (`HEROES` dans dungeon.js, avec un talent) : soldier (Gladiateur), human (Mirmillon), orc,
  archer (Archère), knight (Chevalier), zombie, robot (Automate). `equip(p, kind, wpn)` applique stats + talent.
- **Armes** (`WEAPONS` dans sim.js, `wpnOf(f)`) : sword, spear, tower, axe, hammer, staff (sceptre de feu),
  tome (grimoire), bow ; `bite` = crocs des chiens (`hidden`, pas proposée). Champs : reach, dmg, combo,
  run, guard (coût du blocage), crush, bow (tir), fire (boule de feu), summon (invocation).
  `f.arch` = arme à distance. Défaut : `defaultWeapon(kind)` (archère → arc).
- **Sceptre** : projectiles `sim.pr` avec `k: 1` (flèches `k: 0`), `explode()` = dégâts de zone (`FIRE`).
- **Grimoire** : `summon()` ajoute un chien (`kind 'dog'`, `team 0`, `owner`) + son IA ; 2 max (`CAST.max`).
  Les fighters ont un **camp** `team` (0 héros + chiens, 1 ennemis) : `target`, `foeOf`, `foesLeft`, les
  frappes et `onKO` raisonnent par camp ; `isHero(f)` (idx < np) reste pour ce qui concerne les joueurs.
  Les chiens disparaissent à la salle suivante (f = héros + ennemis de la nouvelle salle).
- Ennemis (`FOES`) : grunt/guard/elite/archer + zombie (salle ≥ 4, sans tirage aléatoire en plus).
- **Boss** (`boss: true` dans FOES, une salle sur 5, `bossOf(n)` : chef orc salles 5, 15… ; colosse 10, 20…).
  `room.bossId`. **Colosse d'airain** (`colosse` : robot ×1,9, marteau, `moves`) : attaques spéciales réglées
  par `BOSS`, état `'special'` + `f.sp` ('slam' saut écrasant, 'charge', 'roar' = rage à 50 % PV qui appelle
  des zombies `adds`). Seuls les ennemis à `moves` ont les champs `sp, spT, spA, spX, spZ, spHit, spCd, rage`
  (`sp !== undefined` les repère). `bossThink` décide (rng de la sim), `special` avance avant `updateFighter`,
  pendant une spéciale il encaisse sans broncher (`armorHit`). Charge dans un mur/obstacle = sonné.
  Affichage : `bossTele` (zones au sol déduites de l'état), `bossHud` + `#bossBar` (grande barre en haut,
  pas de petite barre au-dessus des boss), teinte bronze et lueur de rage dans `makeView`/`FighterView`.
- **Outil de débogage** (F2, hors ligne) : `#dbg` dans index.html, `setupDebug`/`dbgGoto` dans game.js,
  méthodes `debugGoto/Kill/Heal/God/Spawn/Tp/Boss` de DungeonSim (testées dans tests/boss.test.js).
  `dng.room = -1` force la reconstruction de la salle.
- Vues : `makeView`/`extraViews` créent les vues au fil des invocations sans reconstruire la salle ;
  `heroViews` remplace la vue d'un héros qui change de perso/arme.

## Performances de l'affichage (game.js) : règles à respecter
- Changer de salle/arène passe par `clearWorld()` : tout ce qui est dans `world` est **libéré** (géométries,
  matériaux, textures, carte d'ombre du soleil, ciel), sauf ce qui est marqué `keep(...)` (`KEEP`) : modèles
  chargés (marqués au chargement) et formes/matériaux partagés déclarés au niveau du module. Un nouvel objet
  partagé entre salles doit être passé à `keep()`, sinon il sera détruit à la salle suivante.
- `FighterView.dispose()` libère aussi ses matériaux clonés, son squelette (texture des os) et sa barre de vie.
- Lumières : leur nombre fait partie des shaders (un nombre nouveau = tout recompiler) ; `padLights()` complète
  au multiple de 4 en fin de construction. Une lumière qui apparaît en cours de jeu doit exister dès la
  construction, éteinte (comme celle du coffre).
- Dalles plates et immobiles : `PT()` au lieu de `P()` (regroupées en InstancedMesh par `flushTiles()`,
  sans ombre projetée). `inst()` ne fait pas projeter d'ombre aux modèles `*floor*` ni à la lave.
- Anneaux (`ring`) : réserve réutilisée, ne pas recréer de matériau par effet. Particules : retrait par échange.
- HUD : écrire via `setTxt` / `setW` / `setCls` (seulement quand la valeur change).
- Mesurer : avec `?debug`, `spartiate.renderer.info` (memory.geometries/textures, programs.length,
  render.calls) et `spartiate.debugGoto(n)` ; ces compteurs doivent rester stables d'une salle à l'autre.
- Piste restante : murs générés des biomes très détaillés (basalt-wall ≈ 3000 triangles, ruin-wall-broken
  ≈ 2600, contre une centaine pour un mur Kenney) : la forge dépasse 180 000 triangles. À simplifier dans
  tools/blender/biomes.py.

## Affichage des armes (game.js)
- `heldWeapon(key, s, back)` : arme dans la main droite (repère du bras, direction `SWORD_DIR`).
- Les animations Kenney font tourner le bras pendant la frappe : une arme fixe pointerait vers
  l'arrière à l'impact. Pendant un coup, `swingPose()` + `FighterView.swing()` orientent l'arme le long
  d'un arc (coups 1/3 et en l'air : de haut en bas, tranchant devant ; coup 2 : balayage, fini avant 0,2 s
  car le bras droit recule ; lance : estoc ; sceptre : levé puis pointé). Vérifié avec `tools/blender/check_weapons.py`.
- Le « bouclier » (main gauche) est redressé à chaque image ; l'arc et le grimoire y prennent sa place.
  Les matériaux lumineux (`MeshBasicMaterial` : orbe, rune) n'ont pas d'`emissive` : ne pas leur appliquer
  les effets de flash/lueur.
- Le chien n'a pas de squelette : `DogView` anime ses pièces (même interface que `FighterView`).

## Modèles 3D : Blender en ligne de commande
- Blender 5.3 installé : `"C:\Program Files\Blender Foundation\Blender 5.3\blender.exe" -b --factory-startup -P tools/blender/<script>.py`
  (passer des chemins **absolus** Windows aux scripts ; `cygpath -wa` depuis bash).
- `tools/blender/kenney.py` : boîte à outils. Positions/rotations écrites dans le **repère du jeu** (+Y haut,
  radians, ordre XYZ, comme three.js). Couleurs par nom = cases de la palette Kenney (`colormap.png`,
  grille 16×16 de 32 px ; colonnes paires unies, impaires en dégradé). `kenney_character()` importe un
  perso Kenney complet, `recolor()` change ses familles de couleurs, `attach()` accroche une pièce à un os,
  `preview(..., yaw=, height=)` rend un PNG (Workbench) **à regarder systématiquement** avant de livrer.
- Scripts : `weapons.py` (hache, marteau, sceptre `orb`, grimoire `rune` → `assets/weapons/`),
  `archer.py` (archère + `arrow.glb` + `weapon-bow.glb` : nœuds `bow` > `nocked`), `dog.py`
  (`assets/summons/dog.glb` : `dog` > `body` > head/tail/leg-fl/fr/bl/br/glow), `check_weapons.py`,
  `merchant.py` (vieux marchand : Kenney male-b chauve et barbu, barbe blanche ALLONGÉE en déplaçant ses
  sommets, robe violette, couronne de cheveux ; + étal `stall.glb` → `assets/npc/`).
  Aperçus dans `tools/blender/previews/`. Base de l'archère : `tools/blender/sources/character-female-f.glb`.
- Squelette Kenney : os root, leg-left/right, torso, arm-left/right, head ; rotations de repos nulles,
  bras à l'horizontale, visage vers +z. Les nœuds nommés exportés gardent leur nom ; exporter un objet
  dans une scène vide si un homonyme existe (sinon `bow.001`).
- `tools/archer-asset.html` (ancien générateur three.js) n'est plus utilisé : il écraserait l'archère.
- Les GLB générés embarquent la palette (~100-300 Ko) ; ceux de Kenney la référencent (`Textures/colormap.png`).

## Assets
- Packs Kenney CC0 : `assets/arena`, `assets/dungeon`, `assets/characters` (Mini Characters : seulement
  knight, zombie, robot + colormap). **Pas de personnages modernes** (demande de l'utilisateur).
- Nos modèles : `assets/archer`, `assets/weapons`, `assets/summons`, `assets/npc` (marchand, étal).

## Préférences de l'utilisateur
- Veut le **style Kenney** partout (mêmes proportions, palette, peu de détails). Pour modifier un perso
  Kenney, **modifier son maillage** (ex. oreilles d'elfe = sommets des oreilles d'origine étirés,
  `elf_ears` dans archer.py) plutôt que d'ajouter des pièces par-dessus.
- Archère : corps Kenney female-f, cheveux blancs (façon elfe), tunique verte, oreilles pointues, carquois ;
  l'arc n'est pas dans le modèle (il est pris en main comme arme).
- Vérifier visuellement (aperçus Blender, captures navigateur) et tester à fond ce qui est livré.
- Ne pas recréer de personnages d'autres jeux (refusé : Link) ; proposer un héros original à la place.
- Idées laissées en suspens : héros original
  « Écuyer des bois » proposé ; GLB plus légers (palette externe).
