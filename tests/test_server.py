"""Tests du serveur (stdlib uniquement) : lance le vrai serveur en sous-processus."""
import base64
import json
import os
import socket
import struct
import subprocess
import sys
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
            self.assertIn(b'<', r.read(200))

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


if __name__ == '__main__':
    unittest.main()
