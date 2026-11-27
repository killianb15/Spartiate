# Spartiate — notes pour Claude

Jeu de combat 3D dans le navigateur (Three.js 0.160 par CDN, modules ES, sans build) + mode Donjon
rogue-like, jouable seul, à deux sur un clavier ou en ligne (rollback). Tout le code, les commentaires,
les textes du jeu et les échanges avec l'utilisateur sont **en français**.

## Lancer / tester
- Jeu : `python serveur.py` (port 8123) → http://localhost:8123 ; `?dungeon` lance le donjon directement,
  `&debug` expose `window.spartiate.sim` / `.views` dans la console. Ouvrir index.html en fichier ne marche pas.
- Tests : `node --test tests/*.test.js` (tous doivent passer ; ~170 tests ; `node --test tests/` échoue ici). `tests/test_server.py` pour le serveur.
- Après une modif de `game.js`, l'utilisateur doit faire **Ctrl+F5** (cache).
- Test dans un vrai navigateur (pas de Chrome/Edge connecté ici) : Chromium de Playwright présent dans
  `%LOCALAPPDATA%\ms-playwright\chromium-1217\chrome-win64\chrome.exe`, piloté par `tools/browser-test.mjs`
  (mode d'emploi en tête du fichier : serveur sur 8137, Chromium headless sur 9333, captures + ETAT + erreurs ;
  scénarios tome, staff, shop, biomes, boss, gloves, compte, cerbere, morsure, objets, sorcier). Chromium headless est lent (quelques images/s) : pour une capture
  précise, figer la simulation (`s.step = () => {}`) et appeler l'ancien step à la main.
  Il a déjà trouvé des plantages invisibles aux tests de simulation : l'utiliser après un changement d'affichage.
- Penser à arrêter ensuite le serveur et Chromium (ports 8137 / 9333).

## Comptes joueurs (api/, Rust)
- `api/` : axum + sqlx (PostgreSQL), migrations dans `api/migrations/` (jamais modifier une migration
  passée : en ajouter une, ex. amis/guildes). Routes : sante (interne), inscription, connexion,
  deconnexion, profil, partie (fin de donjon), classement. Argon2id, jetons (empreinte SHA-256 en base),
  freins par adresse (`FREIN_CONNEXION/INSCRIPTION`, adresse = `X-Real-IP` posé par serveur.py).
- `docker-compose.yml` : **tout en conteneurs** : `jeu` (Dockerfile à la racine, python:alpine, utilisateur `jeu`,
  `.dockerignore` en liste blanche : serveur.py, index.html, *.js, assets), publié sur `SPARTIATE_PORT` (8123, ouvert
  au réseau local), parle à `http://api:8124` sur le réseau `sortie` (pas sur `interne` : il ne joint pas la base) ;
  `api` aussi publiée sur 127.0.0.1:8124 (pour jouer.bat hors conteneur) ; `db` sans port publié sur `internal`.
  Lecture seule, cap_drop ALL. Mot de passe dans `.env` (ignoré par git ; modèle `.env.exemple`). En conteneur,
  `SPARTIATE_DOCKER=1` : l'adresse « pour ton ami » vient de `SPARTIATE_URLS` (`public_urls()` dans serveur.py).
  **Fins de ligne** : `*.sql` forcés en LF (.gitattributes) : sqlx garde l'empreinte des migrations, une conversion
  CRLF (autocrlf de Windows) fait planter l'API (`VersionMismatch`).
  Pile de test : `docker compose -p spartiate-test` avec API sur 8125 et jeu sur 8126.
- `serveur.py` reste en bibliothèque standard : il relaie `API_ROUTES` vers `SPARTIATE_API`, répond
  `/api/etat`, met le pseudo vérifié (`pseudo_of(token)`) dans les salons, ne sert pas les fichiers cachés.
  `SPARTIATE_PROXY=1` (VPS derrière nginx) : adresse du joueur lue dans X-Real-IP, seulement si la connexion vient
  d'une adresse privée (`private_peer` : nginx, Docker), sinon l'en-tête pourrait être inventé.
- **Déploiement** (`.github/workflows/deploy.yml`, push sur master) : tests, rsync vers `/home/ubuntu/spartiate`
  (sans `.env`, ni effacé ni envoyé), puis sur le VPS : `.env` créé une seule fois (mot de passe aléatoire +
  `SPARTIATE_PROXY=1`), `docker compose build` (avant la bascule), arrêt de l'ancien service systemd `spartiate`,
  `docker compose up -d`, vérification de `/api/etat` (`comptes: true`) ; en cas d'échec : `stop jeu` et retour au
  service systemd (toujours installé, `deploy/spartiate.service`). nginx (Docker) → `host.docker.internal:8123`.
- game.js : `compte`, `api()`, `setupAccount`, `accountRun` (appelé par `endDungeon`), `myName()`,
  `net.peerName` (pseudo de l'équipier, reçu dans `hello`). Bloc `#acctSec` du menu, masqué sans API.
- **Défis des héros** : définis et comptés côté serveur (`api/src/defis.rs` : `DEFIS`, 4 par héros, mesures
  Ennemis/Salles/Record/Boss/Arme/EnLigne/Parties ; identifiants stables gardés dans `defis_reussis`).
  La sim compte les victimes de chaque héros (`p.kills`, chiens compris, remis à zéro par `start`/`startHub`) ;
  `endDungeon` envoie `{salle, ennemis: kills, heros, arme}` à /api/partie qui renvoie `nouveaux` (annoncés
  dans `#resDefis`). Panneau « Défis » du menu (`accountChallenges`, `challengesHTML`). Garder `HEROS`/`ARMES`
  de defis.rs alignés sur HEROES/WEAPONS. Scénario navigateur : `browser-test.mjs compte` (sur l'API de test).
- **Héros verrouillés** : seul `FIRST_HERO` (Gladiateur) au départ ; chaîne = ordre de `HERO_IDS` / `HEROS`
  (defis.rs `debloques` : un défi réussi du héros précédent débloque le suivant, renvoyé dans le profil). Sans
  compte (invité, expliqué par `#acGuest` dans le bloc Compte) : Gladiateur seulement. La sim reçoit les listes (`new DungeonSim(seed, kinds, wpns, unlocked)`,
  `canPick(i, kind)`, pas de l'état ; null = tout permis pour les tests) ; en ligne elles passent dans
  `hello`/`start` (`u1`, `u2`). Affichage : statues de pierre + 🔒 (`buildHub`), boutons du menu de l'arène
  désactivés (`refreshMenu`), `clampHeroes()` remet le Gladiateur à la place d'un choix verrouillé.
- Tests : `cargo test` (api/) ; `python tests/test_comptes.py` (pile `docker compose -p spartiate-test`,
  API de test sur 8125, détruite à la fin ; vide la base via `docker compose exec db psql`).

## Architecture
- `sim.js` : simulation pure et **déterministe** (pas de Three.js/DOM/son, pas de `Math.random`, pas de
  `Math.sin/cos` : utiliser `dmath.js`). Pas fixe 1/60 s, état « plat » (save/load/hash) pour le rollback.
  Ce qui se voit/s'entend sort en événements `sim.ev` (`sfx`, `emit`, `ring`, `pop`, `fx`, `shake`…).
- `dungeon.js` : `DungeonSim extends Sim` (salles, ennemis, IA dans la sim, butin/salles au trésor,
  salle d'armes, chiens invoqués). `ai.js` : IA (vise toujours `sim.target(i)`). `rollback.js`, `net.js` : en ligne.
- `game.js` : tout l'affichage (vues, caméra, HUD, menus, sons). Il **lit** l'état de la sim, ne le modifie pas.
  Les entrées passent par `step(entrée0, entrée1)` (objets ramassés en marchant dessus : rien à transmettre) pour le rollback.
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
  directement (clic, touches 1 à 9). Affichage (`buildMerchant`, `shopSync`) : la caméra passe derrière
  le héros local en boutique (`camAng = 0`, donc les flèches suivent l'écran), bulle `#talk`, panneau
  `#shop`, carrousel d'armes sur le comptoir, réactions du marchand déduites de l'état (pas d'événements).
- **Sorts** (`SPELLS` dans sim.js, touche Q) : un par héros (clé = `kind`) + `stone` (Peau de pierre : `f.stoneT`,
  −60 % de dégâts via `spellShield`, ×0,5 vitesse `slowOf`, recul réduit `knockOf`, aussi pour les coups des boss)
  et `totem` (Totem de vie : `f.totT/totX/totY/totZ/totK`, `totemTick` soigne les alliés à moins de `R`, jamais
  au-dessus de maxHp, disparaît à la salle suivante). `SPELL_IDS` ; `f.spell` = clé choisie, `''` = sort du héros
  (`spellOf(f)`, `spellKey(p)`) ; gardé au changement de héros (`equip(p, kind, wpn, spell)`), transmis comme les
  armes (`new DungeonSim(seed, kinds, wpns, unlocked, spells)`, `s1/s2` dans cfg, `hello`/`start`, `net.peerSpell`,
  `packFighter`). Tous les sorts sont choisissables par tous les héros.
- **Sorcier** (`SORCERER`, à gauche de la porte : tente = 2 obstacles `kind 'tent'`, chaudron, `npc`) : dalle
  `t: 'spell'`, même boutique que le marchand avec `p.shopK = 1` (`shopList(p)` = SPELL_IDS ou WEAPON_IDS,
  `buy` → `learn`). Affichage `buildSorcerer` : carrousel d'icônes au-dessus du chaudron, caméra plongeante,
  `#shop.spells` (bordure violette), `TALKERS` choisit qui parle dans `#talk`. Modèles : `tools/blender/sorcier.py`.
  Tests : `tests/sorts.test.js` ; scénario navigateur `sorcier`.
- **Salons** (game.js, `lobby*`, `hallStart`, panneau `#lobby` d'index.html) : seul dans la salle d'armes, on
  ouvre son salon (`{t:'open', kind, wpn}` : listé par serveur.py, `rooms[code]['hall']`) ou on rejoint
  celui d'un autre (liste `{t:'list'}` redemandée toutes les 2 s en temps réel, ou code). Quand l'invité
  envoie `hello` (héros + arme), l'hôte relance la salle d'armes en ligne à deux (`start`, même graine).
  Équipier parti (`bye`) : chacun repart seul dans sa salle d'armes (l'hôte garde son salon) ; quitter
  pour le menu en donjon = quitter le salon ; franchir la porte seul ferme le salon. Testé par
  `tests/test_server.py` et `node tools/lobby-test.mjs <dossier>` (deux contextes Chromium).
- **Réanimation** (à deux, `REVIVE` dans dungeon.js) : un héros qui tombe alors que son équipier est debout reste
  `state 'dead'` avec `down = 1` (les ennemis l'ignorent comme un mort ; anim 'crouch'). `reviveTick` (phase fight) :
  un équipier en état 'block' à moins de `R` remplit `revT` ; à `time` s, `getUp` (40 % PV) ; la jauge redescend sinon.
  Salle nettoyée : tous les héros tombés se relèvent. Tous à terre (ou seul) : fin de partie comme avant.
  Affichage : `FighterView` penché en avant (`downK`, rotation 'YXZ'), jauge verte `revive()`, anneau qui clignote.
  Tests : `tests/rea.test.js` ; scénario navigateur `rea`.
- **Objets** (façon Isaac, `items.js`, passifs seulement) : `ITEMS` (~70, qualité `q` 0 commun / 1 rare / 2 épique /
  3 légendaire, `QUALITY`, `fam`, `curse` = maudit), 9 familles `FAMILIES` (3 objets = transformation, `TF_N`, champ `p.tf`),
  `COMBOS` (deux objets précis, `p.combos`), petits bonus `MINORS`. Effets = champs plats du héros (`ITEM_BASE`, posés par
  `equip`), lus par `ITEM_METHODS` (mêlé à DungeonSim) : `onHitItems`, `onKillItems`, `onHurtItems`, `procHit`, `heroTick`…
  États sur tous les combattants (`STATUS0` : `sBurnT`, `sPsn`, `sChill`, `sFrz`, `sConf`, `shrunk`, `hell`) ; `this.src`
  ('melee'/'shot'/'fire') = nature du coup en cours. Garde-fous : bonus additifs, `CAPS`, effets secondaires sans
  « au coup porté ». Obtention : `sim.pk` (objets au sol `{n, t: item|heart|minor, v, x, z, grp, q, arm}`, pris en marchant
  dessus par `pickups`, un par héros et par groupe : `p.took`) ; boss = piédestaux (`ODDS.boss`), salle au trésor après la
  salle n si n % 5 = 2 (toujours) ou 4 (une fois sur deux) (`VAULT`, `g.vaultNext`, `newVault` : `g.vault`, ne change pas
  `g.room`, mais `g.rn` change à chaque salle) ; salle normale : cœur, petit bonus ou rien (`LOOT`, `dropLoot`). Un objet
  ne sort qu'une fois par partie (`g.seen`, repli `eclat`). Mesure des tirages : `node tools/objets.mjs [parties] [salles]
  [malin|hasard]` (partie « cassée » ≈ 1 sur 8 à 10 à la salle 20). Débogage : `debugItem(h, id)`, `debugVault()` (F2).
  Affichage (game.js) : `pkSync` (piédestal + gemme couleur de qualité + icône émoji, lueur réservée `dng.glow`),
  `itemCard` (`#itemCard`), `itemBanner` (`#itemBanner`, 3 au plus en file), `itemsHud` (`#it1/#it2`), `statusPre/Post`
  (lueur `stGlow` des états, taille, aura, lames `orbit`), `animK` (gel/froid/vitesse d'attaque), éclairs `bolt`
  (événement), lames spectrales `k: 2` dans `syncArrows`, `vaultDecor`. Icônes : `emojiMat` (cache gardé par `keep`).
  En ligne : `packFighter` envoie `st` (bits des états), `items/tf/combos/orbit/minors/took/drunk`, et `pk`.
  Tests : `tests/items.test.js` ; scénario navigateur `objets` ; `tools/lobby-test.mjs` vérifie l'invité en salle au trésor.
- **Équilibrage à deux** (`COOP` dans dungeon.js, `coop(np, clé)`) : objectif « aussi dur qu'en solo » par joueur
  (dégâts reçus par héros et durée des salles). Salles normales : ×2 ennemis (max 10), PV ×1,3, dégâts ×1,25 ;
  boss : PV ×2,2, dégâts ×2, attaques spéciales ×0,6 d'attente ; escorte du chef orc ×1,5 + 1 (max 6). Réglé et
  vérifié avec `node tools/equilibrage.mjs 16 2,3,5,8,10,15,20 tank [clé=valeur…]` (héros joués par l'IA, héros
  increvables avec `tank`, affiche les rapports à deux / seul ; objectif 1 et 1). Tests : `tests/coop.test.js`.
- **Héros** (`HEROES` dans dungeon.js, avec un talent) : soldier (Gladiateur), human (Mirmillon), orc,
  archer (Archère), knight (Chevalier), zombie, robot (Automate). `equip(p, kind, wpn)` applique stats + talent.
- **Armes** (`WEAPONS` dans sim.js, `wpnOf(f)`) : sword, spear, tower, axe, hammer, staff (sceptre de feu),
  tome (grimoire), gloves (gants de boxe), bow ; `bite` = crocs des chiens (`hidden`, pas proposée). Champs : reach, dmg, combo,
  run, guard (coût du blocage), crush, bow (tir), fire (boule de feu), summon (invocation),
  tank (part des dégâts encaissée, cumulée avec l'armure du héros dans `equip`).
  `f.arch` = arme à distance. Défaut : `defaultWeapon(kind)` (archère → arc).
- **Sceptre** : projectiles `sim.pr` avec `k: 1` (flèches `k: 0`), `explode()` = dégâts de zone (`FIRE`).
- **Grimoire** : `summon()` ajoute un chien (`kind 'dog'`, `team 0`, `owner`) + son IA ; 2 max (`CAST.max`).
  Les fighters ont un **camp** `team` (0 héros + chiens, 1 ennemis) : `target`, `foeOf`, `foesLeft`, les
  frappes et `onKO` raisonnent par camp ; `isHero(f)` (idx < np) reste pour ce qui concerne les joueurs.
  Les chiens disparaissent à la salle suivante (f = héros + ennemis de la nouvelle salle).
- Ennemis (`FOES`) : grunt/guard/elite/archer + zombie (salle ≥ 4, sans tirage aléatoire en plus) ;
  `hound` (chien des enfers, `kind 'dog'`, camp ennemi) = renfort de Cerbère.
- **Boss** (`boss: true` dans FOES, une salle sur 5, `bossOf(n)` = `BOSS_ORDER` : chef orc 5, 20… ; colosse 10, 25… ;
  Cerbère 15, 30…). `moves` = liste des attaques spéciales de chaque boss (colosse `['slam','charge']`).
  `room.bossId`. **Colosse d'airain** (`colosse` : robot ×1,9, marteau, `moves`) : attaques spéciales réglées
  par `BOSS`, état `'special'` + `f.sp` ('slam' saut écrasant, 'charge', 'roar' = rage à 50 % PV qui appelle
  des zombies `adds`). Seuls les ennemis à `moves` ont les champs `sp, spT, spA, spX, spZ, spHit, spCd, rage`
  (`sp !== undefined` les repère). `bossThink` décide (rng de la sim), `special` avance avant `updateFighter`,
  pendant une spéciale il encaisse sans broncher (`armorHit`). Charge dans un mur/obstacle = sonné.
  Affichage : `bossTele` (zones au sol déduites de l'état), `bossHud` + `#bossBar` (grande barre en haut,
  pas de petite barre au-dessus des boss), teinte bronze et lueur de rage dans `makeView`/`FighterView`.
- **Cerbère** (`cerbere` : `kind 'cerbere'`, taille 2.8, arme cachée `fangs` = 3 morsures, une par tête ;
  moves `['fire','slam','charge']`, adds `hound`). `fire` (`BOSS.fire`) : wind puis souffle dans un cône (`half`,
  `R`) en pivotant vers la cible, brûlure par `flames()` toutes les `tick` s (roulade/derrière/hors portée = rien,
  blocage = garde). Sa salle (`room.lair = 'cerbere'`) : pas d'estrade ni de piège, 4 colonnes (il s'y assomme en
  chargeant). Affichage : `DogView(i, 'cerbere', hellGlow)` (têtes `head-l/c/r`, yeux `eyes-*`, gerbes de flammes
  `jets` d'après l'état), cône `tele.cone`, biome `BIOME.lair` + `lairDecor()` (os, flammes), bandeau à l'entrée.
  Modèle : `tools/blender/cerbere.py` → `assets/summons/cerbere.glb`. Tests : `tests/cerbere.test.js`.
  `brute` (FOES → `e.brute`) : son IA ne pare, ne bloque ni ne roule. Morsure préparée : arme `fangs` avec
  `windup` (0,5 s ; ×0,6 pour les morsures enchaînées, `windupOf(f)` dans sim.js) puis `lunge` (bond) ; il vise
  jusqu'à 0,25 s avant le bond puis se fige (fenêtre d'esquive) ; arc rouge `tele.bite` au sol pendant la préparation.
  Grands corps : la portée des coups compte depuis la surface de la cible (`big` dans `resolve`) et l'IA compte leur
  contact comme le corps à corps (`touch` dans ai.js). Scénario navigateur : `browser-test.mjs morsure`.
- **Salle d'armes en plein air** : `BIOME.hub` (murs des cryptes, ciel de jour) et `outsideDecor('meadow')` :
  2 rangées de dalles d'herbe seulement (≈ 400-950 triangles chacune !), puis sol vert, touffes et fleurs
  instanciées, arbres (côtés vus par la caméra), buissons, rochers, collines.
- **Outil de débogage** (F2, hors ligne) : protégé par un **code d'accès** demandé une fois par onglet (`#dbgLock`,
  `dbgUnlock` ; seule son empreinte FNV `DBG_CODE` est dans le code, le code lui-même est connu de l'utilisateur :
  ne jamais l'écrire dans le dépôt ; déverrouillage gardé dans `sessionStorage['spartiate-dbg']`, que
  browser-test.mjs pose lui-même ; scénario `code` avec `CODE_DBG=…`). `#dbg` dans index.html, `setupDebug`/`dbgGoto` dans game.js,
  méthodes `debugGoto/Kill/Heal/God/Spawn/Tp/Boss` de DungeonSim (testées dans tests/boss.test.js). Bouton
  « Antre de Cerbère » (salle 15) ; `debugBoss(kind)` ne lance que les attaques de `moves` du boss présent.
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
  construction, éteinte (comme la lueur des piédestaux, `dng.glow`).
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
- **Gants de boxe** : un gant par main (`gloveModel` : `inst('glove')`, miroir x pour la droite), tous deux
  redressés à chaque image ; le gauche tient lieu de bouclier (`v.shield`, lueur au blocage), le droit est
  `v.glove` (pas de `v.sword` ni de `swing`). Modèle : `tools/blender/gloves.py` → `assets/weapons/weapon-glove.glb`.
  Vérifier : `node tools/browser-test.mjs gloves <dossier>`.
- Le chien n'a pas de squelette : `DogView` anime ses pièces (même interface que `FighterView`).

## Modèles 3D : Blender en ligne de commande
- Blender 5.3 installé (winget `BlenderFoundation.Blender` 5.3.0, le 25/11/2026) : `"C:\Program Files\Blender Foundation\Blender 5.3\blender.exe" -b --factory-startup -P tools/blender/<script>.py`
  (passer des chemins **absolus** Windows aux scripts ; `cygpath -wa` depuis bash).
  Sous Linux (sans Blender installé) : l'archive portable `blender-5.3.0-linux-x64.tar.xz` de blender.org suffit
  (`blender -b --factory-startup -P <chemin absolu>`).
- `tools/blender/kenney.py` : boîte à outils. Positions/rotations écrites dans le **repère du jeu** (+Y haut,
  radians, ordre XYZ, comme three.js). Couleurs par nom = cases de la palette Kenney (`colormap.png`,
  grille 16×16 de 32 px ; colonnes paires unies, impaires en dégradé). `kenney_character()` importe un
  perso Kenney complet, `recolor()` change ses familles de couleurs, `attach()` accroche une pièce à un os,
  `preview(..., yaw=, height=)` rend un PNG (Workbench) **à regarder systématiquement** avant de livrer.
- Scripts : `weapons.py` (hache, marteau, sceptre `orb`, grimoire `rune` → `assets/weapons/`), `gloves.py`
  (gant de boxe `weapon-glove.glb` + aperçus glove/glove-front/gloves),
  `archer.py` (archère + `arrow.glb` + `weapon-bow.glb` : nœuds `bow` > `nocked`), `dog.py`
  (`assets/summons/dog.glb` : `dog` > `body` > head/tail/leg-fl/fr/bl/br/glow), `check_weapons.py`,
  `cerbere.py` (Cerbère : pièces articulées comme `dog.py`, trois têtes `head-*` avec yeux `eyes-*`),
  `merchant.py` (vieux marchand : Kenney male-b chauve et barbu, barbe blanche ALLONGÉE en déplaçant ses
  sommets, robe violette, couronne de cheveux ; + étal `stall.glb` → `assets/npc/`),
  `sorcier.py` (sorcier : Kenney male-b en robe bleue, barbe grise allongée, chapeau pointu ; tente rayée
  `tent.glb`, chaudron `cauldron.glb` (nœud `brew`) → `assets/npc/` ; totem `assets/summons/totem.glb` (nœud `gem`)).
  Aperçus dans `tools/blender/previews/`. Base de l'archère : `tools/blender/sources/character-female-f.glb`.
- Squelette Kenney : os root, leg-left/right, torso, arm-left/right, head ; rotations de repos nulles,
  bras à l'horizontale, visage vers +z. Les nœuds nommés exportés gardent leur nom ; exporter un objet
  dans une scène vide si un homonyme existe (sinon `bow.001`).
- `tools/archer-asset.html` (ancien générateur three.js) n'est plus utilisé : il écraserait l'archère.
- Les GLB générés embarquent la palette (~100-300 Ko) ; ceux de Kenney la référencent (`Textures/colormap.png`).

## Assets
- Packs Kenney CC0 : `assets/arena`, `assets/dungeon`, `assets/characters` (Mini Characters : seulement
  knight, zombie, robot + colormap). **Pas de personnages modernes** (demande de l'utilisateur).
- Nos modèles : `assets/archer`, `assets/weapons`, `assets/summons` (chien, Cerbère, totem), `assets/npc`
  (marchand, étal, sorcier, tente, chaudron).

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
