// Ganganalyse für einen Beschleunigungssensor am unteren Rücken (L3–L5).
// Reine Funktionen ohne DOM-Abhängigkeit, damit sie auch in Node getestet werden können.
//
// Eingabe:  ax, ay, az in g (beliebige Einbau-Orientierung), Abtastrate fs in Hz.
// Ausgabe:  Schritte (Zeit, Dauer, Länge) und aggregierte Gangparameter.

export const G = 9.81;

const MIN_STEP_S = 0.3;      // schnellste plausible Schrittdauer (200 Schritte/min)
const MAX_STEP_S = 1.4;      // langsamste plausible Schrittdauer (43 Schritte/min)
const MAX_STEP_JUMP = 0.4;   // max. relative Änderung zum vorigen Schritt innerhalb eines Gehabschnitts
const MIN_BOUT_PEAKS = 6;    // Mindestlänge eines Gehabschnitts
const MIN_PEAK_G = 0.04;     // minimale vertikale Beschleunigungsspitze (g)

// ---------- Signalverarbeitung ----------

function butterLowpass(fc, fs) {
  const w0 = (2 * Math.PI * fc) / fs;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * Math.SQRT1_2);
  const a0 = 1 + alpha;
  return {
    b: [(1 - cos) / 2 / a0, (1 - cos) / a0, (1 - cos) / 2 / a0],
    a: [1, (-2 * cos) / a0, (1 - alpha) / a0],
  };
}

function filter({ b, a }, x) {
  const y = new Float64Array(x.length);
  let z1 = 0, z2 = 0;
  for (let i = 0; i < x.length; i++) {
    const out = b[0] * x[i] + z1;
    z1 = b[1] * x[i] - a[1] * out + z2;
    z2 = b[2] * x[i] - a[2] * out;
    y[i] = out;
  }
  return y;
}

/** Nullphasiger Tiefpass (vorwärts + rückwärts) mit ungerader Randfortsetzung. */
export function lowpassZeroPhase(x, fc, fs) {
  const n = x.length;
  if (n < 8) return Float64Array.from(x);
  const pad = Math.min(n - 1, Math.round(fs));
  const ext = new Float64Array(n + 2 * pad);
  for (let i = 0; i < pad; i++) {
    ext[i] = 2 * x[0] - x[pad - i];
    ext[n + pad + i] = 2 * x[n - 1] - x[n - 2 - i];
  }
  for (let i = 0; i < n; i++) ext[pad + i] = x[i];
  const c = butterLowpass(fc, fs);
  const fwd = filter(c, ext);
  fwd.reverse();
  const bwd = filter(c, fwd);
  bwd.reverse();
  return bwd.slice(pad, pad + n);
}

function movingAverage(x, win) {
  const n = x.length;
  const cum = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + x[i];
  const half = Math.floor(win / 2);
  const out = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n, i + half + 1);
    out[i] = (cum[hi] - cum[lo]) / (hi - lo);
  }
  return out;
}

const mean = (a) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : NaN);
const sd = (a) => {
  if (a.length < 2) return NaN;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1));
};
const median = (a) => {
  if (!a.length) return NaN;
  const s = [...a].sort((p, q) => p - q);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Zerlegt die Beschleunigung in vertikal (entlang der Schwerkraft) und horizontal.
 * Die Schwerkraftrichtung wird über ein 2-s-Mittel geschätzt, daher funktioniert die
 * Analyse unabhängig davon, wie der Sensor am Rücken sitzt.
 */
export function decompose(ax, ay, az, fs) {
  const n = ax.length;
  const win = Math.max(3, Math.round(2 * fs));
  const gx = movingAverage(ax, win);
  const gy = movingAverage(ay, win);
  const gz = movingAverage(az, win);
  const vert = new Float64Array(n);
  const horiz = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const gm = Math.hypot(gx[i], gy[i], gz[i]) || 1;
    const ux = gx[i] / gm, uy = gy[i] / gm, uz = gz[i] / gm;
    const dot = ax[i] * ux + ay[i] * uy + az[i] * uz;
    vert[i] = (dot - gm) * G; // m/s²
    const hx = ax[i] - dot * ux, hy = ay[i] - dot * uy, hz = az[i] - dot * uz;
    horiz[i] = Math.hypot(hx, hy, hz); // g
  }
  return { vert, horiz };
}

// ---------- Schrittdetektion ----------

export function detectPeaks(x, fs, minPeak = MIN_PEAK_G * G) {
  const minDist = Math.round(0.28 * fs);
  const cand = [];
  for (let i = 1; i < x.length - 1; i++) {
    if (x[i] > minPeak && x[i] >= x[i - 1] && x[i] > x[i + 1]) cand.push(i);
  }
  cand.sort((p, q) => x[q] - x[p]);
  const taken = new Uint8Array(x.length);
  const accepted = [];
  for (const i of cand) {
    let ok = true;
    for (let j = Math.max(0, i - minDist); j <= Math.min(x.length - 1, i + minDist); j++) {
      if (taken[j]) { ok = false; break; }
    }
    if (ok) { taken[i] = 1; accepted.push(i); }
  }
  return accepted.sort((p, q) => p - q);
}

/** Gruppiert Spitzen zu zusammenhängenden Gehabschnitten (regelmäßige Schrittfolge). */
export function findBouts(peaks, fs) {
  const bouts = [];
  let cur = [];
  let prevDt = null;
  const flush = () => {
    if (cur.length >= MIN_BOUT_PEAKS) bouts.push(cur);
    cur = [];
    prevDt = null;
  };
  for (let k = 0; k < peaks.length; k++) {
    if (!cur.length) { cur = [peaks[k]]; continue; }
    const dt = (peaks[k] - cur[cur.length - 1]) / fs;
    const valid = dt >= MIN_STEP_S && dt <= MAX_STEP_S &&
      (prevDt === null || Math.abs(dt - prevDt) / prevDt <= MAX_STEP_JUMP);
    if (valid) { cur.push(peaks[k]); prevDt = dt; }
    else { flush(); cur = [peaks[k]]; }
  }
  flush();
  return bouts;
}

/** Vertikale Verlagerung des Körperschwerpunkts innerhalb eines Schritts (m) per Doppelintegration. */
export function verticalExcursion(a, i0, i1, fs) {
  const n = i1 - i0 + 1;
  if (n < 4) return 0;
  let m = 0;
  for (let i = i0; i <= i1; i++) m += a[i];
  m /= n;
  const dt = 1 / fs;
  const v = new Float64Array(n);
  for (let j = 1; j < n; j++) v[j] = v[j - 1] + ((a[i0 + j - 1] + a[i0 + j] - 2 * m) / 2) * dt;
  const vm = mean(v);
  const d = new Float64Array(n);
  for (let j = 1; j < n; j++) d[j] = d[j - 1] + (((v[j - 1] - vm) + (v[j] - vm)) / 2) * dt;
  let lo = Infinity, hi = -Infinity;
  const slope = d[n - 1] / (n - 1);
  for (let j = 0; j < n; j++) {
    const val = d[j] - slope * j; // lineare Drift entfernen
    if (val < lo) lo = val;
    if (val > hi) hi = val;
  }
  return hi - lo;
}

/** Schrittlänge nach dem Modell des umgekehrten Pendels (Zijlstra & Hof). */
export function stepLengthFromExcursion(h, legLengthM, calib = 1) {
  const hh = Math.min(Math.max(h, 0), legLengthM);
  return calib * 2 * Math.sqrt(Math.max(0, 2 * legLengthM * hh - hh * hh));
}

// ---------- Regelmäßigkeit (Autokorrelation, Moe-Nilssen) ----------

function autocorr(x, maxLag) {
  const n = x.length;
  const m = mean(x);
  const c = new Float64Array(maxLag + 1);
  for (let l = 0; l <= maxLag; l++) {
    let s = 0;
    for (let i = 0; i + l < n; i++) s += (x[i] - m) * (x[i + l] - m);
    c[l] = s / (n - l);
  }
  const v = c[0] || 1;
  return c.map((q) => q / v);
}

function regularity(x, stepLagSamples) {
  const maxLag = Math.round(stepLagSamples * 2.3);
  if (x.length < maxLag * 3) return null;
  const r = autocorr(x, maxLag);
  const peakIn = (lo, hi) => {
    let best = -Infinity;
    for (let l = Math.max(1, Math.round(lo)); l <= Math.min(maxLag, Math.round(hi)); l++) best = Math.max(best, r[l]);
    return best;
  };
  const ac1 = peakIn(stepLagSamples * 0.8, stepLagSamples * 1.2);
  const ac2 = peakIn(stepLagSamples * 1.8, stepLagSamples * 2.2);
  if (!isFinite(ac1) || !isFinite(ac2) || ac2 <= 0) return null;
  return { ac1, ac2 };
}

// ---------- Hauptfunktion ----------

/**
 * @param {{ax:ArrayLike<number>, ay:ArrayLike<number>, az:ArrayLike<number>}} data  in g
 * @param {number} fs  Abtastrate in Hz
 * @param {{legLengthM?:number, calib?:number, fast?:boolean}} opts
 */
export function analyze(data, fs, opts = {}) {
  const legLengthM = opts.legLengthM ?? 0.9;
  const calib = opts.calib ?? 1;
  const n = data.ax.length;
  const totalTimeS = n / fs;
  const empty = emptyMetrics(totalTimeS);
  if (n < fs * 5) return { steps: [], metrics: empty };

  const { vert, horiz } = decompose(data.ax, data.ay, data.az, fs);
  const vf = lowpassZeroPhase(vert, 4, fs);
  const peaks = detectPeaks(vf, fs);
  const bouts = findBouts(peaks, fs);
  if (!bouts.length) return { steps: [], metrics: empty };

  const steps = [];
  const boutStats = [];
  let swaySum = 0, swayN = 0;

  bouts.forEach((bout, bi) => {
    const times = [];
    for (let k = 1; k < bout.length; k++) {
      const i0 = bout[k - 1], i1 = bout[k];
      const dt = (i1 - i0) / fs;
      const h = verticalExcursion(vf, i0, i1, fs);
      const len = stepLengthFromExcursion(h, legLengthM, calib);
      steps.push({ t: i1 / fs, dt, len, bout: bi });
      times.push(dt);
    }
    for (let i = bout[0]; i <= bout[bout.length - 1]; i++) { swaySum += horiz[i] ** 2; swayN++; }
    const st = { n: times.length, mean: mean(times), cv: (sd(times) / mean(times)) * 100, asym: null, reg: null };
    if (times.length >= 8) {
      const odd = times.filter((_, i) => i % 2 === 0), even = times.filter((_, i) => i % 2 === 1);
      st.asym = (Math.abs(mean(odd) - mean(even)) / mean(times)) * 100;
    }
    if (!opts.fast) {
      const seg = Array.from(vf.subarray(bout[0], bout[bout.length - 1] + 1));
      const chunk = Math.round(20 * fs);
      const lag = Math.round(median(times) * fs);
      const regs = [];
      for (let s = 0; s < seg.length && regs.length < 30; s += chunk) {
        const part = seg.slice(s, s + chunk);
        const r = part.length >= chunk * 0.5 ? regularity(part, lag) : null;
        if (r) regs.push({ ...r, w: part.length });
      }
      if (regs.length) {
        const w = regs.reduce((q, r) => q + r.w, 0);
        st.reg = {
          ac1: regs.reduce((q, r) => q + r.ac1 * r.w, 0) / w,
          ac2: regs.reduce((q, r) => q + r.ac2 * r.w, 0) / w,
        };
      }
    }
    boutStats.push(st);
  });

  const w = (_, pick) => {
    const items = boutStats.filter((b) => pick(b) != null && isFinite(pick(b)));
    const tot = items.reduce((s, b) => s + b.n, 0);
    return tot ? items.reduce((s, b) => s + pick(b) * b.n, 0) / tot : null;
  };

  const stepTimes = steps.map((s) => s.dt);
  const lens = steps.map((s) => s.len);
  const speeds = steps.map((s) => s.len / s.dt);
  const ac1 = w(0, (b) => b.reg?.ac1);
  const ac2 = w(0, (b) => b.reg?.ac2);

  let fatiguePct = null;
  if (steps.length >= 40) {
    const q = Math.floor(steps.length / 4);
    const first = mean(speeds.slice(0, q)), last = mean(speeds.slice(-q));
    if (first > 0) fatiguePct = ((last - first) / first) * 100;
  }

  const metrics = {
    ...empty,
    steps: steps.length + bouts.length, // Spitzen = Schritte (erster Schritt je Abschnitt inklusive)
    walkTimeS: stepTimes.reduce((s, v) => s + v, 0),
    bouts: bouts.length,
    cadence: 60 / mean(stepTimes),
    stepTimeMs: mean(stepTimes) * 1000,
    stepTimeCV: w(0, (b) => b.cv),
    stepLengthM: mean(lens),
    stepLengthCV: (sd(lens) / mean(lens)) * 100,
    speedMs: mean(speeds),
    distanceM: lens.reduce((s, v) => s + v, 0) + 0,
    asymmetryPct: w(0, (b) => b.asym),
    stepRegularity: ac1,
    strideRegularity: ac2,
    symmetryIdx: ac1 != null && ac2 ? ac1 / ac2 : null,
    swayRms: swayN ? Math.sqrt(swaySum / swayN) : null,
    fatiguePct,
  };
  return { steps, metrics };
}

export function emptyMetrics(totalTimeS = 0) {
  return {
    steps: 0, totalTimeS, walkTimeS: 0, bouts: 0, cadence: null, stepTimeMs: null, stepTimeCV: null,
    stepLengthM: null, stepLengthCV: null, speedMs: null, distanceM: 0, asymmetryPct: null,
    stepRegularity: null, strideRegularity: null, symmetryIdx: null, swayRms: null, fatiguePct: null,
  };
}

/** Zeitreihe in festen Zeitfenstern (z. B. 30 s) für Verlaufsdiagramme innerhalb einer Messung. */
export function binSteps(steps, binS = 30) {
  const bins = new Map();
  for (const s of steps) {
    const k = Math.floor(s.t / binS);
    if (!bins.has(k)) bins.set(k, []);
    bins.get(k).push(s);
  }
  return [...bins.entries()].sort((a, b) => a[0] - b[0]).map(([k, arr]) => ({
    t: (k + 0.5) * binS,
    cadence: 60 / mean(arr.map((s) => s.dt)),
    stepLengthM: mean(arr.map((s) => s.len)),
    speedMs: mean(arr.map((s) => s.len / s.dt)),
    n: arr.length,
  }));
}

/** Kalibrierfaktor aus einer Strecke bekannter Länge (z. B. 20 m). */
export function calibrationFactor(knownDistanceM, estimatedDistanceM, currentCalib = 1) {
  if (!(estimatedDistanceM > 0) || !(knownDistanceM > 0)) return currentCalib;
  return currentCalib * (knownDistanceM / estimatedDistanceM);
}
