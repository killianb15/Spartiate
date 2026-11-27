"""Tests du serveur (stdlib uniquement) : lance le vrai serveur en sous-processus."""
import base64
import gzip
import http.client
import json
import os
import socket
import struct
import subprocess
import sys
import threading
import time
import unittest
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MAX_MSG = 64 * 1024


def free_port():
    with socket.socket() as s:
        s.bind(('127.0.0.1', 0))
        return s.getsockname()[1]


class WS:
    """Mini client WebSocket."""

    def __init__(self, port):
        self.sock = socket.create_connection(('127.0.0.1', port), timeout=5)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall((f'GET /ws HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n'
                           f'Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n'
                           f'Sec-WebSocket-Version: 13\r\n\r\n').encode())
        buf = b''
        while b'\r\n\r\n' not in buf:
            d = self.sock.recv(1)
            if not d:
                raise ConnectionError('handshake')
            buf += d
        assert b' 101 ' in buf.split(b'\r\n')[0], buf
        self.buf = b''

    @staticmethod
    def frame(data, op=0x81):
        if isinstance(data, str):
            data = data.encode()
        n = len(data)
        if n < 126:
            head = struct.pack('!BB', op, 0x80 | n)
        elif n < 65536:
            head = struct.pack('!BBH', op, 0x80 | 126, n)
        else:
            head = struct.pack('!BBQ', op, 0x80 | 127, n)
        mask = os.urandom(4)
        body = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        return head + mask + body

    def send(self, data):
        self.sock.sendall(self.frame(data))

    def send_json(self, **m):
        self.send(json.dumps(m))

    def _read(self, n):
        while len(self.buf) < n:
            d = self.sock.recv(65536)
            if not d:
                raise ConnectionError('fermée')
            self.buf += d
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def recv(self, timeout=3):
        """Texte du prochain message ; None si la connexion est fermée ; TimeoutError sinon."""
        self.sock.settimeout(timeout)
        try:
            while True:
                b0, b1 = self._read(2)
                n = b1 & 0x7F
                if n == 126:
                    n = struct.unpack('!H', self._read(2))[0]
                elif n == 127:
                    n = struct.unpack('!Q', self._read(8))[0]
                data = self._read(n)
                op = b0 & 0x0F
                if op == 8:
                    return None
                if op == 1:
                    return data.decode()
        except (ConnectionError, ConnectionResetError, BrokenPipeError):
            return None
        except socket.timeout:
            raise TimeoutError('pas de message')

    def recv_json(self, timeout=3):
        m = self.recv(timeout)
        return None if m is None else json.loads(m)

    def expect_silence(self, timeout=0.4):
        try:
            m = self.recv(timeout)
        except TimeoutError:
            return
        self.fail_msg = m
        raise AssertionError(f'message inattendu : {m!r}')

    def close(self):
        try:
            self.sock.close()
        except OSError:
            pass


class ServerTest(unittest.TestCase):
    def setUp(self):
        self.port = free_port()
        self.proc = subprocess.Popen(
            [sys.executable, os.path.join(ROOT, 'serveur.py'), str(self.port), '--no-browser'],
            cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        self.clients = []
        deadline = time.time() + 8
        while time.time() < deadline:
            try:
                socket.create_connection(('127.0.0.1', self.port), timeout=0.5).close()
                break
            except OSError:
                time.sleep(0.1)
        else:
            self.fail('le serveur ne démarre pas')

    def tearDown(self):
        for c in self.clients:
            c.close()
        self.proc.terminate()
        try:
            self.proc.wait(5)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait()

    def client(self):
        c = WS(self.port)
        self.clients.append(c)
        return c

    def pair(self):
        h, g = self.client(), self.client()
        h.send_json(t='create')
        code = h.recv_json()['code']
        g.send_json(t='join', code=code)
        self.assertEqual(g.recv_json()['t'], 'joined')
        self.assertEqual(h.recv_json()['t'], 'peer')
        return h, g, code

    def test_http_index(self):
        with urllib.request.urlopen(f'http://127.0.0.1:{self.port}/index.html', timeout=5) as r:
            self.assertEqual(r.status, 200)
            self.assertEqual(r.headers.get('Cache-Control'), 'no-cache')
            self.assertIn(b'<', r.read(200))

    def test_http_gzip_cache_and_keepalive(self):
        conn = http.client.HTTPConnection('127.0.0.1', self.port, timeout=5)
        try:
            conn.request('GET', '/game.js', headers={'Accept-Encoding': 'gzip'})
            r1 = conn.getresponse()
            body1 = r1.read()
            self.assertEqual(r1.status, 200)
            self.assertEqual(r1.getheader('Content-Encoding'), 'gzip')
            self.assertEqual(r1.getheader('Cache-Control'), 'no-cache')
            raw1 = gzip.decompress(body1)
            with open(os.path.join(ROOT, 'game.js'), 'rb') as f:
                self.assertEqual(raw1, f.read())

            # même connexion HTTP/1.1 réutilisée pour un modèle 3D (cache long + gzip)
            conn.request('GET', '/assets/biomes/lava.glb', headers={'Accept-Encoding': 'gzip'})
            r2 = conn.getresponse()
            body2 = r2.read()
            self.assertEqual(r2.status, 200)
            self.assertEqual(r2.getheader('Content-Encoding'), 'gzip')
            self.assertEqual(r2.getheader('Cache-Control'), 'public, max-age=86400')
            with open(os.path.join(ROOT, 'assets/biomes/lava.glb'), 'rb') as f:
                self.assertEqual(gzip.decompress(body2), f.read())

            # fichier caché toujours refusé même avec gzip
            conn.request('GET', '/.gitignore', headers={'Accept-Encoding': 'gzip'})
            r3 = conn.getresponse()
            r3.read()
            self.assertEqual(r3.status, 404)
        finally:
            conn.close()

    def test_create_join_relay(self):
        h, g, code = self.pair()
        self.assertEqual(len(code), 4)
        h.send('{"t":"state","x":1}')
        self.assertEqual(g.recv(), '{"t":"state","x":1}')
        g.send('{"t":"input","k":2}')
        self.assertEqual(h.recv(), '{"t":"input","k":2}')

    def test_unknown_code(self):
        g = self.client()
        g.send_json(t='join', code='ZZZZ')
        m = g.recv_json()
        self.assertEqual(m['t'], 'error')
        self.assertNotIn('ZZZZ', json.dumps(m))

    def test_full_room(self):
        h, g, code = self.pair()
        x = self.client()
        x.send_json(t='join', code=code)
        self.assertEqual(x.recv_json()['t'], 'error')
        g.expect_silence()

    def test_oversize_frame_closes(self):
        h, g, code = self.pair()
        h.send('a' * (MAX_MSG + 1))
        self.assertIsNone(h.recv())
        # le serveur reste utilisable
        self.pair()

    def test_host_leaves_sends_bye(self):
        h, g, code = self.pair()
        h.close()
        self.assertEqual(g.recv_json()['t'], 'bye')

    def test_invalid_json_ignored(self):
        c = self.client()
        c.send('pas du json {')
        c.send('[1,2')
        c.send_json(t='create')
        self.assertEqual(c.recv_json()['t'], 'created')

    def test_rate_limit(self):
        h, g, code = self.pair()
        total = 1500
        for i in range(total):
            h.send(f'{{"t":"i","n":{i}}}')
        time.sleep(2.5)           # le seau se remplit à nouveau
        h.send('{"t":"fin"}')
        got = 0
        while True:
            m = g.recv(3)
            if m == '{"t":"fin"}':
                break
            got += 1
        self.assertLess(got, total)
        self.assertGreaterEqual(got, 400)
        # toujours utilisable dans les deux sens
        g.send('{"t":"ok"}')
        self.assertEqual(h.recv(), '{"t":"ok"}')
        self.pair()

    def test_rtc_signaling_both_ways(self):
        h, g, code = self.pair()
        msgs = [
            {'t': 'rtc', 'k': 'offer', 'sdp': 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\n'},
            {'t': 'rtc', 'k': 'candidate', 'c': {'candidate': 'candidate:1 1 udp 1 1.2.3.4 5 typ host', 'sdpMid': '0'}},
        ]
        for m in msgs:
            h.send_json(**m)
            self.assertEqual(g.recv_json(), m)
        ans = {'t': 'rtc', 'k': 'answer', 'sdp': 'v=0\r\n'}
        g.send_json(**ans)
        self.assertEqual(h.recv_json(), ans)
        g.send_json(**msgs[1])
        self.assertEqual(h.recv_json(), msgs[1])

    def test_hall_listed_then_hidden_when_full(self):
        h, x = self.client(), self.client()
        h.send_json(t='open', kind='orc', wpn='gloves', extra='x' * 500)
        m = h.recv_json()
        self.assertEqual(m['t'], 'created')
        self.assertTrue(m['hall'])
        code = m['code']
        x.send_json(t='list')
        rooms = x.recv_json()
        self.assertEqual(rooms['t'], 'rooms')
        self.assertEqual(rooms['rooms'], [{'code': code, 'kind': 'orc', 'wpn': 'gloves', 'name': ''}])   # sans compte : pas de pseudo
        # l'hôte ne se voit pas dans la liste
        h.send_json(t='list')
        self.assertEqual(h.recv_json()['rooms'], [])
        # une partie créée depuis le menu n'est pas listée
        p = self.client()
        p.send_json(t='create')
        self.assertFalse(p.recv_json()['hall'])
        x.send_json(t='list')
        self.assertEqual(len(x.recv_json()['rooms']), 1)
        # on rejoint depuis la liste : le salon complet disparaît
        x.send_json(t='join', code=code)
        self.assertEqual(x.recv_json()['t'], 'joined')
        self.assertEqual(h.recv_json()['t'], 'peer')
        y = self.client()
        y.send_json(t='list')
        self.assertEqual(y.recv_json()['rooms'], [])
        # l'invité repart : le salon est de nouveau proposé
        x.close()
        self.assertEqual(h.recv_json()['t'], 'bye')
        y.send_json(t='list')
        self.assertEqual([r['code'] for r in y.recv_json()['rooms']], [code])

    def test_hall_close(self):
        h, x = self.client(), self.client()
        h.send_json(t='open', kind='knight', wpn='sword')
        code = h.recv_json()['code']
        h.send_json(t='close')
        x.send_json(t='join', code=code)
        self.assertEqual(x.recv_json()['t'], 'error')
        x.send_json(t='list')
        self.assertEqual(x.recv_json()['rooms'], [])
        # le salon refermé, la connexion sert encore (rouvrir)
        h.send_json(t='open', kind='knight', wpn='sword')
        self.assertEqual(h.recv_json()['t'], 'created')

    def test_hall_state_update_and_unlist_on_dungeon_start(self):
        h, g, obs = self.client(), self.client(), self.client()
        h.send_json(t='open', kind='soldier', wpn='sword')
        code = h.recv_json()['code']

        # Mise à jour en direct de l'équipement dans la salle d'armes
        h.send_json(t='hall_state', kind='knight', wpn='axe')
        obs.send_json(t='list')
        rooms = obs.recv_json()['rooms']
        self.assertEqual(len(rooms), 1)
        self.assertEqual(rooms[0]['kind'], 'knight')
        self.assertEqual(rooms[0]['wpn'], 'axe')

        # Un invité rejoint, puis le duo quitte la salle d'armes (hall_state open=False)
        g.send_json(t='join', code=code)
        self.assertEqual(g.recv_json()['t'], 'joined')
        self.assertEqual(h.recv_json()['t'], 'peer')
        h.send_json(t='hall_state', open=False)
        g.expect_silence(0.2)

        # Quand l'invité quitte en salle 1+, le salon NE réapparaît PAS dans la liste publique
        g.send_json(t='leave')
        self.assertEqual(h.recv_json()['t'], 'bye')
        obs.send_json(t='list')
        self.assertEqual(obs.recv_json()['rooms'], [])

    def test_close_and_leave_while_paired(self):
        h, g, code = self.pair()
        g.send_json(t='leave')
        self.assertEqual(h.recv_json()['t'], 'bye')
        # L'hôte peut encore fermer proprement la salle
        h.send_json(t='close')
        x = self.client()
        x.send_json(t='join', code=code)
        self.assertEqual(x.recv_json()['t'], 'error')



class FakeApi:
    """Fausse API des comptes : jeton « jeton-<pseudo>-xxxxxxxxxxxxxxxx » ; AMIS = amitiés acceptées."""
    AMIS = {'Achille': ['Patrocle', 'Ulysse'], 'Patrocle': ['Achille'], 'Ulysse': ['Achille'], 'Hector': []}

    def __init__(self):
        from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
        amis = self.AMIS

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_GET(self):
                auth = self.headers.get('Authorization', '')
                nom = auth.split('-')[1] if auth.startswith('Bearer jeton-') else ''
                if self.path == '/api/sante':
                    st, r = 200, {'ok': True}
                elif nom not in amis:
                    st, r = 401, {'erreur': 'Session expirée.'}
                elif self.path == '/api/profil':
                    st, r = 200, {'profil': {'pseudo': nom}}
                elif self.path == '/api/amis':
                    st, r = 200, {'amis': [{'pseudo': a, 'record': 1, 'parties': 1} for a in amis[nom]], 'recues': [], 'envoyees': []}
                else:
                    st, r = 404, {}
                data = json.dumps(r).encode()
                self.send_response(st)
                self.send_header('Content-Length', str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.httpd = ThreadingHTTPServer(('127.0.0.1', 0), H)
        self.port = self.httpd.server_address[1]
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self):
        self.httpd.shutdown()
        self.httpd.server_close()


def jeton(nom):
    return f'jeton-{nom}-' + 'x' * 16


class AmisTest(ServerTest):
    """Amis en ligne (présence, salons, invitations) avec une fausse API des comptes."""

    def setUp(self):
        self.fake = FakeApi()
        os.environ['SPARTIATE_API'] = f'http://127.0.0.1:{self.fake.port}'
        try:
            super().setUp()
        finally:
            del os.environ['SPARTIATE_API']

    def tearDown(self):
        super().tearDown()
        self.fake.close()

    def login(self, nom):
        c = self.client()
        c.send_json(t='ident', token=jeton(nom))
        self.assertEqual(c.recv_json(), {'t': 'ident', 'name': nom})
        return c

    def friends(self, c):
        c.send_json(t='friends')
        m = c.recv_json()
        self.assertEqual(m['t'], 'friends')
        return {a['name']: a for a in m['friends']}

    def test_presence_et_salon_des_amis(self):
        a = self.login('Achille')
        f = self.friends(a)
        self.assertEqual(set(f), {'Patrocle', 'Ulysse'})
        self.assertFalse(f['Patrocle']['online'])
        p = self.login('Patrocle')
        self.login('Hector')                  # pas son ami : jamais montré
        time.sleep(0.1)
        f = self.friends(a)
        self.assertEqual(set(f), {'Patrocle', 'Ulysse'})
        self.assertEqual((f['Patrocle']['online'], f['Patrocle']['code'], f['Ulysse']['online']), (True, '', False))
        p.send_json(t='open', kind='orc', wpn='axe', token=jeton('Patrocle'))
        code = p.recv_json()['code']
        f = self.friends(a)
        self.assertEqual(f['Patrocle']['code'], code)
        self.assertEqual(list(f)[0], 'Patrocle', 'salon ouvert en tête')
        a.send_json(t='join', code=code)       # rejoindre son salon
        self.assertEqual(a.recv_json()['t'], 'joined')
        self.assertEqual(p.recv_json()['t'], 'peer')
        u = self.login('Ulysse')
        f = self.friends(u)
        self.assertTrue(f['Achille']['busy'])
        self.assertEqual(f['Achille']['code'], '')

    def test_sans_compte_ni_faux_jeton(self):
        c = self.client()
        c.send_json(t='ident', token='faux' * 10)
        self.assertEqual(c.recv_json(), {'t': 'ident', 'name': ''})
        self.assertEqual(self.friends(c), {})
        c.send_json(t='invite', name='Achille')
        c.expect_silence()

    def test_invitation_entre_amis_seulement(self):
        a, p, h = self.login('Achille'), self.login('Patrocle'), self.login('Hector')
        a.send_json(t='invite', name='Patrocle')            # sans salon ouvert
        self.assertEqual(a.recv_json()['t'], 'error')
        time.sleep(2.1)                                     # une invitation toutes les 2 s
        a.send_json(t='open', kind='soldier', wpn='sword', token=jeton('Achille'))
        code = a.recv_json()['code']
        a.send_json(t='invite', name='patrocle')
        self.assertEqual(p.recv_json(), {'t': 'invite', 'name': 'Achille', 'code': code})
        self.assertEqual(a.recv_json(), {'t': 'invited', 'name': 'Patrocle', 'ok': True})
        a.send_json(t='invite', name='Patrocle')            # trop tôt : ignorée
        p.expect_silence()
        time.sleep(2.1)
        a.send_json(t='invite', name='Hector')              # pas son ami
        self.assertEqual(a.recv_json()['t'], 'error')
        h.expect_silence()
        h.send_json(t='open', kind='orc', wpn='axe', token=jeton('Hector'))
        h.recv_json()
        h.send_json(t='invite', name='Achille')             # Hector n'est l'ami de personne
        self.assertEqual(h.recv_json()['t'], 'error')
        a.expect_silence()


class ProxyTest(unittest.TestCase):
    """X-Real-IP n'est cru que si la connexion vient d'une adresse privée (nginx, Docker)."""

    def test_private_peer(self):
        sys.path.insert(0, ROOT)
        import serveur
        for ip in ['127.0.0.1', '::1', '172.17.0.1', '10.0.0.5', '192.168.1.20', '::ffff:172.18.0.3']:
            self.assertTrue(serveur.private_peer(ip), ip)
        for ip in ['51.210.150.192', '8.8.8.8', '::ffff:8.8.8.8', '2001:4860::8888', 'pas une ip', '']:
            self.assertFalse(serveur.private_peer(ip), ip)


if __name__ == '__main__':
    unittest.main()
