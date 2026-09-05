// ─── console themes ───────────────────────────────────────────────────
// Two operator schemes. GRAPHITE is the darkened field console; DAYLIGHT
// is a white-and-blue scheme for lit control rooms and projected briefings.
// CSS reads the tokens through [data-theme]; the canvases read the same
// values from `palette`, so map, graphs and panels never disagree.

export const THEMES = {
  graphite: {
    label: 'GRAPHITE',
    map: {
      bg: '#0B0E0B',
      relief: { base: [16, 20, 15], shade: [26, 28, 20], elev: [12, 12, 8] },
      contourMajor: 'rgba(190,196,170,0.20)',
      contourMinor: 'rgba(160,170,140,0.09)',
      grid: 'rgba(149,168,95,0.09)',
      gridLabel: 'rgba(122,133,120,0.55)',
      spur: 'rgba(96,88,64,0.55)',
      spurDash: 'rgba(140,128,92,0.22)',
      trackCase: 'rgba(88,80,58,0.85)',
      trackFill: 'rgba(134,120,86,0.8)',
      trackDash: 'rgba(196,182,142,0.16)',
      wpAhead: 'rgba(224,139,54,0.85)',
      wp: 'rgba(149,168,95,0.45)',
      wpLabelAhead: 'rgba(224,139,54,0.75)',
      wpLabel: 'rgba(122,133,120,0.6)',
      trailCase: 'rgba(18,24,14,0.85)',
      trail: 'rgba(139,158,88,0.9)',
      trailTail: 'rgba(186,208,124,0.95)',
      trailDot: 'rgba(216,230,180,0.9)',
      node: 'rgba(126,154,168,0.8)',
      area: 'rgba(122,133,120,0.35)',
      placeLabel: 'rgba(176,186,168,0.75)',
      accFill: 'rgba(224,139,54,0.07)',
      accLine: 'rgba(224,139,54,0.32)',
      heading: 'rgba(224,139,54,0.7)',
      hull: '#12160F',
      hullEdge: '#E08B36',
      hullTrack: 'rgba(224,139,54,0.85)',
      hullMark: '#D8DDD1',
      frame: 'rgba(48,56,41,0.9)',
      tick: 'rgba(149,168,95,0.35)',
    },
    graph: {
      grid: 'rgba(149,168,95,0.07)',
      series: ['#95A85F', '#D9A63F', '#E08B36', '#7E9AA8', '#8FA0B8'],
      fillAlpha: '38',
    },
  },

  daylight: {
    label: 'DAYLIGHT',
    map: {
      bg: '#E8EEF4',
      relief: { base: [239, 243, 247], shade: [-48, -42, -31], elev: [-15, -11, -2] },
      contourMajor: 'rgba(52,86,120,0.28)',
      contourMinor: 'rgba(70,104,138,0.13)',
      grid: 'rgba(43,111,181,0.13)',
      gridLabel: 'rgba(64,96,124,0.7)',
      spur: 'rgba(150,132,96,0.6)',
      spurDash: 'rgba(120,102,70,0.3)',
      trackCase: 'rgba(146,124,84,0.7)',
      trackFill: 'rgba(206,186,142,0.95)',
      trackDash: 'rgba(112,92,58,0.28)',
      wpAhead: 'rgba(200,110,28,0.95)',
      wp: 'rgba(43,111,181,0.5)',
      wpLabelAhead: 'rgba(178,96,22,0.9)',
      wpLabel: 'rgba(70,102,130,0.75)',
      trailCase: 'rgba(255,255,255,0.9)',
      trailTail: 'rgba(20,86,158,0.95)',
      trail: 'rgba(38,110,186,0.85)',
      trailDot: 'rgba(12,60,116,0.9)',
      node: 'rgba(34,96,148,0.85)',
      area: 'rgba(76,110,140,0.45)',
      placeLabel: 'rgba(38,68,96,0.85)',
      accFill: 'rgba(200,110,28,0.09)',
      accLine: 'rgba(200,110,28,0.45)',
      heading: 'rgba(178,96,22,0.85)',
      hull: '#FFFFFF',
      hullEdge: '#C86E1C',
      hullTrack: 'rgba(200,110,28,0.9)',
      hullMark: '#12283C',
      frame: 'rgba(150,172,192,0.9)',
      tick: 'rgba(43,111,181,0.45)',
    },
    graph: {
      grid: 'rgba(43,111,181,0.10)',
      series: ['#2C6FB5', '#C0801A', '#C86E1C', '#3E7EA6', '#5A6C86'],
      fillAlpha: '2E',
    },
  },
};

export const DEFAULT_THEME = 'graphite';
const KEY = 'kavach.theme';

export let theme = DEFAULT_THEME;
export let palette = THEMES[DEFAULT_THEME];

export function applyTheme(name) {
  if (!THEMES[name]) name = DEFAULT_THEME;
  theme = name;
  palette = THEMES[name];
  document.documentElement.dataset.theme = name;
  try { localStorage.setItem(KEY, name); } catch { /* private browsing */ }
  document.dispatchEvent(new CustomEvent('kavach:theme', { detail: name }));
  return name;
}

export function storedTheme() {
  // ?theme=daylight lets a kiosk or briefing screen pin the scheme
  const q = new URLSearchParams(location.search).get('theme');
  if (q && THEMES[q]) return q;
  try { return THEMES[localStorage.getItem(KEY)] ? localStorage.getItem(KEY) : DEFAULT_THEME; }
  catch { return DEFAULT_THEME; }
}
