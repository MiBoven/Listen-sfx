'use strict';
/* =====================================================================
   Listen — cinematic sound effects in the browser
   app.js: DSP engines, effect chain, timeline, projects, import/record,
   export. Everything runs client-side; no network requests.
   ===================================================================== */

const APP_VERSION = '0.1.0';
const SR = 48000;
const $ = (id) => document.getElementById(id);

/* ---------- Small helpers ---------- */
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);
const TAU = Math.PI * 2;
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const deepCopy = (o) => JSON.parse(JSON.stringify(o));

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Audio buffers are plain objects { L: Float32Array, R: Float32Array } at SR.
function newBuf(len) { len = Math.max(1, len | 0); return { L: new Float32Array(len), R: new Float32Array(len) }; }
const bufLen = (b) => b.L.length;
function sliceBuf(b, a, e) { // seconds
  const s = clamp(Math.round(a * SR), 0, bufLen(b) - 1);
  const t = clamp(Math.round(e * SR), s + 1, bufLen(b));
  return { L: b.L.slice(s, t), R: b.R.slice(s, t) };
}
function peakOf(b) {
  let p = 0;
  for (const ch of [b.L, b.R]) for (let i = 0; i < ch.length; i++) { const v = Math.abs(ch[i]); if (v > p) p = v; }
  return p;
}
function scaleBuf(b, g) { for (const ch of [b.L, b.R]) for (let i = 0; i < ch.length; i++) ch[i] *= g; return b; }
function normalizeBuf(b, target = 0.89) { const p = peakOf(b); if (p > 1e-6) scaleBuf(b, target / p); return b; }
function fadeEdges(b, inS = 0.002, outS = 0.01) {
  const n = bufLen(b), fi = Math.min(n, Math.round(inS * SR)), fo = Math.min(n, Math.round(outS * SR));
  for (const ch of [b.L, b.R]) {
    for (let i = 0; i < fi; i++) ch[i] *= i / fi;
    for (let i = 0; i < fo; i++) ch[n - 1 - i] *= i / fo;
  }
  return b;
}
function panGains(pos) { // pos -1..1, equal power
  const a = (clamp(pos, -1, 1) + 1) * Math.PI / 4;
  return [Math.cos(a), Math.sin(a)];
}

/* ---------- Filters ---------- */
class Biquad {
  constructor(type, f, q = 0.707, gainDb = 0) { this.x1 = this.x2 = this.y1 = this.y2 = 0; this.set(type, f, q, gainDb); }
  set(type, f, q = 0.707, gainDb = 0) {
    f = clamp(f, 10, SR * 0.49);
    const w = TAU * f / SR, c = Math.cos(w), s = Math.sin(w), al = s / (2 * q), A = Math.pow(10, gainDb / 40);
    let b0, b1, b2, a0, a1, a2;
    switch (type) {
      case 'hp': b0 = (1 + c) / 2; b1 = -(1 + c); b2 = b0; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; break;
      case 'bp': b0 = al; b1 = 0; b2 = -al; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; break;
      case 'ls': {
        const sq = 2 * Math.sqrt(A) * al;
        b0 = A * ((A + 1) - (A - 1) * c + sq); b1 = 2 * A * ((A - 1) - (A + 1) * c); b2 = A * ((A + 1) - (A - 1) * c - sq);
        a0 = (A + 1) + (A - 1) * c + sq; a1 = -2 * ((A - 1) + (A + 1) * c); a2 = (A + 1) + (A - 1) * c - sq; break;
      }
      default: b0 = (1 - c) / 2; b1 = 1 - c; b2 = b0; a0 = 1 + al; a1 = -2 * c; a2 = 1 - al; // lp
    }
    this.b0 = b0 / a0; this.b1 = b1 / a0; this.b2 = b2 / a0; this.a1 = a1 / a0; this.a2 = a2 / a0;
  }
  p(x) {
    const y = this.b0 * x + this.b1 * this.x1 + this.b2 * this.x2 - this.a1 * this.y1 - this.a2 * this.y2;
    this.x2 = this.x1; this.x1 = x; this.y2 = this.y1; this.y1 = y;
    return y;
  }
}
// Zero-delay state-variable filter — cheap to modulate every sample.
class SVF {
  constructor() { this.ic1 = 0; this.ic2 = 0; this.lp = 0; this.bp = 0; this.hp = 0; }
  run(x, f, q) {
    const g = Math.tan(Math.PI * clamp(f, 10, SR * 0.45) / SR), k = 1 / q;
    const a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2;
    const v3 = x - this.ic2, v1 = a1 * this.ic1 + a2 * v3, v2 = this.ic2 + a2 * this.ic1 + a3 * v3;
    this.ic1 = 2 * v1 - this.ic1; this.ic2 = 2 * v2 - this.ic2;
    this.lp = v2; this.bp = v1; this.hp = x - k * v1 - v2;
    return v2;
  }
}
function polyblep(t, dt) {
  if (t < dt) { t /= dt; return t + t - t * t - 1; }
  if (t > 1 - dt) { t = (t - 1) / dt; return t * t + t + t + 1; }
  return 0;
}

/* =====================================================================
   Parameter definitions
   k key · n name · min/max · d default · u unit · log · opts (discrete)
   tip: what moving the dial does to the sound
   ===================================================================== */
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
function fmtVal(def, v) {
  if (def.opts) return def.opts[Math.round(v)];
  switch (def.u) {
    case 'Hz': return v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 1 : 2).replace(/\.?0+$/, '') + 'k' : (v < 10 ? v.toFixed(1) : Math.round(v)) + '';
    case 's': return v.toFixed(v < 1 ? 2 : 1) + 's';
    case 'ms': return Math.round(v) + 'ms';
    case '%': return Math.round(v) + '%';
    case 'st': return (v > 0 ? '+' : '') + Math.round(v);
    case 'dB': return (v > 0 ? '+' : '') + v.toFixed(Math.abs(v) < 10 ? 1 : 0);
    case 'note': return NOTE_NAMES[Math.round(v) % 12] + (Math.floor(Math.round(v) / 12) - 1);
    case 'x': return v.toFixed(2) + '×';
    case '/s': return v.toFixed(v < 10 ? 1 : 0);
    default: return Math.abs(v) < 10 && v % 1 ? v.toFixed(1) : Math.round(v) + '';
  }
}
function unitLabel(def) { return def.opts ? '' : ({ Hz: 'Hz', '/s': 'per s', bits: 'bits' }[def.u] || ''); }
function toN(def, v) {
  if (def.opts) return def.opts.length > 1 ? clamp(v, 0, def.opts.length - 1) / (def.opts.length - 1) : 0;
  if (def.log) return clamp(Math.log(v / def.min) / Math.log(def.max / def.min), 0, 1);
  return clamp((v - def.min) / (def.max - def.min), 0, 1);
}
function fromN(def, n) {
  n = clamp(n, 0, 1);
  if (def.opts) return Math.round(n * (def.opts.length - 1));
  let v = def.log ? def.min * Math.pow(def.max / def.min, n) : def.min + n * (def.max - def.min);
  const range = def.max - def.min;
  if (def.int || def.u === 'note' || def.u === 'st' || def.u === '%' || def.u === 'ms' || (!def.log && range >= 20)) v = Math.round(v);
  else if (def.log) { const m = Math.pow(10, Math.floor(Math.log10(Math.abs(v))) - 2); v = Math.round(v / m) * m; }
  else v = Math.round(v * 100) / 100;
  return clamp(v, def.min ?? 0, def.max ?? v);
}
function defaultsOf(defs) { const o = {}; defs.forEach((d) => (o[d.k] = d.d)); return o; }

/* =====================================================================
   Sound engines
   ===================================================================== */
const ENGINES = {
  retro: {
    name: '8-Bit',
    desc: 'Classic video-game chip sound — a single oscillator with slides and jumps.',
    params: [
      { k: 'wave', n: 'Wave', opts: ['Square', 'Saw', 'Triangle', 'Noise'], d: 0, tip: 'Square = classic console · Saw = buzzy · Triangle = soft · Noise = explosions & hits' },
      { k: 'freq', n: 'Pitch', min: 50, max: 2400, log: true, d: 440, u: 'Hz', tip: 'Starting pitch. Low = heavy, high = tiny and bright' },
      { k: 'slide', n: 'Slide', min: -48, max: 48, d: 0, u: 'st', tip: 'Glides the pitch up (jumps, power-ups) or down (lasers, falling) over the sound' },
      { k: 'length', n: 'Length', min: 0.05, max: 2.5, d: 0.3, u: 's', tip: 'Total duration of the sound' },
      { k: 'decay', n: 'Fade', min: 0, max: 100, d: 60, u: '%', tip: '0 = stays loud until the end · 100 = short plucky blip' },
      { k: 'duty', n: 'Pulse width', min: 5, max: 50, d: 50, u: '%', tip: 'Square only: 50% = hollow, small = thin and nasal' },
      { k: 'vibrato', n: 'Vibrato', min: 0, max: 100, d: 0, u: '%', tip: 'Wobbly pitch — dreamy or "hurt" sounds' },
      { k: 'arp', n: 'Jump', min: -12, max: 12, d: 0, u: 'st', tip: 'Pitch jump halfway through — the coin "ding-ding" effect' },
      { k: 'repeat', n: 'Repeats', min: 0, max: 8, d: 0, int: true, tip: 'Retriggers the sound several times in a row' },
    ],
    gen(p, rnd) {
      const len = Math.round(p.length * SR), b = newBuf(len), seg = len / (p.repeat + 1);
      const duty = p.duty / 100, dk = p.decay / 100 * 3.5, vib = p.vibrato / 100 * 0.06;
      let ph = 0, nz = 0, nph = 0, lastSeg = -1;
      for (let i = 0; i < len; i++) {
        const sIdx = Math.floor(i / seg); if (sIdx !== lastSeg) { lastSeg = sIdx; ph = 0; }
        const ts = (i - sIdx * seg) / seg;
        const semis = p.slide * ts + (ts > 0.42 ? p.arp : 0);
        const f = p.freq * Math.pow(2, semis / 12) * (1 + vib * Math.sin(TAU * 6.5 * i / SR));
        ph += f / SR; if (ph >= 1) ph -= Math.floor(ph);
        let y;
        switch (p.wave) {
          case 1: y = 2 * ph - 1; break;
          case 2: y = 1 - 4 * Math.abs(ph - 0.5); break;
          case 3: nph += f * 8 / SR; if (nph >= 1) { nph -= Math.floor(nph); nz = rnd() * 2 - 1; } y = nz; break;
          default: y = ph < duty ? 1 : -1;
        }
        let env = Math.pow(1 - ts, dk);
        const tIn = (i - sIdx * seg) / SR; if (tIn < 0.003) env *= tIn / 0.003;
        y = Math.round(y * env * 15) / 15; // 4-bit-ish amplitude steps for chip flavour
        b.L[i] = b.R[i] = y * 0.6;
      }
      return b;
    },
  },

  impact: {
    name: 'Impact',
    desc: 'Explosions and hits — a noise blast, a low thump, debris and a rumbling tail.',
    params: [
      { k: 'length', n: 'Length', min: 0.2, max: 8, d: 2.5, u: 's', tip: 'How long until it has died away completely' },
      { k: 'body', n: 'Thump', min: 0, max: 100, d: 70, u: '%', tip: 'The punch you feel in the stomach' },
      { k: 'thump', n: 'Thump pitch', min: 25, max: 160, d: 55, u: 'Hz', tip: 'Low = huge and far, high = tight and close' },
      { k: 'bright', n: 'Brightness', min: 200, max: 16000, log: true, d: 5000, u: 'Hz', tip: 'Low = muffled, behind a wall · high = sharp and close' },
      { k: 'crunch', n: 'Crunch', min: 0, max: 100, d: 40, u: '%', tip: 'Distortion — more aggressive and dirty' },
      { k: 'tail', n: 'Rumble', min: 0, max: 100, d: 50, u: '%', tip: 'Low rolling rumble after the blast' },
      { k: 'debris', n: 'Debris', min: 0, max: 100, d: 30, u: '%', tip: 'Crackling bits flying around' },
      { k: 'width', n: 'Width', min: 0, max: 100, d: 70, u: '%', tip: 'Stereo spread — 0 = mono, 100 = all around you' },
    ],
    gen(p, rnd) {
      const len = Math.round(p.length * SR), b = newBuf(len);
      const dec = p.length * 0.22, w = p.width / 100;
      const fL = new SVF(), fR = new SVF(), rum = new Biquad('lp', 90, 0.7), dhp = new Biquad('hp', 900);
      const drive = 1 + p.crunch / 100 * 10, dnorm = Math.tanh(drive);
      let tph = 0, brown = 0, click = 0;
      const dens = p.debris / 100 * 90 / SR;
      for (let i = 0; i < len; i++) {
        const t = i / SR;
        const envN = t < 0.004 ? t / 0.004 : Math.exp(-(t - 0.004) / dec);
        const fc = 120 + (p.bright - 120) * Math.exp(-t / (dec * 0.5));
        const sh = rnd() * 2 - 1;
        const nL = sh * (1 - w * 0.7) + (rnd() * 2 - 1) * w * 0.7, nR = sh * (1 - w * 0.7) + (rnd() * 2 - 1) * w * 0.7;
        let yL = fL.run(nL, fc, 0.8) * envN, yR = fR.run(nR, fc, 0.8) * envN;
        // thump
        const tf = p.thump * (1 + 2.5 * Math.exp(-t / 0.025));
        tph += tf / SR;
        const th = Math.sin(TAU * tph) * (p.body / 100) * Math.exp(-t / (0.12 + p.length * 0.06)) * Math.min(1, t / 0.002) * 1.6;
        // rumble
        brown = brown * 0.995 + (rnd() * 2 - 1) * 0.05;
        const ru = rum.p(brown) * 6 * (p.tail / 100) * Math.exp(-t / (p.length * 0.4)) * (1 - Math.exp(-t / 0.06));
        // debris
        if (rnd() < dens * Math.exp(-t / (dec * 2))) click = 0.3 + rnd() * 0.7;
        click *= 0.993;
        const db = dhp.p((rnd() * 2 - 1) * click) * 0.8;
        const dp = rnd() * 2 - 1;
        yL += th + ru + db * (1 - dp * w * 0.5); yR += th + ru + db * (1 + dp * w * 0.5);
        b.L[i] = Math.tanh(yL * drive) / dnorm; b.R[i] = Math.tanh(yR * drive) / dnorm;
      }
      return b;
    },
  },

  power: {
    name: 'Power',
    desc: 'Motors, generators and risers — a buzzing tone that sweeps up or down.',
    params: [
      { k: 'start', n: 'Start pitch', min: 20, max: 3000, log: true, d: 400, u: 'Hz', tip: 'Pitch at the beginning' },
      { k: 'end', n: 'End pitch', min: 20, max: 3000, log: true, d: 40, u: 'Hz', tip: 'Pitch at the end — lower than start = shutting down, higher = powering up' },
      { k: 'length', n: 'Length', min: 0.2, max: 12, d: 3, u: 's', tip: 'Duration of the sweep' },
      { k: 'curve', n: 'Curve', min: -100, max: 100, d: 0, tip: 'Negative = changes fast at first, then slowly · positive = slow start, fast finish' },
      { k: 'harmonics', n: 'Buzz', min: 0, max: 100, d: 60, u: '%', tip: 'Pure tone → raw electric buzz' },
      { k: 'wobble', n: 'Rotor', min: 0, max: 100, d: 40, u: '%', tip: 'Pulsing of a spinning machine — speeds up and slows with the pitch' },
      { k: 'hum', n: 'Whine', min: 0, max: 100, d: 20, u: '%', tip: 'High electric whine on top' },
      { k: 'clunk', n: 'Clunk', min: 0, max: 100, d: 40, u: '%', tip: 'A mechanical clunk where the machine stops (or starts)' },
    ],
    gen(p, rnd) {
      const len = Math.round(p.length * SR), b = newBuf(len);
      const k = Math.pow(2, p.curve / 40), h = p.harmonics / 100, down = p.end < p.start;
      const lp = new SVF();
      let ph = 0, sph = 0, wph = 0, hph = 0;
      const ref = Math.max(p.start, p.end);
      for (let i = 0; i < len; i++) {
        const u = i / len, uu = Math.pow(u, k);
        const f = p.start * Math.pow(p.end / p.start, uu), dt = f / SR;
        ph += dt; if (ph >= 1) ph -= 1;
        sph += dt / 2; if (sph >= 1) sph -= 1;
        const saw = 2 * ph - 1 - polyblep(ph, dt);
        let y = Math.sin(TAU * ph) * (1 - h * 0.7) + saw * h * 0.7 + Math.sin(TAU * sph) * 0.35;
        y = lp.run(y, f * (3 + h * 10) + 150, 0.9);
        wph += clamp(f / 7, 0.3, 45) / SR;
        y *= 1 - p.wobble / 100 * 0.55 * (0.5 + 0.5 * Math.sin(TAU * wph));
        hph += f * 4.02 / SR;
        y += Math.sin(TAU * hph) * 0.18 * (p.hum / 100) + (rnd() * 2 - 1) * 0.03 * (p.hum / 100);
        const amp = 0.45 + 0.55 * Math.sqrt(f / ref);
        let env = amp;
        const t = i / SR, tEnd = (len - i) / SR;
        if (t < 0.03) env *= t / 0.03;
        if (tEnd < 0.08) env *= tEnd / 0.08;
        b.L[i] = b.R[i] = y * env * 0.7;
      }
      if (p.clunk > 0) { // mechanical clunk at the low end of the sweep
        const at = down ? Math.max(0, len - Math.round(0.35 * SR)) : 0;
        const n = Math.round(0.35 * SR), hp = new Biquad('bp', 1800, 1.5);
        let cph = 0;
        for (let i = 0; i < n && at + i < len; i++) {
          const t = i / SR, e = Math.exp(-t / 0.05) * (p.clunk / 100);
          cph += 70 * (1 + Math.exp(-t / 0.01)) / SR;
          const y = Math.sin(TAU * cph) * e * 1.2 + hp.p(rnd() * 2 - 1) * Math.exp(-t / 0.012) * (p.clunk / 100) * 1.5;
          b.L[at + i] += y; b.R[at + i] += y;
        }
      }
      return b;
    },
  },

  whoosh: {
    name: 'Whoosh',
    desc: 'Air moving past — swings, fly-bys and left-to-right passes.',
    params: [
      { k: 'length', n: 'Length', min: 0.15, max: 6, d: 1.2, u: 's', tip: 'Short = fast swing, long = slow fly-by' },
      { k: 'peak', n: 'Closest', min: 5, max: 95, d: 55, u: '%', tip: 'When the object is closest to you (loudest point)' },
      { k: 'pitch', n: 'Pitch', min: 150, max: 8000, log: true, d: 1200, u: 'Hz', tip: 'Low = big and heavy objects · high = thin blades, arrows' },
      { k: 'sweep', n: 'Sweep', min: 0, max: 100, d: 60, u: '%', tip: 'How much the pitch opens up when it is close' },
      { k: 'pan', n: 'Left → right', min: -100, max: 100, d: 80, tip: 'Movement across the stereo field. Negative = right to left' },
      { k: 'tone', n: 'Whistle', min: 0, max: 100, d: 0, u: '%', tip: 'Adds a tonal whistle — spaceships and magic' },
      { k: 'doppler', n: 'Doppler', min: 0, max: 100, d: 30, u: '%', tip: 'Pitch drops as it passes — like a race car' },
    ],
    gen(p, rnd) {
      const len = Math.round(p.length * SR), b = newBuf(len), pk = p.peak / 100, P = p.pan / 100;
      const f1 = new SVF(), f2 = new SVF();
      let tph = 0;
      const sp = 5 / Math.max(pk, 1 - pk);
      for (let i = 0; i < len; i++) {
        const u = i / len;
        const e = u < pk ? Math.pow(u / pk, 2.2) : Math.pow((1 - u) / (1 - pk), 1.6);
        const dop = Math.pow(2, (p.doppler / 100) * 0.7 * Math.tanh((pk - u) * 8));
        const fc = p.pitch * Math.pow(2, (p.sweep / 100) * 2 * (e - 0.5)) * dop;
        const n = rnd() * 2 - 1;
        f1.run(n, fc, 1.1); f2.run(f1.bp, fc, 1.1);
        let y = f2.bp * 2.2 * (1 - p.tone / 100 * 0.5);
        tph += fc / SR;
        y += Math.sin(TAU * tph) * (p.tone / 100) * 0.45;
        y *= e;
        const [gl, gr] = panGains(P * Math.tanh((u - pk) * sp));
        b.L[i] = y * gl * 1.2; b.R[i] = y * gr * 1.2;
      }
      return b;
    },
  },

  zap: {
    name: 'Zap',
    desc: 'Lasers, blasters and teleports — FM synthesis with a pitch sweep.',
    params: [
      { k: 'length', n: 'Length', min: 0.05, max: 3, d: 0.35, u: 's', tip: 'Duration of one shot' },
      { k: 'start', n: 'Start pitch', min: 100, max: 6000, log: true, d: 2400, u: 'Hz', tip: 'Pitch at the beginning of the shot' },
      { k: 'end', n: 'End pitch', min: 40, max: 6000, log: true, d: 300, u: 'Hz', tip: 'Pitch at the end — far below start = classic "pew"' },
      { k: 'ratio', n: 'Metal', min: 0.5, max: 8, d: 2, u: 'x', tip: 'Character of the tone — whole numbers sound clean, odd values metallic' },
      { k: 'depth', n: 'Grit', min: 0, max: 100, d: 40, u: '%', tip: 'Pure beep → rich, aggressive energy' },
      { k: 'repeat', n: 'Shots', min: 0, max: 10, d: 0, int: true, tip: 'Number of extra shots in a row (pew-pew-pew)' },
      { k: 'noise', n: 'Crackle', min: 0, max: 100, d: 0, u: '%', tip: 'Electric crackling on top' },
    ],
    gen(p, rnd) {
      const len = Math.round(p.length * (p.repeat + 1) * SR), seg = Math.round(p.length * SR), b = newBuf(len);
      const f = new SVF();
      let cph = 0, mph = 0;
      for (let i = 0; i < len; i++) {
        const si = i % seg; if (si === 0) { cph = 0; mph = 0; }
        const u = si / seg, fr = p.start * Math.pow(p.end / p.start, u);
        cph += fr / SR; mph += fr * p.ratio / SR;
        const I = p.depth / 100 * 6 * (1 - u * 0.6);
        let y = Math.sin(TAU * cph + I * Math.sin(TAU * mph));
        f.run(rnd() * 2 - 1, fr, 2);
        y += f.bp * (p.noise / 100) * 2;
        let env = Math.pow(1 - u, 1.4);
        const t = si / SR; if (t < 0.002) env *= t / 0.002;
        b.L[i] = b.R[i] = y * env * 0.7;
      }
      return b;
    },
  },

  magic: {
    name: 'Sparkle',
    desc: 'Glittering bell tones — fairy dust, spells and treasure.',
    params: [
      { k: 'length', n: 'Length', min: 0.4, max: 8, d: 2.5, u: 's', tip: 'How long notes keep appearing' },
      { k: 'density', n: 'Density', min: 1, max: 40, d: 14, u: '/s', tip: 'Notes per second — few = gentle, many = a shower of glitter' },
      { k: 'root', n: 'Pitch', min: 48, max: 96, d: 79, u: 'note', tip: 'Center pitch — high = tiny fairies, low = big bells' },
      { k: 'spread', n: 'Range', min: 0, max: 36, d: 24, u: 'st', tip: 'How far the notes spread around the center pitch' },
      { k: 'scale', n: 'Mood', opts: ['Pentatonic', 'Major', 'Minor', 'Lydian', 'Whole-tone', 'Chromatic'], d: 0, tip: 'Pentatonic/Major = happy · Minor = sad · Lydian = dreamy · Whole-tone = mysterious' },
      { k: 'shimmer', n: 'Shimmer', min: 0, max: 100, d: 50, u: '%', tip: 'Adds bright overtones and a gentle chorus' },
      { k: 'rise', n: 'Direction', min: -100, max: 100, d: 40, tip: 'Positive = notes climb upwards, negative = they fall' },
      { k: 'decay', n: 'Ring', min: 0.1, max: 3, d: 0.8, u: 's', tip: 'How long each bell rings out' },
    ],
    gen(p, rnd) {
      const SCALES = [[0, 2, 4, 7, 9], [0, 2, 4, 5, 7, 9, 11], [0, 2, 3, 5, 7, 8, 10], [0, 2, 4, 6, 7, 9, 11], [0, 2, 4, 6, 8, 10], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]];
      const sc = SCALES[p.scale] || SCALES[0];
      const ring = Math.min(p.decay * 3.5, 5);
      const len = Math.round((p.length + ring) * SR), b = newBuf(len);
      const PART = [1, 2.756, 5.404, 8.933], AMP = [1, 0.45, 0.22 + p.shimmer / 400, 0.1 + p.shimmer / 500], DEC = [1, 0.6, 0.35, 0.22];
      let t = rnd() * 0.02;
      while (t < p.length) {
        const u = t / p.length;
        const center = p.root + (p.rise / 100) * p.spread * (u - 0.5);
        const raw = center + (rnd() - 0.5) * p.spread;
        const oct = Math.floor(raw / 12), pc = raw - oct * 12;
        let best = sc[0], bd = 99;
        for (const s of sc.concat([12])) { const d = Math.abs(s - pc); if (d < bd) { bd = d; best = s; } }
        const f0 = mtof(oct * 12 + best);
        const amp = 0.18 * (0.55 + rnd() * 0.45), [gl, gr] = panGains((rnd() * 2 - 1) * 0.8);
        const start = Math.round(t * SR);
        for (let pi = 0; pi < 4; pi++) {
          const f = f0 * PART[pi]; if (f > SR * 0.45) continue;
          const dcy = p.decay * DEC[pi], n = Math.min(len - start, Math.round(dcy * 6.9 * SR));
          // recursive sine oscillator (cheap)
          const w = TAU * f / SR, c2 = 2 * Math.cos(w); let s1 = 0, s2 = -Math.sin(w);
          const det = 1 + p.shimmer / 100 * 0.004, w2 = TAU * f * det / SR, c22 = 2 * Math.cos(w2); let r1 = 0, r2 = -Math.sin(w2);
          const k = Math.exp(-1 / (dcy * SR)), a = amp * AMP[pi], sh = p.shimmer / 100 * 0.5;
          let e = a;
          for (let i = 0; i < n; i++) {
            const s0 = c2 * s1 - s2; s2 = s1; s1 = s0;
            const r0 = c22 * r1 - r2; r2 = r1; r1 = r0;
            const att = i < 96 ? i / 96 : 1;
            const y = (s0 + r0 * sh) * e * att;
            b.L[start + i] += y * gl; b.R[start + i] += y * gr;
            e *= k;
          }
        }
        t += -Math.log(1 - rnd() * 0.98) / p.density;
      }
      return b;
    },
  },

  pad: {
    name: 'Goosebumps',
    desc: 'Swelling choirs, strings and glass — sounds that get under your skin.',
    params: [
      { k: 'length', n: 'Length', min: 1, max: 16, d: 6, u: 's', tip: 'Total length including the fade out' },
      { k: 'root', n: 'Pitch', min: 36, max: 72, d: 50, u: 'note', tip: 'Lowest note of the chord' },
      { k: 'chord', n: 'Chord', opts: ['Octaves', 'Power', 'Major', 'Minor', 'Sus', 'Dark cluster', 'Major 9'], d: 2, tip: 'Major = hopeful · Minor = sad · Sus = open, floating · Cluster = unsettling' },
      { k: 'voice', n: 'Voice', opts: ['Choir Aah', 'Choir Ooh', 'Strings', 'Glass'], d: 0, tip: 'The kind of instrument singing the chord' },
      { k: 'swell', n: 'Swell', min: 0, max: 100, d: 45, u: '%', tip: 'How slowly it fades in — slow swells give the goosebumps' },
      { k: 'shimmer', n: 'Shimmer', min: 0, max: 100, d: 40, u: '%', tip: 'Heavenly high octaves that bloom over time' },
      { k: 'breath', n: 'Breath', min: 0, max: 100, d: 25, u: '%', tip: 'Airy breath noise — makes voices feel human' },
      { k: 'width', n: 'Width', min: 0, max: 100, d: 80, u: '%', tip: 'Stereo width and voice detuning — wider = bigger ensemble' },
    ],
    gen(p, rnd) {
      const CH = [[0, 12, 24], [0, 7, 12, 19], [0, 7, 12, 16, 19], [0, 7, 12, 15, 19], [0, 7, 12, 17, 19], [0, 1, 6, 12, 13], [0, 7, 14, 16, 23]];
      const notes = CH[p.chord] || CH[2];
      const len = Math.round(p.length * SR), b = newBuf(len), w = p.width / 100;
      const glass = p.voice === 3;
      const voices = [];
      notes.forEach((iv, ni) => {
        const f = mtof(p.root + iv);
        for (let v = 0; v < 3; v++) {
          voices.push({ f: f * Math.pow(2, ((v - 1) * 8 * (0.3 + w)) / 1200), ph: rnd(), vph: rnd(), vr: 4.5 + rnd() * 1.5,
            pan: ((ni / Math.max(1, notes.length - 1)) * 2 - 1) * 0.6 * w + (v - 1) * 0.3 * w, amp: 1 / Math.sqrt(notes.length * 3) });
        }
      });
      const mixL = new Float32Array(len), mixR = new Float32Array(len);
      for (const vo of voices) {
        const [pl, pr] = panGains(vo.pan), gl = pl * vo.amp, gr = pr * vo.amp, f0 = vo.f, vinc = TAU * vo.vr / SR;
        let ph = vo.ph, vph = vo.vph * TAU, dt = f0 / SR;
        for (let i = 0; i < len; i++) {
          if ((i & 15) === 0) { dt = f0 * (1 + 0.003 * Math.sin(vph)) / SR; vph += vinc * 16; }
          ph += dt; if (ph >= 1) ph -= 1;
          const y = glass ? Math.sin(TAU * ph) + 0.3 * Math.sin(TAU * 3 * ph) : 2 * ph - 1 - polyblep(ph, dt);
          mixL[i] += y * gl; mixR[i] += y * gr;
        }
      }
      // voice colour: formants for choirs, low-pass for strings
      const FORM = p.voice === 1 ? [[330, 6, 1], [700, 7, 0.5], [2400, 9, 0.18]] : [[750, 6, 1], [1150, 7, 0.6], [2900, 9, 0.22]];
      const breath = p.breath / 100;
      for (const [ch, out] of [[mixL, b.L], [mixR, b.R]]) {
        if (p.voice <= 1) {
          const fs = FORM.map(([f, q, g]) => ({ bq: new Biquad('bp', f, q), g }));
          const lp = new Biquad('lp', 3500, 0.7);
          for (let i = 0; i < len; i++) {
            const x = ch[i] + (rnd() * 2 - 1) * breath * 0.5;
            let y = 0; for (const fo of fs) y += fo.bq.p(x) * fo.g;
            out[i] = lp.p(y * 3 + ch[i] * 0.08);
          }
        } else {
          const lp = new Biquad('lp', glass ? 6000 : 2600, 0.8), bp = new Biquad('bp', 1500, 1);
          for (let i = 0; i < len; i++) out[i] = lp.p(ch[i]) * (glass ? 0.8 : 0.9) + bp.p((rnd() * 2 - 1)) * breath * 0.15;
        }
      }
      // shimmer: high octaves blooming in
      if (p.shimmer > 0) {
        notes.slice(-3).forEach((iv, k) => {
          const f = mtof(p.root + iv + 24); if (f > 9000) return;
          const [gl, gr] = panGains((k - 1) * 0.7 * w);
          let ph = rnd(), tp = rnd();
          for (let i = 0; i < len; i++) {
            const u = i / len; ph += f / SR; tp += 0.25 / SR;
            const y = Math.sin(TAU * ph) * (p.shimmer / 100) * 0.07 * Math.min(1, u * 2.5) * (0.6 + 0.4 * Math.sin(TAU * tp));
            b.L[i] += y * gl; b.R[i] += y * gr;
          }
        });
      }
      const att = Math.max(0.05, p.swell / 100 * p.length * 0.7), rel = Math.max(0.2, p.length * 0.25);
      for (let i = 0; i < len; i++) {
        const t = i / SR, te = (len - i) / SR;
        let e = 1;
        if (t < att) e *= Math.pow(Math.sin(Math.PI / 2 * t / att), 2);
        if (te < rel) e *= Math.pow(Math.sin(Math.PI / 2 * te / rel), 2);
        b.L[i] *= e; b.R[i] *= e;
      }
      return b;
    },
  },

  drone: {
    name: 'Drone',
    desc: 'Dark, living textures — horror drones, alien hums and metal scrapes.',
    params: [
      { k: 'length', n: 'Length', min: 1, max: 16, d: 6, u: 's', tip: 'Total duration' },
      { k: 'pitch', n: 'Pitch', min: 20, max: 300, log: true, d: 55, u: 'Hz', tip: 'Base pitch — very low is felt more than heard' },
      { k: 'beat', n: 'Beating', min: 0, max: 10, d: 1.5, u: 'Hz', tip: 'Slow pulsing between two detuned tones — unease' },
      { k: 'grit', n: 'Grit', min: 0, max: 100, d: 30, u: '%', tip: 'Saturation — clean hum → menacing growl' },
      { k: 'motion', n: 'Motion', min: 0, max: 100, d: 50, u: '%', tip: 'Slowly breathing filter — makes it feel alive' },
      { k: 'metal', n: 'Metal', min: 0, max: 100, d: 0, u: '%', tip: 'Screeching metallic scrapes on top' },
      { k: 'rise', n: 'Drift', min: -24, max: 24, d: 0, u: 'st', tip: 'Pitch slowly drifts up (rising tension) or down (sinking dread)' },
    ],
    gen(p, rnd) {
      const len = Math.round(p.length * SR), b = newBuf(len);
      const fL = new SVF(), fR = new SVF(), drive = 1 + p.grit / 100 * 6, dn = Math.tanh(drive);
      const mf = [1320, 2150, 3460, 5120].map((f) => f * (0.9 + rnd() * 0.2));
      const mB = [mf.map((f) => new Biquad('bp', f, 40)), mf.map((f) => new Biquad('bp', f * 1.01, 40))];
      let a = 0, c = 0, d = 0, s = 0, lfo = rnd(), lfo2 = rnd(), scrape = 0, sTarget = 0;
      for (let i = 0; i < len; i++) {
        const u = i / len, t = i / SR;
        const f = p.pitch * Math.pow(2, p.rise * u / 12);
        a += f / SR; c += (f + p.beat) / SR; d += (f * 1.5 - p.beat * 0.5) / SR; s += f / 2 / SR;
        a -= Math.floor(a); c -= Math.floor(c); d -= Math.floor(d); s -= Math.floor(s);
        lfo += 0.13 / SR; lfo2 += 0.071 / SR;
        const cut = f * 3 + 60 + (p.motion / 100) * 1800 * (0.5 + 0.5 * Math.sin(TAU * lfo)) * (0.6 + 0.4 * Math.sin(TAU * lfo2));
        const sawA = 2 * a - 1 - polyblep(a, f / SR), sawC = 2 * c - 1 - polyblep(c, (f + p.beat) / SR), sawD = 2 * d - 1;
        const sub = Math.sin(TAU * s) * 0.6;
        let yL = fL.run(sawA * 0.6 + sawD * 0.2, cut, 1.4) + sub, yR = fR.run(sawC * 0.6 + sawD * 0.2, cut * 1.03, 1.4) + sub;
        yL = Math.tanh(yL * drive) / dn; yR = Math.tanh(yR * drive) / dn;
        if (p.metal > 0) {
          if ((i & 511) === 0) sTarget = Math.pow(rnd(), 3);
          scrape += (sTarget - scrape) * 0.0004;
          const n = rnd() * 2 - 1;
          let mL = 0, mR = 0; for (let k = 0; k < 4; k++) { mL += mB[0][k].p(n); mR += mB[1][k].p(n); }
          const g = (p.metal / 100) * scrape * 6;
          yL += mL * g; yR += mR * g;
        }
        let e = Math.min(1, t / 0.8, (len - i) / SR / 1.2);
        b.L[i] = yL * e * 0.55; b.R[i] = yR * e * 0.55;
      }
      return b;
    },
  },
};

function generate(engineId, params, seed) {
  const eng = ENGINES[engineId];
  const p = Object.assign(defaultsOf(eng.params), params);
  const b = eng.gen(p, mulberry32(seed >>> 0));
  for (const ch of [b.L, b.R]) for (let i = 0; i < ch.length; i++) if (!isFinite(ch[i])) ch[i] = 0;
  return fadeEdges(normalizeBuf(b, 0.85), 0.001, 0.01);
}

/* =====================================================================
   Themes & presets
   ===================================================================== */
const THEMES = [
  { id: 'standard', name: 'Standard', presets: [
    ['Big explosion', 'impact', { length: 5, body: 85, thump: 45, bright: 7000, crunch: 55, tail: 80, debris: 55, width: 85 }],
    ['Punchy hit', 'impact', { length: 0.6, body: 90, thump: 70, bright: 3500, crunch: 30, tail: 10, debris: 0, width: 40 }],
    ['Cinematic boom', 'impact', { length: 6, body: 100, thump: 32, bright: 900, crunch: 20, tail: 90, debris: 5, width: 90 }],
    ['Whoosh left → right', 'whoosh', { length: 1.2, peak: 50, pitch: 1100, sweep: 60, pan: 90, tone: 0, doppler: 25 }],
    ['Riser', 'power', { start: 80, end: 1400, length: 5, curve: 60, harmonics: 45, wobble: 25, hum: 15, clunk: 0 }],
    ['Power down', 'power', { start: 900, end: 30, length: 2.5, curve: -40, harmonics: 55, wobble: 20, hum: 10, clunk: 35 }],
    ['Goosebumps choir', 'pad', { length: 8, root: 50, chord: 2, voice: 0, swell: 60, shimmer: 60, breath: 25, width: 85 }],
    ['Sparkle', 'magic', { length: 2, density: 16, root: 84, spread: 24, scale: 0, shimmer: 60, rise: 50, decay: 0.7 }],
  ] },
  { id: 'scifi', name: 'Sci-Fi', presets: [
    ['Laser shot', 'zap', { length: 0.3, start: 3200, end: 220, ratio: 1.5, depth: 45, repeat: 0, noise: 0 }],
    ['Blaster pew-pew', 'zap', { length: 0.22, start: 1800, end: 300, ratio: 2.5, depth: 60, repeat: 2, noise: 10 }],
    ['Shield up', 'power', { start: 120, end: 900, length: 1.6, curve: 40, harmonics: 30, wobble: 70, hum: 40, clunk: 0 }],
    ['Generator shutdown', 'power', { start: 420, end: 22, length: 6, curve: -55, harmonics: 75, wobble: 60, hum: 55, clunk: 60 }],
    ['Generator start-up', 'power', { start: 25, end: 380, length: 5, curve: 50, harmonics: 70, wobble: 60, hum: 50, clunk: 45 }],
    ['Teleport', 'zap', { length: 1.8, start: 200, end: 4000, ratio: 3.5, depth: 85, repeat: 0, noise: 40 }],
    ['Spaceship fly-by', 'whoosh', { length: 3, peak: 55, pitch: 500, sweep: 50, pan: 100, tone: 55, doppler: 80 }],
    ['Alien drone', 'drone', { length: 8, pitch: 65, beat: 3, grit: 40, motion: 70, metal: 20, rise: 0 }],
  ] },
  { id: 'fantasy', name: 'Fantasy', presets: [
    ['Fairy glisten', 'magic', { length: 3, density: 22, root: 86, spread: 24, scale: 3, shimmer: 80, rise: 40, decay: 1.2 }],
    ['Spell cast', 'magic', { length: 1.8, density: 30, root: 72, spread: 30, scale: 4, shimmer: 60, rise: 90, decay: 0.5 }],
    ['Healing light', 'magic', { length: 4, density: 7, root: 76, spread: 14, scale: 1, shimmer: 70, rise: 20, decay: 2.2 }],
    ['Angel choir', 'pad', { length: 9, root: 55, chord: 6, voice: 0, swell: 55, shimmer: 80, breath: 20, width: 90 }],
    ['Magic portal', 'power', { start: 60, end: 600, length: 4, curve: 20, harmonics: 20, wobble: 85, hum: 30, clunk: 0 }],
    ['Wind spirit', 'whoosh', { length: 3.5, peak: 45, pitch: 700, sweep: 80, pan: 60, tone: 35, doppler: 10 }],
    ['Enchanted harp', 'magic', { length: 2.5, density: 12, root: 67, spread: 24, scale: 1, shimmer: 20, rise: 100, decay: 1.6 }],
    ['Crystal choir', 'pad', { length: 7, root: 62, chord: 4, voice: 3, swell: 40, shimmer: 70, breath: 5, width: 80 }],
  ] },
  { id: 'rpg', name: 'RPG', presets: [
    ['Coin', 'retro', { wave: 0, freq: 988, slide: 0, length: 0.35, decay: 70, duty: 50, vibrato: 0, arp: 5, repeat: 0 }],
    ['Level up', 'retro', { wave: 0, freq: 523, slide: 12, length: 0.9, decay: 30, duty: 25, vibrato: 0, arp: 7, repeat: 3 }],
    ['Sword swing', 'whoosh', { length: 0.35, peak: 45, pitch: 2600, sweep: 70, pan: 40, tone: 0, doppler: 20 }],
    ['Sword hit', 'impact', { length: 0.9, body: 30, thump: 120, bright: 14000, crunch: 60, tail: 5, debris: 40, width: 50 }],
    ['Fireball blast', 'impact', { length: 2.5, body: 60, thump: 60, bright: 2500, crunch: 70, tail: 40, debris: 80, width: 80 }],
    ['Potion / heal', 'magic', { length: 1.5, density: 18, root: 79, spread: 12, scale: 0, shimmer: 40, rise: 100, decay: 0.6 }],
    ['Treasure found', 'magic', { length: 2.2, density: 24, root: 72, spread: 30, scale: 1, shimmer: 50, rise: 100, decay: 1 }],
    ['Quest complete', 'pad', { length: 4, root: 60, chord: 2, voice: 2, swell: 15, shimmer: 40, breath: 0, width: 70 }],
  ] },
  { id: 'horror', name: 'Horror', presets: [
    ['Dark drone', 'drone', { length: 10, pitch: 45, beat: 1.2, grit: 30, motion: 40, metal: 0, rise: 0 }],
    ['Metallic scrape', 'drone', { length: 5, pitch: 110, beat: 6, grit: 50, motion: 70, metal: 90, rise: 0 }],
    ['Creaking metal', 'drone', { length: 4, pitch: 180, beat: 9, grit: 20, motion: 90, metal: 70, rise: -12 }],
    ['Sub drop', 'power', { start: 140, end: 24, length: 3, curve: -30, harmonics: 10, wobble: 0, hum: 0, clunk: 20 }],
    ['Ghost whoosh', 'whoosh', { length: 3, peak: 60, pitch: 450, sweep: 70, pan: -70, tone: 45, doppler: 50 }],
    ['Tension riser', 'power', { start: 40, end: 700, length: 9, curve: 70, harmonics: 60, wobble: 45, hum: 40, clunk: 0 }],
    ['Jump scare', 'impact', { length: 3, body: 90, thump: 40, bright: 12000, crunch: 80, tail: 50, debris: 20, width: 90 }],
    ['Eerie choir', 'pad', { length: 10, root: 46, chord: 5, voice: 1, swell: 70, shimmer: 30, breath: 45, width: 90 }],
  ] },
  { id: 'retro', name: 'Retro (8-Bit)', presets: [
    ['Coin', 'retro', { wave: 0, freq: 988, slide: 0, length: 0.35, decay: 70, duty: 50, arp: 5 }],
    ['Jump', 'retro', { wave: 0, freq: 300, slide: 14, length: 0.3, decay: 50, duty: 25 }],
    ['Laser', 'retro', { wave: 1, freq: 1400, slide: -30, length: 0.25, decay: 40 }],
    ['Explosion', 'retro', { wave: 3, freq: 600, slide: -24, length: 0.9, decay: 60 }],
    ['Power-up', 'retro', { wave: 2, freq: 330, slide: 24, length: 0.7, decay: 20, vibrato: 30, repeat: 2 }],
    ['Hit / hurt', 'retro', { wave: 3, freq: 1200, slide: -12, length: 0.2, decay: 70 }],
    ['Blip / select', 'retro', { wave: 0, freq: 880, length: 0.08, decay: 20 }],
    ['Game over', 'retro', { wave: 2, freq: 440, slide: -24, length: 1.6, decay: 10, vibrato: 50, repeat: 3 }],
  ] },
].map((t) => ({ ...t, presets: t.presets.map(([name, engine, params]) => ({ name, engine, params })) }));

/* =====================================================================
   Effects (Magic Transform chain). Each effect takes a buffer and
   returns a new (or modified) buffer, possibly asynchronously.
   ===================================================================== */
function resampleCh(a, ratio, outLen) {
  const n = outLen ?? Math.max(1, Math.floor(a.length / ratio)), o = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * ratio, i0 = x | 0, fr = x - i0;
    o[i] = (a[i0] || 0) * (1 - fr) + (a[i0 + 1] || 0) * fr;
  }
  return o;
}
function hannWin(N) { const w = new Float32Array(N); for (let i = 0; i < N; i++) w[i] = 0.5 - 0.5 * Math.cos(TAU * i / N); return w; }
// WSOLA time-stretch: changes length by `factor` without changing pitch.
function wsola(x, factor, N) {
  N = Math.max(256, N & ~3);
  const len = x.length, outLen = Math.max(1, Math.round(len * factor));
  const out = new Float32Array(outLen + N), norm = new Float32Array(outLen + N), win = hannWin(N);
  const Hs = N >> 2, tol = Math.min(Hs, 600);
  let prev = 0;
  for (let o = 0, k = 0; o < outLen; o += Hs, k++) {
    const ideal = Math.round(o / factor);
    let best = clamp(ideal, 0, Math.max(0, len - 1));
    if (k > 0) {
      const target = prev + Hs; let bc = -Infinity;
      for (let d = -tol; d <= tol; d += 8) {
        const s = ideal + d; if (s < 0 || s >= len) continue;
        let c = 0;
        for (let j = 0; j < N; j += 16) { const a = s + j < len ? x[s + j] : 0, b = target + j < len ? x[target + j] : 0; c += a * b; }
        if (c > bc) { bc = c; best = s; }
      }
    }
    for (let j = 0; j < N; j++) { const idx = best + j; const v = idx < len ? x[idx] : 0; out[o + j] += v * win[j]; norm[o + j] += win[j]; }
    prev = best;
  }
  const res = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) res[i] = norm[i] > 0.05 ? out[i] / norm[i] : 0;
  return res;
}
function mapCh(b, fn) { return { L: fn(b.L, 0), R: fn(b.R, 1) }; }
function extend(b, extraSec) { const n = bufLen(b), o = newBuf(n + Math.round(extraSec * SR)); o.L.set(b.L); o.R.set(b.R); return o; }
function trimTailSilence(b, thr = 0.0005) {
  let e = bufLen(b);
  while (e > 1 && Math.abs(b.L[e - 1]) < thr && Math.abs(b.R[e - 1]) < thr) e--;
  return e < bufLen(b) ? { L: b.L.slice(0, e), R: b.R.slice(0, e) } : b;
}

async function convolveReverb(b, p) {
  const decay = 0.3 + Math.pow(p.size / 100, 1.6) * 7.7;
  const irLen = Math.round(decay * SR), pre = Math.round((0.005 + p.size / 100 * 0.04) * SR);
  const rnd = mulberry32(12345);
  const ir = [new Float32Array(irLen + pre), new Float32Array(irLen + pre)];
  const coef = 0.05 + (p.tone / 100) * 0.9;
  for (let c = 0; c < 2; c++) {
    let lp = 0, e2 = 0;
    for (let i = 0; i < irLen; i++) {
      lp += coef * ((rnd() * 2 - 1) - lp);
      const v = lp * Math.exp(-6.9 * i / irLen) * Math.min(1, i / (0.004 * SR));
      ir[c][pre + i] = v; e2 += v * v;
    }
    const g = 1 / Math.sqrt(e2 || 1);
    for (let i = 0; i < ir[c].length; i++) ir[c][i] *= g;
  }
  const n = bufLen(b), total = n + ir[0].length;
  const ctx = new OfflineAudioContext(2, total, SR);
  const src = ctx.createBufferSource(), ab = ctx.createBuffer(2, total, SR);
  ab.copyToChannel(b.L, 0); ab.copyToChannel(b.R, 1); src.buffer = ab;
  const conv = ctx.createConvolver(); conv.normalize = false;
  const irb = ctx.createBuffer(2, ir[0].length, SR); irb.copyToChannel(ir[0], 0); irb.copyToChannel(ir[1], 1); conv.buffer = irb;
  const wet = ctx.createGain(); wet.gain.value = p.mix / 100 * 0.9;
  const dry = ctx.createGain(); dry.gain.value = 1 - (p.mix / 100) * 0.5;
  src.connect(dry).connect(ctx.destination); src.connect(conv).connect(wet).connect(ctx.destination);
  src.start();
  const r = await ctx.startRendering();
  return trimTailSilence({ L: r.getChannelData(0).slice(), R: r.getChannelData(1).slice() });
}

function subOctave(ch, amount) {
  const lp = new Biquad('lp', 160, 0.7), lp2 = new Biquad('lp', 110, 0.7), out = new Float32Array(ch.length);
  let state = 1, prev = 0, env = 0;
  for (let i = 0; i < ch.length; i++) {
    const x = lp.p(ch[i]);
    if (prev <= 0 && x > 0) state = -state;
    prev = x; env += (Math.abs(x) - env) * 0.002;
    out[i] = ch[i] + lp2.p(state * env) * amount * 1.3;
  }
  return out;
}

const EFFECTS = {
  tape: { name: 'Tape speed', tip: 'Pitch and speed together, like a record played slower or faster',
    params: [{ k: 'semis', n: 'Speed', min: -24, max: 24, d: -7, u: 'st', tip: 'Down = slower, deeper, bigger (monsters, giants) · up = faster, smaller (chipmunks)' }],
    sum: (p) => fmtVal(EFFECTS.tape.params[0], p.semis) + ' semitones',
    fn: (b, p) => { const r = Math.pow(2, p.semis / 12); return mapCh(b, (c) => resampleCh(c, r)); } },
  pitch: { name: 'Pitch', tip: 'Changes pitch but keeps the length',
    params: [{ k: 'semis', n: 'Pitch', min: -24, max: 24, d: 7, u: 'st', tip: 'Higher or lower without changing the timing' },
      { k: 'grain', n: 'Smoothness', min: 20, max: 120, d: 45, u: 'ms', tip: 'Short = crisp for clicks and knocks · long = smooth for tones and voices' }],
    sum: (p) => fmtVal({ u: 'st' }, p.semis) + ' st',
    fn: (b, p) => { const r = Math.pow(2, p.semis / 12), N = Math.round(p.grain * SR / 1000), n = bufLen(b);
      return mapCh(b, (c) => resampleCh(wsola(c, r, N), r, n)); } },
  stretch: { name: 'Stretch', tip: 'Makes it longer or shorter but keeps the pitch',
    params: [{ k: 'speed', n: 'Speed', min: 25, max: 400, log: true, d: 50, u: '%', tip: 'Below 100% = slow motion · above = fast forward' },
      { k: 'grain', n: 'Smoothness', min: 20, max: 120, d: 45, u: 'ms', tip: 'Short = crisp for clicks · long = smooth for tones' }],
    sum: (p) => p.speed + '%',
    fn: (b, p) => { const N = Math.round(p.grain * SR / 1000); return mapCh(b, (c) => wsola(c, 100 / p.speed, N)); } },
  reverse: { name: 'Reverse', tip: 'Plays the sound backwards — eerie, magical, sucked-in', params: [], sum: () => 'backwards',
    fn: (b) => mapCh(b, (c) => c.slice().reverse()) },
  distort: { name: 'Distortion', tip: 'Overdrives the sound — aggressive, dirty, powerful',
    params: [{ k: 'drive', n: 'Drive', min: 0, max: 100, d: 40, u: '%', tip: 'A little = warm and fat · a lot = raw and broken' },
      { k: 'tone', n: 'Tone', min: 500, max: 16000, log: true, d: 6000, u: 'Hz', tip: 'Lower = darker and smoother after distorting' },
      { k: 'mix', n: 'Mix', min: 0, max: 100, d: 100, u: '%', tip: 'Blend between original and distorted' }],
    sum: (p) => 'drive ' + p.drive + '%',
    fn: (b, p) => { const k = 1 + p.drive / 100 * 30, n = Math.tanh(k), m = p.mix / 100;
      return mapCh(b, (c) => { const f = new Biquad('lp', p.tone, 0.7), o = new Float32Array(c.length);
        for (let i = 0; i < c.length; i++) o[i] = c[i] * (1 - m) + f.p(Math.tanh(c[i] * k) / n) * m; return o; }); } },
  crush: { name: 'Bitcrusher', tip: 'Lo-fi digital crunch — retro consoles, broken robots',
    params: [{ k: 'bits', n: 'Bits', min: 2, max: 16, d: 8, int: true, tip: 'Fewer bits = harsher, noisier' },
      { k: 'rate', n: 'Sample rate', min: 500, max: 48000, log: true, d: 11000, u: 'Hz', tip: 'Lower = grainier and more metallic' }],
    sum: (p) => p.bits + ' bit · ' + fmtVal({ u: 'Hz' }, p.rate) + 'Hz',
    fn: (b, p) => { const q = Math.pow(2, p.bits - 1), step = SR / p.rate;
      return mapCh(b, (c) => { const o = new Float32Array(c.length); let acc = step, hold = 0;
        for (let i = 0; i < c.length; i++) { acc += 1; if (acc >= step) { acc -= step; hold = Math.round(c[i] * q) / q; } o[i] = hold; } return o; }); } },
  filter: { name: 'Filter', tip: 'Removes highs or lows — muffled, thin, radio, underwater',
    params: [{ k: 'mode', n: 'Type', opts: ['Low-pass', 'High-pass', 'Band-pass'], d: 0, tip: 'Low-pass = muffled · High-pass = thin · Band-pass = telephone' },
      { k: 'cutoff', n: 'Frequency', min: 30, max: 18000, log: true, d: 1200, u: 'Hz', tip: 'Where the filter cuts' },
      { k: 'reso', n: 'Resonance', min: 0, max: 100, d: 20, u: '%', tip: 'Emphasis at the cut point — whistling, synthy' }],
    sum: (p) => ['Low-pass', 'High-pass', 'Band-pass'][p.mode] + ' ' + fmtVal({ u: 'Hz' }, p.cutoff) + 'Hz',
    fn: (b, p) => { const t = ['lp', 'hp', 'bp'][p.mode], q = 0.5 + Math.pow(p.reso / 100, 2) * 14;
      return mapCh(b, (c) => { const f = new Biquad(t, p.cutoff, q), o = new Float32Array(c.length);
        for (let i = 0; i < c.length; i++) o[i] = f.p(c[i]); return o; }); } },
  bass: { name: 'Bass', tip: 'More weight and power in the low end',
    params: [{ k: 'boost', n: 'Boost', min: 0, max: 18, d: 8, u: 'dB', tip: 'Lifts the lows — fuller, heavier' },
      { k: 'sub', n: 'Sub', min: 0, max: 100, d: 30, u: '%', tip: 'Adds a new tone one octave lower — the cinema rumble you feel' }],
    sum: (p) => '+' + p.boost + ' dB · sub ' + p.sub + '%',
    fn: (b, p) => mapCh(b, (c) => { const f = new Biquad('ls', 110, 0.7, p.boost), o = new Float32Array(c.length);
      for (let i = 0; i < c.length; i++) o[i] = f.p(c[i]); return p.sub > 0 ? subOctave(o, p.sub / 100) : o; }) },
  echo: { name: 'Echo', tip: 'Repeats of the sound — canyons, space, rhythm',
    params: [{ k: 'time', n: 'Time', min: 20, max: 1500, log: true, d: 320, u: 'ms', tip: 'Short = metallic doubling · long = canyon' },
      { k: 'fb', n: 'Repeats', min: 0, max: 92, d: 45, u: '%', tip: 'How many echoes until it fades out' },
      { k: 'mix', n: 'Mix', min: 0, max: 100, d: 40, u: '%', tip: 'Loudness of the echoes' },
      { k: 'mode', n: 'Mode', opts: ['Normal', 'Ping-pong'], d: 0, tip: 'Ping-pong bounces the echoes between left and right' }],
    sum: (p) => Math.round(p.time) + ' ms · ' + p.fb + '%' + (p.mode ? ' · ping-pong' : ''),
    fn: (b, p) => { const D = Math.max(1, Math.round(p.time * SR / 1000)), fb = p.fb / 100;
      const tail = Math.min(12, (p.time / 1000) * Math.ceil(Math.log(0.001) / Math.log(Math.max(fb, 0.05))));
      const n0 = bufLen(b), o = extend(b, tail), n = bufLen(o), wL = new Float32Array(n), wR = new Float32Array(n), m = p.mix / 100;
      for (let i = D; i < n; i++) {
        const iL = i - D < n0 ? b.L[i - D] : 0, iR = i - D < n0 ? b.R[i - D] : 0;
        if (p.mode) { wL[i] = (iL + iR) * 0.5 + fb * wR[i - D]; wR[i] = fb * wL[i - D]; }
        else { wL[i] = iL + fb * wL[i - D]; wR[i] = iR + fb * wR[i - D]; }
        o.L[i] += wL[i] * m; o.R[i] += wR[i] * m;
      }
      return trimTailSilence(o); } },
  reverb: { name: 'Reverb', tip: 'Places the sound in a room — from a small room to a cathedral',
    params: [{ k: 'size', n: 'Space', min: 0, max: 100, d: 50, u: '%', tip: 'Small room → hall → cathedral → endless canyon' },
      { k: 'tone', n: 'Brightness', min: 0, max: 100, d: 50, u: '%', tip: 'Dark = stone cellar, warm · bright = glassy, airy' },
      { k: 'mix', n: 'Mix', min: 0, max: 100, d: 35, u: '%', tip: 'How far away the sound feels' }],
    sum: (p) => 'space ' + p.size + '% · mix ' + p.mix + '%',
    fn: convolveReverb },
  pan: { name: 'Move L/R', tip: 'Moves the sound across the stereo field',
    params: [{ k: 'from', n: 'From', min: -100, max: 100, d: -100, tip: '-100 = fully left · 100 = fully right' },
      { k: 'to', n: 'To', min: -100, max: 100, d: 100, tip: 'Where the sound ends up' },
      { k: 'rate', n: 'Swing', min: 0, max: 8, d: 0, u: 'Hz', tip: '0 = one movement from start to end · above = swings back and forth' }],
    sum: (p) => p.from + ' → ' + p.to + (p.rate > 0 ? ' · swing ' + p.rate + ' Hz' : ''),
    fn: (b, p) => { const n = bufLen(b), o = newBuf(n), a = p.from / 100, z = p.to / 100;
      for (let i = 0; i < n; i++) {
        const u = p.rate > 0 ? 0.5 - 0.5 * Math.cos(TAU * p.rate * i / SR) : i / n;
        const [gl, gr] = panGains(a + (z - a) * u), m = (b.L[i] + b.R[i]) * 0.5;
        o.L[i] = m * gl * 1.41; o.R[i] = m * gr * 1.41;
      } return o; } },
  ring: { name: 'Ring modulator', tip: 'Metallic, robotic, alien voices',
    params: [{ k: 'freq', n: 'Frequency', min: 20, max: 4000, log: true, d: 440, u: 'Hz', tip: 'Low = robot, Dalek · high = bells, clanging metal' },
      { k: 'mix', n: 'Mix', min: 0, max: 100, d: 60, u: '%', tip: 'Blend with the original' }],
    sum: (p) => fmtVal({ u: 'Hz' }, p.freq) + ' Hz · ' + p.mix + '%',
    fn: (b, p) => { const m = p.mix / 100, w = TAU * p.freq / SR;
      return mapCh(b, (c) => { const o = new Float32Array(c.length); for (let i = 0; i < c.length; i++) o[i] = c[i] * (1 - m + m * Math.sin(w * i)); return o; }); } },
  flanger: { name: 'Flanger', tip: 'Sweeping jet-plane swoosh — sci-fi doors, warp',
    params: [{ k: 'rate', n: 'Speed', min: 0.05, max: 5, log: true, d: 0.3, u: 'Hz', tip: 'How fast it sweeps' },
      { k: 'depth', n: 'Depth', min: 0, max: 100, d: 70, u: '%', tip: 'How wide it sweeps' },
      { k: 'fb', n: 'Intensity', min: 0, max: 95, d: 60, u: '%', tip: 'More = stronger, more metallic' },
      { k: 'mix', n: 'Mix', min: 0, max: 100, d: 50, u: '%', tip: 'Blend with the original' }],
    sum: (p) => fmtVal({ u: 'Hz' }, p.rate) + ' Hz · ' + p.depth + '%',
    fn: (b, p) => mapCh(b, (c, ci) => { const n = c.length, o = new Float32Array(n), d = new Float32Array(n), fb = p.fb / 100, m = p.mix / 100;
      for (let i = 0; i < n; i++) {
        const dl = (0.001 + 0.006 * (p.depth / 100) * (0.5 + 0.5 * Math.sin(TAU * p.rate * i / SR + ci * 0.6))) * SR;
        const x = i - dl, i0 = Math.floor(x), fr = x - i0;
        const del = i0 >= 0 ? d[i0] * (1 - fr) + (i0 + 1 < i ? d[i0 + 1] : 0) * fr : 0;
        d[i] = c[i] + del * fb; o[i] = c[i] * (1 - m * 0.5) + del * m;
      } return o; }) },
  tremolo: { name: 'Tremolo', tip: 'Pulsing volume — helicopters, alarms, shivering',
    params: [{ k: 'rate', n: 'Speed', min: 0.5, max: 40, log: true, d: 6, u: 'Hz', tip: 'Slow = pulsing · fast = buzzing, rotor' },
      { k: 'depth', n: 'Depth', min: 0, max: 100, d: 70, u: '%', tip: 'How strongly the volume dips' }],
    sum: (p) => fmtVal({ u: 'Hz' }, p.rate) + ' Hz · ' + p.depth + '%',
    fn: (b, p) => mapCh(b, (c) => { const o = new Float32Array(c.length), dp = p.depth / 100;
      for (let i = 0; i < c.length; i++) o[i] = c[i] * (1 - dp * (0.5 + 0.5 * Math.sin(TAU * p.rate * i / SR))); return o; }) },
  boom: { name: 'Cinema boom', tip: 'Layers a deep sub boom under the sound — instant trailer impact',
    params: [{ k: 'pitch', n: 'Pitch', min: 25, max: 120, d: 42, u: 'Hz', tip: 'Lower = deeper, bigger' },
      { k: 'length', n: 'Length', min: 0.2, max: 4, d: 1.4, u: 's', tip: 'How long the boom rolls out' },
      { k: 'amount', n: 'Amount', min: 0, max: 100, d: 70, u: '%', tip: 'Loudness of the boom' },
      { k: 'at', n: 'Position', opts: ['Start', 'Loudest hit'], d: 1, tip: 'Loudest hit = lines up with the strongest moment, e.g. your knock' }],
    sum: (p) => fmtVal({ u: 'Hz' }, p.pitch) + ' Hz · ' + p.length + ' s',
    fn: (b, p) => { let at = 0;
      if (p.at === 1) { let pk = 0; for (let i = 0; i < bufLen(b); i++) { const v = Math.abs(b.L[i]) + Math.abs(b.R[i]); if (v > pk) { pk = v; at = i; } } at = Math.max(0, at - Math.round(0.004 * SR)); }
      const n = Math.round(p.length * SR), need = at + n;
      const o = need > bufLen(b) ? extend(b, (need - bufLen(b)) / SR) : { L: b.L.slice(), R: b.R.slice() };
      const ref = Math.max(0.3, peakOf(b)), a = p.amount / 100 * ref * 1.1;
      let ph = 0;
      for (let i = 0; i < n; i++) { const t = i / SR; ph += p.pitch * (1 + 1.8 * Math.exp(-t / 0.04)) / SR;
        const y = Math.sin(TAU * ph) * a * Math.exp(-t / (p.length * 0.3)) * Math.min(1, t / 0.003);
        o.L[at + i] += y; o.R[at + i] += y; }
      return o; } },
  gain: { name: 'Volume & fades', tip: 'Louder, quieter, soft beginning or end',
    params: [{ k: 'gain', n: 'Volume', min: -24, max: 24, d: 0, u: 'dB', tip: '+6 dB ≈ twice as loud · −6 dB ≈ half' },
      { k: 'fin', n: 'Fade in', min: 0, max: 5000, d: 0, u: 'ms', tip: 'Soft start' },
      { k: 'fout', n: 'Fade out', min: 0, max: 5000, d: 0, u: 'ms', tip: 'Soft ending' }],
    sum: (p) => fmtVal({ u: 'dB' }, p.gain) + ' dB' + (p.fin ? ' · in ' + p.fin + 'ms' : '') + (p.fout ? ' · out ' + p.fout + 'ms' : ''),
    fn: (b, p) => { const g = Math.pow(10, p.gain / 20), n = bufLen(b), fi = Math.round(p.fin * SR / 1000), fo = Math.round(p.fout * SR / 1000);
      return mapCh(b, (c) => { const o = new Float32Array(n);
        for (let i = 0; i < n; i++) { let e = g; if (i < fi) e *= i / fi; if (n - i < fo) e *= (n - i) / fo; o[i] = c[i] * e; } return o; }); } },
  normalize: { name: 'Normalize', tip: 'Makes the loudest moment hit a set level — evens out quiet recordings',
    params: [{ k: 'level', n: 'Level', min: -18, max: 0, d: -1, u: 'dB', tip: 'Target peak level' }],
    sum: (p) => p.level + ' dB',
    fn: (b, p) => normalizeBuf({ L: b.L.slice(), R: b.R.slice() }, Math.pow(10, p.level / 20)) },
  trim: { name: 'Trim silence', tip: 'Cuts silence at the start and end — great for recordings',
    params: [{ k: 'thr', n: 'Threshold', min: -70, max: -10, d: -45, u: 'dB', tip: 'Everything quieter than this at the edges counts as silence' }],
    sum: (p) => 'below ' + p.thr + ' dB',
    fn: (b, p) => { const t = Math.pow(10, p.thr / 20) * Math.max(peakOf(b), 1e-6), n = bufLen(b);
      let s = 0, e = n; while (s < n && Math.abs(b.L[s]) < t && Math.abs(b.R[s]) < t) s++;
      while (e > s + 1 && Math.abs(b.L[e - 1]) < t && Math.abs(b.R[e - 1]) < t) e--;
      s = Math.max(0, s - Math.round(0.005 * SR)); e = Math.min(n, e + Math.round(0.05 * SR));
      return fadeEdges({ L: b.L.slice(s, e), R: b.R.slice(s, e) }, 0.002, 0.02); } },
};
const EFFECT_ORDER = ['tape', 'pitch', 'stretch', 'reverse', 'distort', 'crush', 'filter', 'bass', 'echo', 'reverb', 'pan', 'ring', 'flanger', 'tremolo', 'boom', 'gain', 'normalize', 'trim'];

function makeStep(type, params) {
  return { id: uid(), type, on: true, params: Object.assign(defaultsOf(EFFECTS[type].params), params || {}) };
}
// Built-in Magic Transform recipes
const RECIPES = [
  ['Monster', [['tape', { semis: -7 }], ['distort', { drive: 35, tone: 4000 }], ['bass', { boost: 9, sub: 40 }], ['reverb', { size: 40, mix: 25 }]]],
  ['Giant step', [['trim', {}], ['tape', { semis: -12 }], ['bass', { boost: 12, sub: 60 }], ['boom', { pitch: 38, length: 1.2, amount: 70 }], ['reverb', { size: 55, mix: 30, tone: 30 }]]],
  ['Cinema hit', [['trim', {}], ['boom', { pitch: 36, length: 2, amount: 85 }], ['bass', { boost: 6, sub: 30 }], ['reverb', { size: 90, mix: 35, tone: 40 }], ['normalize', {}]]],
  ['Explosion punch', [['tape', { semis: -5 }], ['distort', { drive: 70, tone: 5000 }], ['bass', { boost: 10, sub: 50 }], ['boom', { pitch: 45, length: 1.6, amount: 60 }], ['reverb', { size: 60, mix: 25 }]]],
  ['Sci-fi door', [['filter', { mode: 1, cutoff: 300, reso: 10 }], ['flanger', { rate: 0.4, depth: 80, fb: 75, mix: 60 }], ['tape', { semis: 3 }], ['reverb', { size: 25, mix: 20, tone: 70 }]]],
  ['Sword clang', [['ring', { freq: 1800, mix: 45 }], ['filter', { mode: 1, cutoff: 600, reso: 20 }], ['echo', { time: 90, fb: 20, mix: 25 }], ['reverb', { size: 50, mix: 30, tone: 80 }]]],
  ['Robot', [['ring', { freq: 90, mix: 70 }], ['crush', { bits: 8, rate: 12000 }]]],
  ['Ghost', [['reverse', {}], ['reverb', { size: 85, mix: 70, tone: 40 }], ['reverse', {}], ['tape', { semis: -3 }], ['filter', { mode: 0, cutoff: 4000, reso: 10 }]]],
  ['Space echo', [['echo', { time: 380, fb: 55, mix: 45, mode: 1 }], ['reverb', { size: 70, mix: 30, tone: 60 }]]],
  ['Underwater', [['filter', { mode: 0, cutoff: 600, reso: 35 }], ['flanger', { rate: 0.15, depth: 60, fb: 40, mix: 40 }], ['tape', { semis: -2 }]]],
  ['Radio', [['filter', { mode: 2, cutoff: 1600, reso: 25 }], ['distort', { drive: 25, tone: 5000 }]]],
  ['Pixie', [['pitch', { semis: 12, grain: 30 }], ['echo', { time: 140, fb: 35, mix: 30, mode: 1 }], ['reverb', { size: 60, mix: 35, tone: 90 }]]],
].map(([name, steps]) => ({ name, steps: steps.map(([type, params]) => ({ type, params })) }));

async function applyChain(src, chain) {
  let b = src;
  for (const st of chain) {
    if (!st.on || !EFFECTS[st.type]) continue;
    const p = Object.assign(defaultsOf(EFFECTS[st.type].params), st.params);
    try { b = await EFFECTS[st.type].fn(b, p); } catch (e) { console.warn('Effect failed', st.type, e); }
    if (!b || bufLen(b) < 1) b = newBuf(1);
    await new Promise((r) => setTimeout(r, 0)); // keep the UI responsive between steps
  }
  return b;
}

/* =====================================================================
   Infinity dial: a row of round value buttons + one draggable tick ruler
   (inspired by phone photo editors). Swipe the ruler to change the
   active value; double-tap a button to reset it.
   ===================================================================== */
class Dials {
  constructor(container, defs, values, opts = {}) {
    this.c = container; this.defs = defs; this.values = values; this.opts = opts;
    this.defaults = opts.defaults || defaultsOf(defs);
    this.active = defs[0] ? defs[0].k : null;
    this.render();
  }
  render() {
    this.c.innerHTML = '';
    if (!this.defs.length) { this.c.innerHTML = '<p class="hint">No settings — this effect just does its thing.</p>'; return; }
    const row = document.createElement('div'); row.className = 'dial-row';
    this.btns = {};
    this.defs.forEach((d) => {
      const b = document.createElement('button'); b.type = 'button'; b.className = 'dial';
      b.innerHTML = '<div class="knob"><span></span></div><div class="lbl"></div>';
      b.querySelector('.lbl').textContent = d.n;
      let lastTap = 0;
      b.addEventListener('click', () => {
        const now = Date.now();
        if (now - lastTap < 320 && this.active === d.k) {
          this.values[d.k] = this.defaults[d.k] ?? d.d; this.update(); this.opts.onCommit && this.opts.onCommit(d.k);
          showStatus(d.n + ' reset');
        }
        lastTap = now; this.setActive(d.k);
      });
      row.appendChild(b); this.btns[d.k] = b;
    });
    this.name = document.createElement('div'); this.name.className = 'dial-name';
    this.canvas = document.createElement('canvas'); this.canvas.className = 'ruler';
    this.tip = document.createElement('div'); this.tip.className = 'dial-tip';
    this.c.append(row, this.name, this.canvas, this.tip);
    this.bindRuler();
    this.setActive(this.active);
  }
  def(k) { return this.defs.find((d) => d.k === k); }
  setActive(k) {
    this.active = k;
    Object.entries(this.btns).forEach(([kk, b]) => b.classList.toggle('active', kk === k));
    const d = this.def(k);
    this.name.textContent = d.n;
    this.tip.textContent = d.tip || '';
    this.update();
  }
  update() {
    this.defs.forEach((d) => {
      const b = this.btns[d.k], v = this.values[d.k] ?? d.d, n = toN(d, v);
      b.querySelector('span').textContent = fmtVal(d, v);
      let a0 = 0, a1 = n * 360;
      if (!d.opts && d.min < 0 && d.max > 0) { const z = toN(d, 0); a0 = Math.min(z, n) * 360; a1 = Math.max(z, n) * 360; }
      b.querySelector('.knob').style.setProperty('--a0', a0 + 'deg');
      b.querySelector('.knob').style.setProperty('--a1', a1 + 'deg');
    });
    this.draw();
  }
  draw() {
    const cv = this.canvas, dpr = window.devicePixelRatio || 1, W = cv.clientWidth || 300, H = 46;
    if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const d = this.def(this.active); if (!d) return;
    const cs = getComputedStyle(document.documentElement);
    const col = cs.getPropertyValue('--text-secondary').trim(), acc = cs.getPropertyValue('--accent').trim();
    const n = toN(d, this.values[d.k] ?? d.d), S = this.scale(d), cx = W / 2;
    const steps = d.opts ? d.opts.length - 1 : 50;
    for (let i = 0; i <= steps; i++) {
      const tn = i / steps, x = cx + (tn - n) * S;
      if (x < -2 || x > W + 2) continue;
      const major = d.opts || i % 5 === 0;
      g.fillStyle = col; g.globalAlpha = Math.max(0.25, 1 - Math.abs(x - cx) / (W / 2)) * (major ? 1 : 0.7);
      g.fillRect(Math.round(x) - 0.5, major ? 14 : 18, 1.5, major ? 18 : 10);
      if (d.opts) { g.font = '10px sans-serif'; g.textAlign = 'center'; g.fillText(d.opts[i], x, 44); }
    }
    g.globalAlpha = 1;
    const dn = toN(d, this.defaults[d.k] ?? d.d), dx = cx + (dn - n) * S;
    if (dx > 0 && dx < W) { g.fillStyle = col; g.beginPath(); g.arc(dx, 6, 2.5, 0, TAU); g.fill(); }
    g.fillStyle = acc; g.fillRect(cx - 1.5, 6, 3, 30);
  }
  scale(d) { return d.opts ? Math.max(70, 50 * (d.opts.length - 1)) : 900; }
  bindRuler() {
    const cv = this.canvas;
    let lastX = 0, raw = 0, dragging = false, changed = false;
    cv.addEventListener('pointerdown', (e) => {
      const d = this.def(this.active); if (!d) return;
      dragging = true; changed = false; lastX = e.clientX; raw = toN(d, this.values[d.k] ?? d.d);
      cv.setPointerCapture(e.pointerId);
    });
    cv.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const d = this.def(this.active);
      raw = clamp(raw - (e.clientX - lastX) / this.scale(d), 0, 1); lastX = e.clientX;
      const v = fromN(d, raw);
      if (v !== this.values[d.k]) { this.values[d.k] = v; changed = true; this.update(); this.opts.onInput && this.opts.onInput(d.k); }
      else this.draw();
    });
    const end = () => { if (!dragging) return; dragging = false; if (changed && this.opts.onCommit) this.opts.onCommit(this.active); };
    cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const d = this.def(this.active), n = toN(d, this.values[d.k] ?? d.d);
      const step = d.opts ? 1 / (d.opts.length - 1) : 0.01;
      this.values[d.k] = fromN(d, clamp(n + (e.deltaY < 0 ? step : -step), 0, 1)); this.update();
      clearTimeout(this.wt); this.wt = setTimeout(() => this.opts.onCommit && this.opts.onCommit(d.k), 350);
    }, { passive: false });
  }
}

/* =====================================================================
   Settings, storage
   ===================================================================== */
const settings = Object.assign({ undo: 20, pickMin: 5, autoPreview: true, micNs: false, forcePick: false, exFormat: 'mp3-192', exNorm: true, exChannels: '2' },
  JSON.parse(localStorage.getItem('listen-settings') || '{}'));
const saveSettings = () => localStorage.setItem('listen-settings', JSON.stringify(settings));
let ownRecipes = JSON.parse(localStorage.getItem('listen-recipes') || '[]');
const saveRecipes = () => localStorage.setItem('listen-recipes', JSON.stringify(ownRecipes));

let db = null;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('listen', 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('projects', { keyPath: 'id' });
      d.createObjectStore('assets', { keyPath: 'id' }).createIndex('project', 'projectId');
    };
    r.onsuccess = () => { db = r.result; res(); };
    r.onerror = () => rej(r.error);
  });
}
function idb(store, mode, fn) {
  return new Promise((res, rej) => {
    const t = db.transaction(store, mode), r = fn(t.objectStore(store));
    t.oncomplete = () => res(r ? r.result : undefined);
    t.onerror = t.onabort = () => rej(t.error);
  });
}

/* =====================================================================
   State
   ===================================================================== */
let project = null;          // { id, name, created, updated, clips: [], playhead, zoom }
let selectedId = null;       // selected clip id
let selection = null;        // { a, b } seconds
const assetBuffers = new Map();   // assetId -> decoded buffer
const assetMeta = new Map();      // assetId -> { blob, name }
const srcCache = new Map();       // source key -> buffer
const chainCache = new Map();     // full key -> buffer
const rendered = new Map();       // clip id -> { key, buf }
let undoStack = [], redoStack = [];

const getClip = (id) => project.clips.find((c) => c.id === id);
const selClip = () => (selectedId ? getClip(selectedId) : null);

function srcKey(clip) { return clip.src.kind === 'gen' ? 'g:' + clip.src.engine + ':' + clip.src.seed + ':' + JSON.stringify(clip.src.params) : 'a:' + clip.src.assetId; }
function fullKey(clip) { return srcKey(clip) + '|' + JSON.stringify(clip.chain.filter((s) => s.on).map((s) => [s.type, s.params])); }

async function getSource(clip) {
  const k = srcKey(clip);
  if (srcCache.has(k)) return srcCache.get(k);
  let b;
  if (clip.src.kind === 'gen') b = generate(clip.src.engine, clip.src.params, clip.src.seed);
  else b = await loadAssetBuffer(clip.src.assetId);
  if (srcCache.size > 40) srcCache.delete(srcCache.keys().next().value);
  srcCache.set(k, b);
  return b;
}
async function renderClip(clip) {
  const k = fullKey(clip), cur = rendered.get(clip.id);
  if (cur && cur.key === k) return cur.buf;
  let buf = chainCache.get(k);
  if (!buf) {
    const src = await getSource(clip);
    buf = clip.chain.some((s) => s.on) ? await applyChain(src, clip.chain) : src;
    if (buf !== src) { const pk = peakOf(buf); if (pk > 0.95) scaleBuf(buf, 0.95 / pk); } // keep effect chains from clipping
    if (chainCache.size > 60) chainCache.delete(chainCache.keys().next().value);
    chainCache.set(k, buf);
  }
  rendered.set(clip.id, { key: k, buf });
  return buf;
}
function clipBuf(clip) { // trimmed rendered buffer (sync, requires renderClip first)
  const r = rendered.get(clip.id); if (!r) return null;
  const full = r.buf, n = bufLen(full);
  const a = clamp(Math.round((clip.trim?.a || 0) * SR), 0, n - 1);
  const e = clip.trim?.b != null ? clamp(Math.round(clip.trim.b * SR), a + 1, n) : n;
  return { L: full.L.subarray(a, e), R: full.R.subarray(a, e) };
}
function clipDur(clip) { const b = clipBuf(clip); return b ? bufLen(b) / SR : (clip.estDur || 1); }
function projectEnd() { return project.clips.reduce((m, c) => Math.max(m, c.start + clipDur(c)), 0); }

let renderToken = 0;
async function renderAll() {
  const tok = ++renderToken;
  const pending = project.clips.filter((c) => { const r = rendered.get(c.id); return !r || r.key !== fullKey(c); });
  if (!pending.length) return;
  if (pending.some((c) => c.chain.length || c.src.kind === 'gen')) showStatus('Rendering…', 0);
  for (const c of pending) {
    try { await renderClip(c); c.estDur = clipDur(c); } catch (e) { console.warn(e); }
    if (tok !== renderToken) return;
    drawTimeline();
  }
  hideStatus();
}

/* ---------- Assets ---------- */
async function decodeBlob(blob) {
  const ab = await blob.arrayBuffer();
  const ctx = new OfflineAudioContext(2, 1, SR);
  const a = await ctx.decodeAudioData(ab);
  const L = a.getChannelData(0).slice(), R = a.numberOfChannels > 1 ? a.getChannelData(1).slice() : L.slice();
  return { L, R };
}
async function loadAssetBuffer(id) {
  if (assetBuffers.has(id)) return assetBuffers.get(id);
  let meta = assetMeta.get(id);
  if (!meta) { const rec = await idb('assets', 'readonly', (s) => s.get(id)); if (!rec) throw new Error('Missing audio'); meta = rec; assetMeta.set(id, rec); }
  const b = await decodeBlob(meta.blob);
  assetBuffers.set(id, b);
  return b;
}
async function storeAsset(blob, name, buf) {
  const rec = { id: uid(), projectId: project.id, blob, name, type: blob.type };
  await idb('assets', 'readwrite', (s) => s.put(rec));
  assetMeta.set(rec.id, rec);
  if (buf) assetBuffers.set(rec.id, buf);
  return rec.id;
}

/* ---------- Projects ---------- */
function newProjectObj() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  return { id: uid(), name: `Project ${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`,
    created: Date.now(), updated: Date.now(), clips: [], playhead: 0, zoom: 80 };
}
let saveTimer = null;
function scheduleSave() {
  $('saveState').textContent = '…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 500);
}
async function saveNow() {
  clearTimeout(saveTimer);
  if (!project) return;
  project.updated = Date.now();
  try { await idb('projects', 'readwrite', (s) => s.put(project)); $('saveState').textContent = 'Saved'; }
  catch (e) { $('saveState').textContent = 'Not saved!'; console.warn(e); }
}
async function openProject(p) {
  stopPlayback();
  project = p; project.clips.forEach((c) => { c.chain ||= []; c.trim ||= { a: 0, b: null }; });
  selectedId = null; selection = null; undoStack = []; redoStack = [];
  rendered.clear(); assetBuffers.clear(); assetMeta.clear();
  localStorage.setItem('listen-project', p.id);
  // drop assets no clip uses any more (history is empty now, so it's safe)
  const used = new Set(p.clips.filter((c) => c.src.kind === 'asset').map((c) => c.src.assetId));
  const assets = await idb('assets', 'readonly', (s) => s.index('project').getAllKeys(p.id));
  for (const id of assets) if (!used.has(id)) await idb('assets', 'readwrite', (s) => s.delete(id));
  cancelGenEdit();
  refreshAll();
  renderAll();
}
async function deleteProject(id) {
  const keys = await idb('assets', 'readonly', (s) => s.index('project').getAllKeys(id));
  for (const k of keys) await idb('assets', 'readwrite', (s) => s.delete(k));
  await idb('projects', 'readwrite', (s) => s.delete(id));
}
async function duplicateProject(id) {
  const src = await idb('projects', 'readonly', (s) => s.get(id));
  const copy = deepCopy(src); copy.id = uid(); copy.name = src.name + ' (copy)'; copy.created = copy.updated = Date.now();
  const assets = await idb('assets', 'readonly', (s) => s.index('project').getAll(id)), map = {};
  for (const a of assets) { const n = { ...a, id: uid(), projectId: copy.id }; map[a.id] = n.id; await idb('assets', 'readwrite', (s) => s.put(n)); }
  copy.clips.forEach((c) => { if (c.src.kind === 'asset') c.src.assetId = map[c.src.assetId] || c.src.assetId; });
  await idb('projects', 'readwrite', (s) => s.put(copy));
}

/* ---------- Undo / redo ---------- */
function snapshot() { return JSON.stringify({ name: project.name, clips: project.clips }); }
function pushHistory() {
  undoStack.push(snapshot());
  while (undoStack.length > settings.undo) undoStack.shift();
  redoStack = [];
  updateUndoButtons();
}
function restore(snap) {
  const s = JSON.parse(snap); project.name = s.name; project.clips = s.clips;
  if (selectedId && !getClip(selectedId)) selectedId = null;
  refreshAll(); renderAll(); scheduleSave();
}
function undo() { if (!undoStack.length) return; redoStack.push(snapshot()); restore(undoStack.pop()); }
function redo() { if (!redoStack.length) return; undoStack.push(snapshot()); restore(redoStack.pop()); }
function updateUndoButtons() { $('undoBtn').disabled = !undoStack.length; $('redoBtn').disabled = !redoStack.length; }
function commit() { scheduleSave(); refreshAll(); renderAll(); }

/* =====================================================================
   Playback
   ===================================================================== */
let actx = null, player = null, loopOn = false;
function getCtx() {
  if (!actx) { try { actx = new AudioContext({ sampleRate: SR }); } catch (e) { actx = new AudioContext(); } }
  if (actx.state === 'suspended') actx.resume();
  return actx;
}
function toAudioBuffer(ctx, b) {
  const ab = ctx.createBuffer(2, Math.max(1, bufLen(b)), SR);
  ab.copyToChannel(b.L instanceof Float32Array && b.L.buffer.byteLength === b.L.length * 4 ? b.L : new Float32Array(b.L), 0);
  ab.copyToChannel(b.R instanceof Float32Array && b.R.buffer.byteLength === b.R.length * 4 ? b.R : new Float32Array(b.R), 1);
  return ab;
}
function stopPlayback() {
  if (player) { try { player.src.onended = null; player.src.stop(); } catch (e) {} player = null; }
  $('playBtn').textContent = '▶';
}
function playBuf(b, opts = {}) {
  stopPlayback();
  const ctx = getCtx(), src = ctx.createBufferSource();
  let pk = peakOf(b); const g = ctx.createGain(); g.gain.value = pk > 1 ? 1 / pk : 1;
  src.buffer = toAudioBuffer(ctx, b); src.loop = !!opts.loop;
  src.connect(g).connect(ctx.destination);
  const t0 = ctx.currentTime + 0.02; src.start(t0);
  player = { src, t0, dur: bufLen(b) / SR, offset: opts.offset ?? null, loop: !!opts.loop };
  src.onended = () => { if (player && player.src === src) { player = null; $('playBtn').textContent = '▶'; drawPlayhead(); } };
  if (opts.offset != null) { $('playBtn').textContent = '❚❚'; requestAnimationFrame(tick); }
}
function mixRange(a, e) {
  const n = Math.max(1, Math.round((e - a) * SR)), out = newBuf(n);
  for (const c of project.clips) {
    const b = clipBuf(c); if (!b) continue;
    const off = Math.round((c.start - a) * SR), len = bufLen(b);
    const i0 = Math.max(0, -off), i1 = Math.min(len, n - off);
    for (let i = i0; i < i1; i++) { out.L[off + i] += b.L[i]; out.R[off + i] += b.R[i]; }
  }
  return out;
}
async function playTimeline() {
  if (player && player.offset != null) { // pause
    const pos = currentPos(); stopPlayback(); project.playhead = pos; drawPlayhead(); return;
  }
  await renderAll();
  const end = projectEnd();
  if (!end) { showStatus('Nothing on the track yet'); return; }
  let a, e;
  if (selection) { a = selection.a; e = selection.b; }
  else { a = project.playhead >= end - 0.01 ? 0 : project.playhead; e = end; }
  playBuf(mixRange(a, e), { offset: a, loop: loopOn });
}
function currentPos() {
  if (!player || player.offset == null) return project.playhead;
  let t = Math.max(0, actx.currentTime - player.t0);
  if (player.loop) t %= player.dur; else t = Math.min(t, player.dur);
  return player.offset + t;
}
function tick() {
  if (!player || player.offset == null) { drawPlayhead(); return; }
  drawPlayhead(currentPos());
  requestAnimationFrame(tick);
}

/* =====================================================================
   Timeline
   ===================================================================== */
const tl = $('timeline'), tlInner = $('tlInner'), tlTrack = $('tlTrack'), tlRuler = $('tlRuler');
const pps = () => project.zoom; // pixels per second
const fmtTime = (s) => { s = Math.max(0, s); const m = Math.floor(s / 60); return m + ':' + (s - m * 60).toFixed(2).padStart(5, '0'); };

function cssVar(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
function drawTimeline() {
  if (!project) return;
  const W = tl.clientWidth, total = Math.max(projectEnd() + 4, W / pps());
  tlInner.style.width = Math.ceil(total * pps()) + 'px';
  // clips
  const existing = new Map([...tlTrack.children].map((el) => [el.dataset.id, el]));
  for (const c of project.clips) {
    let el = existing.get(c.id); existing.delete(c.id);
    if (!el) { el = document.createElement('div'); el.className = 'tl-clip'; el.dataset.id = c.id; el.innerHTML = '<canvas></canvas><span class="name"></span>'; bindClip(el); tlTrack.appendChild(el); }
    const w = Math.max(4, clipDur(c) * pps());
    el.style.left = c.start * pps() + 'px'; el.style.width = w + 'px';
    el.classList.toggle('selected', c.id === selectedId);
    el.classList.toggle('pending', !rendered.has(c.id) || rendered.get(c.id).key !== fullKey(c));
    el.querySelector('.name').textContent = c.name;
    const key = (rendered.get(c.id)?.key || '') + w + JSON.stringify(c.trim) + document.documentElement.dataset.theme;
    if (el._key !== key) { el._key = key; drawWave(el.querySelector('canvas'), clipBuf(c), Math.min(w, 4096), 80); }
  }
  existing.forEach((el) => el.remove());
  drawRuler(); drawSelection(); drawPlayhead(); updateClipBar();
}
function drawWave(cv, b, w, h) {
  w = Math.max(1, Math.round(w)); cv.width = w; cv.height = h;
  const g = cv.getContext('2d'); g.clearRect(0, 0, w, h);
  if (!b) return;
  g.fillStyle = cssVar('--wave');
  const n = bufLen(b), step = n / w, mid = h / 2 + 5, amp = (h - 14) / 2;
  for (let x = 0; x < w; x++) {
    let mx = 0; const s = Math.floor(x * step), e = Math.min(n, Math.floor((x + 1) * step) + 1);
    const inc = Math.max(1, ((e - s) / 64) | 0);
    for (let i = s; i < e; i += inc) { const v = Math.abs(b.L[i]) + Math.abs(b.R[i]); if (v > mx) mx = v; }
    const hh = Math.max(0.5, Math.min(1, mx / 2) * amp);
    g.fillRect(x, mid - hh, 1, hh * 2);
  }
}
function drawRuler() {
  const W = tl.clientWidth, dpr = window.devicePixelRatio || 1, x0 = tl.scrollLeft;
  tlRuler.style.left = x0 + 'px'; tlRuler.style.width = W + 'px';
  tlRuler.width = Math.round(W * dpr); tlRuler.height = Math.round(24 * dpr);
  const g = tlRuler.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, 24);
  g.fillStyle = cssVar('--surface'); g.fillRect(0, 0, W, 24);
  const steps = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30, 60];
  const major = steps.find((s) => s * pps() >= 60) || 60, minor = major / 5;
  g.fillStyle = cssVar('--text-secondary'); g.font = '10px sans-serif';
  const t0 = x0 / pps(), t1 = (x0 + W) / pps();
  for (let t = Math.floor(t0 / minor) * minor; t <= t1; t += minor) {
    const x = t * pps() - x0, isMaj = Math.abs(t / major - Math.round(t / major)) < 1e-6;
    g.fillRect(Math.round(x), isMaj ? 12 : 18, 1, isMaj ? 12 : 6);
    if (isMaj) g.fillText(major < 1 ? t.toFixed(2).replace(/0$/, '') + 's' : fmtTime(t).replace(/\.00$/, ''), x + 3, 10);
  }
}
function drawSelection() {
  const el = $('tlSelection');
  if (!selection) { el.hidden = true; $('selInfo').hidden = true; return; }
  el.hidden = false; el.style.left = selection.a * pps() + 'px'; el.style.width = (selection.b - selection.a) * pps() + 'px';
  $('selInfo').hidden = false;
  $('selText').textContent = `Selection ${fmtTime(selection.a)} – ${fmtTime(selection.b)} (${(selection.b - selection.a).toFixed(2)} s)`;
}
function drawPlayhead(pos) {
  const t = pos ?? project.playhead;
  $('tlPlayhead').style.left = t * pps() + 'px';
  $('timeDisplay').textContent = fmtTime(t);
}
tl.addEventListener('scroll', drawRuler);
window.addEventListener('resize', () => { drawTimeline(); gen.dials && gen.dials.draw(); });

/* ---------- Ruler: tap = playhead, drag = selection ---------- */
(() => {
  let down = null;
  const tAt = (e) => clamp((e.clientX - tl.getBoundingClientRect().left + tl.scrollLeft) / pps(), 0, 36000);
  tlRuler.addEventListener('pointerdown', (e) => { down = { x: e.clientX, t: tAt(e), moved: false }; tlRuler.setPointerCapture(e.pointerId); });
  tlRuler.addEventListener('pointermove', (e) => {
    if (!down) return;
    if (Math.abs(e.clientX - down.x) > 6) down.moved = true;
    if (down.moved) { const t = tAt(e); selection = { a: Math.min(down.t, t), b: Math.max(down.t, t) }; drawSelection(); }
  });
  tlRuler.addEventListener('pointerup', (e) => {
    if (!down) return;
    if (!down.moved) { stopPlayback(); project.playhead = down.t; selection = null; drawSelection(); drawPlayhead(); }
    else if (selection && selection.b - selection.a < 0.02) { selection = null; drawSelection(); }
    else { stopPlayback(); project.playhead = selection.a; drawPlayhead(); }
    down = null; updateClipBar();
  });
  tlTrack.addEventListener('click', (e) => {
    if (e.target !== tlTrack) return;
    stopPlayback();
    project.playhead = clamp((e.clientX - tl.getBoundingClientRect().left + tl.scrollLeft) / pps(), 0, 36000);
    selectClip(null); drawPlayhead();
  });
})();

/* ---------- Clips: tap to select, drag selected clip to move ---------- */
function bindClip(el) {
  let drag = null;
  el.addEventListener('pointerdown', (e) => {
    const c = getClip(el.dataset.id); if (!c || c.id !== selectedId) return;
    drag = { x: e.clientX, start: c.start, moved: false, snap: snapshot() };
    el.setPointerCapture(e.pointerId);
  });
  el.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const c = getClip(el.dataset.id), dx = e.clientX - drag.x;
    if (!drag.moved && Math.abs(dx) < 5) return;
    drag.moved = true;
    let s = Math.max(0, drag.start + dx / pps());
    // snap to 0, playhead and other clips' edges
    const pts = [0, project.playhead]; project.clips.forEach((o) => { if (o !== c) pts.push(o.start, o.start + clipDur(o)); });
    const d = clipDur(c), tol = 8 / pps();
    for (const pt of pts) { if (Math.abs(s - pt) < tol) { s = pt; break; } if (Math.abs(s + d - pt) < tol) { s = pt - d; break; } }
    c.start = Math.max(0, s); el.style.left = c.start * pps() + 'px';
  });
  const end = () => {
    if (!drag) return;
    if (drag.moved) { undoStack.push(drag.snap); while (undoStack.length > settings.undo) undoStack.shift(); redoStack = []; updateUndoButtons(); scheduleSave(); drawTimeline(); }
    drag = null;
  };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  el.addEventListener('click', () => { if (el.dataset.id !== selectedId) selectClip(el.dataset.id); });
}
function selectClip(id) {
  selectedId = id;
  if (gen.editing && gen.editing !== id) cancelGenEdit();
  drawTimeline(); renderTransform();
}
function updateClipBar() {
  const c = selClip();
  $('clipBar').hidden = !c;
  if (!c) return;
  $('clipTitle').textContent = c.name + ' · ' + clipDur(c).toFixed(2) + ' s' + (c.chain.filter((s) => s.on).length ? ' · ' + c.chain.filter((s) => s.on).length + ' effects' : '');
  $('clipEdit').hidden = c.src.kind !== 'gen';
  const ph = project.playhead;
  $('clipSplit').disabled = !(ph > c.start + 0.01 && ph < c.start + clipDur(c) - 0.01);
  $('clipTrim').disabled = !(selection && selection.b > c.start && selection.a < c.start + clipDur(c));
}
function addClip(clip, at) {
  pushHistory();
  clip.id = uid(); clip.chain ||= []; clip.trim ||= { a: 0, b: null };
  clip.start = at ?? project.playhead;
  project.clips.push(clip);
  selectedId = clip.id;
  commit();
  return clip;
}
// After a new clip is rendered, move the playhead to its end so the next one lines up.
async function addClipAndAdvance(clip) {
  addClip(clip);
  await renderClip(clip);
  clip.estDur = clipDur(clip);
  project.playhead = clip.start + clipDur(clip);
  drawTimeline();
  const x = clip.start * pps();
  if (x < tl.scrollLeft || x > tl.scrollLeft + tl.clientWidth - 40) tl.scrollLeft = Math.max(0, x - 30);
}

/* ---------- Clip actions ---------- */
$('clipEdit').addEventListener('click', () => { const c = selClip(); if (c && c.src.kind === 'gen') startGenEdit(c); });
$('clipDel').addEventListener('click', () => {
  const c = selClip(); if (!c) return;
  pushHistory(); project.clips = project.clips.filter((x) => x !== c); selectedId = null; commit(); renderTransform();
});
$('clipDup').addEventListener('click', () => {
  const c = selClip(); if (!c) return;
  const n = deepCopy(c); n.name = c.name; addClip(n, c.start + clipDur(c)); renderAll();
});
$('clipSplit').addEventListener('click', () => {
  const c = selClip(); if (!c) return;
  const cut = project.playhead - c.start; if (cut <= 0.01 || cut >= clipDur(c) - 0.01) return;
  pushHistory();
  const n = deepCopy(c); n.id = uid();
  const a = c.trim.a || 0;
  n.trim = { a: a + cut, b: c.trim.b }; n.start = c.start + cut;
  c.trim = { a, b: a + cut };
  project.clips.push(n); selectedId = n.id; commit();
});
$('clipTrim').addEventListener('click', () => {
  const c = selClip(); if (!c || !selection) return;
  const s = Math.max(selection.a, c.start), e = Math.min(selection.b, c.start + clipDur(c)); if (e - s < 0.01) return;
  pushHistory();
  const a = c.trim.a || 0;
  c.trim = { a: a + (s - c.start), b: a + (e - c.start) }; c.start = s;
  selection = null; commit();
});
$('selClear').addEventListener('click', () => { selection = null; drawSelection(); updateClipBar(); });

/* ---------- Transport ---------- */
$('playBtn').addEventListener('click', playTimeline);
$('stopBtn').addEventListener('click', () => { stopPlayback(); project.playhead = selection ? selection.a : 0; drawPlayhead(); tl.scrollLeft = Math.max(0, project.playhead * pps() - 30); });
$('loopBtn').addEventListener('click', () => { loopOn = !loopOn; $('loopBtn').classList.toggle('active', loopOn); if (player && player.offset != null) player.src.loop = loopOn; });
function setZoom(z) {
  const center = (tl.scrollLeft + tl.clientWidth / 2) / pps();
  project.zoom = clamp(z, 5, 2000); drawTimeline();
  tl.scrollLeft = Math.max(0, center * pps() - tl.clientWidth / 2); drawRuler(); scheduleSave();
}
$('zoomInBtn').addEventListener('click', () => setZoom(pps() * 1.6));
$('zoomOutBtn').addEventListener('click', () => setZoom(pps() / 1.6));
$('zoomFitBtn').addEventListener('click', () => { const e = projectEnd(); setZoom(e > 0 ? (tl.clientWidth - 20) / (e + 0.5) : 80); tl.scrollLeft = 0; drawRuler(); });
$('undoBtn').addEventListener('click', undo);
$('redoBtn').addEventListener('click', redo);

/* =====================================================================
   Panels: tabs
   ===================================================================== */
let activePanel = 'create';
function showPanel(name) {
  activePanel = name;
  document.querySelectorAll('#panelTabs .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.panel === name));
  ['create', 'transform', 'add'].forEach((p) => ($('panel-' + p).hidden = p !== name));
  if (name === 'create' && gen.dials) gen.dials.draw();
  if (name === 'transform') renderTransform();
}
$('panelTabs').addEventListener('click', (e) => { const b = e.target.closest('.seg-btn'); if (b) showPanel(b.dataset.panel); });

/* =====================================================================
   Create (sound generator)
   ===================================================================== */
const gen = { theme: 0, preset: 0, engine: null, params: {}, base: {}, seed: 1, dials: null, editing: null };
function fillThemeSelect() {
  $('themeSelect').innerHTML = THEMES.map((t, i) => `<option value="${i}">${t.name}</option>`).join('');
  $('themeSelect').value = gen.theme;
  fillPresetSelect();
}
function fillPresetSelect() {
  $('presetSelect').innerHTML = THEMES[gen.theme].presets.map((p, i) => `<option value="${i}">${p.name}</option>`).join('');
  $('presetSelect').value = gen.preset;
}
function loadPreset() {
  const pr = THEMES[gen.theme].presets[gen.preset];
  gen.engine = pr.engine;
  gen.base = Object.assign(defaultsOf(ENGINES[pr.engine].params), pr.params);
  gen.params = { ...gen.base };
  gen.seed = (Math.random() * 1e9) | 0;
  buildGenDials();
}
function buildGenDials() {
  const eng = ENGINES[gen.engine];
  $('presetHint').textContent = eng.desc;
  const active = gen.dials && gen.dials.defs === eng.params ? gen.dials.active : null;
  gen.dials = new Dials($('genDials'), eng.params, gen.params, { defaults: gen.base, onCommit: () => { if (settings.autoPreview) previewGen(); } });
  if (active) gen.dials.setActive(active);
}
function previewGen() {
  try { playBuf(generate(gen.engine, gen.params, gen.seed)); } catch (e) { console.error(e); showStatus('Could not create this sound'); }
}
function presetName() { return THEMES[gen.theme].presets[gen.preset].name; }
$('themeSelect').addEventListener('change', () => { gen.theme = +$('themeSelect').value; gen.preset = 0; fillPresetSelect(); loadPreset(); if (settings.autoPreview) previewGen(); });
$('presetSelect').addEventListener('change', () => { gen.preset = +$('presetSelect').value; loadPreset(); if (settings.autoPreview) previewGen(); });
$('genPlay').addEventListener('click', previewGen);
$('genVary').addEventListener('click', () => {
  const rnd = Math.random;
  ENGINES[gen.engine].params.forEach((d) => {
    if (d.opts || d.k === 'length') return;
    gen.params[d.k] = fromN(d, clamp(toN(d, gen.base[d.k]) + (rnd() - 0.5) * 0.3, 0, 1));
  });
  if (gen.base.length != null) { const d = ENGINES[gen.engine].params.find((x) => x.k === 'length'); gen.params.length = fromN(d, clamp(toN(d, gen.base.length) + (rnd() - 0.5) * 0.1, 0, 1)); }
  gen.seed = (Math.random() * 1e9) | 0;
  gen.dials.update(); previewGen();
});
$('genAdd').addEventListener('click', () => {
  addClipAndAdvance({ name: presetName(), src: { kind: 'gen', engine: gen.engine, params: { ...gen.params }, seed: gen.seed } });
});
function startGenEdit(c) {
  gen.editing = c.id; gen.engine = c.src.engine;
  gen.base = Object.assign(defaultsOf(ENGINES[c.src.engine].params), c.src.params);
  gen.params = { ...gen.base }; gen.seed = c.src.seed;
  // try to show the theme/preset the clip came from
  THEMES.forEach((t, ti) => t.presets.forEach((p, pi) => { if (p.name === c.name && p.engine === c.src.engine) { gen.theme = ti; gen.preset = pi; } }));
  fillThemeSelect(); buildGenDials();
  $('genEditBanner').hidden = false; $('genEditName').textContent = c.name; $('genAdd').hidden = true;
  showPanel('create'); $('panel-create').scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function cancelGenEdit() { gen.editing = null; $('genEditBanner').hidden = true; $('genAdd').hidden = false; }
$('genEditCancel').addEventListener('click', cancelGenEdit);
$('genUpdate').addEventListener('click', () => {
  const c = getClip(gen.editing); if (!c) return cancelGenEdit();
  pushHistory();
  c.src = { kind: 'gen', engine: gen.engine, params: { ...gen.params }, seed: gen.seed };
  if (c.trim.b != null) c.trim = { a: 0, b: null };
  cancelGenEdit(); commit(); showStatus('Clip updated');
});

/* =====================================================================
   Magic Transform (effect chain of the selected clip)
   ===================================================================== */
let openStep = null, trDials = null;
function renderTransform() {
  const c = selClip();
  $('trNoClip').hidden = !!c; $('trBody').hidden = !c;
  if (!c || activePanel !== 'transform') return;
  $('trClipName').textContent = c.name;
  // recipe chips
  const chips = $('recipeChips'); chips.innerHTML = '';
  RECIPES.forEach((r) => chips.appendChild(recipeChip(r, false)));
  ownRecipes.forEach((r, i) => chips.appendChild(recipeChip(r, true, i)));
  // chain
  const list = $('chainList'); list.innerHTML = '';
  if (!c.chain.length) list.innerHTML = '<p class="hint">No effects yet — tap a recipe above or add an effect below.</p>';
  c.chain.forEach((st, i) => {
    const fx = EFFECTS[st.type]; if (!fx) return;
    const p = Object.assign(defaultsOf(fx.params), st.params);
    const el = document.createElement('div'); el.className = 'step' + (st.on ? '' : ' off') + (openStep === st.id ? ' open' : '');
    el.innerHTML = `<div class="step-head"><span class="num">${i + 1}</span><input type="checkbox" ${st.on ? 'checked' : ''} title="On / off">
      <div class="title"><b></b><small></small></div>
      <button data-a="up" title="Move up">↑</button><button data-a="down" title="Move down">↓</button><button data-a="del" title="Remove">✕</button></div>`;
    el.querySelector('b').textContent = fx.name;
    el.querySelector('small').textContent = fx.sum(p);
    el.querySelector('input').addEventListener('change', (e) => { pushHistory(); st.on = e.target.checked; chainChanged(); });
    el.querySelector('.title').addEventListener('click', () => { openStep = openStep === st.id ? null : st.id; renderTransform(); });
    el.querySelectorAll('.step-head button').forEach((b) => b.addEventListener('click', () => {
      pushHistory();
      const a = b.dataset.a, j = c.chain.indexOf(st);
      if (a === 'del') c.chain.splice(j, 1);
      else { const k = a === 'up' ? j - 1 : j + 1; if (k < 0 || k >= c.chain.length) { undoStack.pop(); updateUndoButtons(); return; } [c.chain[j], c.chain[k]] = [c.chain[k], c.chain[j]]; }
      chainChanged();
    }));
    if (openStep === st.id) {
      const body = document.createElement('div'); body.className = 'step-body';
      const tip = document.createElement('p'); tip.className = 'hint'; tip.textContent = fx.tip; body.appendChild(tip);
      const dc = document.createElement('div'); body.appendChild(dc); el.appendChild(body);
      let snap = null;
      st.params = p;
      trDials = new Dials(dc, fx.params, st.params, {
        onInput: () => { if (!snap) snap = snapshot(); el.querySelector('small').textContent = fx.sum(st.params); },
        onCommit: () => { undoStack.push(snap || snapshot()); snap = null; redoStack = []; updateUndoButtons(); chainChanged(true); },
      });
    }
    list.appendChild(el);
  });
}
function recipeChip(r, own, idx) {
  const b = document.createElement('button'); b.className = 'chip' + (own ? ' own' : ''); b.textContent = r.name;
  if (own) { const x = document.createElement('span'); x.className = 'x'; x.textContent = '✕'; b.appendChild(x);
    x.addEventListener('click', (e) => { e.stopPropagation(); if (confirm(`Delete your recipe "${r.name}"?`)) { ownRecipes.splice(idx, 1); saveRecipes(); renderTransform(); } }); }
  b.addEventListener('click', () => {
    const c = selClip(); if (!c) return;
    pushHistory();
    c.chain = r.steps.map((s) => ({ ...makeStep(s.type, s.params), on: s.on !== false }));
    openStep = null; chainChanged(); showStatus(`Recipe "${r.name}" applied`);
  });
  return b;
}
async function chainChanged(keepOpen) {
  const c = selClip(); if (!c) return;
  scheduleSave();
  if (!keepOpen) renderTransform(); else updateClipBar();
  await renderAll();
  drawTimeline();
  if (settings.autoPreview && getClip(c.id)) { const b = clipBuf(c); if (b) playBuf(b); }
}
$('addEffectSelect').innerHTML += EFFECT_ORDER.map((k) => `<option value="${k}">${EFFECTS[k].name}</option>`).join('');
$('addEffectSelect').addEventListener('change', (e) => {
  const c = selClip(), t = e.target.value; e.target.value = ''; if (!c || !t) return;
  pushHistory(); const st = makeStep(t); c.chain.push(st); openStep = st.id; chainChanged();
});
$('chainClear').addEventListener('click', () => { const c = selClip(); if (!c || !c.chain.length) return; pushHistory(); c.chain = []; chainChanged(); });
$('chainPlay').addEventListener('click', async () => { const c = selClip(); if (!c) return; await renderClip(c); playBuf(clipBuf(c)); });
$('chainBypass').addEventListener('click', async () => { const c = selClip(); if (!c) return; playBuf(await getSource(c)); });
$('recipeSave').addEventListener('click', async () => {
  const c = selClip(); if (!c || !c.chain.length) { showStatus('Add some effects first'); return; }
  const name = await askText('Name your recipe', c.name + ' style'); if (!name) return;
  ownRecipes.push({ name, steps: c.chain.map((s) => ({ type: s.type, params: { ...s.params }, on: s.on })) }); saveRecipes(); renderTransform();
  showStatus('Recipe saved');
});

/* =====================================================================
   Add audio: import & record
   ===================================================================== */
const drop = $('drop'), fileInput = $('fileInput');
drop.addEventListener('click', () => fileInput.click());
['dragenter', 'dragover'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add('drag'); }));
['dragleave', 'drop'].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove('drag'); }));
drop.addEventListener('drop', (e) => { if (e.dataTransfer.files[0]) importFiles([...e.dataTransfer.files]); });
fileInput.addEventListener('change', () => { importFiles([...fileInput.files]); fileInput.value = ''; });
$('forcePick').addEventListener('change', (e) => { settings.forcePick = e.target.checked; saveSettings(); });
function updatePickHint() {
  $('pickHint').textContent = settings.pickMin > 0
    ? `Files longer than ${settings.pickMin} min ask for a section first (change this in Settings).`
    : 'Every file asks for a section first (change this in Settings).';
}

function encodeWav(b, bits = 16, channels = 2) {
  const n = bufLen(b), bps = bits / 8, size = 44 + n * channels * bps, buf = new ArrayBuffer(size), v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, size - 8, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); v.setUint16(22, channels, true); v.setUint32(24, SR, true);
  v.setUint32(28, SR * channels * bps, true); v.setUint16(32, channels * bps, true); v.setUint16(34, bits, true);
  w(36, 'data'); v.setUint32(40, n * channels * bps, true);
  let o = 44;
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < channels; c++) {
      const s = clamp(channels === 1 ? (b.L[i] + b.R[i]) / 2 : c ? b.R[i] : b.L[i], -1, 1);
      if (bits === 16) { v.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7FFF, true); o += 2; }
      else { const x = Math.round(s < 0 ? s * 0x800000 : s * 0x7FFFFF); v.setUint8(o, x & 255); v.setUint8(o + 1, (x >> 8) & 255); v.setUint8(o + 2, (x >> 16) & 255); o += 3; }
    }
  }
  return new Blob([buf], { type: 'audio/wav' });
}

async function importFiles(files) {
  for (const f of files) await importFile(f);
}
async function importFile(file) {
  const isVideo = file.type.startsWith('video/') || /\.(mp4|mov|m4v|mkv|3gp|avi)$/i.test(file.name);
  if (!file.type.startsWith('audio/') && !isVideo && !/\.(mp3|wav|ogg|oga|opus|m4a|aac|flac|webm|weba)$/i.test(file.name)) {
    showStatus(`"${file.name}" is not an audio or video file`); return;
  }
  showStatus('Reading ' + file.name + '…', 0);
  let buf;
  try { buf = await decodeBlob(file); }
  catch (e) { hideStatus(); alert(`Couldn't read the sound of "${file.name}". The format may not be supported by this browser.`); return; }
  hideStatus();
  const dur = bufLen(buf) / SR, base = file.name.replace(/\.[^.]+$/, '');
  let range = null;
  if (settings.forcePick || settings.pickMin === 0 || dur > settings.pickMin * 60) {
    range = await pickSection(buf, file.name);
    if (range === false) return;
  }
  let blob = file;
  if (range) buf = sliceBuf(buf, range.a, range.b);
  if (range || isVideo) blob = encodeWav(buf, 16);
  const assetId = await storeAsset(blob, file.name, buf);
  await addClipAndAdvance({ name: base, src: { kind: 'asset', assetId } });
  showStatus('Added "' + base + '"');
}

/* ---------- Section picker ---------- */
function pickSection(buf, name) {
  return new Promise((resolve) => {
    const dur = bufLen(buf) / SR, m = $('pickModal'), s = $('pickStart'), e = $('pickEnd');
    $('pickInfo').textContent = `${name} · ${fmtTime(dur)} long. Choose the part you want — only that part is kept.`;
    s.value = 0; e.value = Math.min(1000, Math.round((Math.min(dur, 60) / dur) * 1000));
    const cv = $('pickWave');
    const upd = () => {
      if (+s.value > +e.value - 1) { if (document.activeElement === s) s.value = +e.value - 1; else e.value = +s.value + 1; }
      $('pickStartVal').textContent = fmtTime(s.value / 1000 * dur); $('pickEndVal').textContent = fmtTime(e.value / 1000 * dur);
      const W = cv.clientWidth || 300; drawWave(cv, buf, W, 90);
      const g = cv.getContext('2d'); g.fillStyle = 'rgba(0,0,0,.55)';
      g.fillRect(0, 0, W * s.value / 1000, 90); g.fillRect(W * e.value / 1000, 0, W, 90);
    };
    s.oninput = e.oninput = upd;
    const close = (val) => { m.hidden = true; stopPlayback(); resolve(val); };
    $('pickPlay').onclick = () => playBuf(sliceBuf(buf, s.value / 1000 * dur, e.value / 1000 * dur));
    $('pickUse').onclick = () => close({ a: s.value / 1000 * dur, b: e.value / 1000 * dur });
    $('pickAll').onclick = () => close(null);
    $('pickCancel').onclick = () => close(false);
    m.hidden = false; requestAnimationFrame(upd);
  });
}

/* ---------- Recording ---------- */
let rec = null;
$('recBtn').addEventListener('click', startRecording);
async function startRecording() {
  if (!navigator.mediaDevices || !window.MediaRecorder) { alert('Recording is not supported in this browser.'); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: settings.micNs, autoGainControl: false } }); }
  catch (e) { alert('Microphone access was denied or no microphone is available.'); return; }
  stopPlayback();
  const ctx = getCtx(), an = ctx.createAnalyser(); an.fftSize = 1024;
  const node = ctx.createMediaStreamSource(stream); node.connect(an);
  const mr = new MediaRecorder(stream), chunks = [];
  mr.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec = { stream, mr, chunks, t0: performance.now(), an, node, cancel: false };
  mr.start(200);
  $('recModal').hidden = false;
  const data = new Float32Array(an.fftSize);
  const loop = () => {
    if (!rec) return;
    const t = (performance.now() - rec.t0) / 1000, m = Math.floor(t / 60);
    $('recTime').textContent = m + ':' + (t - m * 60).toFixed(1).padStart(4, '0');
    an.getFloatTimeDomainData(data); let pk = 0; for (const v of data) pk = Math.max(pk, Math.abs(v));
    $('recMeter').style.width = Math.min(100, Math.sqrt(pk) * 100) + '%';
    requestAnimationFrame(loop);
  };
  loop();
  mr.onstop = async () => {
    const r = rec; rec = null; $('recModal').hidden = true;
    r.stream.getTracks().forEach((t) => t.stop()); r.node.disconnect();
    if (r.cancel || !r.chunks.length) return;
    try {
      const buf = await decodeBlob(new Blob(r.chunks, { type: r.mr.mimeType }));
      const name = 'Recording ' + (project.clips.filter((c) => /^Recording \d+$/.test(c.name)).length + 1);
      const assetId = await storeAsset(encodeWav(buf, 16), name + '.wav', buf);
      await addClipAndAdvance({ name, src: { kind: 'asset', assetId } });
      showPanel('transform');
      showStatus('Recorded — now pick a recipe to transform it');
    } catch (e) { console.error(e); alert('The recording could not be processed.'); }
  };
}
$('recStop').addEventListener('click', () => rec && rec.mr.stop());
$('recCancel').addEventListener('click', () => { if (rec) { rec.cancel = true; rec.mr.stop(); } });

/* =====================================================================
   Export
   ===================================================================== */
const hasLame = () => typeof window.lamejs !== 'undefined' && !window.__noLame;
let exRange = 'all';
function openExport() {
  const c = selClip();
  document.querySelectorAll('#exRange .seg-btn').forEach((b) => {
    b.disabled = (b.dataset.v === 'sel' && !selection) || (b.dataset.v === 'clip' && !c);
  });
  if ((exRange === 'sel' && !selection) || (exRange === 'clip' && !c)) exRange = 'all';
  setExRange(exRange);
  const fmt = $('exFormat');
  [...fmt.options].forEach((o) => (o.disabled = o.value.startsWith('mp3') && !hasLame()));
  fmt.value = !hasLame() && settings.exFormat.startsWith('mp3') ? 'wav16' : settings.exFormat;
  $('exMp3Hint').hidden = hasLame();
  $('exChannels').value = settings.exChannels; $('exNorm').checked = settings.exNorm;
  $('exShare').hidden = !(navigator.canShare && navigator.canShare({ files: [new File([''], 'x.wav', { type: 'audio/wav' })] }));
  openModal('exportModal');
}
function setExRange(v) {
  exRange = v;
  document.querySelectorAll('#exRange .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.v === v));
  const slug = (s) => s.replace(/[\\/:*?"<>|]+/g, '').replace(/\s+/g, '_').slice(0, 60) || 'listen';
  const c = selClip();
  $('exName').value = v === 'clip' && c ? slug(c.name) : slug(project.name) + (v === 'sel' ? '_selection' : '');
  const dur = v === 'sel' ? selection.b - selection.a : v === 'clip' ? clipDur(c) : projectEnd();
  $('exInfo').textContent = 'Length: ' + fmtTime(dur);
}
$('exRange').addEventListener('click', (e) => { const b = e.target.closest('.seg-btn'); if (b && !b.disabled) setExRange(b.dataset.v); });
$('exportBtn').addEventListener('click', () => { if (!project.clips.length) { showStatus('Nothing to export yet'); return; } openExport(); });

async function buildExport() {
  settings.exFormat = $('exFormat').value; settings.exChannels = $('exChannels').value; settings.exNorm = $('exNorm').checked; saveSettings();
  showStatus('Preparing…', 0);
  await renderAll();
  let b;
  if (exRange === 'clip') { const c = selClip(); await renderClip(c); const t = clipBuf(c); b = { L: t.L.slice(), R: t.R.slice() }; }
  else if (exRange === 'sel') b = mixRange(selection.a, selection.b);
  else b = mixRange(0, projectEnd());
  if (settings.exNorm) normalizeBuf(b, 0.891);
  else { const p = peakOf(b); if (p > 1) scaleBuf(b, 0.999 / p); }
  const ch = +settings.exChannels, f = settings.exFormat;
  let blob, ext;
  if (f.startsWith('mp3')) { blob = await encodeMp3(b, +f.split('-')[1], ch); ext = 'mp3'; }
  else { blob = encodeWav(b, f === 'wav24' ? 24 : 16, ch); ext = 'wav'; }
  hideStatus();
  return new File([blob], ($('exName').value.trim() || 'listen') + '.' + ext, { type: blob.type });
}
async function encodeMp3(b, kbps, ch) {
  const enc = new lamejs.Mp3Encoder(ch, SR, kbps), out = [], n = bufLen(b), B = 1152;
  const toI16 = (a, s, e) => { const o = new Int16Array(e - s); for (let i = s; i < e; i++) { const v = clamp(a[i], -1, 1); o[i - s] = v < 0 ? v * 0x8000 : v * 0x7FFF; } return o; };
  const mono = ch === 1 ? (() => { const m = new Float32Array(n); for (let i = 0; i < n; i++) m[i] = (b.L[i] + b.R[i]) / 2; return m; })() : null;
  for (let i = 0, k = 0; i < n; i += B, k++) {
    const e = Math.min(n, i + B);
    const d = ch === 1 ? enc.encodeBuffer(toI16(mono, i, e)) : enc.encodeBuffer(toI16(b.L, i, e), toI16(b.R, i, e));
    if (d.length) out.push(new Int8Array(d));
    if (k % 200 === 0) { showStatus('Encoding MP3… ' + Math.round(i / n * 100) + '%', 0); await new Promise((r) => setTimeout(r, 0)); }
  }
  const d = enc.flush(); if (d.length) out.push(new Int8Array(d));
  return new Blob(out, { type: 'audio/mpeg' });
}
$('exGo').addEventListener('click', async () => {
  try {
    const file = await buildExport(), url = URL.createObjectURL(file), a = document.createElement('a');
    a.href = url; a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 30000);
    closeModal('exportModal'); showStatus('Exported ' + file.name);
  } catch (e) { console.error(e); hideStatus(); alert('Export failed: ' + e.message); }
});
$('exShare').addEventListener('click', async () => {
  try { const file = await buildExport(); await navigator.share({ files: [file], title: file.name }); closeModal('exportModal'); }
  catch (e) { hideStatus(); if (e.name !== 'AbortError') alert('Sharing failed: ' + e.message); }
});

/* =====================================================================
   Modals, menu, status
   ===================================================================== */
function openModal(id) { $(id).hidden = false; }
function closeModal(id) { $(id).hidden = true; }
document.querySelectorAll('.modal-bg').forEach((m) => {
  m.addEventListener('click', (e) => { if (e.target === m && m.id !== 'recModal' && m.id !== 'pickModal') m.hidden = true; });
  m.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', () => (m.hidden = true)));
});
let statusTimer = null;
function showStatus(msg, ms = 2200) {
  const s = $('status'); s.textContent = msg; s.hidden = false;
  clearTimeout(statusTimer); if (ms) statusTimer = setTimeout(hideStatus, ms);
}
function hideStatus() { $('status').hidden = true; }
function askText(title, value) {
  return new Promise((resolve) => {
    $('textTitle').textContent = title; $('textInput').value = value || ''; openModal('textModal');
    setTimeout(() => { $('textInput').focus(); $('textInput').select(); }, 50);
    const done = (v) => { closeModal('textModal'); $('textOk').onclick = $('textCancel').onclick = $('textInput').onkeydown = null; resolve(v); };
    $('textOk').onclick = () => done($('textInput').value.trim());
    $('textCancel').onclick = () => done(null);
    $('textInput').onkeydown = (e) => { if (e.key === 'Enter') done($('textInput').value.trim()); if (e.key === 'Escape') done(null); };
  });
}

const menu = $('menu');
$('menuBtn').addEventListener('click', (e) => { e.stopPropagation(); menu.style.display = menu.style.display === 'none' ? 'block' : 'none'; });
document.addEventListener('click', (e) => { if (!menu.contains(e.target)) menu.style.display = 'none'; });
menu.addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  menu.style.display = 'none';
  ({ projects: openProjects, theme: toggleTheme, settings: openSettings, about: () => openModal('aboutModal') })[b.dataset.act]();
});
function setTheme(t) {
  document.documentElement.dataset.theme = t; localStorage.setItem('listen-theme', t);
  $('themeItem').textContent = t === 'dark' ? 'Light mode' : 'Dark mode';
  document.querySelector('meta[name=theme-color]').content = t === 'dark' ? '#131313' : '#f4f4f2';
  if (project) drawTimeline(); if (gen.dials) gen.dials.draw(); if (trDials) trDials.draw();
}
function toggleTheme() { setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark'); }
$('fullscreenBtn').addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else (document.documentElement.requestFullscreen || document.documentElement.webkitRequestFullscreen)?.call(document.documentElement);
});
const goHome = () => (location.href = '/');
$('brand').addEventListener('click', goHome);
$('brand').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goHome(); } });

/* ---------- Settings ---------- */
function openSettings() {
  $('setUndo').value = settings.undo; $('setPick').value = settings.pickMin;
  $('setAuto').checked = settings.autoPreview; $('setMicNs').checked = settings.micNs;
  openModal('settingsModal');
}
$('setUndo').addEventListener('change', (e) => { settings.undo = clamp(Math.round(+e.target.value) || 20, 5, 100); e.target.value = settings.undo; saveSettings(); });
$('setPick').addEventListener('change', (e) => { settings.pickMin = clamp(Math.round(+e.target.value) || 0, 0, 120); e.target.value = settings.pickMin; saveSettings(); updatePickHint(); });
$('setAuto').addEventListener('change', (e) => { settings.autoPreview = e.target.checked; saveSettings(); });
$('setMicNs').addEventListener('change', (e) => { settings.micNs = e.target.checked; saveSettings(); });

/* ---------- Projects ---------- */
$('projectName').addEventListener('click', async () => {
  const n = await askText('Project name', project.name); if (!n) return;
  pushHistory(); project.name = n; refreshAll(); scheduleSave();
});
async function openProjects() {
  await saveNow();
  const list = (await idb('projects', 'readonly', (s) => s.getAll())).sort((a, b) => b.updated - a.updated);
  const el = $('projectList'); el.innerHTML = '';
  list.forEach((p) => {
    const row = document.createElement('div'); row.className = 'proj' + (p.id === project.id ? ' current' : '');
    row.innerHTML = '<div class="info"><b></b><small></small></div><button data-a="ren">Rename</button><button data-a="dup">Duplicate</button><button data-a="del">Delete</button>';
    row.querySelector('b').textContent = p.name;
    row.querySelector('small').textContent = new Date(p.updated).toLocaleString() + ' · ' + p.clips.length + ' clip' + (p.clips.length === 1 ? '' : 's') + (p.id === project.id ? ' · open' : '');
    row.querySelector('.info').addEventListener('click', async () => { if (p.id !== project.id) { await openProject(p); } closeModal('projectsModal'); });
    row.querySelectorAll('button').forEach((b) => b.addEventListener('click', async () => {
      const a = b.dataset.a;
      if (a === 'ren') { const n = await askText('Project name', p.name); if (!n) return; if (p.id === project.id) { project.name = n; refreshAll(); await saveNow(); } else { p.name = n; await idb('projects', 'readwrite', (s) => s.put(p)); } }
      if (a === 'dup') { await duplicateProject(p.id); showStatus('Project duplicated'); }
      if (a === 'del') {
        if (!confirm(`Delete "${p.name}" and all its audio? This can't be undone.`)) return;
        await deleteProject(p.id);
        if (p.id === project.id) { const rest = list.filter((x) => x.id !== p.id); await openProject(rest[0] || newProjectObj()); await saveNow(); }
      }
      openProjects();
    }));
    el.appendChild(row);
  });
  if (navigator.storage && navigator.storage.estimate) {
    navigator.storage.estimate().then((e) => { $('storageInfo').textContent = `${list.length} project${list.length === 1 ? '' : 's'} · storage used by this app: ${(e.usage / 1048576).toFixed(1)} MB. Projects live only in this browser.`; });
  }
  openModal('projectsModal');
}
$('projNew').addEventListener('click', async () => { await saveNow(); await openProject(newProjectObj()); await saveNow(); closeModal('projectsModal'); showStatus('New project'); });

/* ---------- Refresh ---------- */
function refreshAll() {
  $('projectName').textContent = project.name;
  updateUndoButtons(); drawTimeline(); renderTransform();
}

/* ---------- Keyboard (desktop) ---------- */
document.addEventListener('keydown', (e) => {
  if (e.target.matches('input, select, textarea') || [...document.querySelectorAll('.modal-bg')].some((m) => !m.hidden)) return;
  const mod = e.ctrlKey || e.metaKey;
  if (e.code === 'Space') { e.preventDefault(); playTimeline(); }
  else if (mod && e.key.toLowerCase() === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
  else if (mod && (e.key.toLowerCase() === 'y' || (e.key.toLowerCase() === 'z' && e.shiftKey))) { e.preventDefault(); redo(); }
  else if ((e.key === 'Delete' || e.key === 'Backspace') && selClip()) { e.preventDefault(); $('clipDel').click(); }
});

/* ---------- Files shared to the installed app (Web Share Target) ---------- */
async function receiveShared() {
  if (!new URLSearchParams(location.search).has('share')) return;
  history.replaceState(null, '', '/');
  try {
    const cache = await caches.open('listen-share'), reqs = await cache.keys(), files = [];
    for (const r of reqs) {
      const res = await cache.match(r), blob = await res.blob();
      files.push(new File([blob], decodeURIComponent(res.headers.get('X-Name') || 'shared'), { type: blob.type }));
      await cache.delete(r);
    }
    if (files.length) { showPanel('add'); await importFiles(files); }
  } catch (e) { console.warn('Share target', e); }
}

/* =====================================================================
   Init
   ===================================================================== */
(async function init() {
  $('versionFooter').textContent = $('versionAbout').textContent = APP_VERSION;
  setTheme(localStorage.getItem('listen-theme') || 'dark');
  $('forcePick').checked = settings.forcePick; updatePickHint();
  fillThemeSelect(); loadPreset();
  try { await openDB(); } catch (e) { alert('This browser does not allow storage — projects cannot be saved.'); return; }
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  const lastId = localStorage.getItem('listen-project');
  let p = lastId ? await idb('projects', 'readonly', (s) => s.get(lastId)) : null;
  if (!p) { const all = await idb('projects', 'readonly', (s) => s.getAll()); p = all.sort((a, b) => b.updated - a.updated)[0]; }
  await openProject(p || newProjectObj());
  if (!p) await saveNow();
  receiveShared();
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
})();
