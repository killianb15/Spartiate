"""Serveur de Spartiate Arènes : sert les fichiers du jeu et relaie les parties
en ligne (réseau local) entre l'hôte et l'invité via WebSocket.
Aucune dépendance pour jouer : seulement la bibliothèque standard de Python.
Comptes des joueurs (/api/...) : facultatifs, relayés vers l'API Rust (api/, docker-compose.yml),
seule à parler à la base PostgreSQL. Sans elle, le jeu marche comme avant (comptes indisponibles)."""
import base64
import email.utils
import gzip
import hashlib
import http.client
import ipaddress
import json
import os
import random
import re
import socket
import struct
import sys
import threading
import time
import webbrowser
from functools import partial
from urllib.parse import unquote, urlsplit
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ARGS = [a for a in sys.argv[1:] if not a.startswith('-')]
PORT = int(ARGS[0]) if ARGS and ARGS[0].isdigit() else 8123   # (importé par les tests : autres arguments)
OPEN_BROWSER = '--no-browser' not in sys.argv[1:]
ROOT = os.path.dirname(os.path.abspath(__file__))
WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'

MAX_MSG = 64 * 1024     # taille max d'un message WebSocket (les messages du jeu font < 2 Ko)
MAX_ROOMS = 200         # parties simultanées
MAX_CONNS = 500         # connexions WebSocket simultanées
RATE_LIMIT = 240        # messages/s par connexion en moyenne (le jeu : ~60 inputs/s + signalisation WebRTC)
RATE_BURST = 480        # rafale maximale tolérée (capacité du seau)
RATE_ABUSE = 20         # au-delà de RATE_ABUSE x RATE_LIMIT messages ignorés en 1 s : connexion fermée
conns = 0

rooms = {}          # code -> {'host': Conn, 'guest': Conn | None, 'hall': dict | None}
# 'hall' : salon ouvert depuis la salle d'armes du donjon, visible de tous (list) tant qu'il reste une place
MAX_LIST = 30       # salons renvoyés par 'list'
HALL_KEYS = {'kind': 16, 'wpn': 16}   # ce que l'hôte montre de lui (héros, arme) : longueur max
MAX_BODY = 4096     # corps d'une requête /api (JSON)
# API des comptes (Rust, 127.0.0.1 seulement) : on ne lui relaie que ces routes
API = urlsplit(os.environ.get('SPARTIATE_API', 'http://127.0.0.1:8124'))
API_ROUTES = {('GET', '/api/profil'), ('GET', '/api/classement'), ('GET', '/api/defis'), ('POST', '/api/inscription'),
              ('POST', '/api/connexion'), ('POST', '/api/deconnexion'), ('POST', '/api/partie')}
API_DOWN = 'Comptes indisponibles : le service des comptes ne répond pas (docker compose up -d).'
TOKEN_RE = re.compile(r'^[A-Za-z0-9_-]{20,100}$')
# derrière un proxy de confiance (nginx du VPS) : l'adresse du joueur est dans X-Real-IP, mais seulement
# quand la connexion vient d'une adresse privée (nginx, Docker) : sinon n'importe qui pourrait l'inventer
BEHIND_PROXY = os.environ.get('SPARTIATE_PROXY') == '1'


def private_peer(ip):
    """Vrai pour une adresse locale ou privée (proxy de la même machine ou du réseau Docker)."""
    try:
        a = ipaddress.ip_address(ip)
        if a.version == 6 and a.ipv4_mapped:
            a = a.ipv4_mapped
        return a.is_private or a.is_loopback
    except ValueError:
        return False
lock = threading.Lock()


def public_urls():
    """Adresse du jeu à donner à un ami : SPARTIATE_URLS si on la connaît (en conteneur, l'adresse vue
    par le serveur est celle du conteneur, inutile), sinon celle de ce PC sur le réseau local."""
    env = os.environ.get('SPARTIATE_URLS', '')
    if env or os.environ.get('SPARTIATE_DOCKER'):
        return [u.strip() for u in env.split(',') if u.strip()][:2]
    return [f'http://{ip}:{PORT}' for ip in lan_ips()[:1]]


def lan_ips():
    """Adresses IP de ce PC sur le réseau local (la principale en premier)."""
    ips = []
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('10.255.255.255', 1))   # aucun paquet n'est envoyé
        ips.append(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    try:
        for ip in socket.gethostbyname_ex(socket.gethostname())[2]:
            if ip not in ips:
                ips.append(ip)
    except OSError:
        pass
    return [ip for ip in ips if not ip.startswith('127.')]


class Conn:
    """Une connexion WebSocket (trames texte, sans extension)."""

    def __init__(self, handler):
        self.rfile = handler.rfile
        self.wfile = handler.wfile
        self.wlock = threading.Lock()
        self.room = None
        self.is_host = False
        self.tokens = float(RATE_BURST)
        self.last = time.monotonic()
        self.drop_start = self.last
        self.drops = 0

    def allow(self):
        """Token bucket. Renvoie True si le message est accepté, False s'il doit être ignoré,
        None en cas d'abus massif (la connexion doit être fermée)."""
        now = time.monotonic()
        self.tokens = min(RATE_BURST, self.tokens + (now - self.last) * RATE_LIMIT)
        self.last = now
        if self.tokens >= 1:
            self.tokens -= 1
            return True
        if now - self.drop_start > 1:
            self.drop_start, self.drops = now, 0
        self.drops += 1
        return None if self.drops > RATE_ABUSE * RATE_LIMIT else False

    def send(self, data, op=0x81):
        if isinstance(data, str):
            data = data.encode()
        n = len(data)
        if n < 126:
            head = struct.pack('!BB', op, n)
        elif n < 65536:
            head = struct.pack('!BBH', op, 126, n)
        else:
            head = struct.pack('!BBQ', op, 127, n)
        with self.wlock:
            try:
                self.wfile.write(head + data)
            except OSError:
                pass

    def send_json(self, **m):
        self.send(json.dumps(m))

    def recv(self):
        """Texte du prochain message, ou None quand la connexion se ferme."""
        buf = b''
        while True:
            head = self.rfile.read(2)
            if len(head) < 2:
                return None
            fin, op, n = head[0] & 0x80, head[0] & 0x0F, head[1] & 0x7F
            if n == 126:
                n = struct.unpack('!H', self.rfile.read(2))[0]
            elif n == 127:
                n = struct.unpack('!Q', self.rfile.read(8))[0]
            if n > MAX_MSG or len(buf) + n > MAX_MSG:
                return None        # message trop gros : on coupe la connexion
            mask = self.rfile.read(4) if head[1] & 0x80 else None
            data = self.rfile.read(n)
            if len(data) < n:
                return None
            if mask:
                k = (mask * (n // 4 + 1))[:n]
                data = (int.from_bytes(data, 'big') ^ int.from_bytes(k, 'big')).to_bytes(n, 'big')
            if op == 0x8:
                return None
            if op == 0x9:
                self.send(data, 0x8A)
                continue
            if op == 0xA:
                continue
            buf += data
            if fin:
                return buf.decode('utf-8', 'replace')


def peer_of(c):
    with lock:
        r = rooms.get(c.room)
        if not r:
            return None
        return r['guest'] if c.is_host else r['host']


def leave(c):
    other = None
    with lock:
        r = rooms.get(c.room)
        if r:
            if c.is_host:
                del rooms[c.room]
                other = r['guest']
                if other:
                    other.room = None
            elif r['guest'] is c:
                r['guest'] = None
                other = r['host']
        c.room = None
    if other:
        other.send_json(t='bye')


def create(c, hall=None):
    leave(c)
    with lock:
        if len(rooms) >= MAX_ROOMS:
            c.send_json(t='error', msg='Le serveur est complet, réessaie plus tard.')
            return
        code = ''.join(random.choice(LETTERS) for _ in range(4))
        while code in rooms:
            code = ''.join(random.choice(LETTERS) for _ in range(4))
        rooms[code] = {'host': c, 'guest': None, 'hall': hall}
        c.room, c.is_host = code, True
    c.send_json(t='created', code=code, hall=hall is not None, urls=public_urls())
    print(f'  Partie créée : {code}', flush=True)


def api_call(method, path, body=None, token='', ip=''):
    """Requête à l'API des comptes : (code HTTP, objet JSON) ; (503, ...) si elle ne répond pas."""
    headers = {'Content-Type': 'application/json'}
    if token:
        headers['Authorization'] = 'Bearer ' + token
    if ip:
        headers['X-Real-IP'] = ip
    c = http.client.HTTPConnection(API.hostname, API.port or 80, timeout=8)
    try:
        c.request(method, path, body=body, headers=headers)
        r = c.getresponse()
        try:
            obj = json.loads(r.read(1024 * 1024) or b'{}')
        except ValueError:
            obj = None
        if not isinstance(obj, dict):
            return 502, {'erreur': 'Réponse invalide du service des comptes.'}
        return r.status, obj
    except (OSError, http.client.HTTPException):
        return 503, {'erreur': API_DOWN}
    finally:
        c.close()


def pseudo_of(token):
    """Pseudo du compte de ce jeton de session (vérifié par l'API), ou ''."""
    if not isinstance(token, str) or not TOKEN_RE.match(token):
        return ''
    st, r = api_call('GET', '/api/profil', token=token)
    p = r.get('profil') if st == 200 else None
    return str(p.get('pseudo', ''))[:16] if isinstance(p, dict) else ''


def hall_of(m):
    """Description publique d'un salon (seulement des chaînes courtes) ; le pseudo vient du compte
    (jeton de session vérifié par l'API), jamais de ce que le joueur écrit."""
    h = {k: str(m.get(k, ''))[:n] for k, n in HALL_KEYS.items()}
    h['name'] = pseudo_of(m.get('token'))
    return h


def update_hall(c, m):
    """Met à jour l'état public d'un salon ouvert par l'hôte (fermeture dès qu'on quitte la salle d'armes,
    ou mise à jour du héros / de l'arme affichés dans la liste des salons)."""
    with lock:
        r = rooms.get(c.room)
        if not r or not c.is_host:
            return
        if m.get('open') is False:
            r['hall'] = None
        elif r['hall'] is not None:
            for k, n in HALL_KEYS.items():
                if k in m:
                    r['hall'][k] = str(m.get(k, ''))[:n]


def list_halls(c):
    with lock:
        out = [{'code': code, **r['hall']} for code, r in rooms.items()
               if r['hall'] is not None and r['guest'] is None and r['host'] is not c][:MAX_LIST]
    c.send_json(t='rooms', rooms=out)


def join(c, code):
    leave(c)
    with lock:
        r = rooms.get(code)
        if not r:
            err = 'Aucune partie avec ce code.'
        elif r['guest']:
            err = 'Cette partie est déjà complète.'
        else:
            err = None
            r['guest'] = c
            c.room, c.is_host = code, False
    if err:
        c.send_json(t='error', msg=err)
        return
    c.send_json(t='joined', code=code)
    r['host'].send_json(t='peer')
    print(f'  Un joueur a rejoint la partie {code}', flush=True)


def hidden(path):
    """Chemin vers un fichier ou dossier caché (.git, .env…), même encodé (%2e)."""
    return any(part.startswith('.') for part in unquote(path).replace('\\', '/').split('/'))


# Compression gzip en mémoire des fichiers statiques (GLB, JS, HTML : ~78 % plus léger au chargement)
GZIP_EXTS = {'.js', '.mjs', '.html', '.css', '.json', '.svg', '.glb'}
GZIP_CACHE = {}          # (chemin, mtime_ns, taille) -> bytes compressés
GZIP_CACHE_MAX = 200
GZIP_LOCK = threading.Lock()


def gzip_bytes(fs_path, st):
    """Renvoie la version gzip d'un fichier (mise en cache en mémoire tant que le fichier ne change pas)."""
    key = (fs_path, st.st_mtime_ns, st.st_size)
    with GZIP_LOCK:
        hit = GZIP_CACHE.get(key)
        if hit is not None:
            return hit
    with open(fs_path, 'rb') as f:
        data = gzip.compress(f.read(), compresslevel=6)
    with GZIP_LOCK:
        if len(GZIP_CACHE) >= GZIP_CACHE_MAX:
            GZIP_CACHE.clear()
        GZIP_CACHE[key] = data
    return data


class Handler(SimpleHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'     # connexions persistantes (keep-alive) : bien moins de poignées de main TCP
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript', '.mjs': 'text/javascript',
        '.glb': 'model/gltf-binary', '.html': 'text/html; charset=utf-8',
    }

    def log_message(self, fmt, *args):
        pass

    def cache_policy(self):
        path = self.path.split('?')[0]
        if path.startswith('/assets/'):
            return 'public, max-age=86400'
        return 'no-cache'

    def end_headers(self):
        has_cc = any(line.lower().startswith(b'cache-control:') for line in getattr(self, '_headers_buffer', ()))
        if not has_cc:
            self.send_header('Cache-Control', self.cache_policy())
        super().end_headers()

    def serve_gzip(self, head_only=False):
        """Sert le fichier statique compressé en gzip si le navigateur l'accepte. Renvoie True si traité."""
        if 'gzip' not in self.headers.get('Accept-Encoding', '').lower():
            return False
        fs_path = self.translate_path(self.path)
        if not os.path.isfile(fs_path):
            return False
        _, ext = os.path.splitext(fs_path)
        if ext.lower() not in GZIP_EXTS:
            return False
        try:
            st = os.stat(fs_path)
            ims = self.headers.get('If-Modified-Since')
            if ims:
                try:
                    t = email.utils.parsedate_to_datetime(ims)
                    if t.tzinfo is not None and int(st.st_mtime) <= int(t.timestamp()):
                        self.send_response(304)
                        self.send_header('Vary', 'Accept-Encoding')
                        self.send_header('Content-Length', '0')
                        self.end_headers()
                        return True
                except (TypeError, ValueError, OverflowError):
                    pass
            gz = gzip_bytes(fs_path, st)
        except OSError:
            return False
        self.send_response(200)
        self.send_header('Content-Type', self.guess_type(fs_path))
        self.send_header('Content-Encoding', 'gzip')
        self.send_header('Vary', 'Accept-Encoding')
        self.send_header('Content-Length', str(len(gz)))
        self.send_header('Last-Modified', self.date_time_string(st.st_mtime))
        self.end_headers()
        if not head_only:
            self.wfile.write(gz)
        return True

    def do_GET(self):
        path = self.path.split('?')[0]
        if path == '/ws' and self.headers.get('Upgrade', '').lower() == 'websocket':
            self.websocket()
        elif path.startswith('/api/'):
            self.api('GET', path)
        elif hidden(path):
            self.send_error(404)     # .git, .env… : jamais servis
        elif not self.serve_gzip(head_only=False):
            super().do_GET()

    def do_HEAD(self):
        if hidden(self.path.split('?')[0]):
            self.send_error(404)
        elif not self.serve_gzip(head_only=True):
            super().do_HEAD()

    def do_POST(self):
        path = self.path.split('?')[0]
        if path.startswith('/api/'):
            self.api('POST', path)
        else:
            self.send_error(405)

    # ---------- comptes des joueurs : relais vers l'API Rust ----------
    def reply(self, status, obj):
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(data)))
        self.send_header('Cache-Control', 'no-store')
        self.end_headers()
        self.wfile.write(data)

    def client_ip(self):
        if BEHIND_PROXY and private_peer(self.client_address[0]):
            ip = self.headers.get('X-Real-IP', '').strip()
            if re.match(r'^[0-9A-Fa-f:.]{2,45}$', ip):
                return ip
        return self.client_address[0]

    def api(self, method, path):
        if (method, path) == ('GET', '/api/etat'):
            st, _ = api_call('GET', '/api/sante')
            return self.reply(200, {'comptes': st == 200})
        if (method, path) not in API_ROUTES:
            return self.reply(404, {'erreur': 'Inconnu.'})
        body = None
        if method == 'POST':
            try:
                n = int(self.headers.get('Content-Length', '0'))
            except ValueError:
                n = -1
            if not 0 <= n <= MAX_BODY:
                self.close_connection = True
                return self.reply(413, {'erreur': 'Requête trop grosse.'})
            body = self.rfile.read(n)
        auth = self.headers.get('Authorization', '')
        token = auth[7:].strip() if auth.startswith('Bearer ') else ''
        st, obj = api_call(method, path, body, token if TOKEN_RE.match(token) else '', self.client_ip())
        self.reply(st, obj)

    def websocket(self):
        key = self.headers.get('Sec-WebSocket-Key', '')
        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        self.wfile.write(('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                          f'Sec-WebSocket-Accept: {accept}\r\n\r\n').encode())
        self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        global conns
        with lock:
            if conns >= MAX_CONNS:
                return
            conns += 1
        c = Conn(self)
        try:
            while True:
                msg = c.recv()
                if msg is None:
                    break
                ok = c.allow()
                if ok is None:
                    break              # abus massif : on coupe
                if not ok:
                    continue           # débit dépassé : message ignoré
                other = peer_of(c)
                # Voie rapide : paquets jeu temps réel relayés sans analyse JSON
                if other and msg.startswith(('{"t":"cs"', '{"t":"ci"', '{"t":"cp"', '{"t":"cq"', '{"t":"ri"', '{"t":"rs"', '{"t":"rtc"')):
                    other.send(msg)
                    continue
                try:
                    m = json.loads(msg)
                except ValueError:
                    if other:
                        other.send(msg)
                    continue
                t = m.get('t') if isinstance(m, dict) else None
                if t == 'create':
                    create(c)
                elif t == 'open':
                    create(c, hall_of(m))
                elif t == 'list':
                    list_halls(c)
                elif t in ('close', 'leave'):
                    leave(c)
                elif t == 'hall_state':
                    update_hall(c, m)
                elif t == 'join':
                    join(c, str(m.get('code', '')).strip().upper())
                elif other:
                    other.send(msg)       # message de partie (start, hello, menu, etc.) : relayé tel quel
        except OSError:
            pass
        finally:
            with lock:
                conns -= 1
            leave(c)
            self.close_connection = True


class Server(ThreadingHTTPServer):
    """Écoute en IPv4 et en IPv6 (« localhost » pointe souvent vers ::1), et refuse
    de partager le port : sous Windows, un ancien serveur pourrait sinon répondre à sa place.
    Sous Linux/macOS, SO_REUSEADDR n'autorise pas deux serveurs sur le même port mais évite
    l'erreur « port déjà utilisé » pendant ~1 min après avoir fermé le jeu."""
    address_family = socket.AF_INET6
    allow_reuse_address = os.name != 'nt'

    def server_bind(self):
        if hasattr(socket, 'SO_EXCLUSIVEADDRUSE'):
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        if self.address_family == socket.AF_INET6:
            self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
        super().server_bind()


class Server4(Server):
    address_family = socket.AF_INET


def main():
    handler = partial(Handler, directory=ROOT)
    try:
        try:
            httpd = Server(('::', PORT), handler)
        except OSError as e:
            if getattr(e, 'winerror', None) == 10048 or e.errno in (48, 98):
                raise
            httpd = Server4(('', PORT), handler)    # pas d'IPv6 sur ce PC
    except OSError:
        print(f'Le port {PORT} est déjà utilisé : le jeu tourne sans doute déjà dans une autre fenêtre.')
        print('Ferme les autres fenêtres du jeu (jouer.bat / jouer.sh) puis relance,')
        print(f'ou choisis un autre port, par exemple : python serveur.py {PORT + 1}')
        sys.exit(1)
    print('=' * 60)
    print('  SPARTIATE ARENES')
    print(f'  Sur ce PC       : http://localhost:{PORT}')
    ips = [] if os.environ.get('SPARTIATE_DOCKER') else lan_ips()
    for u in public_urls() if os.environ.get('SPARTIATE_DOCKER') else []:
        print(f'  Pour ton ami    : {u}')
    if ips:
        print(f'  Pour ton ami    : http://{ips[0]}:{PORT}   (même Wi-Fi / réseau)')
    if len(ips) > 1:
        print('  (autres adresses possibles : ' + ', '.join(ips[1:]) + ')')
    print('  Comptes joueurs : ' + ('activés' if api_call('GET', '/api/sante')[0] == 200 else 'désactivés (docker compose up -d pour les activer)'))
    print('  Laisse cette fenêtre ouverte pendant que vous jouez.')
    print('  (Ctrl+C pour arrêter)')
    print('=' * 60, flush=True)
    if OPEN_BROWSER:
        threading.Timer(0.5, webbrowser.open, (f'http://localhost:{PORT}/',)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
