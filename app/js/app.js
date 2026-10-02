import { analyze, binSteps, calibrationFactor } from './gait.js';
import { BackSensor, HeartRateSensor, bleSupported } from './ble.js';
import { SimulatedDevice, demoHistory } from './simulator.js';
import { mountLineChart, mountBars, sparkline, drawWave, fmtDate, fmtDateLong } from './charts.js';
import * as store from './store.js';
import { METRICS, metricByKey, fmt, fmtMetric } from './store.js';

const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const timeFmt = new Intl.DateTimeFormat('de-CH', { hour: '2-digit', minute: '2-digit' });
const mmss = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

const TYPES = {
  walk: { label: 'Freies Gehen', auto: 0 },
  test: { label: '2-Minuten-Gehtest', auto: 120 },
  calib: { label: 'Kalibrierung (bekannte Strecke)', auto: 0 },
};

// ---------- Zustand ----------
const state = {
  settings: store.loadSettings(),
  view: 'dash',
  metric: 'speedMs',
  range: 90,
  conn: 'disconnected',
  battery: null,
  fs: 52,
  device: null,          // BackSensor | SimulatedDevice
  hr: null, hrBpm: null,
  wave: [],              // letzte ~6 s |a|-1 für die Live-Kurve
  rec: null,             // laufende Messung
  type: 'walk',
  lastLossNote: 0,
};

function applyTheme() {
  const t = state.settings.theme;
  if (t === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', t);
}
applyTheme();

function toast(msg, ms = 3500) {
  const t = $('#toast');
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}

// ---------- Navigation ----------
document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => show(b.dataset.view)));
$('#conn-chip').addEventListener('click', () => show('live'));

function show(view) {
  state.view = view;
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== `view-${view}`; });
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  render();
  window.scrollTo({ top: 0 });
}
function render() {
  ({ dash: renderDash, live: renderLive, history: renderHistory, settings: renderSettings })[state.view]();
}

// ---------- Verbindung ----------
function setConn(c) {
  state.conn = c;
  const chip = $('#conn-chip');
  chip.className = `chip conn ${c === 'connected' ? 'on' : c === 'connecting' ? 'busy' : 'off'}`;
  const label = { connected: 'Verbunden', connecting: 'Verbinde …', disconnected: 'Nicht verbunden' }[c];
  $('#conn-text').textContent = state.battery != null && c === 'connected' ? `${label} · ${state.battery}%` : label;
  if (state.view === 'live') renderLive();
}

async function connectDevice() {
  try {
    if (state.settings.useSimulator) {
      state.device = new SimulatedDevice();
      state.fs = state.device.fs;
      state.device.start(onData, (b) => { state.battery = b; });
      setConn('connected');
      toast('Demo-Sensor läuft (simulierte Daten)');
      return;
    }
    if (!bleSupported()) {
      toast('Dieser Browser unterstützt kein Web Bluetooth. Nutze Chrome auf Android/Desktop – oder den Demo-Modus.', 7000);
      return;
    }
    const dev = new BackSensor({
      onData,
      onState: (s) => setConn(s),
      onBattery: (b) => { state.battery = b; setConn(state.conn); },
    });
    state.device = dev;
    await dev.connect();
    state.fs = dev.fs;
  } catch (err) {
    if (err?.name !== 'NotFoundError') toast(`Verbindung fehlgeschlagen: ${err.message}`, 6000);
    setConn('disconnected');
  }
}

function disconnectDevice() {
  if (state.rec) stopRecording(true);
  state.device?.disconnect?.();
  state.device?.stop?.();
  state.device = null;
  setConn('disconnected');
}

// ---------- Datenfluss ----------
function onData(chunk, meta = {}) {
  const n = chunk.ax.length;
  for (let i = 0; i < n; i++) {
    state.wave.push(Math.hypot(chunk.ax[i], chunk.ay[i], chunk.az[i]) - 1);
  }
  const keep = Math.round(state.fs * 6);
  if (state.wave.length > keep) state.wave.splice(0, state.wave.length - keep);

  const r = state.rec;
  if (r) {
    for (let i = 0; i < n; i++) { r.ax.push(chunk.ax[i]); r.ay.push(chunk.ay[i]); r.az.push(chunk.az[i]); }
    if (meta.lost) r.lost += meta.lost;
  }
  if (state.view === 'live') drawLive();
}

// ---------- Messung ----------
function startRecording() {
  if (state.conn !== 'connected') { toast('Erst den Sensor verbinden.'); return; }
  state.rec = { id: `s-${Date.now()}`, start: Date.now(), type: state.type, ax: [], ay: [], az: [], lost: 0, hr: [], live: null, tick: 0 };
  state.rec.timer = setInterval(recTick, 1000);
  renderLive();
}

function recTick() {
  const r = state.rec;
  if (!r) return;
  r.tick++;
  if (state.hrBpm) r.hr.push(state.hrBpm);
  const dur = r.ax.length / state.fs;
  if (r.tick % 3 === 0 && dur > 8) {
    r.live = analyze(r, state.fs, { legLengthM: state.settings.legLengthM, calib: state.settings.calib, fast: true }).metrics;
  }
  const auto = TYPES[r.type].auto;
  if (auto && dur >= auto) { stopRecording(); return; }
  if (state.view === 'live') updateLiveNumbers();
}

function stopRecording(discard = false) {
  const r = state.rec;
  if (!r) return;
  clearInterval(r.timer);
  state.rec = null;
  if (discard) { renderLive(); return; }
  const dur = r.ax.length / state.fs;
  if (dur < 15) { toast('Messung zu kurz (< 15 s) und nicht gespeichert.'); renderLive(); return; }
  const { steps, metrics } = analyze(r, state.fs, { legLengthM: state.settings.legLengthM, calib: state.settings.calib });
  const session = {
    id: r.id, start: r.start, type: r.type, note: '', fatigueRating: null,
    avgHr: r.hr.length ? Math.round(r.hr.reduce((a, b) => a + b, 0) / r.hr.length) : null,
    lossPct: r.lost ? +((r.lost * 5) / (r.ax.length || 1) * 100).toFixed(1) : 0,
    metrics, series: binSteps(steps, 30),
  };
  renderLive();
  openAfterDialog(session);
}

function openAfterDialog(session) {
  const m = session.metrics;
  const dlg = $('#dlg');
  const isCalib = session.type === 'calib';
  dlg.innerHTML = `
    <h2>Messung beendet</h2>
    <p class="muted">${TYPES[session.type].label} · ${mmss(m.totalTimeS)} min</p>
    <div class="kv">
      <div><span>Schritte</span><b>${m.steps}</b></div>
      <div><span>Tempo</span><b>${fmt(m.speedMs, 2)} m/s</b></div>
      <div><span>Kadenz</span><b>${fmt(m.cadence, 0)} /min</b></div>
      <div><span>Strecke (geschätzt)</span><b>${fmt(m.distanceM, 0)} m</b></div>
    </div>
    ${isCalib ? `
      <div class="field"><label for="known">Tatsächlich gelaufene Strecke (m)</label><input id="known" type="number" inputmode="decimal" min="1" step="0.1" placeholder="z. B. 20"></div>
      <p class="muted">Der Schrittlängen-Faktor wird so angepasst, dass die geschätzte Strecke zur echten passt.</p>` : `
      <div class="field"><label for="rating">Wie fühlst du dich gerade? (Fatigue)</label>
        <select id="rating"><option value="">– keine Angabe –</option><option value="1">1 – fit</option><option value="2">2</option><option value="3">3 – mittel</option><option value="4">4</option><option value="5">5 – sehr erschöpft</option></select></div>
      <div class="field"><label for="note">Notiz (optional)</label><textarea id="note" rows="2" placeholder="Symptome, Schuhe, Untergrund …"></textarea></div>`}
    <div class="row" style="justify-content:flex-end">
      <button class="btn danger" id="d-discard">Verwerfen</button>
      <button class="btn primary" id="d-save">${isCalib ? 'Kalibrieren' : 'Speichern'}</button>
    </div>`;
  dlg.showModal();
  $('#d-discard').onclick = () => dlg.close();
  $('#d-save').onclick = () => {
    if (isCalib) {
      const known = parseFloat($('#known').value);
      if (!(known > 0)) { toast('Bitte die echte Strecke eingeben.'); return; }
      state.settings.calib = +calibrationFactor(known, m.distanceM, state.settings.calib).toFixed(3);
      store.saveSettings(state.settings);
      toast(`Kalibrierfaktor: ${state.settings.calib}`);
    } else {
      session.fatigueRating = parseInt($('#rating').value, 10) || null;
      session.note = $('#note').value.trim();
      store.saveSession(session);
      toast('Messung gespeichert');
    }
    dlg.close();
    show(isCalib ? 'settings' : 'dash');
  };
}

// ---------- Ansicht: Live ----------
function renderLive() {
  const el = $('#view-live');
  if (state.view !== 'live') return;
  const connected = state.conn === 'connected';
  const rec = state.rec;
  el.innerHTML = `
    <div class="card">
      <div class="card-head"><h2>Sensor</h2>
        ${state.settings.useSimulator ? '<span class="badge">Demo-Modus</span>' : ''}</div>
      <p class="muted" id="conn-help">${connected
        ? 'Sensor verbunden – Messung starten und normal gehen.'
        : 'Sensor am unteren Rücken (Höhe L3–L5, mittig) mit Gurt befestigen, einschalten und verbinden.'}</p>
      <div class="row">
        ${connected
          ? '<button class="btn" id="b-disc">Trennen</button>'
          : `<button class="btn primary" id="b-conn" ${state.conn === 'connecting' ? 'disabled' : ''}>${state.settings.useSimulator ? 'Demo-Sensor starten' : 'Sensor verbinden'}</button>`}
      </div>
      ${!bleSupported() && !state.settings.useSimulator ? '<p class="notice" style="margin-top:10px">Dieser Browser unterstützt Web Bluetooth nicht (z. B. Safari/iPhone). Nutze Chrome auf Android oder Desktop, auf dem iPhone den Browser „Bluefy“, oder aktiviere in den Einstellungen den Demo-Modus.</p>' : ''}
    </div>

    <div class="card">
      <div class="card-head"><h2>Live-Signal</h2><span class="muted" id="sig-q"></span></div>
      <canvas class="wave" id="wave" aria-label="Live-Beschleunigungssignal"></canvas>
    </div>

    <div class="card">
      <div class="card-head"><h2>Messung</h2>
        ${rec ? '<span><span class="rec-dot"></span> Aufnahme</span>' : ''}</div>
      ${rec ? '' : `
      <div class="field"><label for="type">Art der Messung</label>
        <select id="type">${Object.entries(TYPES).map(([k, v]) => `<option value="${k}" ${state.type === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select></div>
      <p class="muted">${{ walk: 'Gehe wie gewohnt. Mindestens ~1 Minute für aussagekräftige Werte.', test: 'Gehe 2 Minuten so schnell du sicher kannst. Stoppt automatisch.', calib: 'Gehe eine abgemessene Strecke (z. B. 20 m) und gib danach die echte Länge ein.' }[state.type]}</p>`}
      <div class="live-grid" style="margin:10px 0">
        <div class="big"><div class="lbl">Zeit</div><div class="val" id="l-time">0:00</div></div>
        <div class="big"><div class="lbl">Schritte</div><div class="val" id="l-steps">0</div></div>
        <div class="big"><div class="lbl">Kadenz</div><div class="val"><span id="l-cad">–</span><small> /min</small></div></div>
        <div class="big"><div class="lbl">Tempo</div><div class="val"><span id="l-speed">–</span><small> m/s</small></div></div>
        ${state.hr ? '<div class="big"><div class="lbl">Herzfrequenz</div><div class="val"><span id="l-hr">–</span><small> bpm</small></div></div>' : ''}
      </div>
      ${rec
        ? '<button class="btn primary" id="b-stop" style="width:100%">Messung beenden</button>'
        : `<button class="btn primary" id="b-start" style="width:100%" ${connected ? '' : 'disabled'}>Messung starten</button>`}
    </div>`;
  $('#b-conn')?.addEventListener('click', connectDevice);
  $('#b-disc')?.addEventListener('click', disconnectDevice);
  $('#b-start')?.addEventListener('click', startRecording);
  $('#b-stop')?.addEventListener('click', () => stopRecording());
  $('#type')?.addEventListener('change', (e) => { state.type = e.target.value; renderLive(); });
  updateLiveNumbers();
  drawLive();
}

function updateLiveNumbers() {
  const r = state.rec;
  const set = (id, v) => { const e = $(id); if (e) e.textContent = v; };
  const dur = r ? r.ax.length / state.fs : 0;
  set('#l-time', mmss(dur));
  const m = r?.live;
  set('#l-steps', m ? m.steps : 0);
  set('#l-cad', m ? fmt(m.cadence, 0) : '–');
  set('#l-speed', m ? fmt(m.speedMs, 2) : '–');
  if (state.hrBpm) set('#l-hr', state.hrBpm);
  const q = $('#sig-q');
  if (q && state.device?.lossRate !== undefined) {
    const loss = state.device.lossRate * 100;
    q.textContent = loss < 1 ? 'Signal gut' : `Paketverlust ${loss.toFixed(1)} %`;
  }
}

function drawLive() {
  const c = $('#wave');
  if (c) drawWave(c, state.wave);
}

// ---------- Ansicht: Verlauf (Dashboard) ----------
function renderDash() {
  const el = $('#view-dash');
  const all = store.loadSessions();
  const valid = all.filter(store.isValid);
  if (!valid.length) {
    el.innerHTML = `
      <div class="card">
        <h2>Willkommen bei NeuroSync</h2>
        <p class="muted">Hier erscheint der Gangverlauf: Tempo, Schrittlänge, Kadenz, Symmetrie und mehr – mit Trend gegenüber deiner persönlichen Baseline. Mach 4–5 Messungen, damit die Baseline entsteht.</p>
        <div class="row"><button class="btn primary" id="go-live">Erste Messung</button><button class="btn" id="go-demo">Demo-Daten laden</button></div>
      </div>`;
    $('#go-live').onclick = () => show('live');
    $('#go-demo').onclick = loadDemo;
    return;
  }

  const rangeMs = state.range * 864e5;
  const inRange = state.range === 0 ? all : all.filter((s) => s.start >= Date.now() - rangeMs);
  const m = metricByKey[state.metric];
  const pts = store.metricSeries(inRange, state.metric);
  const base = store.baseline(valid, state.metric);
  const trend = store.linearTrend(pts);
  const ts = store.trendStatus(valid, state.metric);

  const tiles = METRICS.map((mt) => {
    const t = store.trendStatus(valid, mt.key);
    const series = store.metricSeries(valid, mt.key);
    const last = series.at(-1);
    const arrow = t.state === 'better' ? '▲' : t.state === 'worse' ? '▼' : t.state === 'stable' ? '●' : '';
    const word = { better: 'besser', worse: 'schwächer', stable: 'stabil', none: '' }[t.state];
    return `<button class="tile ${mt.key === state.metric ? 'sel' : ''}" data-m="${mt.key}" aria-pressed="${mt.key === state.metric}">
      <span class="lbl">${mt.label}</span>
      <span class="val">${last ? fmtMetric(mt.key, last.y) : '–'}<small>${mt.unit}</small></span>
      <span class="foot">
        <span class="delta ${t.state}">${arrow} ${t.state === 'none' ? 'Baseline fehlt' : `${t.pct >= 0 ? '+' : ''}${t.pct.toFixed(0)} % · ${word}`}</span>
        ${sparkline(series.slice(-14))}
      </span></button>`;
  }).join('');

  const slopeTxt = trend ? (() => {
    const perMonth = trend.perDay * 30;
    return `Trend: ${perMonth >= 0 ? '+' : '−'}${Math.abs(perMonth).toFixed(m.dec + 1 > 3 ? 3 : m.dec + 1)} ${m.unit} pro Monat`;
  })() : '';

  const last = all.at(-1);
  el.innerHTML = `
    <div class="card">
      <div class="card-head"><h2>Zuletzt gemessen</h2><span class="muted">${fmtDateLong(last.start)}, ${timeFmt.format(last.start)}</span></div>
      <p class="muted" style="margin-top:6px">Veränderung der letzten 3 Messungen gegenüber deiner Baseline (erste 5 Messungen). Ab ±5 % wird farbig markiert.</p>
    </div>
    <div class="tiles">${tiles}</div>

    <div class="card">
      <div class="card-head"><h2>${m.label} <span class="muted">(${m.unit || 'Index'})</span></h2>
        <div class="row" role="group" aria-label="Zeitraum">
          ${[[30, '30 T'], [90, '90 T'], [180, '6 Mon.'], [0, 'Alles']].map(([d, l]) => `<button class="chip ${state.range === d ? 'active' : ''}" data-r="${d}">${l}</button>`).join('')}
        </div>
      </div>
      <p class="muted" style="margin:4px 0 8px">${esc(m.hint)}</p>
      <div class="chart" id="main-chart"></div>
      <div class="legend"><span><i></i>${m.label} je Messung</span>${base != null ? '<span><i class="b"></i>Baseline</span>' : ''}${trend ? '<span><i class="t"></i>Trend</span>' : ''}</div>
      <p class="muted" style="margin-top:8px">${slopeTxt}</p>
      <details style="margin-top:6px"><summary class="muted">Tabelle anzeigen</summary>
        <table class="data"><thead><tr><th>Datum</th><th>${m.label}</th></tr></thead><tbody>
        ${pts.slice().reverse().slice(0, 40).map((p) => `<tr><td>${fmtDateLong(p.x)}</td><td>${p.y.toFixed(m.dec)} ${m.unit}</td></tr>`).join('')}
        </tbody></table></details>
    </div>

    <div class="card">
      <h2>Schritte pro Tag <span class="muted">(gemessene Gehzeit, letzte 14 Tage)</span></h2>
      <div class="chart" id="steps-chart"></div>
    </div>
    <p class="notice">Die App ist ein Forschungs-/Schulprojekt und kein Medizinprodukt. Werte sind Schätzungen und ersetzen keine ärztliche Beurteilung. Besprich Veränderungen mit deinem Neurologen.</p>`;

  el.querySelectorAll('.tile').forEach((t) => t.addEventListener('click', () => { state.metric = t.dataset.m; renderDash(); }));
  el.querySelectorAll('[data-r]').forEach((b) => b.addEventListener('click', () => { state.range = +b.dataset.r; renderDash(); }));
  mountLineChart($('#main-chart'), { points: pts, dec: m.dec + (m.dec === 0 ? 0 : 0), unit: m.unit, label: m.label, baseline: base, trend });
  mountBars($('#steps-chart'), { points: store.dailySteps(all, 14), unit: 'Schritte' });
}

async function loadDemo() {
  store.replaceSessions([...store.loadSessions().filter((s) => !s.demo), ...demoHistory()]);
  toast('Demo-Daten geladen');
  render();
}

// ---------- Ansicht: Messungen ----------
function renderHistory() {
  const el = $('#view-history');
  const all = store.loadSessions().slice().reverse();
  el.innerHTML = `
    <div class="card-head"><h2>Alle Messungen (${all.length})</h2>
      <div class="row"><button class="btn" id="ex-csv" ${all.length ? '' : 'disabled'}>CSV</button><button class="btn" id="ex-json" ${all.length ? '' : 'disabled'}>JSON</button></div></div>
    <div class="list">
      ${all.length ? all.map((s) => `
        <button class="item" data-id="${esc(s.id)}">
          <b>${fmtDateLong(s.start)} <span class="muted">${timeFmt.format(s.start)}</span>${s.demo ? '<span class="badge">Demo</span>' : ''}<span class="badge">${TYPES[s.type]?.label ?? ''}</span></b>
          <b>${fmt(s.metrics.speedMs, 2)} m/s</b>
          <span class="muted">${mmss(s.metrics.totalTimeS)} min · ${s.metrics.steps} Schritte · ${fmt(s.metrics.cadence, 0)}/min</span>
          <span class="muted">${s.fatigueRating ? `Fatigue ${s.fatigueRating}/5` : ''}</span>
        </button>`).join('') : '<p class="muted">Noch keine Messungen.</p>'}
    </div>`;
  el.querySelectorAll('.item').forEach((b) => b.addEventListener('click', () => openSession(b.dataset.id)));
  $('#ex-csv')?.addEventListener('click', () => download('neurosync.csv', store.toCSV(store.loadSessions()), 'text/csv'));
  $('#ex-json')?.addEventListener('click', () => download('neurosync.json', JSON.stringify(store.loadSessions(), null, 2), 'application/json'));
}

function download(name, text, type) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function openSession(id) {
  const s = store.loadSessions().find((x) => x.id === id);
  if (!s) return;
  const dlg = $('#dlg');
  const m = s.metrics;
  const rows = METRICS.map((mt) => `<div><span>${mt.label}</span><b>${fmtMetric(mt.key, m[mt.key])} ${mt.unit}</b></div>`).join('');
  dlg.innerHTML = `
    <div class="card-head"><h2>${fmtDateLong(s.start)}, ${timeFmt.format(s.start)}</h2><button class="btn" id="x">Schließen</button></div>
    <p class="muted">${TYPES[s.type]?.label ?? ''} · ${mmss(m.totalTimeS)} min · ${m.steps} Schritte · ${fmt(m.distanceM, 0)} m${s.avgHr ? ` · Ø ${s.avgHr} bpm` : ''}</p>
    <div class="kv" style="margin:12px 0">${rows}</div>
    ${s.series?.length > 2 ? `<h2>Tempo im Messverlauf</h2><div class="chart" id="s-chart" style="margin-top:8px"></div>` : ''}
    ${s.fatigueRating ? `<p>Fatigue: ${s.fatigueRating}/5</p>` : ''}${s.note ? `<p>„${esc(s.note)}“</p>` : ''}
    <div class="row" style="justify-content:flex-end;margin-top:12px"><button class="btn danger" id="del">Löschen</button></div>`;
  dlg.showModal();
  $('#x').onclick = () => dlg.close();
  $('#del').onclick = () => {
    if (confirm('Diese Messung löschen?')) { store.deleteSession(id); dlg.close(); render(); }
  };
  if (s.series?.length > 2) {
    mountLineChart($('#s-chart'), {
      points: s.series.map((p) => ({ x: p.t, y: p.speedMs })), dec: 2, unit: 'm/s', label: 'Tempo im Messverlauf', height: 180,
      xFmt: (x) => mmss(x), xTipFmt: (x) => `bei ${mmss(x)} min`,
    });
  }
}

// ---------- Ansicht: Einstellungen ----------
function renderSettings() {
  const el = $('#view-settings');
  const st = state.settings;
  el.innerHTML = `
    <div class="card"><h2>Körpermaße & Kalibrierung</h2>
      <div class="field"><label for="leg">Beinlänge (Hüfte bis Boden, m)</label><input id="leg" type="number" inputmode="decimal" step="0.01" min="0.5" max="1.3" value="${st.legLengthM}"></div>
      <div class="field"><label for="cal">Schrittlängen-Faktor</label><input id="cal" type="number" inputmode="decimal" step="0.01" min="0.5" max="2" value="${st.calib}"></div>
      <p class="muted">Tipp: Messungsart „Kalibrierung“ wählen, 20 m abgemessen gehen und die echte Strecke eingeben – der Faktor wird automatisch bestimmt.</p></div>

    <div class="card"><h2>Zweiter Sensor (optional)</h2>
      <p class="muted">Ein Handgelenk-Tracker mit Standard-Herzfrequenzdienst (BLE 0x180D) kann parallel verbunden werden; der Durchschnittspuls wird je Messung mitgespeichert.</p>
      <div class="row"><button class="btn" id="hr">${state.hr ? 'Herzfrequenz-Sensor trennen' : 'Herzfrequenz-Sensor verbinden'}</button></div></div>

    <div class="card"><h2>Darstellung & Demo</h2>
      <div class="field"><label for="theme">Farbschema</label><select id="theme">
        ${[['auto', 'Automatisch'], ['light', 'Hell'], ['dark', 'Dunkel']].map(([v, l]) => `<option value="${v}" ${st.theme === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>
      <label class="row"><input type="checkbox" id="sim" ${st.useSimulator ? 'checked' : ''}> Demo-Sensor statt echtem Bluetooth-Sensor verwenden</label>
      <div class="row" style="margin-top:12px"><button class="btn" id="demo">Demo-Verlauf laden (4 Monate)</button><button class="btn" id="demo-x">Demo-Daten entfernen</button></div></div>

    <div class="card"><h2>Daten</h2>
      <p class="muted">Alle Daten liegen nur lokal in diesem Browser. Exportiere sie regelmäßig unter „Messungen“.</p>
      <button class="btn danger" id="wipe">Alle Messungen löschen</button></div>`;
  const num = (id, key, lo, hi) => $(id).addEventListener('change', (e) => {
    const v = parseFloat(e.target.value);
    if (v >= lo && v <= hi) { st[key] = v; store.saveSettings(st); } else e.target.value = st[key];
  });
  num('#leg', 'legLengthM', 0.5, 1.3);
  num('#cal', 'calib', 0.5, 2);
  $('#theme').addEventListener('change', (e) => { st.theme = e.target.value; store.saveSettings(st); applyTheme(); });
  $('#sim').addEventListener('change', (e) => {
    st.useSimulator = e.target.checked; store.saveSettings(st);
    if (state.device) disconnectDevice();
  });
  $('#demo').onclick = loadDemo;
  $('#demo-x').onclick = () => { store.replaceSessions(store.loadSessions().filter((s) => !s.demo)); toast('Demo-Daten entfernt'); };
  $('#wipe').onclick = () => { if (confirm('Wirklich ALLE Messungen löschen?')) { store.clearSessions(); toast('Alle Messungen gelöscht'); } };
  $('#hr').onclick = async () => {
    if (state.hr) { state.hr.disconnect(); state.hr = null; state.hrBpm = null; renderSettings(); return; }
    try {
      const hr = new HeartRateSensor({ onHr: (b) => { state.hrBpm = b; }, onState: (s) => { if (s === 'disconnected') { state.hr = null; state.hrBpm = null; } } });
      await hr.connect();
      state.hr = hr;
      toast('Herzfrequenz-Sensor verbunden');
      renderSettings();
    } catch (err) { if (err?.name !== 'NotFoundError') toast(`Herzfrequenz: ${err.message}`, 5000); }
  };
}

// ---------- Start ----------
if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
window.addEventListener('beforeunload', (e) => { if (state.rec) { e.preventDefault(); e.returnValue = ''; } });
setConn('disconnected');
show('dash');
