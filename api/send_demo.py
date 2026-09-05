#!/usr/bin/env python3
"""
Example producer for the KAVACH ingest API.

Pushes a plausible drive profile — the vehicle pulls away, works up a rise,
warms its drives, drains the pack and drifts out of good radio coverage —
so you can watch the console react to values it did not generate itself.

    python3 api/send_demo.py                        # localhost:8000
    python3 api/send_demo.py --host 10.133.147.176  # a console on the LAN
    python3 api/send_demo.py --drive                # also steer the vehicle

Standard library only. Ctrl+C to stop; the console falls back to its own
simulation once the values stop arriving.
"""

import argparse
import json
import math
import time
import urllib.error
import urllib.request

parser = argparse.ArgumentParser(description='Push a demo telemetry profile into KAVACH GCS')
parser.add_argument('--host', default='127.0.0.1')
parser.add_argument('--port', type=int, default=8000)
parser.add_argument('--rate', type=float, default=5.0, help='updates per second (default 5)')
parser.add_argument('--drive', action='store_true', help='also send steer/throttle commands')
args = parser.parse_args()

BASE = f'http://{args.host}:{args.port}'


def post(path, payload):
    req = urllib.request.Request(
        BASE + path,
        data=json.dumps(payload).encode(),
        headers={'Content-Type': 'application/json'},
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=3) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        print(f'  ! {path} -> {e.code} {e.read().decode()[:180]}')
    except urllib.error.URLError as e:
        print(f'  ! cannot reach {BASE} ({e.reason}). Is kavach_api.py running?')
        raise SystemExit(1)


print(f'  pushing to {BASE} at {args.rate} Hz — Ctrl+C to stop')
post('/api/event', {'message': 'BENCH RIG LINKED · EXTERNAL TELEMETRY', 'severity': 'ok'})

t0 = time.time()
soc = 78.0
next_event = 8.0

try:
    while True:
        t = time.time() - t0
        # a drive profile: ease up to speed, then vary with the terrain
        speed = max(0.0, 16.0 + 7.0 * math.sin(t / 11.0) + 2.0 * math.sin(t / 2.7))
        speed *= min(1.0, t / 4.0)
        heading = (84 + 26 * math.sin(t / 19.0)) % 360
        watt = 210 + speed * 17 + 90 * abs(math.sin(t / 6.0))
        soc = max(0.0, soc - watt * (1 / args.rate) / 3600 / 2680 * 100 * 6)
        duty = watt / 900

        post('/api/telemetry', {
            'source': 'bench-rig-1',
            'speed': round(speed, 2),
            'heading': round(heading, 1),
            'soc': round(soc, 2),
            'watt': round(watt, 1),
            'volt': round(51.9 - (78 - soc) * 0.08 - watt / 1000 * 0.9, 2),
            'amp': round(-watt / 51.0, 2),
            'rssi': round(-58 - 16 * abs(math.sin(t / 23.0)), 1),
            'linkPct': round(97 - 22 * abs(math.sin(t / 23.0)), 1),
            'latency': round(38 + 60 * abs(math.sin(t / 23.0)), 0),
            'loss': round(max(0.0, 2.4 * abs(math.sin(t / 23.0)) - 0.3), 2),
            'sats': 13 if math.sin(t / 31.0) > -0.6 else 9,
            'temps': {
                'driveA': round(41 + duty * 26 + 3 * math.sin(t / 8.0), 1),
                'driveB': round(40 + duty * 25 + 3 * math.cos(t / 8.0), 1),
                'battery': round(35 + duty * 9, 1),
                'controller': round(38 + duty * 13, 1),
                'ambient': 31.0,
            },
        })

        if args.drive:
            post('/api/control', {
                'steer': round(0.45 * math.sin(t / 7.0), 3),
                'throttle': round(0.55 + 0.35 * math.sin(t / 13.0), 3),
            })

        if t > next_event:
            next_event += 12
            post('/api/event', {'message': f'BENCH RIG SEGMENT {int(t // 12)} COMPLETE · {speed:.1f} KM/H',
                                'severity': 'note'})

        time.sleep(1 / args.rate)
except KeyboardInterrupt:
    post('/api/event', {'message': 'BENCH RIG DISCONNECTED', 'severity': 'warn'})
    print('\n  stopped')
