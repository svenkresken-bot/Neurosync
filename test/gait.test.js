import test from 'node:test';
import assert from 'node:assert/strict';
import { analyze, stepLengthFromExcursion, calibrationFactor } from '../app/js/gait.js';
import { synthWalk } from '../app/js/simulator.js';

const near = (actual, expected, tol, msg) =>
  assert.ok(Math.abs(actual - expected) <= tol, `${msg}: ${actual} ≉ ${expected} (±${tol})`);

test('Kadenz und Schrittzahl bei gleichmäßigem Gehen', () => {
  const sig = synthWalk({ seconds: 60, stepFreq: 1.8, restS: 3, seed: 3 });
  const { metrics } = analyze(sig, sig.fs, { legLengthM: 0.9 });
  near(metrics.cadence, 108, 3, 'Kadenz');
  near(metrics.steps, 54 * 1.8, 6, 'Schritte');
  assert.ok(metrics.stepTimeCV < 6, `CV zu hoch: ${metrics.stepTimeCV}`);
});

test('Schrittlänge folgt dem Pendelmodell', () => {
  const h = 0.04, l = 0.9;
  const expected = stepLengthFromExcursion(h, l);
  const sig = synthWalk({ seconds: 60, stepFreq: 1.8, h, restS: 3, seed: 4 });
  const { metrics } = analyze(sig, sig.fs, { legLengthM: l });
  near(metrics.stepLengthM, expected, expected * 0.15, 'Schrittlänge');
  near(metrics.speedMs, expected * 1.8, expected * 1.8 * 0.2, 'Tempo');
});

test('Orientierung des Sensors ist egal', () => {
  const a = analyze(synthWalk({ seconds: 40, tiltDeg: 0, seed: 5 }), 52).metrics;
  const b = analyze(synthWalk({ seconds: 40, tiltDeg: 35, seed: 5 }), 52).metrics;
  near(b.cadence, a.cadence, 2, 'Kadenz');
  near(b.stepLengthM, a.stepLengthM, a.stepLengthM * 0.15, 'Schrittlänge');
});

test('Asymmetrie wird erkannt', () => {
  const sym = analyze(synthWalk({ seconds: 60, asym: 0, jitter: 0.01, seed: 6 }), 52).metrics;
  const asy = analyze(synthWalk({ seconds: 60, asym: 0.08, jitter: 0.01, seed: 6 }), 52).metrics;
  assert.ok(asy.asymmetryPct > sym.asymmetryPct + 5, `${asy.asymmetryPct} vs ${sym.asymmetryPct}`);
  assert.ok(asy.symmetryIdx < sym.symmetryIdx, 'Symmetrieindex sinkt');
});

test('Variabilität steigt mit Streuung', () => {
  const calm = analyze(synthWalk({ seconds: 60, jitter: 0.01, seed: 8 }), 52).metrics;
  const wobbly = analyze(synthWalk({ seconds: 60, jitter: 0.08, seed: 8 }), 52).metrics;
  assert.ok(wobbly.stepTimeCV > calm.stepTimeCV * 2);
});

test('Ermüdung: Tempoabfall wird erkannt', () => {
  const m = analyze(synthWalk({ seconds: 120, fatigue: 0.2, seed: 9 }), 52).metrics;
  assert.ok(m.fatiguePct < -8, `fatiguePct=${m.fatiguePct}`);
});

test('Stehen ergibt keine Schritte', () => {
  const sig = synthWalk({ seconds: 30, restS: 15, seed: 10 });
  sig.ax.fill(0.0); sig.ay.fill(1); sig.az.fill(0);
  assert.equal(analyze(sig, 52).metrics.steps, 0);
});

test('Kalibrierfaktor', () => {
  near(calibrationFactor(20, 16, 1), 1.25, 1e-9, 'k');
});

test('BLE-Paket wird korrekt dekodiert', async () => {
  const { parsePacket } = await import('../app/js/ble.js');
  const buf = new ArrayBuffer(62);
  const v = new DataView(buf);
  v.setUint16(0, 513, true);
  v.setInt16(2, 1000, true);   // ax = 1 g
  v.setInt16(4, -500, true);
  v.setInt16(8, -1234, true);  // gx = -123.4 °/s
  v.setInt16(2 + 4 * 12, 250, true);
  const p = parsePacket(v);
  assert.equal(p.seq, 513);
  assert.equal(p.ax[0], 1);
  assert.equal(p.ay[0], -0.5);
  assert.equal(p.gx[0], -123.4);
  assert.equal(p.ax[4], 0.25);
});
