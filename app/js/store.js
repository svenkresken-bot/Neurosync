// Lokale Speicherung (localStorage, mit Fallback auf Speicher) + Kennzahlen-Definitionen & Trendlogik.

const KEY_SESSIONS = 'neurosync.sessions.v1';
const KEY_SETTINGS = 'neurosync.settings.v1';
const mem = {};

function read(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw);
  } catch { /* privater Modus o. ä. */ }
  return mem[key] ?? fallback;
}
function write(key, value) {
  mem[key] = value;
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignorieren */ }
}

export const DEFAULT_SETTINGS = { legLengthM: 0.9, calib: 1, theme: 'auto', useSimulator: false };
export const loadSettings = () => ({ ...DEFAULT_SETTINGS, ...read(KEY_SETTINGS, {}) });
export const saveSettings = (s) => write(KEY_SETTINGS, s);

export const loadSessions = () => read(KEY_SESSIONS, []).sort((a, b) => a.start - b.start);
export function saveSession(s) {
  const all = loadSessions().filter((x) => x.id !== s.id);
  all.push(s);
  write(KEY_SESSIONS, all);
}
export const deleteSession = (id) => write(KEY_SESSIONS, loadSessions().filter((s) => s.id !== id));
export const replaceSessions = (list) => write(KEY_SESSIONS, list);
export const clearSessions = () => write(KEY_SESSIONS, []);

// ---------- Kennzahlen ----------
// better: 1 = höher ist besser, -1 = niedriger ist besser, 0 = neutral
export const METRICS = [
  { key: 'speedMs', label: 'Gehtempo', unit: 'm/s', dec: 2, better: 1, hint: 'Wichtigster Einzelwert; fällt bei Fortschreiten oft zuerst.' },
  { key: 'cadence', label: 'Kadenz', unit: 'Schritte/min', dec: 0, better: 1, hint: 'Schritte pro Minute.' },
  { key: 'stepLengthM', label: 'Schrittlänge', unit: 'm', dec: 2, better: 1, hint: 'Geschätzt über das Pendelmodell; erst nach Kalibrierung absolut aussagekräftig.' },
  { key: 'stepTimeCV', label: 'Schritt-Variabilität', unit: '%', dec: 1, better: -1, hint: 'Streuung der Schrittdauer. Höher = unregelmäßigeres Gehen.' },
  { key: 'asymmetryPct', label: 'Asymmetrie', unit: '%', dec: 1, better: -1, hint: 'Unterschied zwischen links/rechts-Schrittdauer.' },
  { key: 'strideRegularity', label: 'Regelmäßigkeit', unit: '', dec: 2, better: 1, hint: 'Autokorrelation (0–1). Höher = gleichmäßigeres Gangmuster.' },
  { key: 'symmetryIdx', label: 'Symmetrie-Index', unit: '', dec: 2, better: 1, hint: 'Verhältnis Schritt- zu Doppelschritt-Regelmäßigkeit, 1 = symmetrisch.' },
  { key: 'swayRms', label: 'Rumpfschwankung', unit: 'g', dec: 3, better: -1, hint: 'Effektivwert der horizontalen Beschleunigung am Rücken.' },
  { key: 'fatiguePct', label: 'Tempo-Ermüdung', unit: '%', dec: 1, better: 1, hint: 'Tempoänderung vom ersten zum letzten Viertel der Messung; stark negativ = ermüdet.' },
];
export const metricByKey = Object.fromEntries(METRICS.map((m) => [m.key, m]));

export const fmt = (v, dec = 1) => (v == null || !isFinite(v) ? '–' : v.toFixed(dec));
export const fmtMetric = (key, v) => fmt(v, metricByKey[key]?.dec ?? 1);

/** Nur Messungen mit genug Schritten zählen für Trends. */
export const isValid = (s) => (s.metrics?.steps ?? 0) >= 30;

export function metricSeries(sessions, key) {
  return sessions.filter(isValid).map((s) => ({ x: s.start, y: s.metrics[key], id: s.id })).filter((p) => p.y != null && isFinite(p.y));
}

const median = (a) => {
  const s = [...a].sort((p, q) => p - q);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/** Persönliche Baseline = Median der ersten 5 gültigen Messungen. */
export function baseline(sessions, key, n = 5) {
  const vals = metricSeries(sessions, key).slice(0, n).map((p) => p.y);
  return vals.length >= 3 ? median(vals) : null;
}

/** Vergleich: Mittel der letzten 3 Messungen vs. Baseline → Veränderung in % und Bewertung. */
export function trendStatus(sessions, key) {
  const m = metricByKey[key];
  const series = metricSeries(sessions, key);
  if (series.length < 4) return { state: 'none' };
  const base = baseline(sessions, key);
  if (base == null) return { state: 'none' };
  const recent = series.slice(-3).map((p) => p.y);
  const cur = recent.reduce((s, v) => s + v, 0) / recent.length;
  const denom = Math.abs(base) > 1e-6 ? Math.abs(base) : 1;
  const pct = ((cur - base) / denom) * 100;
  let state = 'stable';
  if (m.better !== 0 && Math.abs(pct) >= 5) state = pct * m.better > 0 ? 'better' : 'worse';
  return { state, pct, cur, base };
}

/** Lineare Regression → Steigung pro Tag. */
export function linearTrend(points) {
  if (points.length < 3) return null;
  const n = points.length;
  const mx = points.reduce((s, p) => s + p.x, 0) / n;
  const my = points.reduce((s, p) => s + p.y, 0) / n;
  let num = 0, den = 0;
  for (const p of points) { num += (p.x - mx) * (p.y - my); den += (p.x - mx) ** 2; }
  if (!den) return null;
  const slope = num / den;
  return { slope, at: (x) => my + slope * (x - mx), perDay: slope * 864e5 };
}

/** Schritte pro Kalendertag (lokale Zeit). */
export function dailySteps(sessions, days = 14) {
  const out = [];
  const today = new Date(); today.setHours(0, 0, 0, 0);
  for (let i = days - 1; i >= 0; i--) {
    const d0 = today.getTime() - i * 864e5;
    const total = sessions.filter((s) => s.start >= d0 && s.start < d0 + 864e5).reduce((a, s) => a + (s.metrics?.steps || 0), 0);
    out.push({ x: d0, y: total });
  }
  return out;
}

// ---------- Export ----------
export function toCSV(sessions) {
  const cols = ['start', 'type', 'durationS', 'fatigueRating', ...METRICS.map((m) => m.key), 'steps', 'distanceM', 'avgHr', 'note'];
  const esc = (v) => (v == null ? '' : `"${String(v).replace(/"/g, '""')}"`);
  const rows = sessions.map((s) => cols.map((c) => {
    if (c === 'start') return new Date(s.start).toISOString();
    if (c === 'durationS') return s.metrics?.totalTimeS?.toFixed(0);
    if (['type', 'fatigueRating', 'avgHr', 'note'].includes(c)) return esc(s[c]);
    return s.metrics?.[c];
  }).join(','));
  return [cols.join(','), ...rows].join('\n');
}
