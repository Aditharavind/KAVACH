# KAVACH Ground Control Station

Operator console for **KAVACH-07**, a fictional indigenous unmanned ground vehicle.
Built with Vite + three.js. Everything on screen — video, map, telemetry, health,
GNSS, radio link and controls — comes from a simulation that runs in the browser.

> **PROTOTYPE · SIMULATED TELEMETRY · NO REAL VEHICLE CONNECTION.**
> The virtual controller drives the on-screen model only. Nothing here talks to
> hardware, a network link, or any external service.

## Run

```bash
npm install
npm run dev        # http://localhost:5173
npm run build      # production bundle in dist/
npm run preview    # serve the built bundle on :4173
```

Both servers bind `0.0.0.0`, so the console is also reachable from other machines
on the same network at `http://<this-machine-ip>:5173`. Vite prints the usable
addresses on startup. To keep it local only, set `host: '127.0.0.1'` in
`vite.config.js`. Typefaces load from Google Fonts; without internet access the
page falls back to system faces and everything else still works.

Designed for 13–16" laptops: 1366×768, 1440×900, 1920×1080 and 2560×1440.
Below ~1500px the vehicle-health rail becomes tabbed and keeps an at-a-glance
summary pinned beneath it; below ~1080px the console reflows into a single column
with the camera first.

## Themes

Two schemes, switched from the header and remembered per browser:

- **GRAPHITE** — the darkened field console (default).
- **DAYLIGHT** — white and blue, for lit rooms and projected briefings.

Both are driven from one token set in [`src/theme.js`](src/theme.js): CSS reads
it through `[data-theme]`, and the map and telemetry canvases read the same
values, so nothing drifts out of scheme. The virtual controller stays graphite
in both — it represents a physical device, not a panel. The camera feed is a
video image and keeps its own exposure; only the MAP view's overlays follow
the theme, since that view is rendered rather than filmed.

## Operating it

| Control | What it does |
| --- | --- |
| Joystick (mouse / touch) | Steer X and throttle Y; springs back to neutral on release |
| Arrow keys / WASD | Same, while the joystick has focus. `Esc` centres it |
| MANUAL / ASSIST / AUTO | Direct control · track-centring assist · autonomous route following |
| CAM 01 / CAM 02 / THERMAL / MAP | Forward mast, rear, LWIR imager, navigation map |
| Map: + − · CENTER VEHICLE · NORTH UP · FOLLOW VEHICLE | Zoom, recentre, orientation, follow. Drag to pan, wheel to zoom |
| `1`–`4` · `C` · `F` · `N` | Camera feed · centre input · follow · north-up |

`window.KAVACH` exposes the live vehicle state, map view and renderer for
inspection from the console (`KAVACH.diag()`).

## Feeding it real values — the Python API

`api/kavach_api.py` is a small ingest service (standard library only, nothing to
install). Start it, point the console's **API** panel at it, and anything that
can make an HTTP request can drive what the console shows.

```bash
npm run api                              # or: python3 api/kavach_api.py
python3 api/kavach_api.py --port 9000    # different port
python3 api/kavach_api.py --host 127.0.0.1   # local only (default is 0.0.0.0)
```

The console links to `http://<its own hostname>:8000` automatically. Override it
in the API panel, or with `?api=http://host:port` on the URL.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/` | usage document |
| `GET` | `/api/health` | liveness, uptime, counters |
| `GET` | `/api/state` | last known value for every field pushed |
| `GET` | `/api/stream` | Server-Sent Events — what the console subscribes to |
| `POST` | `/api/telemetry` | merge telemetry fields |
| `POST` | `/api/control` | steer / throttle / mode |
| `POST` | `/api/event` | append a line to the system event log |
| `POST` | `/api/reset` | drop everything; the console returns to local simulation |

```bash
# move the needles
curl -X POST http://localhost:8000/api/telemetry \
  -H 'content-type: application/json' \
  -d '{"speed":22.5,"soc":68,"rssi":-71,"temps":{"driveA":61},"source":"bench-rig-1"}'

# drive the vehicle
curl -X POST http://localhost:8000/api/control \
  -H 'content-type: application/json' -d '{"steer":-0.4,"throttle":0.9}'

# put a line in the event log
curl -X POST http://localhost:8000/api/event \
  -H 'content-type: application/json' -d '{"message":"BENCH RIG LINKED","severity":"ok"}'
```

A worked example that pushes a whole drive profile:

```bash
npm run api:demo                                    # localhost
python3 api/send_demo.py --host 10.0.0.5 --drive    # a console elsewhere on the LAN
```

**Fields.** `speed` `heading` `soc` `volt` `amp` `watt` `rssi` `linkPct`
`latency` `loss` `sats` `hdop` `acc` `pitch` `roll` `lat` `lon` `odo`,
`temps.{battery,driveA,driveB,controller,ambient}`, plus `mode`
(`MANUAL`/`ASSIST`/`AUTO`) and `source` (a name for whatever is pushing).
Control takes `steer` and `throttle` in −1…1. Values outside a sensible range
are clamped; unknown keys come back in `ignored` so a typo is obvious rather
than silent.

**How overrides behave.** A pushed field overrides the simulation *for as long
as it keeps arriving* — 12 seconds after the last update it expires and the
model resumes generating that field. So a producer that only sends `soc` and
`speed` leaves everything else running normally, and a producer that dies never
strands the console on frozen numbers. `speed`, `heading` and `lat`/`lon` move
the vehicle for real: the camera drives, the map marker moves and the breadcrumb
extends. A `/api/control` command is ignored the moment the local operator
touches the joystick — the person at the console always outranks the network.
The API panel lists every field currently under external control, and
**RELEASE TO LOCAL SIM** hands everything back.

## How it fits together

One vehicle model feeds every panel, so the camera, map, graphs, health readouts
and event log always describe the same machine on the same piece of ground.

| Module | Responsibility |
| --- | --- |
| `src/util.js` | Deterministic terrain height field, the wandering dirt track, spatial index, geodesy. The single source of truth for "where the ground is" |
| `src/sim.js` | Drive-train, skid-steer yaw, attitude from terrain gradient, power draw and discharge, thermal model, radio link vs. range from the control station, GNSS quality, autopilot |
| `src/scene.js` | three.js field environment — recentring terrain tile with vertex-coloured ground cover, graded track ribbon, instanced rocks / scrub / thorn trees / range markers, hull seen from its own cameras, hazy ridge lines, and a sensor post-process pass (vignette, scanlines, grain, chromatic split, LWIR palette) |
| `src/map.js` | Canvas relief map: hillshade and 2 m contours marched from the same height field, survey graticule, track, waypoints, breadcrumb trail, UGV marker |
| `src/telemetry.js` | Five 60-second engineering traces sampled at 5 Hz |
| `src/joystick.js` | Pointer / touch / keyboard input with sprung return |
| `src/events.js` | System event log: heartbeats plus state-change events raised by the model |
| `src/ui.js` | Binds vehicle state into the panels at 10 Hz |
| `src/theme.js` | The two console schemes, for CSS and canvas alike |
| `src/remote.js` | SSE client for the ingest API, with reconnect and override expiry |
| `api/kavach_api.py` | The ingest service — stdlib HTTP, SSE fan-out, validation |
| `api/send_demo.py` | Example producer: a full drive profile over the API |

### Simulation notes

- Battery discharge runs at 3× real rate so the trend is visible within a demo session.
- The radio link degrades with range from the control station at the survey origin,
  which is why signal, latency and packet loss drift as the vehicle drives out.
- Coordinates are simulated around a fictional field-test range origin
  (10.0124° N, 76.2972° E). No real facility is depicted.
- No real Indian military or government insignia are used anywhere in the interface.
  The national flag is shown at its correct 3:2 proportion with a 24-spoke chakra,
  displayed as an identity mark and never stretched, tinted or used as a background.

Designed & engineered in India.
