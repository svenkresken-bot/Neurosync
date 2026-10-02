// Synthetischer Rückensensor: erzeugt realistisch wirkende Gehdaten für Demo-Modus, Tests
// und die Entwicklung ohne Hardware.

import { G } from './gait.js';

function rng(seed) {
  let a = seed >>> 0;
  const uniform = () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(uniform() || 1e-9)) * Math.cos(2 * Math.PI * uniform());
  return { uniform, gauss };
}

/**
 * @param {object} p
 * @param {number} p.seconds     Dauer
 * @param {number} [p.fs=52]     Abtastrate
 * @param {number} [p.stepFreq=1.8]  Schritte pro Sekunde
 * @param {number} [p.h=0.04]    vertikale Schwerpunktverlagerung pro Schritt (m, Spitze-Spitze)
 * @param {number} [p.asym=0]    relative Schrittdauer-Asymmetrie (0.05 = ±5 %)
 * @param {number} [p.jitter=0.02] zufällige Schrittdauer-Streuung (relativ)
 * @param {number} [p.fatigue=0] relative Verlangsamung bis zum Ende (0.1 = −10 %)
 * @param {number} [p.tiltDeg=12] Neigung des Sensors
 * @param {number} [p.noise=0.01] Sensorrauschen (g)
 * @param {number} [p.restS=2]   Stehphase am Anfang und Ende
 */
export function synthWalk(p) {
  const fs = p.fs ?? 52;
  const f0 = p.stepFreq ?? 1.8;
  const h0 = p.h ?? 0.04;
  const asym = p.asym ?? 0;
  const jitter = p.jitter ?? 0.02;
  const fatigue = p.fatigue ?? 0;
  const th = ((p.tiltDeg ?? 12) * Math.PI) / 180;
  const noise = p.noise ?? 0.01;
  const rest = p.restS ?? 2;
  const { gauss } = rng(p.seed ?? 1);

  const up = [], ap = [], ml = [];
  const push = (u, a, m) => { up.push(u); ap.push(a); ml.push(m); };
  for (let i = 0; i < rest * fs; i++) push(0, 0, 0);

  const walkEnd = (p.seconds - rest) * fs;
  let k = 0;
  while (up.length < walkEnd) {
    const progress = up.length / walkEnd;
    const scale = 1 - fatigue * progress;
    const T = (1 / (f0 * scale)) * (1 + (k % 2 ? asym : -asym)) * (1 + jitter * gauss());
    const h = h0 * scale;
    const n = Math.round(T * fs);
    for (let j = 0; j < n; j++) {
      const ph = (2 * Math.PI * j) / n;
      const w = (2 * Math.PI) / T;
      const a = (h / 2) * w * w * Math.cos(ph); // m/s², Spitze zu Schrittbeginn (Fersenkontakt)
      push(a / G, 0.08 * Math.sin(ph + 0.6), 0.06 * Math.sin(ph / 2 + (k % 2) * Math.PI));
    }
    k++;
  }
  while (up.length < p.seconds * fs) push(0, 0, 0);

  const n = up.length;
  const ax = new Float64Array(n), ay = new Float64Array(n), az = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const u = 1 + up[i];
    ax[i] = ml[i] + noise * gauss();
    ay[i] = u * Math.cos(th) + ap[i] * Math.sin(th) + noise * gauss();
    az[i] = -u * Math.sin(th) + ap[i] * Math.cos(th) + noise * gauss();
  }
  return { ax, ay, az, fs };
}

/** Streamt eine endlose Gehsequenz in 5er-Paketen, wie es die Firmware tut. */
export class SimulatedDevice {
  constructor(params = {}) {
    this.fs = 52;
    this.params = params;
    this.timer = null;
  }

  start(onData, onBattery) {
    const sig = synthWalk({ seconds: 600, fs: this.fs, fatigue: 0.08, asym: 0.015, ...this.params, restS: 1, seed: 7 });
    const t0 = performance.now();
    let sent = 0;
    this.timer = setInterval(() => {
      const due = Math.floor(((performance.now() - t0) / 1000) * this.fs);
      if (due - sent < 1) return;
      const out = { ax: [], ay: [], az: [], gx: [], gy: [], gz: [] };
      while (sent < due) {
        const i = sent % sig.ax.length;
        out.ax.push(sig.ax[i]); out.ay.push(sig.ay[i]); out.az.push(sig.az[i]);
        out.gx.push(0); out.gy.push(0); out.gz.push(0);
        sent++;
      }
      onData(out, { lost: 0 });
    }, 100);
    onBattery?.(87);
  }

  stop() { clearInterval(this.timer); this.timer = null; }
}

/** Erzeugt eine glaubhafte Messhistorie (nur Kennzahlen) für die Demo-Ansicht. */
export function demoHistory(days = 120, seed = 42) {
  const { gauss, uniform } = rng(seed);
  const out = [];
  const now = Date.now();
  for (let d = days; d >= 0; d--) {
    if (uniform() < 0.3) continue; // nicht jeden Tag eine Messung
    const prog = 1 - d / days;             // 0 → 1: schleichende Verschlechterung
    const flare = d > 35 && d < 50 ? 1 : 0; // ein Schub mit vorübergehender Verschlechterung
    const bad = 0.12 * prog + 0.1 * flare;
    const dur = 300 + uniform() * 900;
    const speed = 1.25 * (1 - bad) + 0.04 * gauss();
    const cadence = 108 * (1 - bad * 0.6) + 2 * gauss();
    const stepLen = (speed * 60) / cadence;
    const steps = Math.round((cadence * dur) / 60);
    const start = now - d * 864e5 - uniform() * 4e7;
    out.push({
      id: `demo-${d}`, start: Math.round(start), type: uniform() < 0.25 ? 'test' : 'walk', demo: true,
      note: '', fatigueRating: Math.min(5, Math.max(1, Math.round(2 + bad * 12 + gauss() * 0.7))),
      metrics: {
        steps, totalTimeS: dur, walkTimeS: dur * 0.9, bouts: 4, cadence, stepTimeMs: 60000 / cadence,
        stepTimeCV: 3 + bad * 20 + Math.abs(gauss()) * 0.5, stepLengthM: stepLen,
        stepLengthCV: 4 + bad * 18 + Math.abs(gauss()) * 0.5, speedMs: speed, distanceM: speed * dur * 0.9,
        asymmetryPct: 1.5 + bad * 12 + Math.abs(gauss()) * 0.4,
        stepRegularity: 0.82 - bad * 0.9 + 0.02 * gauss(), strideRegularity: 0.84 - bad * 0.8 + 0.02 * gauss(),
        symmetryIdx: 0.97 - bad * 0.5 + 0.01 * gauss(), swayRms: 0.1 + bad * 0.25 + 0.01 * gauss(),
        fatiguePct: -(2 + bad * 25) + gauss(),
      },
      series: [],
    });
  }
  return out;
}
