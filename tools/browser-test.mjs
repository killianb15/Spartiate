// =====================================================================
//  Test du jeu dans un vrai navigateur (Chromium sans interface, piloté par le protocole DevTools) :
//  charge le donjon avec une arme, appuie sur des touches, fait des captures d'écran, relève l'état
//  de la simulation (via ?debug) et les erreurs de la console.
//
//  1. serveur du jeu :   python serveur.py 8137 --no-browser
//  2. Chromium :         "%LOCALAPPDATA%\ms-playwright\chromium-1217\chrome-win64\chrome.exe" --headless=new
//                        --remote-debugging-port=9333 --user-data-dir=<dossier temporaire> --window-size=1280,720
//                        --use-angle=swiftshader --enable-unsafe-swiftshader --no-first-run about:blank
//  3. node tools/browser-test.mjs <tome|staff|shop|biomes> <dossier des captures>   (shop : le marchand d'armes ;
//     biomes : une salle de chaque biome, boss compris)
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
const VK = { KeyF: 70, Digit8: 56, KeyW: 87, KeyA: 65, KeyS: 83, KeyD: 68, KeyG: 71, KeyE: 69, Space: 32 };
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
const wpn = { tome: 'tome', staff: 'staff', shop: 'sword' }[scenario] ?? 'tome';
await evalJs(`localStorage.setItem('spartiate-cfg', JSON.stringify({ game: 'dungeon', mode: 'solo', diff: '1', p1: 'archer', p2: 'orc', w1: '${wpn}', arena: 'colisee' })); true`);
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
  // retour et choix direct par la touche 8 (arc)
  await hold(['KeyS'], 500); await hold(['KeyW'], 700); await sleep(300);
  if (!(await evalJs('spartiate.sim.f[0].shop > 0'))) await evalJs(`(() => { const p = spartiate.sim.f[0]; p.x = 3.4; p.z = -3.85; p.pad = -1; return true; })()`);
  await sleep(600);
  await send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'Digit8', key: '8', windowsVirtualKeyCode: 56 });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'Digit8', key: '8', windowsVirtualKeyCode: 56 });
  await sleep(500); console.log('ETAT touche 8', await st());
  await sleep(1500); await shot('arc');
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
