// Schlanke SVG-Diagramme ohne Abhängigkeiten: Linien-/Flächendiagramm mit Tooltip,
// Sparkline, Balkendiagramm. Farben kommen aus CSS-Variablen (Hell/Dunkel).

const NS = 'http://www.w3.org/2000/svg';
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function niceTicks(lo, hi, count = 4) {
  if (lo === hi) { lo -= 1; hi += 1; }
  const raw = (hi - lo) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) || raw;
  const start = Math.floor(lo / step) * step;
  const out = [];
  for (let v = start; v <= hi + step * 0.5; v += step) out.push(+v.toFixed(10));
  return out;
}

const dateFmt = new Intl.DateTimeFormat('de-CH', { day: 'numeric', month: 'short' });
const dateLong = new Intl.DateTimeFormat('de-CH', { weekday: 'short', day: 'numeric', month: 'long', year: 'numeric' });
export const fmtDate = (x) => dateFmt.format(x);
export const fmtDateLong = (x) => dateLong.format(x);

/**
 * @param {HTMLElement} el
 * @param {{points:{x:number,y:number}[], dec?:number, unit?:string, label?:string, baseline?:number|null,
 *          trend?:{at:(x:number)=>number}|null, xFmt?:(x:number)=>string, xTipFmt?:(x:number)=>string, height?:number}} o
 */
export function mountLineChart(el, o) {
  const draw = () => {
    const W = Math.max(260, el.clientWidth);
    const H = o.height ?? 240;
    const m = { t: 12, r: 12, b: 26, l: 44 };
    const pts = o.points;
    el.innerHTML = '';
    if (!pts.length) { el.innerHTML = '<div class="empty-chart">Noch keine Daten</div>'; return; }

    const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
    let x0 = Math.min(...xs), x1 = Math.max(...xs);
    if (x0 === x1) { x0 -= 432e5; x1 += 432e5; }
    const yv = [...ys];
    if (o.baseline != null) yv.push(o.baseline);
    const pad = (Math.max(...yv) - Math.min(...yv) || 1) * 0.12;
    const ticks = niceTicks(Math.min(...yv) - pad, Math.max(...yv) + pad);
    const y0 = ticks[0], y1 = ticks[ticks.length - 1];
    const sx = (x) => m.l + ((x - x0) / (x1 - x0)) * (W - m.l - m.r);
    const sy = (y) => m.t + (1 - (y - y0) / (y1 - y0)) * (H - m.t - m.b);
    const dec = o.dec ?? 1;
    const xFmt = o.xFmt ?? fmtDate;

    let g = '';
    for (const t of ticks) {
      g += `<line class="grid" x1="${m.l}" x2="${W - m.r}" y1="${sy(t)}" y2="${sy(t)}"/>`;
      g += `<text class="tick" x="${m.l - 8}" y="${sy(t) + 4}" text-anchor="end">${t.toFixed(dec)}</text>`;
    }
    const nx = Math.min(5, Math.max(2, Math.floor((W - m.l) / 90)));
    for (let i = 0; i < nx; i++) {
      const x = x0 + ((x1 - x0) * i) / (nx - 1);
      const anchor = i === 0 ? 'start' : i === nx - 1 ? 'end' : 'middle';
      g += `<text class="tick" x="${sx(x)}" y="${H - 6}" text-anchor="${anchor}">${esc(xFmt(x))}</text>`;
    }
    g += `<line class="axis" x1="${m.l}" x2="${W - m.r}" y1="${sy(y0)}" y2="${sy(y0)}"/>`;

    if (o.baseline != null) {
      g += `<line class="baseline" x1="${m.l}" x2="${W - m.r}" y1="${sy(o.baseline)}" y2="${sy(o.baseline)}"/>`;
      g += `<text class="tick" x="${W - m.r}" y="${sy(o.baseline) - 5}" text-anchor="end">Baseline</text>`;
    }
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`).join('');
    const area = `${line}L${sx(pts.at(-1).x).toFixed(1)},${sy(y0)}L${sx(pts[0].x).toFixed(1)},${sy(y0)}Z`;
    g += `<path class="area" d="${area}"/>`;
    if (o.trend) {
      g += `<line class="trend" x1="${sx(x0)}" x2="${sx(x1)}" y1="${sy(o.trend.at(x0))}" y2="${sy(o.trend.at(x1))}"/>`;
    }
    g += `<path class="line" d="${line}"/>`;
    if (pts.length <= 60) {
      for (const p of pts) g += `<circle class="dot" cx="${sx(p.x)}" cy="${sy(p.y)}" r="3.5"/>`;
    }
    g += `<line class="cross" x1="0" x2="0" y1="${m.t}" y2="${sy(y0)}" visibility="hidden"/>`;
    g += `<circle class="hover-dot" r="5.5" visibility="hidden"/>`;
    el.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="${esc(o.label ?? 'Verlauf')}">${g}</svg><div class="tip" hidden></div>`;

    const svg = el.querySelector('svg'), tip = el.querySelector('.tip');
    const cross = svg.querySelector('.cross'), hd = svg.querySelector('.hover-dot');
    const show = (ev) => {
      const r = svg.getBoundingClientRect();
      const mx = ev.clientX - r.left;
      let best = pts[0], bd = Infinity;
      for (const p of pts) { const d = Math.abs(sx(p.x) - mx); if (d < bd) { bd = d; best = p; } }
      const px = sx(best.x), py = sy(best.y);
      cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
      hd.setAttribute('cx', px); hd.setAttribute('cy', py); hd.setAttribute('visibility', 'visible');
      tip.hidden = false;
      tip.innerHTML = `<b>${best.y.toFixed(dec)}${o.unit ? ' ' + esc(o.unit) : ''}</b><span>${esc((o.xTipFmt ?? fmtDateLong)(best.x))}</span>`;
      const tw = tip.offsetWidth;
      tip.style.left = `${Math.min(Math.max(px - tw / 2, 0), W - tw)}px`;
      tip.style.top = `${Math.max(py - 58, 0)}px`;
    };
    const hide = () => { tip.hidden = true; cross.setAttribute('visibility', 'hidden'); hd.setAttribute('visibility', 'hidden'); };
    svg.addEventListener('pointermove', show);
    svg.addEventListener('pointerdown', show);
    svg.addEventListener('pointerleave', hide);
  };
  draw();
  if (el._ro) el._ro.disconnect();
  let lastW = el.clientWidth;
  el._ro = new ResizeObserver(() => { if (Math.abs(el.clientWidth - lastW) > 1) { lastW = el.clientWidth; draw(); } });
  el._ro.observe(el);
}

export function sparkline(points, { w = 96, h = 28 } = {}) {
  if (points.length < 2) return `<svg class="spark" width="${w}" height="${h}"></svg>`;
  const ys = points.map((p) => p.y);
  const lo = Math.min(...ys), hi = Math.max(...ys), rng = hi - lo || 1;
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${((i / (points.length - 1)) * (w - 6) + 3).toFixed(1)},${(h - 4 - ((p.y - lo) / rng) * (h - 8)).toFixed(1)}`).join('');
  const last = points.at(-1);
  const lx = w - 3, ly = h - 4 - ((last.y - lo) / rng) * (h - 8);
  return `<svg class="spark" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true"><path d="${d}"/><circle cx="${lx}" cy="${ly.toFixed(1)}" r="3"/></svg>`;
}

/** Balkendiagramm (z. B. Schritte pro Tag), 4-px-Rundung am Datenende. */
export function mountBars(el, { points, unit = '', height = 150 }) {
  const draw = () => {
    const W = Math.max(260, el.clientWidth), H = height, m = { t: 8, r: 4, b: 22, l: 4 };
    const max = Math.max(1, ...points.map((p) => p.y));
    const bw = (W - m.l - m.r) / points.length;
    const gap = Math.min(6, bw * 0.25);
    let g = `<line class="axis" x1="${m.l}" x2="${W - m.r}" y1="${H - m.b}" y2="${H - m.b}"/>`;
    points.forEach((p, i) => {
      const x = m.l + i * bw + gap / 2, w = bw - gap;
      const h = (p.y / max) * (H - m.t - m.b);
      const y = H - m.b - h;
      const r = Math.min(4, w / 2, h);
      if (p.y > 0) {
        g += `<path class="bar" data-i="${i}" d="M${x},${H - m.b}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${H - m.b}Z"/>`;
      }
      g += `<rect class="hit" data-i="${i}" x="${m.l + i * bw}" y="0" width="${bw}" height="${H - m.b}"/>`;
      if (i % Math.ceil(points.length / 5) === 0 && i < points.length - 2) {
        g += `<text class="tick" x="${x + w / 2}" y="${H - 6}" text-anchor="middle">${new Date(p.x).getDate()}.${new Date(p.x).getMonth() + 1}.</text>`;
      }
    });
    el.innerHTML = `<svg width="${W}" height="${H}" role="img" aria-label="Schritte pro Tag">${g}</svg><div class="tip" hidden></div>`;
    const tip = el.querySelector('.tip');
    el.querySelectorAll('.hit').forEach((r) => {
      const on = () => {
        const p = points[+r.dataset.i];
        tip.hidden = false;
        tip.innerHTML = `<b>${p.y.toLocaleString('de-CH')} ${esc(unit)}</b><span>${esc(fmtDateLong(p.x))}</span>`;
        const px = m.l + (+r.dataset.i + 0.5) * bw, tw = tip.offsetWidth;
        tip.style.left = `${Math.min(Math.max(px - tw / 2, 0), W - tw)}px`;
        tip.style.top = '0px';
      };
      r.addEventListener('pointerenter', on);
      r.addEventListener('pointerdown', on);
      r.addEventListener('pointerleave', () => { tip.hidden = true; });
    });
  };
  draw();
  if (el._ro) el._ro.disconnect();
  let lastW = el.clientWidth;
  el._ro = new ResizeObserver(() => { if (Math.abs(el.clientWidth - lastW) > 1) { lastW = el.clientWidth; draw(); } });
  el._ro.observe(el);
}

/** Live-Signal auf Canvas (scrollend). */
export function drawWave(canvas, values, { range = 0.6 } = {}) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const css = getComputedStyle(canvas);
  ctx.strokeStyle = css.getPropertyValue('--grid');
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(0, h / 2); ctx.lineTo(w, h / 2); ctx.stroke();
  if (values.length < 2) return;
  ctx.strokeStyle = css.getPropertyValue('--series-1');
  ctx.lineWidth = 2; ctx.lineJoin = 'round';
  ctx.beginPath();
  values.forEach((v, i) => {
    const x = (i / (values.length - 1)) * w;
    const y = h / 2 - (Math.max(-range, Math.min(range, v)) / range) * (h / 2 - 4);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  });
  ctx.stroke();
}
