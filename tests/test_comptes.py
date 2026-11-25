"""Tests des comptes joueurs : API Rust + PostgreSQL dans une pile Docker de TEST (projet spartiate-test,
son propre volume, API sur 127.0.0.1:8125), créée au début et détruite à la fin.
Il faut Docker et le fichier .env (voir .env.exemple) ; sinon ces tests sont sautés, sauf ceux du
serveur sans API. Lancer : python tests/test_comptes.py"""
import json
import os
import shutil
import socket
import subprocess
import sys
import time
import unittest
import urllib.error
import urllib.request

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from test_server import WS, free_port, ROOT   # noqa: E402

PORT_API = 8125
PROJET = ['docker', 'compose', '-p', 'spartiate-test']
ENV = dict(os.environ, SPARTIATE_API_PORT=str(PORT_API), FREIN_INSCRIPTION='1000', FREIN_CONNEXION='10')


def docker(*args, check=True, timeout=900):
    return subprocess.run([*PROJET, *args], cwd=ROOT, env=ENV, capture_output=True, text=True, timeout=timeout, check=check)


PILE = None
if not shutil.which('docker'):
    PILE = 'docker absent'
elif not os.path.exists(os.path.join(ROOT, '.env')):
    PILE = 'fichier .env absent (voir .env.exemple)'


def setUpModule():
    global PILE
    if PILE:
        return
    try:
        docker('up', '-d', '--build', '--wait')
    except (subprocess.SubprocessError, OSError) as e:
        PILE = f'pile de test impossible à démarrer : {getattr(e, "stderr", e)}'
        return
    deadline = time.time() + 60
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f'http://127.0.0.1:{PORT_API}/api/sante', timeout=2) as r:
                if r.status == 200:
                    return
        except OSError:
            time.sleep(1)
    PILE = 'l’API de test ne répond pas'


def tearDownModule():
    if shutil.which('docker') and os.path.exists(os.path.join(ROOT, '.env')):
        docker('down', '-v', '--remove-orphans', check=False)


def vider_base():
    docker('exec', '-T', 'db', 'psql', '-U', 'spartiate', '-d', 'spartiate', '-q', '-c',
           'TRUNCATE joueurs, sessions, parties RESTART IDENTITY CASCADE')


def start_server(api_url):
    port = free_port()
    env = dict(os.environ, SPARTIATE_API=api_url)
    env.pop('SPARTIATE_PROXY', None)
    proc = subprocess.Popen([sys.executable, os.path.join(ROOT, 'serveur.py'), str(port), '--no-browser'],
                            cwd=ROOT, env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    deadline = time.time() + 10
    while time.time() < deadline:
        try:
            socket.create_connection(('127.0.0.1', port), timeout=0.5).close()
            return proc, port
        except OSError:
            time.sleep(0.1)
    proc.kill()
    raise RuntimeError('le serveur ne démarre pas')


def stop_server(proc):
    proc.terminate()
    try:
        proc.wait(5)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait()


class Api:
    """Client HTTP ; ip : adresse annoncée (X-Real-IP), pour que chaque test ait ses propres freins."""

    def __init__(self, port, ip=None):
        self.base, self.ip = f'http://127.0.0.1:{port}', ip

    def __call__(self, path, body=None, jeton=None, raw=None, ip=None):
        data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
        req = urllib.request.Request(self.base + path, data=data, method='POST' if data is not None else 'GET')
        req.add_header('Content-Type', 'application/json')
        if jeton:
            req.add_header('Authorization', 'Bearer ' + jeton)
        if ip or self.ip:
            req.add_header('X-Real-IP', ip or self.ip)
        try:
            with urllib.request.urlopen(req, timeout=15) as r:
                return r.status, json.loads(r.read())
        except urllib.error.HTTPError as e:
            body = e.read()
            try:
                return e.code, json.loads(body or b'{}')
            except ValueError:
                return e.code, {'brut': body[:200]}


N = [0]


def skip_sans_pile(cls):
    def setUp(self, _orig=cls.setUp):
        if PILE:
            self.skipTest(PILE)
        _orig(self)
    cls.setUp = setUp
    return cls


@skip_sans_pile
class ApiTest(unittest.TestCase):
    """L'API Rust elle-même (port de test 8125)."""

    def setUp(self):
        vider_base()
        N[0] += 1
        self.api = Api(PORT_API, ip=f'10.0.{N[0]}.1')

    def inscrire(self, pseudo='Leonidas', mdp='thermopyles'):
        st, r = self.api('/api/inscription', {'pseudo': pseudo, 'mdp': mdp})
        self.assertEqual(st, 200, r)
        return r['jeton']

    def test_inscription_connexion_profil_deconnexion(self):
        j = self.inscrire()
        st, r = self.api('/api/profil', jeton=j)
        self.assertEqual(st, 200)
        self.assertEqual(r['profil'], {'pseudo': 'Leonidas', 'parties': 0, 'record': 0, 'ennemis': 0, 'boss': 0, 'debloques': ['soldier']})
        self.assertEqual(self.api('/api/inscription', {'pseudo': 'LEONIDAS', 'mdp': 'autrechose'})[0], 409)
        st, r = self.api('/api/connexion', {'pseudo': 'leonidas', 'mdp': 'thermopyles'})
        self.assertEqual(st, 200)
        self.assertEqual(r['profil']['pseudo'], 'Leonidas')
        j2 = r['jeton']
        self.assertNotEqual(j, j2)
        st, r = self.api('/api/connexion', {'pseudo': 'Leonidas', 'mdp': 'THERMOPYLES'})
        self.assertEqual(st, 401)
        st, r2 = self.api('/api/connexion', {'pseudo': 'Inconnu', 'mdp': 'thermopyles'})
        self.assertEqual(st, 401)
        self.assertEqual(r['erreur'], r2['erreur'], 'même message : on ne révèle pas si le pseudo existe')
        self.assertEqual(self.api('/api/deconnexion', {}, jeton=j)[0], 200)
        self.assertEqual(self.api('/api/profil', jeton=j)[0], 401)
        self.assertEqual(self.api('/api/profil', jeton=j2)[0], 200)
        self.assertEqual(self.api('/api/profil')[0], 401)
        self.assertEqual(self.api('/api/profil', jeton='x' * 43)[0], 401)

    def test_secrets_jamais_en_clair_dans_la_base(self):
        j = self.inscrire(mdp='secret-tres-long')
        out = docker('exec', '-T', 'db', 'psql', '-U', 'spartiate', '-d', 'spartiate', '-At', '-c',
                     'SELECT mdp FROM joueurs; SELECT jeton FROM sessions').stdout
        self.assertIn('$argon2id$', out)
        self.assertNotIn('secret-tres-long', out)
        self.assertNotIn(j, out, 'seule l’empreinte du jeton est stockée')

    def test_refus(self):
        for pseudo, mdp in [('ab', 'motdepasse'), ('a b c', 'motdepasse'), ('x' * 17, 'motdepasse'), ('<script>', 'motdepasse'),
                            ("x'; DROP TABLE joueurs; --", 'motdepasse'), ('Brasidas', 'court'), ('Brasidas', 'x' * 200)]:
            st, r = self.api('/api/inscription', {'pseudo': pseudo, 'mdp': mdp})
            self.assertEqual(st, 400, (pseudo, mdp, r))
        for raw in [b'pas du json', b'[1, 2]', b'{"pseudo": 12, "mdp": ["x"]}', b'{}']:
            self.assertEqual(self.api('/api/inscription', raw=raw)[0], 400, raw)
        self.assertEqual(self.api('/api/inscription', raw=b'{"x": "' + b'a' * 5000 + b'"}')[0], 413)
        self.assertEqual(self.api('/api/nimportequoi')[0], 404)
        self.inscrire('Éponine-2', 'motdepasse')     # accents, chiffres, tiret
        self.assertEqual(self.api('/api/profil', jeton=self.inscrire('Brasidas'))[0], 200, 'la table existe toujours')

    def test_parties_statistiques_classement(self):
        a, b = self.inscrire('Achille'), self.inscrire('Hector')
        st, r = self.api('/api/partie', {'salle': 12, 'ennemis': 30, 'en_ligne': False}, jeton=a)
        self.assertEqual(st, 200)
        self.assertEqual(r['profil'], {'pseudo': 'Achille', 'parties': 1, 'record': 12, 'ennemis': 30, 'boss': 2, 'debloques': ['soldier']})
        st, r = self.api('/api/partie', {'salle': 4, 'ennemis': 5, 'en_ligne': True}, jeton=a)
        self.assertEqual(r['profil'], {'pseudo': 'Achille', 'parties': 2, 'record': 12, 'ennemis': 35, 'boss': 2, 'debloques': ['soldier']})
        self.api('/api/partie', {'salle': 15, 'ennemis': 1}, jeton=b)
        self.inscrire('Paris')       # aucune partie : pas au classement
        st, r = self.api('/api/classement')
        self.assertEqual([p['pseudo'] for p in r['classement']], ['Hector', 'Achille'])
        for body in [{'salle': 0, 'ennemis': 1}, {'salle': 5, 'ennemis': -1}, {'salle': 'x', 'ennemis': 1}, {'salle': 10 ** 9, 'ennemis': 1}]:
            self.assertEqual(self.api('/api/partie', body, jeton=a)[0], 400, body)
        self.assertEqual(self.api('/api/partie', {'salle': 3, 'ennemis': 1})[0], 401)

    def test_defis(self):
        st, r = self.api('/api/defis')
        self.assertEqual(st, 200)
        tous = r['defis']
        self.assertGreaterEqual(len(tous), 28)
        self.assertTrue(all(d['progres'] == 0 and not d['reussi'] for d in tous), 'sans compte : tout à zéro')
        j = self.inscrire('Grommash')
        # une partie d'orc à la hache : 100 ennemis, tombé en salle 26
        st, r = self.api('/api/partie', {'salle': 26, 'ennemis': 100, 'heros': 'orc', 'arme': 'axe'}, jeton=j)
        self.assertEqual(st, 200, r)
        self.assertEqual(sorted(d['id'] for d in r['nouveaux']), ['orc.ennemis', 'orc.hache', 'orc.record'])
        defis = {d['id']: d for d in self.api('/api/defis', jeton=j)[1]['defis']}
        self.assertTrue(defis['orc.hache']['reussi'])
        self.assertEqual((defis['orc.salles']['progres'], defis['orc.salles']['objectif']), (25, 100))
        self.assertEqual(defis['knight.ennemis']['progres'], 0, 'un autre héros ne progresse pas')
        # même partie rejouée : rien de nouveau (un défi n'est annoncé qu'une fois)
        st, r = self.api('/api/partie', {'salle': 26, 'ennemis': 100, 'heros': 'orc', 'arme': 'axe'}, jeton=j)
        self.assertEqual(r['nouveaux'], [])
        # 3 autres parties : 25 x 4 = 100 salles traversées
        for _ in range(2):
            st, r = self.api('/api/partie', {'salle': 26, 'ennemis': 0, 'heros': 'orc', 'arme': 'sword'}, jeton=j)
        self.assertEqual([d['id'] for d in r['nouveaux']], ['orc.salles'])
        # héros ou arme inconnus refusés ; sans héros (ancien client) : stats du compte, pas de défi
        for body in [{'salle': 3, 'ennemis': 1, 'heros': 'link'}, {'salle': 3, 'ennemis': 1, 'heros': 'orc', 'arme': 'sabre-laser'}]:
            self.assertEqual(self.api('/api/partie', body, jeton=j)[0], 400, body)
        st, r = self.api('/api/partie', {'salle': 30, 'ennemis': 500}, jeton=j)
        self.assertEqual((st, r['nouveaux']), (200, []))
        self.assertEqual(r['profil']['record'], 30)
        # héros débloqués en chaîne : les défis de l'Orc ne débloquent rien tant que le Gladiateur n'a pas le sien
        self.assertEqual(r['profil']['debloques'], ['soldier'])
        st, r = self.api('/api/partie', {'salle': 2, 'ennemis': 100, 'heros': 'soldier', 'arme': 'sword'}, jeton=j)
        self.assertEqual([d['id'] for d in r['nouveaux']], ['soldier.ennemis', 'soldier.glaive'])
        self.assertEqual(r['profil']['debloques'], ['soldier', 'human'])
        self.assertEqual(self.api('/api/profil', jeton=j)[1]['profil']['debloques'], ['soldier', 'human'])
        st, r = self.api('/api/connexion', {'pseudo': 'Grommash', 'mdp': 'thermopyles'})
        self.assertEqual(r['profil']['debloques'], ['soldier', 'human'])

    def test_trop_d_essais_de_connexion(self):
        self.inscrire()
        codes = [self.api('/api/connexion', {'pseudo': 'Leonidas', 'mdp': 'mauvais!'})[0] for _ in range(11)]
        self.assertEqual(codes[:10], [401] * 10)
        self.assertEqual(codes[10], 429)
        # une autre adresse n'est pas bloquée
        self.assertEqual(self.api('/api/connexion', {'pseudo': 'Leonidas', 'mdp': 'thermopyles'}, ip='10.99.0.1')[0], 200)


@skip_sans_pile
class IsolementTest(unittest.TestCase):
    """La base n'est joignable que par l'API."""

    def setUp(self):
        pass

    def test_base_sans_port_publie(self):
        self.assertEqual(docker('port', 'db', '5432', check=False).stdout.strip(), '')
        ids = docker('ps', '-q', 'db').stdout.split()
        self.assertEqual(len(ids), 1)
        info = json.loads(subprocess.run(['docker', 'inspect', ids[0]], capture_output=True, text=True, check=True).stdout)[0]
        self.assertFalse(info['HostConfig']['PortBindings'], 'aucun port de la base publié')
        self.assertEqual(list(info['NetworkSettings']['Networks']), ['spartiate-test_interne'])
        net = json.loads(subprocess.run(['docker', 'network', 'inspect', 'spartiate-test_interne'],
                                        capture_output=True, text=True, check=True).stdout)[0]
        self.assertTrue(net['Internal'], 'réseau interne : pas de sortie')

    def test_api_seulement_en_local(self):
        out = docker('port', 'api', '8124').stdout.strip()
        self.assertTrue(out.startswith('127.0.0.1:'), out)


@skip_sans_pile
class RelaisTest(unittest.TestCase):
    """serveur.py relaie /api/* vers l'API (et seulement les routes prévues)."""

    def setUp(self):
        vider_base()
        self.proc, self.port = start_server(f'http://127.0.0.1:{PORT_API}')
        self.api = Api(self.port)
        self.clients = []

    def tearDown(self):
        for c in self.clients:
            c.close()
        stop_server(self.proc)

    def test_relais(self):
        self.assertEqual(self.api('/api/etat'), (200, {'comptes': True}))
        st, r = self.api('/api/inscription', {'pseudo': 'Thémistocle', 'mdp': 'salamine'})
        self.assertEqual(st, 200, r)
        self.assertEqual(self.api('/api/profil', jeton=r['jeton'])[1]['profil']['pseudo'], 'Thémistocle')
        self.assertEqual(self.api('/api/sante')[0], 404, 'route interne non relayée')
        self.assertEqual(self.api('/api/inscription', raw=b'{"x": "' + b'a' * 5000 + b'"}')[0], 413)

    def test_salon_affiche_le_pseudo_du_compte(self):
        st, r = self.api('/api/inscription', {'pseudo': 'Xerxes', 'mdp': 'perse-123'})
        h, x, y = WS(self.port), WS(self.port), WS(self.port)
        self.clients += [h, x, y]
        h.send_json(t='open', kind='orc', wpn='axe', token=r['jeton'], name='Imposteur')
        self.assertEqual(h.recv_json()['t'], 'created')
        y.send_json(t='open', kind='orc', wpn='axe', token='faux' * 11, name='Imposteur')
        y.recv_json()
        x.send_json(t='list')
        self.assertEqual(sorted(r['name'] for r in x.recv_json()['rooms']), ['', 'Xerxes'])


class SansApiTest(unittest.TestCase):
    """Sans l'API des comptes : le jeu marche, les comptes répondent 503."""

    def setUp(self):
        with socket.socket() as s:      # un port où rien n'écoute
            s.bind(('127.0.0.1', 0))
            dead = s.getsockname()[1]
        self.proc, self.port = start_server(f'http://127.0.0.1:{dead}')
        self.api = Api(self.port)

    def tearDown(self):
        stop_server(self.proc)

    def test_jeu_sans_comptes(self):
        self.assertEqual(self.api('/api/etat'), (200, {'comptes': False}))
        st, r = self.api('/api/connexion', {'pseudo': 'Leonidas', 'mdp': 'thermopyles'})
        self.assertEqual(st, 503)
        self.assertIn('indisponibles', r['erreur'])
        with urllib.request.urlopen(f'http://127.0.0.1:{self.port}/index.html', timeout=5) as r:
            self.assertEqual(r.status, 200)
        h = WS(self.port)
        h.send_json(t='open', kind='orc', wpn='axe', token='x' * 43)
        self.assertEqual(h.recv_json()['t'], 'created')
        h.close()

    def test_fichiers_caches_jamais_servis(self):
        for path in ['/.git/config', '/.gitignore', '/%2egit/config', '/assets/../.git/HEAD', '/.env']:
            try:
                with urllib.request.urlopen(f'http://127.0.0.1:{self.port}{path}', timeout=5) as r:
                    self.fail(f'{path} servi ({r.status})')
            except urllib.error.HTTPError as e:
                self.assertEqual(e.code, 404, path)


if __name__ == '__main__':
    unittest.main()
