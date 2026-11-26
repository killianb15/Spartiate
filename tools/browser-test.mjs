// =====================================================================
//  Test du jeu dans un vrai navigateur (Chromium sans interface, piloté par le protocole DevTools) :
//  charge le donjon avec une arme, appuie sur des touches, fait des captures d'écran, relève l'état
//  de la simulation (via ?debug) et les erreurs de la console.
//
//  1. serveur du jeu :   python serveur.py 8137 --no-browser
//  2. Chromium :         "%LOCALAPPDATA%\ms-playwright\chromium-1217\chrome-win64\chrome.exe" --headless=new
//                        --remote-debugging-port=9333 --user-data-dir=<dossier temporaire> --window-size=1280,720
//                        --use-angle=swiftshader --enable-unsafe-swiftshader --no-first-run about:blank
//  3. node tools/browser-test.mjs <tome|staff|shop|biomes|boss|gloves> <dossier des captures>   (shop : le marchand d'armes ;
//     biomes : une salle de chaque biome, boss compris ; boss : le colosse et l'outil de débogage F2 ;
//     gloves : les gants de boxe, gros plans du héros au repos, en garde, en frappe, puis en salle 1)
//  Sortie : CHARGE true/false, lignes ETAT (combattants : [type, camp, état, PV]), ERREURS n + détail.
//  Le cache HTTP est désactivé (sinon un ancien game.js peut être servi).
// =====================================================================
import fs from 'fs';
import path from 'path';

const [, , scenario = 'tome', outDir = '.'] = process.argv;
const PORT = 9333, GAME = 'http://localhost:8137';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map();
const errors = [];
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === 'Runtime.exceptionThrown') errors.push('EXCEPTION ' + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
  if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) errors.push(m.params.type.toUpperCase() + ' ' + m.params.args.map((a) => a.value ?? a.description).join(' '));
  if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error') errors.push('LOG ' + m.params.entry.text + ' ' + (m.params.entry.url || ''));
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const evalJs = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
const VK = { KeyF: 70, Digit8: 56, Digit9: 57, KeyW: 87, KeyA: 65, KeyS: 83, KeyD: 68, KeyG: 71, KeyE: 69, Space: 32 };
const key = (type, code) => send('Input.dispatchKeyEvent', { type, code, key: code.replace('Key', '').toLowerCase(), windowsVirtualKeyCode: VK[code], nativeVirtualKeyCode: VK[code] });
const tap = async (code, ms = 80) => { await key('keyDown', code); await sleep(ms); await key('keyUp', code); };
const hold = async (codes, ms) => { for (const c of codes) await key('keyDown', c); await sleep(ms); for (const c of codes) await key('keyUp', c); };
let shotN = 0;
const shot = async (name) => {
  const r = await send('Page.captureScreenshot', { format: 'png' });
  const f = path.join(outDir, `${String(++shotN).padStart(2, '0')}-${name}.png`);
  fs.writeFileSync(f, Buffer.from(r.result.data, 'base64'));
  console.log('CAPTURE', f);
};
const waitFor = async (expr, ms = 90000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evalJs(expr)) return true; await sleep(300); } return false; };

await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable'); await send('Network.enable'); await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: GAME + '/' });
await sleep(1500);
if (scenario === 'compte') {
  // comptes et défis : à lancer avec un serveur relié à une API de TEST (SPARTIATE_API=http://127.0.0.1:8125,
  // pile docker compose -p spartiate-test) pour ne pas créer de comptes dans la vraie base
  const pseudo = 'Testeur' + Math.floor(Math.random() * 1e5);
  const txt = (id) => evalJs(`document.getElementById('${id}').textContent`);
  await send('Page.navigate', { url: GAME + '/?debug' });
  console.log('MENU', await waitFor(`!document.getElementById('menu').classList.contains('hidden') && !document.getElementById('acctSec').classList.contains('hidden')`, 60000));
  await shot('menu-compte');
  await evalJs(`document.getElementById('acPseudo').value = '${pseudo}'; document.getElementById('acMdp').value = 'thermopyles'; document.getElementById('acNew').click(); true`);
  console.log('CONNECTE', await waitFor(`!document.getElementById('acctIn').classList.contains('hidden')`, 15000), await txt('acProfil'));
  await evalJs(`document.getElementById('acDefis').click(); true`);
  console.log('DEFIS', await waitFor(`document.querySelectorAll('#acDefisList .df').length > 0`, 15000), await evalJs(`document.querySelectorAll('#acDefisList .df').length`));
  await sleep(500); await shot('defis');
  // nouveau compte : seul le Gladiateur est jouable (l'Orc demandé est remplacé, sa statue est verrouillée)
  await evalJs(`(() => { __game.startDungeon({ mode: 'solo', p1: 'orc', w1: 'sword' }); return true; })()`);
  await waitFor(`__game.game.phase === 'hub'`, 30000);
  console.log('HEROS', await evalJs(`__game.sim.f[0].kind`), 'verrouillés :', await evalJs(`['human','orc','robot'].map((k) => k + '=' + !__game.sim.canPick(0, k)).join(' ')`));
  await sleep(2500);
  await shot('salle-armes-verrous');
  // un donjon de Gladiateur au glaive : 120 victimes, tombé en salle 1 → débloque le Mirmillon
  await evalJs(`(() => { const g = __game.sim.g; g.phase = 'exit'; g.t = 0; return true; })()`);
  console.log('SALLE 1', await waitFor(`__game.sim.g.room === 1 && __game.game.phase === 'fight'`, 60000));
  await evalJs(`(() => { const s = __game.sim, p = s.f[0], e = s.f.find((f) => f.team === 1); p.kills = 120; s.damage(e, p, 9999, 0, 0.3, p.x, 1, p.z); return p.state; })()`);
  console.log('FIN', await waitFor(`!document.getElementById('result').classList.contains('hidden') && document.getElementById('resDefis').textContent.length > 0`, 60000));
  console.log('ANNONCE', await txt('resDefis'));
  await sleep(800); await shot('fin-defis');
  await evalJs(`document.getElementById('menuBtn').click(); true`);
  await sleep(1500);
  await evalJs(`document.getElementById('acDefis').click(); true`);
  await waitFor(`document.querySelectorAll('#acDefisList .df.ok').length > 0`, 15000);
  console.log('PROFIL', await txt('acProfil'), '| défis réussis :', await evalJs(`[...document.querySelectorAll('#acDefisList .df.ok .dn')].map((e) => e.textContent).join(', ')`));
  await evalJs(`document.getElementById('acDefisList').scrollTop = 0; true`);
  await sleep(500); await shot('defis-apres');
  console.log('ERREURS', errors.length);
  for (const e of [...new Set(errors)].slice(0, 30)) console.log('  ', e);
  ws.close();
  process.exit(0);
}
const wpn = { tome: 'tome', staff: 'staff', shop: 'sword', gloves: 'gloves' }[scenario] ?? 'tome';
await evalJs(`localStorage.setItem('spartiate-cfg', JSON.stringify({ game: 'dungeon', mode: 'solo', diff: '1', p1: '${scenario === 'gloves' ? 'soldier' : 'archer'}', p2: 'orc', w1: '${wpn}', arena: 'colisee' })); true`);
// le panneau F2 demande un code : déverrouillé pour cet onglet (sauf dans le scénario qui teste ce verrou)
if (scenario !== 'code') await evalJs(`sessionStorage.setItem('spartiate-dbg', '1'); true`);
await send('Page.navigate', { url: GAME + '/?dungeon&debug' });
const ok = await waitFor(`document.getElementById('loading').classList.contains('hidden') && !document.getElementById('hud').classList.contains('hidden')`);
console.log('CHARGE', ok);
await sleep(2500);
await shot('salle-armes');
// clic dans la page pour qu'elle ait le focus clavier
await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 640, y: 600, button: 'left', clickCount: 1 });
await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 640, y: 600, button: 'left', clickCount: 1 });

if (scenario === 'shop') {
  // le marchand : on approche (bulle « Approche… »), on monte sur sa dalle, on fait défiler, on achète
  const st = () => evalJs(`(() => { const p = spartiate.sim.f[0]; return JSON.stringify({ shop: p.shop, wpn: p.wpn, x: +p.x.toFixed(2), z: +p.z.toFixed(2), talk: document.getElementById('talkTxt').textContent, panneau: !document.getElementById('shop').classList.contains('hidden'), nom: document.getElementById('shopName').textContent }); })()`);
  await evalJs(`(() => { const p = spartiate.sim.f[0]; p.x = 3.4; p.z = -2.2; return true; })()`);
  await sleep(1200); await shot('approche'); console.log('ETAT', await st());
  await hold(['KeyW'], 700); await sleep(300);
  console.log('ETAT', await st());
  if (!(await evalJs('spartiate.sim.f[0].shop > 0'))) await evalJs(`(() => { const p = spartiate.sim.f[0]; p.x = 3.4; p.z = -3.85; p.pad = -1; return true; })()`);
  await sleep(1600); await shot('boutique'); console.log('ETAT', await st());
  await tap('KeyD'); await sleep(700); await shot('defile-1'); console.log('ETAT', await st());
  await tap('KeyD'); await sleep(250); await tap('KeyD'); await sleep(250); await tap('KeyD'); await sleep(700); await shot('defile-4'); console.log('ETAT', await st());
  await tap('KeyF'); await sleep(500); await shot('achat'); console.log('ETAT', await st());
  await sleep(1500); await shot('apres-achat'); console.log('ETAT', await st());
  // retour et choix direct par la touche 9 (arc)
  await hold(['KeyS'], 500); await hold(['KeyW'], 700); await sleep(300);
  if (!(await evalJs('spartiate.sim.f[0].shop > 0'))) await evalJs(`(() => { const p = spartiate.sim.f[0]; p.x = 3.4; p.z = -3.85; p.pad = -1; return true; })()`);
  await sleep(600);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'Digit9', key: '9', windowsVirtualKeyCode: 57 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Digit9', key: '9', windowsVirtualKeyCode: 57 });
  await sleep(500); console.log('ETAT touche 9', await st());
  await sleep(1500); await shot('arc');
  console.log('ERREURS', errors.length);
  for (const e of [...new Set(errors)].slice(0, 30)) console.log('  ', e);
  ws.close();
  process.exit(0);
}
if (scenario === 'gloves') {
  // gros plan : capture recadrée autour du héros (position projetée par la caméra du jeu), ×3
  const zoom = async (name, face = true) => {
    // le héros se tourne vers la caméra (vue de face)
    if (face) await evalJs(`(() => { const p = spartiate.sim.f[0], c = spartiate.camera.position; p.yaw = p.visTarget = Math.atan2(c.x - p.x, c.z - p.z) - 0.5; return true; })()`);
    const c = await evalJs(`(() => { const p = spartiate.sim.f[0], v = new spartiate.camera.position.constructor(p.x, p.y + 0.9, p.z).project(spartiate.camera);
      return [(v.x + 1) / 2 * innerWidth, (1 - v.y) / 2 * innerHeight]; })()`);
    const r = await send('Page.captureScreenshot', { format: 'png', clip: { x: Math.max(0, c[0] - 110), y: Math.max(0, c[1] - 120), width: 220, height: 220, scale: 3 } });
    const f = path.join(outDir, `${String(++shotN).padStart(2, '0')}-${name}.png`);
    fs.writeFileSync(f, Buffer.from(r.result.data, 'base64'));
    console.log('CAPTURE', f);
  };
  const hero = () => evalJs(`(() => { const p = spartiate.sim.f[0]; return JSON.stringify({ wpn: p.wpn, armor: +p.armor.toFixed(3), etat: p.state, garde: Math.round(p.guard), pv: Math.round(p.hp) }); })()`);
  console.log('ETAT', await hero());
  await zoom('repos');
  await key('keyDown', 'KeyG'); await sleep(900); await zoom('garde'); console.log('ETAT', await hero()); await key('keyUp', 'KeyG');
  await sleep(400);
  await tap('KeyF'); await sleep(150); await zoom('coup-1');
  await sleep(250); await tap('KeyF'); await sleep(150); await zoom('coup-2');
  await sleep(250); await tap('KeyF'); await sleep(150); await zoom('coup-3');
  // la boutique : les gants sur le comptoir (8e arme)
  await evalJs(`(() => { const p = spartiate.sim.f[0]; p.x = 3.4; p.z = -3.85; p.pad = -1; return true; })()`);
  await sleep(1500);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'Digit8', key: '8', windowsVirtualKeyCode: 56 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Digit8', key: '8', windowsVirtualKeyCode: 56 });
  await sleep(300);
  await tap('KeyD'); await sleep(300); await tap('KeyA'); await sleep(1500);
  await shot('boutique-gants');
  console.log('ETAT', await hero(), await evalJs(`document.getElementById('shopName').textContent + ' | ' + document.getElementById('talkTxt').textContent`));
  await hold(['KeyS'], 600);
  await evalJs(`(() => { const g = spartiate.sim.g; g.phase = 'exit'; g.t = 0; return true; })()`);
  await sleep(2600);
  for (let k = 0; k < 6; k++) {
    await key('keyDown', 'KeyG'); await sleep(700); await key('keyUp', 'KeyG');
    await tap('KeyF'); await sleep(300); await tap('KeyF'); await sleep(300);
    if (k % 2) await zoom('salle-1-' + k); else await shot('salle-1-' + k);
    console.log('ETAT', await hero(), await evalJs(`(() => { const s = spartiate.sim; return s.g.phase + ' salle ' + s.g.room + ' ennemis ' + s.foesLeft + ' vues ' + spartiate.views.length + '/' + s.f.length; })()`));
  }
  console.log('ERREURS', errors.length);
  for (const e of [...new Set(errors)].slice(0, 30)) console.log('  ', e);
  ws.close();
  process.exit(0);
}
if (scenario === 'morsure') {
  // morsure préparée de Cerbère : il se ramasse (arc rouge au sol), se lance puis mord
  await evalJs(`spartiate.debugGoto(15); true`);
  await waitFor(`spartiate.sim.room.lair === 'cerbere' && spartiate.sim.g.phase === 'fight'`, 90000);
  await evalJs(`(() => { const s = spartiate.sim, e = s.f.find((f) => f.foe === 'cerbere'), p = s.f[0]; s.debugGod(true); e.spCd = 999; s.ais[e.idx] = null;
    Object.assign(e, { x: 0, z: -1, vx: 0, vz: 0, yaw: 0, visTarget: 0 }); Object.assign(p, { x: 0, z: 1.2 }); spartiate.views[0].snapPos = true; return true; })()`);
  await sleep(1500);
  const bite = async (label) => {
    await evalJs(`(() => { const s = spartiate.sim, e = s.f.find((f) => f.foe === 'cerbere'); s.startAttack(e, false); return true; })()`);
    await waitFor(`(() => { const e = spartiate.sim.f.find((f) => f.foe === 'cerbere'); return e.state === 'attack' && e.stateT > 0.3; })()`, 30000);
    await shot(label + '-preparation');
    console.log('ETAT', await evalJs(`(() => { const e = spartiate.sim.f.find((f) => f.foe === 'cerbere'); return e.state + ' ' + e.stateT.toFixed(2); })()`));
    await waitFor(`(() => { const e = spartiate.sim.f.find((f) => f.foe === 'cerbere'); return e.state === 'attack' && e.stateT > 0.62; })()`, 30000);
    await shot(label + '-bond');
    await waitFor(`spartiate.sim.f.find((f) => f.foe === 'cerbere').state !== 'attack'`, 30000);
  };
  await bite('morsure');
  console.log('ERREURS', errors.length);
  for (const e of [...new Set(errors)].slice(0, 30)) console.log('  ', e);
  ws.close();
  process.exit(0);
}
if (scenario === 'cerbere') {
  // salle d'armes au milieu de sa prairie, puis l'antre de Cerbère et ses attaques (outil de débogage)
  const info = () => evalJs(`(() => { const r = spartiate.renderer.info; return JSON.stringify({ appels: r.render.calls, triangles: r.render.triangles, programmes: r.programs.length, geos: r.memory.geometries, textures: r.memory.textures, fps: Math.round(1 / Math.max(1e-3, spartiate.sim.dt)) }); })()`);
  const st = () => evalJs(`(() => { const s = spartiate.sim, e = s.f.find((f) => f.foe === 'cerbere'); return JSON.stringify({ salle: s.g.room, phase: s.g.phase, antre: s.room.lair, boss: e && [e.state, e.sp, e.spA, Math.round(e.hp)], chiens: s.f.filter((f) => f.foe === 'hound' && f.state !== 'dead').length, heros: [Math.round(s.f[0].hp), s.f[0].state], titre: document.getElementById('biome').textContent, barre: document.getElementById('bbName').textContent + ' / ' + document.getElementById('bbSub').textContent }); })()`);
  console.log('RENDU salle d\'armes', await info());
  // vue plus large de la salle d'armes : la caméra tourne autour, puis vue normale
  await shot('salle-armes-prairie');
  await evalJs(`spartiate.debugGoto(15); true`);
  console.log('ANTRE', await waitFor(`spartiate.sim.room.lair === 'cerbere' && spartiate.sim.g.phase === 'fight'`, 60000));
  await evalJs(`(() => { const s = spartiate.sim; s.debugGod(true); const e = s.f.find((f) => f.foe === 'cerbere'); e.spCd = 99; return true; })()`);
  await sleep(1500); await shot('antre'); console.log('ETAT', await st()); console.log('RENDU antre', await info());
  // souffle de feu : le héros devant lui
  await evalJs(`(() => { const s = spartiate.sim, e = s.f.find((f) => f.foe === 'cerbere'), p = s.f[0]; Object.assign(e, { x: 0, z: -1.5 }); e.yaw = e.visTarget = 0; Object.assign(p, { x: 0.3, z: 2.2 }); spartiate.views[0].snapPos = true; return s.debugBoss('fire'); })()`);
  await waitFor(`spartiate.sim.f.find((f) => f.foe === 'cerbere').sp === 'fire'`, 5000); await sleep(250);
  await shot('feu-preparation'); console.log('ETAT', await st());
  await waitFor(`(() => { const e = spartiate.sim.f.find((f) => f.foe === 'cerbere'); return e.sp === 'fire' && e.spA === 1 && e.spT > 0.4; })()`, 20000);
  await shot('feu-souffle'); console.log('ETAT', await st());
  await waitFor(`!spartiate.sim.f.find((f) => f.foe === 'cerbere').sp`, 90000); await sleep(600);
  await evalJs(`spartiate.sim.debugBoss('slam')`);
  await waitFor(`(() => { const e = spartiate.sim.f.find((f) => f.foe === 'cerbere'); return e.sp === 'slam' && e.spA === 1; })()`, 60000);
  await shot('bond'); console.log('ETAT', await st());
  await waitFor(`!spartiate.sim.f.find((f) => f.foe === 'cerbere').sp`, 90000); await sleep(600);
  await evalJs(`(() => { const s = spartiate.sim, p = s.f[0]; Object.assign(p, { x: 0, z: 5 }); spartiate.views[0].snapPos = true; return s.debugBoss('charge'); })()`);
  await waitFor(`(() => { const e = spartiate.sim.f.find((f) => f.foe === 'cerbere'); return e.sp === 'charge' && e.spA === 1; })()`, 60000);
  await shot('charge'); console.log('ETAT', await st());
  await waitFor(`!spartiate.sim.f.find((f) => f.foe === 'cerbere').sp && spartiate.sim.f.find((f) => f.foe === 'cerbere').state !== 'stun'`, 90000); await sleep(600);
  await evalJs(`spartiate.sim.debugBoss('rage')`);
  await waitFor(`spartiate.sim.f.some((f) => f.foe === 'hound')`, 20000); await sleep(1500);
  await shot('rage-chiens'); console.log('ETAT', await st(), 'vues', await evalJs(`spartiate.views.length + '/' + spartiate.sim.f.length`));
  // allers-retours salle d'armes <-> antre : les compteurs de mémoire doivent se stabiliser
  for (let k = 0; k < 2; k++) {
    await evalJs(`spartiate.debugGoto(0); true`); await sleep(3000);
    console.log('RENDU salle d\'armes', k + 1, await info());
    await evalJs(`spartiate.debugGoto(15); true`); await sleep(3000);
    console.log('RENDU antre', k + 1, await info());
  }
  console.log('ERREURS', errors.length);
  for (const e of [...new Set(errors)].slice(0, 30)) console.log('  ', e);
  ws.close();
  process.exit(0);
}
if (scenario === 'biomes') {
  // saut direct dans des salles de chaque biome (mines 6-10, ruines 11-15, forge 16-20 ; boss tous les 5)
  for (const n of [6, 8, 10, 11, 13, 15, 16, 18, 20]) {
    await evalJs(`(() => { const s = spartiate.sim; s.g.room = ${n - 1}; s.newRoom(); s.f[0].hp = s.f[0].maxHp = 9999; return true; })()`);
    await sleep(600);
    const titre = await evalJs(`document.getElementById('biome').className + ' ' + document.getElementById('biome').textContent`);
    await sleep(1900);
    await shot('salle-' + n);
    console.log('SALLE', n, 'titre:', titre, 'obstacles:', await evalJs(`JSON.stringify(spartiate.sim.room.obs.map((o) => o.kind))`));
  }
  console.log('ERREURS', errors.length);
  for (const e of [...new Set(errors)].slice(0, 30)) console.log('  ', e);
  ws.close();
  process.exit(0);
}
if (scenario === 'benedictions') {
  // écran du coffre avec une bénédiction de chaque rareté, puis choix de la légendaire (touche 3)
  await evalJs(`spartiate.debugGoto(1); true`);
  await waitFor(`spartiate.sim.g.phase === 'fight'`, 60000);
  await evalJs(`(() => { const s = spartiate.sim; s.debugKill(); s.g.phase = 'reward'; s.g.pick0 = -1; s.g.o0 = 'potion'; s.g.o1 = 'lame'; s.g.o2 = 'phenix'; return true; })()`);
  await waitFor(`!document.getElementById('reward').classList.contains('hidden')`, 20000);
  await sleep(800);
  console.log('BOUTONS', await evalJs(`[...document.querySelectorAll('#reward button')].map((b) => b.className + ':' + b.textContent.slice(0, 40)).join(' | ')`));
  await shot('coffre-raretes');
  await evalJs(`document.querySelectorAll('#reward button')[2].click(); true`);
  await sleep(1500);
  console.log('CHOIX', await evalJs(`spartiate.sim.f[0].boons + ' phénix=' + spartiate.sim.f[0].phoenix`));
  console.log('ERREURS', errors.length);
  for (const e of [...new Set(errors)].slice(0, 30)) console.log('  ', e);
  ws.close();
  process.exit(0);
}
if (scenario === 'invite') {
  // menu sans compte : bloc Compte avec l'explication du jeu en invité, puis partie lancée en invité
  await send('Page.navigate', { url: GAME + '/?debug' });
  await waitFor(`!document.getElementById('menu').classList.contains('hidden')`, 60000);
  await sleep(2500);
  console.log('COMPTE', await evalJs(`!document.getElementById('acctSec').classList.contains('hidden')`), '|', await evalJs(`document.getElementById('acGuest').textContent.slice(0, 60)`));
  await shot('menu-invite');
  await evalJs(`(() => { __game.startDungeon({ mode: 'solo', p1: 'orc', w1: 'sword' }); return true; })()`);
  console.log('PARTIE', await waitFor(`__game.game.phase === 'hub'`, 30000), 'héros', await evalJs(`__game.sim.f[0].kind`));
  console.log('ERREURS', errors.length);
  for (const e of [...new Set(errors)].slice(0, 30)) console.log('  ', e);
  ws.close();
  process.exit(0);
}
if (scenario === 'code') {
  // F2 : le panneau de débogage demande un code ; un mauvais code est refusé (le bon : CODE_DBG=… dans l'environnement)
  const f2 = async () => { await send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'F2', key: 'F2', windowsVirtualKeyCode: 113 }); await send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'F2', key: 'F2', windowsVirtualKeyCode: 113 }); await sleep(300); };
  const vis = (id) => evalJs(`!document.getElementById('${id}').classList.contains('hidden')`);
  const typeCode = async (c) => { await evalJs(`(() => { const i = document.getElementById('dbgCode'); i.value = ${JSON.stringify(c)}; document.getElementById('dbgCodeGo').click(); return true; })()`); await sleep(300); };
  await f2();
  console.log('F2 : verrou', await vis('dbgLock'), '| panneau', await vis('dbg'));
  await typeCode('mauvais');
  console.log('mauvais code : verrou', await vis('dbgLock'), '| panneau', await vis('dbg'), '|', await evalJs(`document.getElementById('dbgCodeMsg').textContent`));
  await shot('code-refuse');
  if (process.env.CODE_DBG) {
    await typeCode(process.env.CODE_DBG);
    console.log('bon code : verrou', await vis('dbgLock'), '| panneau', await vis('dbg'));
    await shot('panneau-ouvert');
    await f2(); await f2();
    console.log('F2 F2 (sans redemander le code) : verrou', await vis('dbgLock'), '| panneau', await vis('dbg'));
  }
  console.log('ERREURS', errors.length);
  for (const e of [...new Set(errors)].slice(0, 30)) console.log('  ', e);
  ws.close();
  process.exit(0);
}
if (scenario === 'boss') {
  // outil de débogage (F2) : salle du colosse, invincible, attaques spéciales, rage, téléportation au clic
  const clk = (sel) => evalJs(`(() => { const b = document.querySelector(${JSON.stringify(sel)}); if (!b) return false; b.click(); return true; })()`);
  const boss = () => evalJs(`(() => { const s = spartiate.sim, e = s.f.find((o) => o.foe === 'colosse'); return JSON.stringify({ salle: s.g.room, phase: s.g.phase, boss: e && [e.state, e.sp, Math.round(e.hp), e.maxHp, e.rage], heros: [s.f[0].state, Math.round(s.f[0].hp), +s.f[0].x.toFixed(1), +s.f[0].z.toFixed(1)], ennemis: s.foesLeft, vues: spartiate.views.length + '/' + s.f.length, barre: document.getElementById('bossBar').className, nom: document.getElementById('bbName').textContent, info: document.getElementById('dbgInfo').textContent }); })()`);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'F2', key: 'F2', windowsVirtualKeyCode: 113 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'F2', key: 'F2', windowsVirtualKeyCode: 113 });
  await sleep(300);
  console.log('PANNEAU', await evalJs(`!document.getElementById('dbg').classList.contains('hidden')`));
  await clk('[data-room="10"]'); await clk('#dbgGod');
  await sleep(2200); await shot('colosse-arrivee'); console.log('ETAT', await boss());
  await sleep(1200);
  await clk('[data-boss="slam"]'); await sleep(350); await shot('saut-zone'); console.log('ETAT', await boss());
  await sleep(700); await shot('saut-impact'); console.log('ETAT', await boss());
  await sleep(1500);
  await evalJs(`(() => { const s = spartiate.sim, e = s.f.find((o) => o.foe === 'colosse'); s.debugTp(0, e.x, e.z + 5.5); return true; })()`);
  await sleep(300);
  await clk('[data-boss="charge"]'); await sleep(450); await shot('charge-couloir'); console.log('ETAT', await boss());
  await sleep(900); await shot('charge-fin'); console.log('ETAT', await boss());
  await sleep(1500);
  await clk('[data-boss="rage"]'); await sleep(600); await shot('rage'); console.log('ETAT', await boss());
  await sleep(1600); await shot('rage-renforts'); console.log('ETAT', await boss());
  // téléportation au clic
  await clk('#dbgTp');
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 400, y: 450, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 400, y: 450, button: 'left', clickCount: 1 });
  await sleep(500); console.log('ETAT tp', await boss());
  await clk('[data-foe="boss"]'); await sleep(800); console.log('ETAT apparition', await boss());
  await clk('#dbgKill'); await sleep(1500); await shot('vaincu'); console.log('ETAT', await boss());
  await clk('[data-room="5"]'); await sleep(2500); await shot('chef-orc'); console.log('ETAT', await boss());
  await clk('[data-room="0"]'); await sleep(1500); await shot('salle-armes-retour'); console.log('ETAT', await boss());
  console.log('ERREURS', errors.length);
  for (const e of [...new Set(errors)].slice(0, 30)) console.log('  ', e);
  ws.close();
  process.exit(0);
}
if (scenario === 'tome') {
  await tap('KeyF'); await sleep(450); await shot('invocation');
  await sleep(900); await shot('chien-1');
  await tap('KeyF'); await sleep(1400); await shot('chien-2');
}
// passage direct à la salle 1 (comme si on franchissait la porte)
await evalJs(`(() => { const g = spartiate.sim.g; g.phase = 'exit'; g.t = 0; return true; })()`);
await sleep(2600);
await shot('salle-1');
const etat = () => evalJs(`JSON.stringify(spartiate.sim.f.map((e) => [e.kind, e.team, e.state, Math.round(e.hp)]))`);
const rec = (where) => evalJs(`(() => { const s = spartiate.sim; return s.g.phase + ' salle ' + s.g.room + ' ennemis ' + s.foesLeft + ' vues ' + spartiate.views.length + '/' + s.f.length; })()`);
if (scenario === 'tome') {
  await tap('KeyF'); await sleep(1300);
  await tap('KeyF'); await sleep(1300);
  await shot('chiens-salle-1');
  console.log('ETAT', await rec(), await etat());
  for (let k = 0; k < 8; k++) { await sleep(1200); await shot('combat-' + k); console.log('ETAT', await rec(), await etat()); }
} else {
  // le héros vise le premier ennemi : il se tourne seul vers lui
  for (let k = 0; k < 6; k++) { await tap('KeyF'); await sleep(230); await shot('feu-' + k); await sleep(500); await shot('explosion-' + k); console.log('ETAT', await rec(), await etat()); await sleep(300); }
}
console.log('ERREURS', errors.length);
for (const e of [...new Set(errors)].slice(0, 30)) console.log('  ', e);
ws.close();
process.exit(0);
