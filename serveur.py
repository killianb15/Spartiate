"""Serveur de Spartiate Arènes : sert les fichiers du jeu et relaie les parties
en ligne (réseau local) entre l'hôte et l'invité via WebSocket.
Aucune dépendance : seulement la bibliothèque standard de Python."""
import base64
import hashlib
import json
import os
import random
import socket
import struct
import sys
import threading
import webbrowser
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

ARGS = [a for a in sys.argv[1:] if not a.startswith('-')]
PORT = int(ARGS[0]) if ARGS else 8123
OPEN_BROWSER = '--no-browser' not in sys.argv[1:]
ROOT = os.path.dirname(os.path.abspath(__file__))
WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'

rooms = {}          # code -> {'host': Conn, 'guest': Conn | None}
lock = threading.Lock()


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


def create(c):
    leave(c)
    with lock:
        code = ''.join(random.choice(LETTERS) for _ in range(4))
        while code in rooms:
            code = ''.join(random.choice(LETTERS) for _ in range(4))
        rooms[code] = {'host': c, 'guest': None}
        c.room, c.is_host = code, True
    c.send_json(t='created', code=code, urls=[f'http://{ip}:{PORT}' for ip in lan_ips()[:1]])
    print(f'  Partie créée : {code}', flush=True)


def join(c, code):
    leave(c)
    with lock:
        r = rooms.get(code)
        if not r:
            err = 'Aucune partie avec le code « %s ».' % code
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


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {
        **SimpleHTTPRequestHandler.extensions_map,
        '.js': 'text/javascript', '.mjs': 'text/javascript',
        '.glb': 'model/gltf-binary', '.html': 'text/html; charset=utf-8',
    }

    def log_message(self, fmt, *args):
        pass

    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache')
        super().end_headers()

    def do_GET(self):
        if self.path.split('?')[0] == '/ws' and self.headers.get('Upgrade', '').lower() == 'websocket':
            self.websocket()
        else:
            super().do_GET()

    def websocket(self):
        key = self.headers.get('Sec-WebSocket-Key', '')
        accept = base64.b64encode(hashlib.sha1((key + WS_GUID).encode()).digest()).decode()
        self.wfile.write(('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n'
                          f'Sec-WebSocket-Accept: {accept}\r\n\r\n').encode())
        self.connection.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        c = Conn(self)
        try:
            while True:
                msg = c.recv()
                if msg is None:
                    break
                other = peer_of(c)
                if other:
                    other.send(msg)       # partie en cours : on relaie tel quel
                    continue
                try:
                    m = json.loads(msg)
                except ValueError:
                    continue
                if m.get('t') == 'create':
                    create(c)
                elif m.get('t') == 'join':
                    join(c, str(m.get('code', '')).strip().upper())
        except OSError:
            pass
        finally:
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
    ips = lan_ips()
    if ips:
        print(f'  Pour ton ami    : http://{ips[0]}:{PORT}   (même Wi-Fi / réseau)')
    if len(ips) > 1:
        print('  (autres adresses possibles : ' + ', '.join(ips[1:]) + ')')
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
