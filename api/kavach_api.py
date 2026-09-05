#!/usr/bin/env python3
"""
KAVACH GCS — external telemetry ingest API
==========================================

A small HTTP service that lets anything on the network push values into the
KAVACH Ground Control Station UI. Standard library only: no pip install.

    python3 api/kavach_api.py                  # 0.0.0.0:8000
    python3 api/kavach_api.py --port 9000
    python3 api/kavach_api.py --host 127.0.0.1 # local only

Endpoints
---------
GET  /                  usage document (JSON)
GET  /api/health        liveness + uptime + counters
GET  /api/state         last known values for every field pushed so far
GET  /api/stream        Server-Sent Events: every update, as it happens
POST /api/telemetry     merge telemetry fields  {"speed": 18.4, "soc": 74}
POST /api/control       drive the vehicle       {"steer": -0.3, "throttle": 0.8}
POST /api/event         append to the event log {"message": "...", "severity": "warn"}
POST /api/reset         drop all overrides; the console returns to local simulation

Nothing here touches hardware. The console is a simulation, and these values
are fed into that simulation for display.
"""

import argparse
import json
import queue
import socket
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ── accepted fields and their sane ranges ────────────────────────────────
# Anything outside the range is clamped; anything unknown is reported back
# in "ignored" so a caller with a typo finds out immediately.
NUMERIC = {
    'speed': (-25.0, 45.0),        # km/h, negative is reverse
    'heading': (0.0, 360.0),       # degrees true
    'soc': (0.0, 100.0),           # battery state of charge, %
    'volt': (0.0, 80.0),
    'amp': (-300.0, 300.0),
    'watt': (0.0, 5000.0),
    'rssi': (-120.0, -10.0),       # dBm
    'linkPct': (0.0, 100.0),
    'latency': (0.0, 5000.0),      # ms
    'loss': (0.0, 100.0),          # %
    'sats': (0.0, 32.0),
    'hdop': (0.0, 20.0),
    'acc': (0.0, 200.0),           # GNSS accuracy, m
    'pitch': (-45.0, 45.0),
    'roll': (-45.0, 45.0),
    'lat': (-90.0, 90.0),
    'lon': (-180.0, 180.0),
    'odo': (0.0, 1e7),             # m
}
TEMPS = {'battery': (-40.0, 250.0), 'driveA': (-40.0, 250.0), 'driveB': (-40.0, 250.0),
         'controller': (-40.0, 250.0), 'ambient': (-60.0, 80.0)}
MODES = ('MANUAL', 'ASSIST', 'AUTO')
SEVERITIES = ('info', 'ok', 'note', 'warn', 'crit')
CONTROL = {'steer': (-1.0, 1.0), 'throttle': (-1.0, 1.0)}


def clamp(v, lo, hi):
    return lo if v < lo else hi if v > hi else v


class Hub:
    """Fan-out of updates to every connected SSE subscriber."""

    def __init__(self):
        self.lock = threading.Lock()
        self.state = {'telemetry': {}, 'control': {}, 'source': None, 'mode': None}
        self.updated = 0.0            # when a value last arrived, for staleness checks
        self.subscribers = set()
        self.seq = 0
        self.started = time.time()
        self.counts = {'telemetry': 0, 'control': 0, 'event': 0}

    def subscribe(self):
        q = queue.Queue(maxsize=200)
        with self.lock:
            self.subscribers.add(q)
        return q

    def unsubscribe(self, q):
        with self.lock:
            self.subscribers.discard(q)

    def publish(self, kind, payload):
        with self.lock:
            self.seq += 1
            self.counts[kind] = self.counts.get(kind, 0) + 1
            if kind in ('telemetry', 'control'):
                self.updated = time.time()
            frame = json.dumps({'kind': kind, 'seq': self.seq, 't': time.time(), 'data': payload})
            dead = []
            for q in self.subscribers:
                try:
                    q.put_nowait(frame)
                except queue.Full:
                    dead.append(q)          # a stalled client must not block the rest
            for q in dead:
                self.subscribers.discard(q)
            return self.seq

    def snapshot(self):
        with self.lock:
            return {
                'seq': self.seq,
                'age': round(time.time() - self.updated, 2) if self.updated else None,
                'uptime': round(time.time() - self.started, 1),
                'subscribers': len(self.subscribers),
                'counts': dict(self.counts),
                'state': json.loads(json.dumps(self.state)),
            }


HUB = Hub()

USAGE = {
    'service': 'KAVACH GCS external telemetry ingest',
    'note': 'Simulation prototype. No real vehicle is connected to this API.',
    'endpoints': {
        'GET /api/health': 'liveness, uptime, counters',
        'GET /api/state': 'last known value for every field pushed',
        'GET /api/stream': 'Server-Sent Events stream of updates',
        'POST /api/telemetry': 'merge telemetry fields into the console',
        'POST /api/control': 'steer / throttle / mode',
        'POST /api/event': 'append a line to the system event log',
        'POST /api/reset': 'clear overrides, hand control back to the local simulation',
    },
    'telemetry_fields': sorted(list(NUMERIC) + ['temps.' + k for k in TEMPS] + ['mode', 'source']),
    'control_fields': ['steer', 'throttle', 'mode'],
    'examples': [
        "curl -X POST http://HOST:8000/api/telemetry -H 'content-type: application/json' "
        "-d '{\"speed\":22.5,\"soc\":68,\"temps\":{\"driveA\":61}}'",
        "curl -X POST http://HOST:8000/api/control -H 'content-type: application/json' "
        "-d '{\"steer\":-0.4,\"throttle\":0.9}'",
        "curl -X POST http://HOST:8000/api/event -H 'content-type: application/json' "
        "-d '{\"message\":\"BENCH RIG CONNECTED\",\"severity\":\"ok\"}'",
    ],
}


def parse_telemetry(body):
    """Validate a telemetry payload. Returns (accepted, ignored)."""
    out, ignored = {}, []
    for key, raw in body.items():
        if key in NUMERIC:
            try:
                lo, hi = NUMERIC[key]
                out[key] = clamp(float(raw), lo, hi)
            except (TypeError, ValueError):
                ignored.append(f'{key} (not a number)')
        elif key == 'temps' and isinstance(raw, dict):
            temps = {}
            for tk, tv in raw.items():
                if tk in TEMPS:
                    try:
                        lo, hi = TEMPS[tk]
                        temps[tk] = clamp(float(tv), lo, hi)
                    except (TypeError, ValueError):
                        ignored.append(f'temps.{tk} (not a number)')
                else:
                    ignored.append(f'temps.{tk}')
            if temps:
                out['temps'] = temps
        elif key == 'mode':
            if isinstance(raw, str) and raw.upper() in MODES:
                out['mode'] = raw.upper()
            else:
                ignored.append(f'mode (expected one of {", ".join(MODES)})')
        elif key == 'source':
            out['source'] = str(raw)[:24]
        else:
            ignored.append(key)
    return out, ignored


def parse_control(body):
    out, ignored = {}, []
    for key, raw in body.items():
        if key in CONTROL:
            try:
                lo, hi = CONTROL[key]
                out[key] = clamp(float(raw), lo, hi)
            except (TypeError, ValueError):
                ignored.append(f'{key} (not a number)')
        elif key == 'mode':
            if isinstance(raw, str) and raw.upper() in MODES:
                out['mode'] = raw.upper()
            else:
                ignored.append('mode')
        elif key == 'source':
            out['source'] = str(raw)[:24]
        else:
            ignored.append(key)
    return out, ignored


class Handler(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    server_version = 'KAVACH-GCS-Ingest/1.0'

    # ── plumbing ──
    def log_message(self, fmt, *args):
        if self.path != '/api/stream':
            print(f'  {self.address_string()} {fmt % args}', flush=True)

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'content-type')
        self.send_header('Access-Control-Max-Age', '86400')

    def _json(self, obj, status=200):
        payload = json.dumps(obj, indent=1).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(payload)))
        self.send_header('Cache-Control', 'no-store')
        self._cors()
        self.end_headers()
        self.wfile.write(payload)

    def _body(self):
        length = int(self.headers.get('Content-Length') or 0)
        if length <= 0:
            return {}, None
        if length > 64 * 1024:
            return None, 'payload too large'
        raw = self.rfile.read(length)
        try:
            parsed = json.loads(raw or b'{}')
        except json.JSONDecodeError as exc:
            return None, f'invalid JSON: {exc.msg} at position {exc.pos}'
        if not isinstance(parsed, dict):
            return None, 'body must be a JSON object'
        return parsed, None

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header('Content-Length', '0')
        self.end_headers()

    # ── reads ──
    def do_GET(self):
        path = self.path.split('?')[0].rstrip('/') or '/'
        if path == '/':
            return self._json(USAGE)
        if path == '/api/health':
            snap = HUB.snapshot()
            return self._json({'ok': True, 'uptime': snap['uptime'], 'seq': snap['seq'],
                               'subscribers': snap['subscribers'], 'counts': snap['counts']})
        if path == '/api/state':
            return self._json(HUB.snapshot())
        if path == '/api/stream':
            return self._stream()
        return self._json({'error': 'not found', 'path': path, 'see': '/'}, 404)

    def _stream(self):
        q = HUB.subscribe()
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Connection', 'keep-alive')
        self.send_header('X-Accel-Buffering', 'no')
        self._cors()
        self.end_headers()
        try:
            snap = HUB.snapshot()
            # `age` lets a joining console decide whether retained values are
            # still worth adopting, instead of replaying stale numbers as live
            self._sse('hello', json.dumps({'service': 'kavach-ingest', 'state': snap['state'],
                                           'seq': snap['seq'], 'age': snap['age']}))
            while True:
                try:
                    frame = q.get(timeout=15)
                except queue.Empty:
                    self.wfile.write(b': keepalive\n\n')      # keeps proxies from idling us out
                    self.wfile.flush()
                    continue
                kind = json.loads(frame)['kind']
                self._sse(kind, frame)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass
        finally:
            HUB.unsubscribe(q)

    def _sse(self, event, data):
        self.wfile.write(f'event: {event}\ndata: {data}\n\n'.encode())
        self.wfile.flush()

    # ── writes ──
    def do_POST(self):
        path = self.path.split('?')[0].rstrip('/') or '/'
        body, err = self._body()
        if err:
            return self._json({'error': err}, 400)

        if path == '/api/telemetry':
            accepted, ignored = parse_telemetry(body)
            if not accepted:
                return self._json({'error': 'no recognised fields', 'ignored': ignored,
                                   'accepted_fields': USAGE['telemetry_fields']}, 400)
            with HUB.lock:
                if 'temps' in accepted:
                    HUB.state['telemetry'].setdefault('temps', {}).update(accepted['temps'])
                    merged = {k: v for k, v in accepted.items() if k != 'temps'}
                    HUB.state['telemetry'].update(merged)
                else:
                    HUB.state['telemetry'].update(accepted)
                if 'source' in accepted:
                    HUB.state['source'] = accepted['source']
                if 'mode' in accepted:
                    HUB.state['mode'] = accepted['mode']
            seq = HUB.publish('telemetry', accepted)
            return self._json({'ok': True, 'seq': seq, 'applied': accepted, 'ignored': ignored})

        if path == '/api/control':
            accepted, ignored = parse_control(body)
            if not accepted:
                return self._json({'error': 'no recognised fields', 'ignored': ignored,
                                   'accepted_fields': USAGE['control_fields']}, 400)
            with HUB.lock:
                HUB.state['control'].update(accepted)
                if 'mode' in accepted:
                    HUB.state['mode'] = accepted['mode']
            seq = HUB.publish('control', accepted)
            return self._json({'ok': True, 'seq': seq, 'applied': accepted, 'ignored': ignored})

        if path == '/api/event':
            message = str(body.get('message', '')).strip()[:160]
            if not message:
                return self._json({'error': 'message is required'}, 400)
            severity = str(body.get('severity', 'info')).lower()
            if severity not in SEVERITIES:
                return self._json({'error': f'severity must be one of {", ".join(SEVERITIES)}'}, 400)
            seq = HUB.publish('event', {'message': message, 'severity': severity})
            return self._json({'ok': True, 'seq': seq})

        if path == '/api/reset':
            with HUB.lock:
                HUB.state = {'telemetry': {}, 'control': {}, 'source': None, 'mode': None}
                HUB.updated = 0.0
            seq = HUB.publish('reset', {})
            return self._json({'ok': True, 'seq': seq, 'note': 'console returns to local simulation'})

        return self._json({'error': 'not found', 'path': path, 'see': '/'}, 404)


def local_addresses():
    addrs = ['127.0.0.1']
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(('8.8.8.8', 80))       # no packets sent; just picks the default route
        addrs.append(s.getsockname()[0])
        s.close()
    except OSError:
        pass
    return addrs


def main():
    ap = argparse.ArgumentParser(description='KAVACH GCS external telemetry ingest API')
    ap.add_argument('--host', default='0.0.0.0', help='bind address (default 0.0.0.0, all interfaces)')
    ap.add_argument('--port', type=int, default=8000, help='bind port (default 8000)')
    args = ap.parse_args()

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    server.daemon_threads = True
    print('\n  KAVACH GCS · EXTERNAL TELEMETRY INGEST')
    print('  simulation prototype — no real vehicle connection\n')
    for addr in local_addresses():
        print(f'  ➜  http://{addr}:{args.port}/            usage')
        print(f'     http://{addr}:{args.port}/api/stream  live stream')
    print(f'\n  point the console at http://<this-host>:{args.port} in its API panel')
    print('  Ctrl+C to stop\n')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n  ingest stopped\n')
    finally:
        server.server_close()


if __name__ == '__main__':
    main()
