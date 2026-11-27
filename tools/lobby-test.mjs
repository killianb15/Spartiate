// =====================================================================
//  Test des salons de la salle d'armes dans de vrais navigateurs : deux joueurs (deux contextes
//  Chromium séparés, donc deux localStorage) dans leur salle d'armes. A ouvre son salon, B le voit
//  dans la liste et le rejoint ; les deux doivent se retrouver dans la même salle d'armes en ligne,
//  chacun avec son héros et son arme. Puis salle au trésor à deux (objets vus par l'invité) ; enfin B s'en va :
//  A continue seul.
//
//  Même préparation que tools/browser-test.mjs (serveur sur 8137, Chromium headless sur 9333), puis :
//    node tools/lobby-test.mjs <dossier des captures>
// =====================================================================
import fs from 'fs';
import path from 'path';

const [, , outDir = '.'] = process.argv;
const PORT = 9333, GAME = 'http://localhost:8137';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];

// une page pilotée par le protocole DevTools
async function page(wsUrl, name) {
  const ws = new WebSocket(wsUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
    if (m.method === 'Runtime.exceptionThrown') errors.push(`${name} EXCEPTION ` + (m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text));
    if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) errors.push(`${name} ${m.params.type.toUpperCase()} ` + m.params.args.map((a) => a.value ?? a.description).join(' '));
    if (m.method === 'Log.entryAdded' && m.params.entry.level === 'error' && !m.params.entry.url?.endsWith('favicon.ico')) errors.push(`${name} LOG ${m.params.entry.text} ${m.params.entry.url || ''}`);
  });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  const evalJs = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
  await send('Runtime.enable'); await send('Log.enable'); await send('Page.enable'); await send('Network.enable');
  await send('Network.setCacheDisabled', { cacheDisabled: true });
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 720, deviceScaleFactor: 1, mobile: false });
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });   // les deux pages restent « au premier plan »
  let shotN = 0;
  const shot = async (label) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    const f = path.join(outDir, `${name}-${String(++shotN).padStart(2, '0')}-${label}.png`);
    fs.writeFileSync(f, Buffer.from(r.result.data, 'base64'));
    console.log('CAPTURE', f);
  };
  const waitFor = async (expr, ms = 90000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await evalJs(expr)) return true; await sleep(300); } return false; };
  const state = () => evalJs(`(() => { const G = window.__game, s = G.sim, n = G.net; return JSON.stringify({ phase: G.game.phase, mode: G.F.length && s.g.np, heros: s.f.filter((f) => f.team === 0).map((f) => f.kind + '/' + f.wpn),
    role: n.role, code: n.code, salon: n.hall, live: n.live, liste: n.halls.map((r) => r.code + ':' + r.kind), panneau: !document.getElementById('lobby').classList.contains('hidden'),
    msg: document.getElementById('lbMsg').textContent }); })()`);
  return { ws, send, evalJs, shot, waitFor, state };
}

const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
const browser = await page(version.webSocketDebuggerUrl, 'navigateur');
// deux contextes séparés : chacun son localStorage (son héros, son arme)
const mk = async (name, hero, wpn) => {
  const { result } = await browser.send('Target.createBrowserContext');
  const t = await browser.send('Target.createTarget', { url: 'about:blank', browserContextId: result.browserContextId });
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const p = await page(list.find((x) => x.id === t.result.targetId).webSocketDebuggerUrl, name);
  await p.send('Page.navigate', { url: GAME + '/' });
  await sleep(1500);
  await p.evalJs(`localStorage.setItem('spartiate-cfg', JSON.stringify({ game: 'dungeon', mode: 'solo', diff: '1', p1: '${hero}', p2: 'orc', w1: '${wpn}', arena: 'colisee' })); true`);
  await p.send('Page.navigate', { url: GAME + '/?dungeon&debug' });
  return p;
};
const A = await mk('A', 'soldier', 'gloves');
const B = await mk('B', 'knight', 'hammer');
for (const [n, p] of [['A', A], ['B', B]]) {
  console.log('CHARGE', n, await p.waitFor(`document.getElementById('loading').classList.contains('hidden') && window.__game?.game.phase === 'hub'`));
}
await sleep(3000);
console.log('ETAT A', await A.state());
console.log('ETAT B', await B.state());
await A.shot('salle-armes');

// A ouvre son salon
await A.evalJs(`document.querySelector('#lbMine button[data-act="open"]').click(); true`);
console.log('SALON A', await A.waitFor(`window.__game.net.hall && window.__game.net.code.length === 4`, 10000));
const code = await A.evalJs('window.__game.net.code');
console.log('ETAT A', await A.state());
// B le voit dans sa liste
console.log('LISTE B', await B.waitFor(`window.__game.net.halls.some((r) => r.code === '${code}')`, 10000));
await sleep(500);
await A.shot('salon-ouvert'); await B.shot('liste');
console.log('ETAT B', await B.state());
// B rejoint en cliquant dans la liste
await B.evalJs(`document.querySelector('#lbList button[data-code="${code}"]').click(); true`);
const both = `window.__game.net.live && window.__game.sim.g.np === 2 && window.__game.game.phase === 'hub'`;
console.log('ENSEMBLE A', await A.waitFor(both, 15000), 'B', await B.waitFor(both, 15000));
await sleep(3000);
console.log('ETAT A', await A.state());
console.log('ETAT B', await B.state());
// B avance un peu : A doit le voir bouger (rollback)
const posB = () => A.evalJs(`JSON.stringify([+window.__game.sim.f[1].x.toFixed(2), +window.__game.sim.f[1].z.toFixed(2)])`);
const before = await posB();
await B.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 640, y: 600, button: 'left', clickCount: 1 });
await B.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 640, y: 600, button: 'left', clickCount: 1 });
await B.send('Input.dispatchKeyEvent', { type: 'keyDown', code: 'KeyD', key: 'd', windowsVirtualKeyCode: 68 });
await sleep(1200);
await B.send('Input.dispatchKeyEvent', { type: 'keyUp', code: 'KeyD', key: 'd', windowsVirtualKeyCode: 68 });
await sleep(1500);
const sync = `(() => { const s = window.__game.sim; return JSON.stringify([s.g.frame, s.f.map((f) => [+f.x.toFixed(2), +f.z.toFixed(2)])]); })()`;
console.log('B BOUGE vu par A', before, '->', await posB());
console.log('POSITIONS A', await A.evalJs(sync), 'B', await B.evalJs(sync));
await A.shot('ensemble'); await B.shot('ensemble');

// objets à deux : l'hôte ouvre une salle au trésor, l'invité voit les piédestaux ; l'hôte donne des objets
// au héros de l'invité (transformation, lames tournoyantes) : l'invité voit ses icônes et son aura
await A.evalJs(`(() => { const s = window.__game.sim; s.g.room = 2; s.debugVault(); return true; })()`);
console.log('TRESOR invité', await B.waitFor(`window.__game.sim.g.vault && window.__game.sim.pk.length === 2 && document.getElementById('timer').textContent.includes('TRÉSOR')`, 20000),
  await B.evalJs(`JSON.stringify(window.__game.sim.pk.map((o) => o.t + ':' + o.v))`));
await A.evalJs(`(() => { const s = window.__game.sim; for (const id of ['silex', 'naphte', 'braise', 'anneau']) s.debugItem(1, id); return true; })()`);
console.log('OBJETS invité', await B.waitFor(`window.__game.sim.f[1].tf === 'feu' && document.getElementById('it2').children.length >= 5`, 20000),
  await B.evalJs(`JSON.stringify({ objets: window.__game.sim.f[1].items, orbit: window.__game.sim.f[1].orbit, hud: document.getElementById('it2').textContent })`));
await sleep(2500);
await A.shot('tresor-hote'); await B.shot('tresor-invite');

// B ferme son onglet : A continue seul (on est dans la salle au trésor, donc dans le donjon)
await B.send('Page.close');
console.log('SEUL A', await A.waitFor(`!window.__game.net.live && window.__game.sim.g.np === 1 && window.__game.sim.g.vault`, 15000));
await sleep(2500);
console.log('ETAT A', await A.state());
await A.shot('equipier-parti');
// A franchit la porte seul : le salon se ferme
await A.evalJs(`(() => { const g = window.__game.sim.g; g.phase = 'exit'; g.t = 0; return true; })()`);
await sleep(3500);
console.log('ETAT A apres porte', await A.state());

console.log('ERREURS', errors.length);
for (const e of [...new Set(errors)].slice(0, 30)) console.log('  ', e);
process.exit(0);
