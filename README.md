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

### Simulation notes

- Battery discharge runs at 3× real rate so the trend is visible within a demo session.
- The radio link degrades with range from the control station at the survey origin,
  which is why signal, latency and packet loss drift as the vehicle drives out.
- Coordinates are simulated around a fictional field-test range origin
  (10.0124° N, 76.2972° E). No real facility is depicted.
- No real Indian military or government insignia are used anywhere in the interface.

Designed & engineered in India.
