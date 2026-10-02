// Web-Bluetooth-Anbindung für den NeuroSync-Rückensensor und (optional) einen
// Standard-Herzfrequenzsensor (z. B. ein späteres Handgelenk-Gerät).

const base = (n) => `6e657572-6f73-796e-6300-0000000000${n}`;
export const UUID = { service: base('01'), data: base('02'), config: base('03') };
const SAMPLES_PER_PKT = 5;
const PKT_LEN = 2 + SAMPLES_PER_PKT * 12;

export const bleSupported = () => typeof navigator !== 'undefined' && !!navigator.bluetooth;

/** Dekodiert ein Datenpaket → Arrays in g bzw. °/s. */
export function parsePacket(view) {
  const seq = view.getUint16(0, true);
  const out = { seq, ax: [], ay: [], az: [], gx: [], gy: [], gz: [] };
  for (let i = 0; i < SAMPLES_PER_PKT; i++) {
    const o = 2 + i * 12;
    out.ax.push(view.getInt16(o, true) / 1000);
    out.ay.push(view.getInt16(o + 2, true) / 1000);
    out.az.push(view.getInt16(o + 4, true) / 1000);
    out.gx.push(view.getInt16(o + 6, true) / 10);
    out.gy.push(view.getInt16(o + 8, true) / 10);
    out.gz.push(view.getInt16(o + 10, true) / 10);
  }
  return out;
}

export class BackSensor {
  /** @param {{onData:Function,onState:Function,onBattery:Function}} cb */
  constructor(cb) {
    this.cb = cb;
    this.device = null;
    this.fs = 52;
    this.lastSeq = null;
    this.lost = 0;
    this.received = 0;
    this.last = null;
    this.wantConnected = false;
    this._onChange = (e) => this._handle(e.target.value);
    this._onDisc = () => this._disconnected();
  }

  async connect() {
    if (!bleSupported()) throw new Error('Web Bluetooth wird von diesem Browser nicht unterstützt.');
    this.cb.onState('connecting');
    this.device = await navigator.bluetooth.requestDevice({
      filters: [{ services: [UUID.service] }],
      optionalServices: ['battery_service'],
    });
    this.device.addEventListener('gattserverdisconnected', this._onDisc);
    this.wantConnected = true;
    await this._open();
  }

  async _open() {
    try {
      this.cb.onState('connecting');
      const server = await this.device.gatt.connect();
      const svc = await server.getPrimaryService(UUID.service);
      try {
        const cfg = await (await svc.getCharacteristic(UUID.config)).readValue();
        this.fs = cfg.getUint16(0, true) || 52;
      } catch { /* Standardwerte */ }
      try {
        const bs = await server.getPrimaryService('battery_service');
        const bc = await bs.getCharacteristic('battery_level');
        this.cb.onBattery((await bc.readValue()).getUint8(0));
        await bc.startNotifications();
        bc.addEventListener('characteristicvaluechanged', (e) => this.cb.onBattery(e.target.value.getUint8(0)));
      } catch { /* Batterieservice optional */ }
      const data = await svc.getCharacteristic(UUID.data);
      data.addEventListener('characteristicvaluechanged', this._onChange);
      await data.startNotifications();
      this.lastSeq = null;
      this.cb.onState('connected');
    } catch (err) {
      this.cb.onState('disconnected');
      throw err;
    }
  }

  _handle(view) {
    if (view.byteLength < PKT_LEN) return; // MTU zu klein → Paket abgeschnitten
    const pkt = parsePacket(view);
    let missing = 0;
    if (this.lastSeq !== null) missing = (pkt.seq - this.lastSeq - 1) & 0xffff;
    this.lastSeq = pkt.seq;
    this.received++;
    if (missing > 0 && missing < 100) {
      // Lücken mit dem letzten Wert auffüllen, damit die Zeitachse stimmt
      const l = this.last;
      const n = missing * SAMPLES_PER_PKT;
      const fill = { ax: Array(n).fill(l.ax), ay: Array(n).fill(l.ay), az: Array(n).fill(l.az),
        gx: Array(n).fill(l.gx), gy: Array(n).fill(l.gy), gz: Array(n).fill(l.gz) };
      this.lost += missing;
      this.cb.onData(fill, { lost: missing });
    }
    this.last = { ax: pkt.ax.at(-1), ay: pkt.ay.at(-1), az: pkt.az.at(-1), gx: pkt.gx.at(-1), gy: pkt.gy.at(-1), gz: pkt.gz.at(-1) };
    this.cb.onData(pkt, { lost: 0 });
  }

  _disconnected() {
    this.cb.onState('disconnected');
    if (!this.wantConnected) return;
    // automatischer Wiederverbindungsversuch (Funkabbruch beim Gehen)
    let tries = 0;
    const retry = async () => {
      if (!this.wantConnected || this.device.gatt.connected) return;
      try { await this._open(); } catch {
        if (++tries < 8) setTimeout(retry, Math.min(1000 * 2 ** tries, 15000));
      }
    };
    setTimeout(retry, 1000);
  }

  disconnect() {
    this.wantConnected = false;
    if (this.device?.gatt?.connected) this.device.gatt.disconnect();
    this.cb.onState('disconnected');
  }

  get lossRate() { const t = this.received + this.lost; return t ? this.lost / t : 0; }
}

/** Optionaler Standard-BLE-Herzfrequenzsensor (Service 0x180D). */
export class HeartRateSensor {
  constructor({ onHr, onState }) { this.onHr = onHr; this.onState = onState; this.device = null; }

  async connect() {
    if (!bleSupported()) throw new Error('Web Bluetooth wird nicht unterstützt.');
    this.device = await navigator.bluetooth.requestDevice({ filters: [{ services: ['heart_rate'] }] });
    this.device.addEventListener('gattserverdisconnected', () => this.onState('disconnected'));
    const server = await this.device.gatt.connect();
    const ch = await (await server.getPrimaryService('heart_rate')).getCharacteristic('heart_rate_measurement');
    ch.addEventListener('characteristicvaluechanged', (e) => {
      const v = e.target.value;
      this.onHr((v.getUint8(0) & 1) ? v.getUint16(1, true) : v.getUint8(1));
    });
    await ch.startNotifications();
    this.onState('connected');
  }

  disconnect() { this.device?.gatt?.connected && this.device.gatt.disconnect(); }
}
