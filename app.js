'use strict';
/* =====================================================================
   Listen — cinematic sound effects in the browser
   app.js: DSP engines, effect chain, timeline, projects, import/record,
   export. Everything runs client-side; no network requests.
   ===================================================================== */

const APP_VERSION = '0.3.0';
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

// Legacy (v0.1.0) engines — kept so clips made with 0.1.0 still play.
function generate(engineId, params, seed) {
  const eng = ENGINES[engineId];
  const p = Object.assign(defaultsOf(eng.params), params);
  const b = eng.gen(p, mulberry32(seed >>> 0));
  for (const ch of [b.L, b.R]) for (let i = 0; i < ch.length; i++) if (!isFinite(ch[i])) ch[i] = 0;
  return fadeEdges(normalizeBuf(b, 0.85), 0.001, 0.01);
}


/* =====================================================================
   Layer engine (v0.2.0) — every sound is 1–4 layers, and every layer
   has the same sections and controls: Source, Pitch, Volume,
   Brightness, Movement, Character.
   ===================================================================== */
const SRC_TYPES = ['Sine', 'Triangle', 'Saw', 'Square', 'Noise', 'Notes'];
const T_SINE = 0, T_TRI = 1, T_SAW = 2, T_SQR = 3, T_NOISE = 4, T_NOTES = 5;
const INSTRUMENTS = ['E-piano', 'Bell', 'Pluck', 'Organ', 'Pad', 'Chip'];
const HARMONIES = ['Major', 'Minor', 'Pentatonic', 'Dreamy', 'Mysterious', 'Dark', 'Power'];
const HARM_CHORD = [[0, 4, 7], [0, 3, 7], [0, 4, 7, 9], [0, 4, 7, 11, 14], [0, 4, 8], [0, 1, 6], [0, 7, 12]];
const HARM_SCALE = [[0, 2, 4, 5, 7, 9, 11], [0, 2, 3, 5, 7, 8, 10], [0, 2, 4, 7, 9], [0, 2, 4, 6, 7, 9, 11], [0, 2, 4, 6, 8, 10], [0, 1, 3, 6, 7, 8, 11], [0, 7]];
const MAX_LAYERS = 4;

function layerDefaults(type = T_SINE) {
  return { on: true, type, color: 1, inst: 0, mode: 0, harmony: 0, density: 8, range: 12, notes: [],
    f0: 440, f1: 440, pcurve: 0, note: 60, glide: 0,
    level: 80, delay: 0, attack: 0.005, dur: 1, decay: 50,
    ftype: 0, b0: 16000, b1: 16000, bcurve: 0, reso: 10,
    vib: 0, vrate: 6, pulse: 0, prate: 8, pan0: 0, pan1: 0, width: 0,
    drive: 0, crush: 16 };
}

// Section definitions. Source and Pitch adapt to the source type; the rest is identical for every layer.
const SECTIONS = [
  { id: 'source', name: 'Source', open: true, defs: (L) => {
    const d = [{ k: 'type', n: 'Source', opts: SRC_TYPES, d: 0, tip: 'The raw material. Sine = pure, round · Triangle = soft · Saw = bright, buzzy · Square = hollow, retro · Noise = air, blasts, wind · Notes = instruments and melodies' }];
    if (L.type === T_NOISE) d.push({ k: 'color', n: 'Noise color', opts: ['Bright', 'Medium', 'Dark'], d: 1, tip: 'Bright = hiss, sizzle · Medium = wind, surf · Dark = rumble, thunder' });
    if (L.type === T_NOTES) d.push(
      { k: 'inst', n: 'Instrument', opts: INSTRUMENTS, d: 0, tip: 'E-piano = warm keys · Bell = glitter, chimes · Pluck = harp, guitar · Organ = steady · Pad = choir-like, soft · Chip = 8-bit' },
      { k: 'mode', n: 'Play', opts: ['Single', 'Chord', 'Arpeggio', 'Random'], d: 0, tip: 'Single = one note · Chord = notes together · Arpeggio = notes one after another, upwards · Random = scattered notes (sparkles)' },
      { k: 'harmony', n: 'Mood', opts: HARMONIES, d: 0, tip: 'Major = happy · Minor = sad · Pentatonic = can\'t sound wrong · Dreamy = floating · Mysterious = magic, unreal · Dark = threatening · Power = bold, open' },
      { k: 'density', n: 'Notes per s', min: 1, max: 40, d: 8, u: '/s', tip: 'Arpeggio and Random: how many notes per second' },
      { k: 'range', n: 'Range', min: 0, max: 36, d: 12, u: 'st', tip: 'Arpeggio and Random: how far the notes spread (12 = one octave)' });
    return d; } },
  { id: 'pitch', name: 'Pitch', open: true, defs: (L) => {
    if (L.type === T_NOISE) return [];
    if (L.type === T_NOTES) return (L.notes && L.notes.length ? [] : [
      { k: 'note', n: 'Root note', min: 24, max: 96, d: 60, u: 'note', tip: 'The base note when no notes are picked below — C4 is middle C' }]).concat([
      { k: 'glide', n: 'Glide', min: -24, max: 24, d: 0, u: 'st', tip: 'Bends everything up or down over the length — rising magic, falling defeat' }]);
    return [
      { k: 'f0', n: 'Start pitch', min: 20, max: 8000, log: true, d: 440, u: 'Hz', tip: 'Pitch at the beginning. ~50 Hz = deep rumble, ~440 Hz = middle, ~3000 Hz = piercing' },
      { k: 'f1', n: 'End pitch', min: 20, max: 8000, log: true, d: 440, u: 'Hz', tip: 'Pitch at the end. Lower than start = falling (laser, power down) · higher = rising (riser, power up)' },
      { k: 'pcurve', n: 'Pitch curve', min: -100, max: 100, d: 0, tip: 'Negative = changes fast at first (punchy drops) · positive = slow start, fast finish (risers)' }];
  } },
  { id: 'volume', name: 'Volume', open: false, defs: () => [
    { k: 'delay', n: 'Start at', min: 0, max: 10, d: 0, u: 's', tip: 'When this layer starts — e.g. a boom after a whoosh' },
    { k: 'attack', n: 'Fade in', min: 0, max: 10, d: 0.005, u: 's', tip: 'Short = hard hit · long = swelling, creeping in' },
    { k: 'decay', n: 'Fade out', min: 0, max: 100, d: 50, u: '%', tip: '0 = stays loud until the end · high = dies away quickly, like a hit or pluck' }] },
  { id: 'bright', name: 'Brightness', open: false, defs: () => [
    { k: 'ftype', n: 'Filter', opts: ['Low-pass', 'High-pass', 'Band-pass'], d: 0, tip: 'Low-pass = removes highs (muffled) · High-pass = removes lows (thin) · Band-pass = keeps a narrow band (whistling wind, radio)' },
    { k: 'b0', n: 'Start', min: 30, max: 18000, log: true, d: 16000, u: 'Hz', tip: 'Filter frequency at the beginning. Low = dark, far away · high = bright, close' },
    { k: 'b1', n: 'End', min: 30, max: 18000, log: true, d: 16000, u: 'Hz', tip: 'Filter frequency at the end — bright → dark makes a blast fade into the distance' },
    { k: 'bcurve', n: 'Curve', min: -100, max: 100, d: 0, tip: 'Negative = moves fast at first · positive = slow start, fast finish' },
    { k: 'reso', n: 'Resonance', min: 0, max: 100, d: 10, u: '%', tip: 'Emphasis at the filter frequency — high values whistle and screech' }] },
  { id: 'move', name: 'Movement', open: false, defs: () => [
    { k: 'vib', n: 'Vibrato', min: 0, max: 100, d: 0, u: '%', tip: 'Wobbling pitch — voices, sirens, alien' },
    { k: 'vrate', n: 'Vibrato speed', min: 0.1, max: 60, log: true, d: 6, u: 'Hz', tip: 'Slow = singing · fast = buzzing, laser' },
    { k: 'pulse', n: 'Pulse', min: 0, max: 100, d: 0, u: '%', tip: 'Pulsing volume — engines, rotors, alarms' },
    { k: 'prate', n: 'Pulse speed', min: 0.1, max: 60, log: true, d: 8, u: 'Hz', tip: 'Slow = breathing · fast = motor, helicopter' },
    { k: 'pan0', n: 'Pan start', min: -100, max: 100, d: 0, tip: '-100 = left · 0 = center · 100 = right' },
    { k: 'pan1', n: 'Pan end', min: -100, max: 100, d: 0, tip: 'Different from start = the sound travels across' },
    { k: 'width', n: 'Width', min: 0, max: 100, d: 0, u: '%', tip: 'Stereo spread — 0 = narrow, 100 = all around you' }] },
  { id: 'char', name: 'Character', open: false, defs: () => [
    { k: 'drive', n: 'Drive', min: 0, max: 100, d: 0, u: '%', tip: 'Distortion — warmer and fatter, then dirty and aggressive' },
    { k: 'crush', n: 'Bits', min: 2, max: 16, d: 16, int: true, tip: '16 = clean · lower = crunchy retro console sound' }] },
];

// Always visible under each layer head
const QUICK_DEFS = [
  { k: 'level', n: 'Level', min: 0, max: 100, d: 80, u: '%', tip: 'Loudness of this layer compared to the others' },
  { k: 'dur', n: 'Length', min: 0.03, max: 16, d: 1, u: 's', tip: 'How long this layer lasts' }];
const shapeU = (u, curve) => Math.pow(u, Math.pow(2, curve / 40));

/* ---------- Instruments for the "Notes" source ---------- */
// Renders one note into dst (stereo arrays) at offset. pm(t) = pitch multiplier over absolute time.
function renderNote(inst, f, len, off, dstL, dstR, gl, gr, amp, pm, rnd) {
  const n = Math.min(len, dstL.length - off); if (n <= 0) return;
  const t0 = off / SR;
  switch (inst) {
    case 0: { // E-piano: 2-operator FM with a short metallic tine
      let cp = 0, mp = 0, tp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / SR, fr = f * pm(t0 + t);
        cp += fr / SR; mp += fr / SR; tp += fr * 14 / SR;
        const I = 1.8 * Math.exp(-t / 0.35) + 0.25;
        const y = (Math.sin(TAU * cp + I * Math.sin(TAU * mp)) * Math.exp(-t / 1.4) + Math.sin(TAU * tp) * 0.25 * Math.exp(-t / 0.015)) * Math.min(1, t / 0.002);
        dstL[off + i] += y * amp * gl; dstR[off + i] += y * amp * gr;
      }
      break;
    }
    case 1: { // Bell: inharmonic partials (rotating-phasor oscillators, pitch updated every 32 samples)
      const P = [1, 2.756, 5.404, 8.933], A = [1, 0.45, 0.25, 0.12], D = [1.2, 0.7, 0.4, 0.25];
      for (let k = 0; k < 4; k++) {
        if (f * P[k] > SR * 0.45) continue;
        const m = Math.min(n, Math.round(D[k] * 7 * SR)), kd = Math.exp(-1 / (D[k] * SR));
        let x = 0, y = 1, e = A[k] * amp, c = 1, s = 0;
        for (let i = 0; i < m; i++) {
          if ((i & 31) === 0) { const w = TAU * f * P[k] * pm(t0 + i / SR) / SR; c = Math.cos(w); s = Math.sin(w); const r = 1 / Math.hypot(x, y); x *= r; y *= r; }
          const nx = x * c - y * s; y = x * s + y * c; x = nx;
          const v = x * e * (i < 96 ? i / 96 : 1); e *= kd;
          dstL[off + i] += v * gl; dstR[off + i] += v * gr;
        }
      }
      break;
    }
    case 2: { // Pluck: Karplus-Strong string
      const N = Math.max(2, Math.round(SR / f)), buf = new Float32Array(N);
      let lp = 0; for (let i = 0; i < N; i++) { lp += 0.5 * ((rnd() * 2 - 1) - lp); buf[i] = lp; }
      const fb = Math.min(0.9995, 0.994 + f / 40000);
      let idx = 0;
      for (let i = 0; i < n; i++) {
        const nx = (idx + 1) % N, y = buf[idx];
        buf[idx] = (buf[idx] + buf[nx]) * 0.5 * fb; idx = nx;
        dstL[off + i] += y * amp * 1.6 * gl; dstR[off + i] += y * amp * 1.6 * gr;
      }
      break;
    }
    case 3: { // Organ: drawbar-like harmonics
      const H = [[0.5, 0.5], [1, 1], [2, 0.6], [3, 0.4], [4, 0.3], [6, 0.15], [8, 0.12]], ph = H.map(() => 0);
      for (let i = 0; i < n; i++) {
        const t = i / SR, fr = f * pm(t0 + t); let y = 0;
        for (let k = 0; k < H.length; k++) { if (f * H[k][0] > SR * 0.45) continue; ph[k] += fr * H[k][0] / SR; y += Math.sin(TAU * ph[k]) * H[k][1]; }
        y *= 0.35 * Math.min(1, t / 0.008, (n - i) / (0.01 * SR));
        dstL[off + i] += y * amp * gl; dstR[off + i] += y * amp * gr;
      }
      break;
    }
    case 4: { // Pad: detuned saws (stereo)
      const det = [-0.006, 0, 0.0055], ph = det.map(() => rnd());
      for (let i = 0; i < n; i++) {
        const t = i / SR, fr = f * pm(t0 + t); let yl = 0, yr = 0;
        for (let k = 0; k < 3; k++) { const dt = fr * (1 + det[k]) / SR; ph[k] += dt; if (ph[k] >= 1) ph[k] -= 1; const s = 2 * ph[k] - 1 - polyblep(ph[k], dt); if (k !== 2) yl += s; if (k !== 0) yr += s; }
        const e = 0.3 * Math.min(1, t / 0.02, (n - i) / (0.05 * SR));
        dstL[off + i] += yl * e * amp * gl; dstR[off + i] += yr * e * amp * gr;
      }
      break;
    }
    default: { // Chip: square with plucky decay
      let ph = 0;
      for (let i = 0; i < n; i++) {
        const t = i / SR; ph += f * pm(t0 + t) / SR; if (ph >= 1) ph -= 1;
        const y = (ph < 0.5 ? 0.5 : -0.5) * Math.max(0.35, Math.exp(-t / 0.25)) * Math.min(1, (n - i) / (0.004 * SR));
        dstL[off + i] += y * amp * gl; dstR[off + i] += y * amp * gr;
      }
    }
  }
}
const NOTE_TAIL = [2.5, 2.5, 2, 0, 0, 0]; // natural ring time for arpeggio/random notes (0 = gated)

function renderNotes(P, dstL, dstR, rnd, vibFn) {
  const n = dstL.length, dur = n / SR, w = P.width / 100;
  const pm = (t) => Math.pow(2, P.glide * (t / dur) / 12) * vibFn(t);
  const chord = HARM_CHORD[P.harmony] || HARM_CHORD[0], scale = HARM_SCALE[P.harmony] || HARM_SCALE[0];
  const play = (midi, start, len, amp, pan) => {
    const [gl, gr] = panGains(pan);
    renderNote(P.inst, mtof(midi), Math.round(len * SR), Math.round(start * SR), dstL, dstR, gl, gr, amp, pm, rnd);
  };
  const own = P.notes && P.notes.length ? P.notes : null; // notes picked by the user (absolute MIDI numbers)
  if (P.mode === 0) play(own ? own[0] : P.note, 0, dur, 0.7, 0);
  else if (P.mode === 1) {
    const ns = own || chord.map((iv) => P.note + iv);
    ns.forEach((m, k) => play(m, 0, dur, 0.7 / Math.sqrt(ns.length), (k / Math.max(1, ns.length - 1) * 2 - 1) * 0.6 * w));
  }
  else {
    const step = 1 / P.density, tail = NOTE_TAIL[P.inst] || step * 1.2;
    let t = 0, k = 0;
    const notes = [];
    const span = Math.max(0, P.range);
    if (P.mode === 2) { // arpeggio: chord tones climbing through the range
      for (let o = 0; o <= 3; o++) chord.forEach((iv) => { const m = iv + o * 12; if (m <= span || notes.length === 0) notes.push(m); });
      if (!notes.length) notes.push(0);
    }
    while (t < dur - 0.01) {
      let midi;
      if (own) midi = P.mode === 2 ? own[k % own.length] : own[Math.floor(rnd() * own.length)];
      else if (P.mode === 2) midi = P.note + notes[k % notes.length];
      else {
        const raw = P.note + (rnd() - 0.5) * span, oct = Math.floor(raw / 12), pc = raw - oct * 12;
        let best = scale[0], bd = 99; for (const s of scale.concat([12])) { const d = Math.abs(s - pc); if (d < bd) { bd = d; best = s; } }
        midi = oct * 12 + best;
      }
      play(midi, t, NOTE_TAIL[P.inst] ? tail : Math.min(tail, dur - t + 0.2), 0.45 * (P.mode === 3 ? 0.6 + rnd() * 0.4 : 1), (rnd() * 2 - 1) * 0.8 * w);
      t += P.mode === 2 ? step : -Math.log(1 - rnd() * 0.98) * step; k++;
    }
  }
}

function renderLayer(L, rnd) {
  const P = Object.assign(layerDefaults(L.type), L);
  const start = Math.round(P.delay * SR), n = Math.max(1, Math.round(P.dur * SR));
  const tail = P.type === T_NOTES && P.mode >= 2 ? Math.round((NOTE_TAIL[P.inst] || 0.2) * SR) : 0;
  const total = n + tail, out = newBuf(start + total);
  const sL = new Float32Array(total), sR = new Float32Array(total), w = P.width / 100;
  const vibDepth = P.vib / 100 * 0.12, vibW = TAU * P.vrate;
  const vibFn = (t) => 1 + vibDepth * Math.sin(vibW * t);
  // --- source
  if (P.type === T_NOTES) renderNotes(P, sL, sR, rnd, vibFn);
  else if (P.type === T_NOISE) {
    let bL = 0, bR = 0, pL = 0, pR = 0;
    for (let i = 0; i < total; i++) {
      const sh = rnd() * 2 - 1, xl = sh * (1 - w) + (rnd() * 2 - 1) * w, xr = sh * (1 - w) + (rnd() * 2 - 1) * w;
      if (P.color === 0) { sL[i] = xl; sR[i] = xr; }
      else if (P.color === 1) { pL += 0.18 * (xl - pL); pR += 0.18 * (xr - pR); sL[i] = pL * 2.2; sR[i] = pR * 2.2; }
      else { bL = bL * 0.985 + xl * 0.15; bR = bR * 0.985 + xr * 0.15; sL[i] = bL * 1.3; sR[i] = bR * 1.3; }
    }
  } else {
    const k = Math.pow(2, P.pcurve / 40), det = 1 + w * 0.006;
    let a = 0, b = rnd() * w;
    for (let i = 0; i < total; i++) {
      const t = i / SR, u = Math.min(1, i / n);
      const f = P.f0 * Math.pow(P.f1 / P.f0, Math.pow(u, k)) * vibFn(t), dt = f / SR, dt2 = dt * det;
      a += dt; if (a >= 1) a -= 1; b += dt2; if (b >= 1) b -= 1;
      sL[i] = oscSample(P.type, a, dt); sR[i] = oscSample(P.type, b, dt2);
    }
  }
  // --- brightness, envelope, movement, character
  const fL = new SVF(), fR = new SVF(), q = 0.6 + Math.pow(P.reso / 100, 2) * 18, bk = Math.pow(2, P.bcurve / 40);
  const filt = !(P.ftype === 0 && P.b0 >= 17000 && P.b1 >= 17000);
  const drive = 1 + P.drive / 100 * 25, dn = Math.tanh(drive), q2 = Math.pow(2, P.crush - 1);
  const att = Math.max(0.001, P.attack), dk = P.decay / 100 * 4, pd = P.pulse / 100, pw = TAU * P.prate, lvl = Math.pow(P.level / 100, 1.5);
  const rel = Math.max(1, Math.min(n, Math.round(0.008 * SR))), ring = P.type === T_NOTES && P.mode >= 2;
  for (let i = 0; i < total; i++) {
    const t = i / SR, u = Math.min(1, i / n);
    let l = sL[i], r = sR[i];
    if (filt) {
      const fc = P.b0 * Math.pow(P.b1 / P.b0, Math.pow(u, bk));
      fL.run(l, fc, q); fR.run(r, fc, q);
      l = P.ftype === 0 ? fL.lp : P.ftype === 1 ? fL.hp : fL.bp * Math.min(3, Math.sqrt(q));
      r = P.ftype === 0 ? fR.lp : P.ftype === 1 ? fR.hp : fR.bp * Math.min(3, Math.sqrt(q));
    }
    // envelope: fade in, fade-out curve over the length; arpeggio/random notes may ring past the end
    let e = t < att ? t / att : 1;
    if (ring) e *= dk > 0 ? Math.pow(1 - u * 0.85, dk) : 1;
    else if (i >= n) e = 0;
    else { if (dk > 0) e *= Math.pow(1 - u, dk); if (i >= n - rel) e *= (n - i) / rel; }
    if (pd > 0) e *= 1 - pd * (0.5 + 0.5 * Math.sin(pw * t));
    l *= e; r *= e;
    if (P.drive > 0) { l = Math.tanh(l * drive) / dn; r = Math.tanh(r * drive) / dn; }
    if (P.crush < 16) { l = Math.round(l * q2) / q2; r = Math.round(r * q2) / q2; }
    const [gl, gr] = panGains((P.pan0 + (P.pan1 - P.pan0) * u) / 100);
    out.L[start + i] = l * gl * 1.414 * lvl; out.R[start + i] = r * gr * 1.414 * lvl;
  }
  return out;
}
function oscSample(type, ph, dt) {
  switch (type) {
    case T_TRI: return 1 - 4 * Math.abs(ph - 0.5);
    case T_SAW: return (2 * ph - 1 - polyblep(ph, dt)) * 0.8;
    case T_SQR: return ((ph < 0.5 ? 1 : -1) + polyblep(ph, dt) - polyblep((ph + 0.5) % 1, dt)) * 0.7;
    default: return Math.sin(TAU * ph);
  }
}
function renderDesign(layers, seed, onlyIdx = -1) {
  const parts = [];
  layers.forEach((L, i) => { if ((onlyIdx < 0 && L.on) || onlyIdx === i) parts.push(renderLayer(L, mulberry32(((seed >>> 0) + i * 7919) >>> 0))); });
  const n = Math.max(1, ...parts.map(bufLen)), b = newBuf(n);
  for (const p of parts) for (let i = 0; i < bufLen(p); i++) { b.L[i] += p.L[i]; b.R[i] += p.R[i]; }
  for (const ch of [b.L, b.R]) for (let i = 0; i < ch.length; i++) if (!isFinite(ch[i])) ch[i] = 0;
  return fadeEdges(normalizeBuf(trimTailSilence(b, 0.00002), 0.85), 0.0005, 0.005);
}
function layerSummary(L) {
  if (L.type === T_NOTES) return INSTRUMENTS[L.inst] + ' · ' + ['single note', 'chord', 'arpeggio', 'random notes'][L.mode] + (L.notes && L.notes.length ? ' · ' + L.notes.map(midiName).join(' ') : '');
  if (L.type === T_NOISE) return ['Bright', 'Medium', 'Dark'][L.color] + ' noise';
  const f = (v) => fmtVal({ u: 'Hz' }, v) + ' Hz';
  return SRC_TYPES[L.type] + ' ' + (Math.abs(L.f0 - L.f1) < 1 ? f(L.f0) : f(L.f0) + ' → ' + f(L.f1));
}
function designSummary(layers) { return layers.filter((l) => l.on).map(layerSummary).join(' + '); }
function newDesign(name, layers) { return { name, variants: [layers], active: 0, seed: (Math.random() * 1e9) | 0 }; }
const curLayers = (d) => d.variants[d.active];

/* =====================================================================
   Themes & presets — all built from layers, so they can be opened in
   the Sound Workshop and rebuilt step by step.
   ===================================================================== */
const Ly = (type, o) => Object.assign(layerDefaults(type), o);
const laserLayer = (delay) => Ly(T_SINE, { f0: 1800, f1: 300, pcurve: -20, dur: 0.2, decay: 70, drive: 40, vib: 30, vrate: 35, delay, level: 85 });
const COIN = [Ly(T_SQR, { f0: 988, f1: 988, dur: 0.1, decay: 10, crush: 6, level: 70 }), Ly(T_SQR, { f0: 1319, f1: 1319, delay: 0.08, dur: 0.35, decay: 70, crush: 6, level: 70 })];
const THEMES = [
  { id: 'standard', name: 'Standard', presets: [
    ['Big explosion', [Ly(T_NOISE, { color: 0, b0: 9000, b1: 150, bcurve: -60, dur: 4, attack: 0.002, decay: 75, drive: 35, width: 85, level: 90 }),
      Ly(T_SINE, { f0: 150, f1: 45, pcurve: -70, dur: 1, decay: 85, drive: 25, level: 100 }),
      Ly(T_NOISE, { color: 2, b0: 250, b1: 70, delay: 0.03, attack: 0.25, dur: 5, decay: 55, width: 90, level: 75 })]],
    ['Punchy hit', [Ly(T_NOISE, { color: 0, b0: 5000, b1: 400, bcurve: -50, dur: 0.35, decay: 90, width: 40, level: 70 }),
      Ly(T_SINE, { f0: 200, f1: 60, pcurve: -70, dur: 0.45, decay: 85, drive: 30, level: 100 })]],
    ['Cinematic boom', [Ly(T_SINE, { f0: 90, f1: 32, pcurve: -50, dur: 3, decay: 70, drive: 15, level: 100 }),
      Ly(T_NOISE, { color: 2, b0: 400, b1: 60, attack: 0.02, dur: 5, decay: 60, width: 90, level: 70 }),
      Ly(T_NOISE, { color: 1, b0: 1200, b1: 200, bcurve: -40, dur: 2.5, decay: 80, width: 100, level: 35 })]],
    ['Whoosh left → right', [Ly(T_NOISE, { color: 1, ftype: 2, b0: 500, b1: 2500, bcurve: 30, reso: 30, dur: 1.2, attack: 0.55, decay: 60, pan0: -90, pan1: 90, width: 30, level: 90 })]],
    ['Riser', [Ly(T_SAW, { f0: 80, f1: 1400, pcurve: 60, dur: 5, attack: 4, decay: 0, b0: 300, b1: 8000, bcurve: 60, reso: 30, vib: 10, width: 50, level: 70 }),
      Ly(T_NOISE, { color: 0, ftype: 2, b0: 400, b1: 8000, bcurve: 60, reso: 20, dur: 5, attack: 4.5, decay: 0, width: 80, level: 45 })]],
    ['Power down', [Ly(T_SAW, { f0: 900, f1: 30, pcurve: -40, dur: 2.5, decay: 20, b0: 6000, b1: 300, pulse: 30, prate: 20, drive: 20, level: 80 })]],
    ['Goosebumps choir', [Ly(T_NOTES, { inst: 4, mode: 1, harmony: 0, note: 50, dur: 8, attack: 4, decay: 20, b0: 2500, b1: 3500, vib: 8, vrate: 5, width: 90, level: 80 }),
      Ly(T_NOTES, { inst: 1, mode: 3, harmony: 2, note: 86, range: 12, density: 2, delay: 2, dur: 6, attack: 2, decay: 30, width: 100, level: 30 })]],
    ['Sparkle', [Ly(T_NOTES, { inst: 1, mode: 3, harmony: 2, note: 84, range: 24, density: 16, glide: 12, dur: 2, decay: 30, width: 90, level: 85 })]],
  ] },
  { id: 'scifi', name: 'Sci-Fi', presets: [
    ['Laser shot', [Ly(T_SQR, { f0: 3200, f1: 220, pcurve: -40, dur: 0.3, decay: 60, b0: 9000, b1: 2000, level: 80 }),
      Ly(T_SINE, { f0: 1600, f1: 110, pcurve: -40, dur: 0.3, decay: 60, vib: 40, vrate: 40, level: 50 })]],
    ['Blaster pew-pew', [laserLayer(0), laserLayer(0.22), laserLayer(0.44)]],
    ['Shield up', [Ly(T_SAW, { f0: 120, f1: 900, pcurve: 40, dur: 1.6, attack: 0.3, decay: 30, b0: 800, b1: 5000, reso: 40, pulse: 50, prate: 14, level: 75 }),
      Ly(T_NOTES, { inst: 1, mode: 2, harmony: 0, note: 72, density: 14, range: 24, dur: 1.4, width: 80, level: 35 })]],
    ['Generator shutdown', [Ly(T_SAW, { f0: 420, f1: 22, pcurve: -55, dur: 6, decay: 15, b0: 4000, b1: 300, pulse: 55, prate: 18, drive: 30, level: 85 }),
      Ly(T_SQR, { f0: 1680, f1: 88, pcurve: -55, dur: 5, decay: 40, b0: 6000, b1: 1000, level: 18 }),
      Ly(T_SINE, { f0: 120, f1: 45, delay: 5.6, dur: 0.35, decay: 90, level: 90 }),
      Ly(T_NOISE, { color: 1, ftype: 2, b0: 1800, b1: 1800, reso: 20, delay: 5.62, dur: 0.15, decay: 90, level: 60 })]],
    ['Generator start-up', [Ly(T_SAW, { f0: 25, f1: 380, pcurve: 50, dur: 5, attack: 0.4, decay: 0, b0: 400, b1: 4000, pulse: 55, prate: 18, drive: 30, level: 85 }),
      Ly(T_SQR, { f0: 100, f1: 1520, pcurve: 50, dur: 5, attack: 1, decay: 0, b0: 1000, b1: 6000, level: 18 }),
      Ly(T_SINE, { f0: 120, f1: 45, dur: 0.3, decay: 90, level: 80 })]],
    ['Teleport', [Ly(T_SINE, { f0: 200, f1: 4000, pcurve: 30, dur: 1.8, attack: 0.1, decay: 40, vib: 60, vrate: 30, level: 60 }),
      Ly(T_NOTES, { inst: 1, mode: 3, harmony: 4, note: 84, range: 24, density: 25, glide: 12, dur: 1.8, width: 100, level: 45 }),
      Ly(T_NOISE, { color: 0, ftype: 2, b0: 500, b1: 8000, reso: 50, dur: 1.8, attack: 0.9, decay: 50, width: 60, level: 40 })]],
    ['Spaceship fly-by', [Ly(T_SAW, { f0: 180, f1: 120, dur: 3, attack: 1.4, decay: 70, b0: 600, b1: 1500, pan0: -100, pan1: 100, width: 40, level: 70 }),
      Ly(T_NOISE, { color: 1, ftype: 2, b0: 300, b1: 1500, reso: 30, dur: 3, attack: 1.5, decay: 70, pan0: -100, pan1: 100, width: 40, level: 80 })]],
    ['Alien drone', [Ly(T_SAW, { f0: 65, f1: 65, dur: 8, attack: 1.5, decay: 10, b0: 300, b1: 1200, reso: 50, vib: 6, vrate: 0.3, pulse: 30, prate: 3, width: 70, drive: 30, level: 80 }),
      Ly(T_SQR, { f0: 98, f1: 92, dur: 8, attack: 3, decay: 10, b0: 800, b1: 400, width: 80, level: 30 })]],
  ] },
  { id: 'fantasy', name: 'Fantasy', presets: [
    ['Fairy glisten', [Ly(T_NOTES, { inst: 1, mode: 3, harmony: 3, note: 86, range: 24, density: 22, glide: 7, dur: 3, decay: 40, width: 100, level: 85 }),
      Ly(T_NOISE, { color: 0, ftype: 1, b0: 8000, b1: 8000, dur: 3, attack: 1, decay: 60, width: 100, level: 12 })]],
    ['Spell cast', [Ly(T_NOTES, { inst: 1, mode: 2, harmony: 4, note: 72, range: 30, density: 30, glide: 12, dur: 1.8, decay: 30, width: 90, level: 80 }),
      Ly(T_NOISE, { color: 0, ftype: 2, b0: 400, b1: 6000, reso: 40, dur: 1.8, attack: 1.2, decay: 70, width: 70, level: 45 })]],
    ['Healing light', [Ly(T_NOTES, { inst: 4, mode: 1, harmony: 0, note: 64, dur: 4, attack: 1.5, decay: 30, b0: 4000, b1: 4000, width: 90, level: 60 }),
      Ly(T_NOTES, { inst: 1, mode: 3, harmony: 0, note: 79, range: 14, density: 7, dur: 4, decay: 30, width: 90, level: 60 })]],
    ['Angel choir', [Ly(T_NOTES, { inst: 4, mode: 1, harmony: 3, note: 55, dur: 9, attack: 4.5, decay: 25, b0: 3000, b1: 3000, vib: 8, vrate: 5, width: 100, level: 80 }),
      Ly(T_NOTES, { inst: 4, mode: 1, harmony: 0, note: 79, delay: 3, dur: 6, attack: 3, decay: 30, width: 100, level: 25 })]],
    ['Magic portal', [Ly(T_SAW, { f0: 60, f1: 600, pcurve: 20, dur: 4, attack: 1, decay: 30, b0: 400, b1: 3000, reso: 50, pulse: 70, prate: 9, width: 60, level: 70 }),
      Ly(T_NOTES, { inst: 1, mode: 3, harmony: 4, note: 74, range: 24, density: 10, glide: 12, dur: 4, width: 100, level: 40 })]],
    ['Wind spirit', [Ly(T_NOISE, { color: 1, ftype: 2, b0: 400, b1: 1500, reso: 60, dur: 3.5, attack: 1.5, decay: 50, pulse: 25, prate: 0.8, pan0: -60, pan1: 60, width: 70, level: 85 }),
      Ly(T_SINE, { f0: 900, f1: 1300, dur: 3.5, attack: 1.6, decay: 60, vib: 30, vrate: 4, level: 15 })]],
    ['Enchanted harp', [Ly(T_NOTES, { inst: 2, mode: 2, harmony: 0, note: 55, range: 24, density: 12, dur: 2.5, decay: 20, width: 70, level: 85 })]],
    ['Crystal choir', [Ly(T_NOTES, { inst: 3, mode: 1, harmony: 3, note: 62, dur: 7, attack: 3, decay: 30, b0: 6000, b1: 6000, vib: 5, vrate: 5, width: 90, level: 70 }),
      Ly(T_NOTES, { inst: 1, mode: 3, harmony: 3, note: 86, density: 4, range: 12, dur: 7, width: 100, level: 30 })]],
  ] },
  { id: 'rpg', name: 'RPG', presets: [
    ['Coin', COIN],
    ['Level up', [Ly(T_NOTES, { inst: 5, mode: 2, harmony: 0, note: 72, range: 24, density: 14, dur: 0.9, decay: 30, crush: 6, level: 80 })]],
    ['Sword swing', [Ly(T_NOISE, { color: 0, ftype: 2, b0: 1500, b1: 4000, reso: 40, dur: 0.35, attack: 0.15, decay: 70, pan0: -40, pan1: 40, level: 90 })]],
    ['Sword clang', [Ly(T_SINE, { f0: 2200, f1: 2150, dur: 1.2, decay: 80, level: 40 }), Ly(T_SINE, { f0: 3170, f1: 3120, dur: 1, decay: 85, level: 30 }),
      Ly(T_NOISE, { color: 0, ftype: 1, b0: 3000, b1: 3000, dur: 0.12, decay: 90, level: 70 }), Ly(T_SINE, { f0: 160, f1: 90, dur: 0.2, decay: 90, level: 60 })]],
    ['Fireball blast', [Ly(T_NOISE, { color: 1, b0: 600, b1: 3000, bcurve: 40, dur: 0.8, attack: 0.7, decay: 0, width: 70, level: 60 }),
      Ly(T_NOISE, { color: 0, b0: 6000, b1: 200, bcurve: -50, delay: 0.8, dur: 2, decay: 70, drive: 40, width: 90, level: 90 }),
      Ly(T_SINE, { f0: 120, f1: 45, pcurve: -60, delay: 0.8, dur: 0.8, decay: 85, level: 90 })]],
    ['Potion / heal', [Ly(T_NOTES, { inst: 1, mode: 2, harmony: 2, note: 79, range: 12, density: 18, glide: 5, dur: 1.5, decay: 30, width: 80, level: 85 })]],
    ['Treasure found', [Ly(T_NOTES, { inst: 1, mode: 2, harmony: 0, note: 72, range: 30, density: 24, dur: 1.2, width: 80, level: 80 }),
      Ly(T_NOTES, { inst: 4, mode: 1, harmony: 0, note: 60, dur: 2.2, attack: 0.2, decay: 40, width: 80, level: 50 })]],
    ['Quest complete', [Ly(T_NOTES, { inst: 0, mode: 1, harmony: 0, note: 60, dur: 3, decay: 40, level: 80 }),
      Ly(T_NOTES, { inst: 4, mode: 1, harmony: 0, note: 48, dur: 4, attack: 0.3, decay: 30, width: 80, level: 40 })]],
  ] },
  { id: 'horror', name: 'Horror', presets: [
    ['Dark drone', [Ly(T_SAW, { f0: 45, f1: 45, dur: 10, attack: 2, decay: 10, b0: 200, b1: 600, reso: 30, vib: 3, vrate: 0.2, width: 80, drive: 30, level: 80 }),
      Ly(T_SAW, { f0: 46.2, f1: 46.2, dur: 10, attack: 2, decay: 10, b0: 200, b1: 600, reso: 30, width: 80, drive: 30, level: 60 }),
      Ly(T_SINE, { f0: 22.5, f1: 22.5, dur: 10, attack: 2, decay: 10, level: 60 })]],
    ['Metallic scrape', [Ly(T_NOISE, { color: 0, ftype: 2, b0: 2100, b1: 2600, reso: 95, dur: 5, attack: 0.5, decay: 20, pulse: 60, prate: 1.3, width: 50, level: 70 }),
      Ly(T_NOISE, { color: 0, ftype: 2, b0: 3460, b1: 3100, reso: 95, dur: 5, attack: 1, decay: 30, pulse: 70, prate: 2.1, width: 60, level: 50 })]],
    ['Creaking door', [Ly(T_NOISE, { color: 1, ftype: 2, b0: 900, b1: 600, reso: 95, dur: 4, attack: 0.2, decay: 30, pulse: 80, prate: 9, level: 80 }),
      Ly(T_SAW, { f0: 300, f1: 180, dur: 4, attack: 0.3, decay: 30, b0: 1200, b1: 800, reso: 60, pulse: 90, prate: 9, level: 25 })]],
    ['Sub drop', [Ly(T_SINE, { f0: 140, f1: 24, pcurve: -30, dur: 3, decay: 30, drive: 15, level: 100 })]],
    ['Ghost whoosh', [Ly(T_NOISE, { color: 1, ftype: 2, b0: 300, b1: 900, reso: 70, dur: 3, attack: 1.6, decay: 60, pan0: 70, pan1: -70, width: 60, level: 80 }),
      Ly(T_SINE, { f0: 700, f1: 450, dur: 3, attack: 1.5, decay: 60, vib: 40, vrate: 5, pan0: 70, pan1: -70, level: 20 })]],
    ['Tension riser', [Ly(T_SAW, { f0: 40, f1: 700, pcurve: 70, dur: 9, attack: 7, decay: 0, b0: 300, b1: 5000, bcurve: 60, reso: 40, pulse: 40, prate: 6, width: 70, level: 70 }),
      Ly(T_NOISE, { color: 0, ftype: 2, b0: 300, b1: 6000, bcurve: 60, reso: 40, dur: 9, attack: 8, decay: 0, width: 90, level: 40 })]],
    ['Jump scare', [Ly(T_NOTES, { inst: 4, mode: 1, harmony: 5, note: 60, dur: 2.5, decay: 70, drive: 50, width: 90, level: 80 }),
      Ly(T_NOISE, { color: 0, b0: 12000, b1: 300, bcurve: -50, dur: 1.5, decay: 85, width: 90, level: 70 }),
      Ly(T_SINE, { f0: 80, f1: 35, dur: 1.5, decay: 80, level: 90 })]],
    ['Eerie choir', [Ly(T_NOTES, { inst: 4, mode: 1, harmony: 5, note: 46, dur: 10, attack: 5, decay: 20, b0: 900, b1: 1600, reso: 40, vib: 15, vrate: 4, width: 100, level: 70 }),
      Ly(T_NOISE, { color: 1, ftype: 2, b0: 700, b1: 1100, reso: 70, dur: 10, attack: 4, decay: 30, width: 100, level: 25 })]],
  ] },
  { id: 'retro', name: 'Retro (8-Bit)', presets: [
    ['Coin', COIN],
    ['Jump', [Ly(T_SQR, { f0: 300, f1: 650, dur: 0.3, decay: 50, crush: 6, level: 70 })]],
    ['Laser', [Ly(T_SAW, { f0: 1400, f1: 250, pcurve: -20, dur: 0.25, decay: 40, crush: 6, level: 70 })]],
    ['Explosion', [Ly(T_NOISE, { color: 0, b0: 3000, b1: 200, bcurve: -30, dur: 0.9, decay: 60, crush: 5, level: 90 })]],
    ['Power-up', [Ly(T_NOTES, { inst: 5, mode: 2, harmony: 0, note: 60, range: 24, density: 16, glide: 12, dur: 0.7, crush: 6, level: 70 })]],
    ['Hit / hurt', [Ly(T_NOISE, { color: 0, b0: 4000, b1: 800, dur: 0.2, decay: 70, crush: 5, level: 80 }), Ly(T_SQR, { f0: 300, f1: 120, dur: 0.15, decay: 70, crush: 5, level: 50 })]],
    ['Blip / select', [Ly(T_SQR, { f0: 880, f1: 880, dur: 0.08, decay: 20, crush: 6, level: 70 })]],
    ['Game over', [Ly(T_SQR, { f0: 440, f1: 110, dur: 1.6, decay: 10, vib: 40, vrate: 8, crush: 6, level: 70 })]],
  ] },
].map((t) => ({ ...t, presets: t.presets.map(([name, layers]) => ({ name, layers })) }));

/* ---------- Note names & chord parsing ("C E G", "A3", "Am", "G7", "Fmaj7", "Dsus4"; H = B) ---------- */
const midiName = (m) => NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
const CHORD_TYPES = { maj: [0, 4, 7], M: [0, 4, 7], m: [0, 3, 7], min: [0, 3, 7], 7: [0, 4, 7, 10], maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10],
  sus2: [0, 2, 7], sus4: [0, 5, 7], sus: [0, 5, 7], dim: [0, 3, 6], aug: [0, 4, 8], 6: [0, 4, 7, 9], 9: [0, 4, 7, 10, 14], add9: [0, 4, 7, 14], m6: [0, 3, 7, 9] };
function parseNotes(text) {
  const out = [], bad = [];
  const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11, H: 11 };
  for (const tok of text.split(/[\s,;]+/).filter(Boolean)) {
    const m = tok.match(/^([A-Ha-h])(#|b|is|es)?(maj7|maj|min|m7|m6|m|M|7|6|9|add9|sus2|sus4|sus|dim|aug)?(-?\d)?$/);
    if (!m || (m[1].toUpperCase() !== 'H' && !(m[1].toUpperCase() in PC))) { bad.push(tok); continue; }
    let pc = PC[m[1].toUpperCase()] + (m[2] === '#' || m[2] === 'is' ? 1 : m[2] === 'b' || m[2] === 'es' ? -1 : 0);
    const oct = m[4] != null ? +m[4] : 4, root = (oct + 1) * 12 + pc;
    if (m[3]) CHORD_TYPES[m[3]].forEach((iv) => out.push(root + iv)); else out.push(root);
  }
  return { notes: out.filter((n) => n >= 12 && n <= 120).slice(0, 16), bad };
}

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
   Controls: choice buttons for options, round value knobs for numbers
   and a vertical jog wheel (tick scale) on the right. Tap a knob, then
   swipe the wheel up/down. Double-tap a knob to reset it.
   ===================================================================== */
class Dials {
  constructor(container, defs, values, opts = {}) {
    this.c = container; this.defs = defs; this.values = values; this.opts = opts;
    this.defaults = opts.defaults || defaultsOf(defs);
    this.nums = defs.filter((d) => !d.opts); this.choices = defs.filter((d) => d.opts);
    this.active = this.nums[0] ? this.nums[0].k : null;
    this.render();
  }
  render() {
    this.c.innerHTML = '';
    if (!this.defs.length) { this.c.innerHTML = '<p class="hint">No settings — this effect just does its thing.</p>'; return; }
    this.choiceEls = {};
    this.choices.forEach((d) => {
      const row = document.createElement('div'); row.className = 'choice-row';
      row.innerHTML = '<div class="choice-label"></div><div class="choices"></div><div class="choice-tip"></div>';
      row.querySelector('.choice-label').textContent = d.n;
      row.querySelector('.choice-tip').textContent = d.tip || '';
      const box = row.querySelector('.choices');
      d.opts.forEach((o, i) => {
        const b = document.createElement('button'); b.type = 'button'; b.className = 'choice'; b.textContent = o;
        b.addEventListener('click', () => {
          if (this.values[d.k] === i) return;
          this.values[d.k] = i; this.updateChoices();
          this.opts.onInput && this.opts.onInput(d.k); this.opts.onCommit && this.opts.onCommit(d.k);
        });
        box.appendChild(b);
      });
      this.choiceEls[d.k] = box; this.c.appendChild(row);
    });
    this.updateChoices();
    if (!this.nums.length) return;
    const wrap = document.createElement('div'); wrap.className = 'dial-wrap' + (this.opts.compact ? ' compact' : '');
    const left = document.createElement('div'); left.className = 'dial-left';
    const row = document.createElement('div'); row.className = 'dial-row';
    this.btns = {};
    this.nums.forEach((d) => {
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
    this.tip = document.createElement('div'); this.tip.className = 'dial-tip';
    left.append(row, this.name, this.tip);
    this.canvas = document.createElement('canvas'); this.canvas.className = 'wheel';
    this.canvas.title = 'Swipe up or down';
    wrap.append(left, this.canvas);
    this.c.appendChild(wrap);
    this.bindWheel();
    if (window.ResizeObserver) new ResizeObserver(() => this.draw()).observe(this.canvas);
    this.setActive(this.active);
  }
  def(k) { return this.defs.find((d) => d.k === k); }
  updateChoices() {
    this.choices.forEach((d) => [...this.choiceEls[d.k].children].forEach((b, i) => b.classList.toggle('active', i === this.values[d.k])));
  }
  setActive(k) {
    if (!this.btns) return;
    this.active = k;
    Object.entries(this.btns).forEach(([kk, b]) => b.classList.toggle('active', kk === k));
    const d = this.def(k);
    this.name.textContent = d.n + ' · ' + fmtVal(d, this.values[d.k] ?? d.d) + (unitLabel(d) ? ' ' + unitLabel(d) : '');
    this.tip.textContent = this.opts.compact ? '' : d.tip || '';
    this.update();
  }
  update() {
    this.updateChoices();
    if (!this.btns) return;
    this.nums.forEach((d) => {
      const b = this.btns[d.k], v = this.values[d.k] ?? d.d, n = toN(d, v);
      b.querySelector('span').textContent = fmtVal(d, v);
      let a0 = 0, a1 = n * 360;
      if (d.min < 0 && d.max > 0) { const z = toN(d, 0); a0 = Math.min(z, n) * 360; a1 = Math.max(z, n) * 360; }
      const kn = b.querySelector('.knob'); kn.style.setProperty('--a0', a0 + 'deg'); kn.style.setProperty('--a1', a1 + 'deg');
    });
    const d = this.def(this.active);
    if (d) this.name.textContent = d.n + ' · ' + fmtVal(d, this.values[d.k] ?? d.d) + (unitLabel(d) ? ' ' + unitLabel(d) : '');
    this.draw();
  }
  draw() {
    const cv = this.canvas; if (!cv) return;
    const dpr = window.devicePixelRatio || 1, W = cv.clientWidth || 56, H = cv.clientHeight || 140;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const d = this.def(this.active); if (!d) return;
    const cs = getComputedStyle(document.documentElement);
    const col = cs.getPropertyValue('--text-secondary').trim(), acc = cs.getPropertyValue('--accent').trim();
    const n = toN(d, this.values[d.k] ?? d.d), S = this.scale(), cy = H / 2;
    for (let i = 0; i <= 50; i++) {
      const tn = i / 50, y = cy - (tn - n) * S; // higher values sit above
      if (y < -2 || y > H + 2) continue;
      const major = i % 5 === 0;
      g.fillStyle = col; g.globalAlpha = Math.max(0.2, 1 - Math.abs(y - cy) / (H / 2)) * (major ? 1 : 0.7);
      const len = major ? W * 0.55 : W * 0.32;
      g.fillRect((W - len) / 2, Math.round(y) - 0.5, len, 1.5);
    }
    g.globalAlpha = 1;
    const dn = toN(d, this.defaults[d.k] ?? d.d), dy = cy - (dn - n) * S;
    if (dy > 0 && dy < H) { g.fillStyle = col; g.beginPath(); g.arc(W - 5, dy, 2.5, 0, TAU); g.fill(); }
    g.fillStyle = acc; g.fillRect(4, cy - 1.5, W - 12, 3);
  }
  scale() { return 900; }
  bindWheel() {
    const cv = this.canvas;
    let lastY = 0, raw = 0, dragging = false, changed = false;
    cv.addEventListener('pointerdown', (e) => {
      const d = this.def(this.active); if (!d) return;
      dragging = true; changed = false; lastY = e.clientY; raw = toN(d, this.values[d.k] ?? d.d);
      cv.setPointerCapture(e.pointerId); e.preventDefault();
    });
    cv.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const d = this.def(this.active);
      raw = clamp(raw - (e.clientY - lastY) / this.scale(), 0, 1); lastY = e.clientY;
      const v = fromN(d, raw);
      if (v !== this.values[d.k]) { this.values[d.k] = v; changed = true; this.update(); this.opts.onInput && this.opts.onInput(d.k); }
      else this.draw();
    });
    const end = () => { if (!dragging) return; dragging = false; if (changed && this.opts.onCommit) this.opts.onCommit(this.active); };
    cv.addEventListener('pointerup', end); cv.addEventListener('pointercancel', end);
    cv.addEventListener('wheel', (e) => {
      e.preventDefault();
      const d = this.def(this.active), n = toN(d, this.values[d.k] ?? d.d);
      this.values[d.k] = fromN(d, clamp(n + (e.deltaY < 0 ? 0.01 : -0.01), 0, 1)); this.update();
      this.opts.onInput && this.opts.onInput(d.k);
      clearTimeout(this.wt); this.wt = setTimeout(() => this.opts.onCommit && this.opts.onCommit(d.k), 350);
    }, { passive: false });
  }
}

/* =====================================================================
   Settings, storage
   ===================================================================== */
const settings = Object.assign({ wsAuto: 'off', undo: 20, pickMin: 5, autoPreview: true, micNs: false, forcePick: false, exFormat: 'mp3-192', exNorm: true, exChannels: '2' },
  JSON.parse(localStorage.getItem('listen-settings') || '{}'));
const saveSettings = () => localStorage.setItem('listen-settings', JSON.stringify(settings));
let ownRecipes = JSON.parse(localStorage.getItem('listen-recipes') || '[]');
const saveRecipes = () => localStorage.setItem('listen-recipes', JSON.stringify(ownRecipes));

let db = null;
function openDB() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('listen', 2);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('projects')) d.createObjectStore('projects', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('assets')) d.createObjectStore('assets', { keyPath: 'id' }).createIndex('project', 'projectId');
      if (!d.objectStoreNames.contains('library')) d.createObjectStore('library', { keyPath: 'id' }); // "My Sounds", shared by all projects
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

function srcKey(clip) {
  const s = clip.src;
  if (s.kind === 'design') return 'd:' + s.design.seed + ':' + JSON.stringify(curLayers(s.design));
  return s.kind === 'gen' ? 'g:' + s.engine + ':' + s.seed + ':' + JSON.stringify(s.params) : 'a:' + s.assetId;
}
function fullKey(clip) { return srcKey(clip) + '|' + JSON.stringify(clip.chain.filter((s) => s.on).map((s) => [s.type, s.params])); }

async function getSource(clip) {
  const k = srcKey(clip);
  if (srcCache.has(k)) return srcCache.get(k);
  let b;
  if (clip.src.kind === 'design') b = renderDesign(curLayers(clip.src.design), clip.src.design.seed);
  else if (clip.src.kind === 'gen') b = generate(clip.src.engine, clip.src.params, clip.src.seed);
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
  if (pending.some((c) => c.chain.length || c.src.kind !== 'asset')) showStatus('Rendering…', 0);
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
  if (player) { const p = player; try { p.src.onended = null; p.src.stop(); } catch (e) {} player = null; p.onEnd && p.onEnd(true); }
  $('playBtn').textContent = '▶';
}
function playBuf(b, opts = {}) {
  stopPlayback();
  const ctx = getCtx(), src = ctx.createBufferSource();
  let pk = peakOf(b); const g = ctx.createGain(); g.gain.value = pk > 1 ? 1 / pk : 1;
  src.buffer = toAudioBuffer(ctx, b); src.loop = !!opts.loop;
  src.connect(g).connect(ctx.destination);
  const t0 = ctx.currentTime + 0.02; src.start(t0);
  player = { src, t0, dur: bufLen(b) / SR, offset: opts.offset ?? null, loop: !!opts.loop, onEnd: opts.onEnd };
  src.onended = () => { if (player && player.src === src) { const p = player; player = null; $('playBtn').textContent = '▶'; drawPlayhead(); p.onEnd && p.onEnd(false); } };
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
window.addEventListener('resize', () => { drawTimeline(); redrawDials(); });

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
  drawTimeline(); renderTransform();
}
function updateClipBar() {
  const c = selClip();
  $('clipBar').hidden = !c;
  if (!c) return;
  $('clipTitle').textContent = c.name + ' · ' + clipDur(c).toFixed(2) + ' s' + (c.chain.filter((s) => s.on).length ? ' · ' + c.chain.filter((s) => s.on).length + ' effects' : '');
  $('clipEdit').hidden = c.src.kind !== 'design';
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
$('clipEdit').addEventListener('click', () => { const c = selClip(); if (c && c.src.kind === 'design') openWorkshop(deepCopy(c.src.design), c.id); });
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
  ['create', 'transform', 'add', 'library'].forEach((p) => ($('panel-' + p).hidden = p !== name));
  if (name === 'transform') renderTransform();
  if (name === 'library') renderLibrary();
}
$('panelTabs').addEventListener('click', (e) => { const b = e.target.closest('.seg-btn'); if (b) showPanel(b.dataset.panel); });

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
   Create tab: browse presets, quick preview / vary / add
   ===================================================================== */
const gen = { theme: 0, preset: 0, design: null, base: null };
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
  gen.base = withIds(deepCopy(pr.layers));
  gen.design = newDesign(pr.name, deepCopy(gen.base));
  $('presetHint').textContent = pr.layers.length + (pr.layers.length === 1 ? ' layer: ' : ' layers: ') + designSummary(pr.layers);
}
function withIds(layers) { layers.forEach((l) => (l.id ||= uid())); return layers; }
let lastRender = { key: '', buf: null };
function renderDesignCached(layers, seed, only = -1) {
  const key = seed + ':' + only + ':' + JSON.stringify(layers);
  if (lastRender.key !== key) lastRender = { key, buf: renderDesign(layers, seed, only) };
  return lastRender.buf;
}
function previewDesign(d, only = -1) {
  try { playBuf(renderDesignCached(curLayers(d), d.seed, only)); } catch (e) { console.error(e); showStatus('Could not create this sound'); }
}
// Nudge every continuous control a little (timing stays as it is)
function varyLayers(layers, base, amount) {
  layers.forEach((L, i) => {
    const B = (base && base[i]) || L;
    SECTIONS.forEach((s) => s.defs(L).forEach((d) => {
      if (d.opts || d.k === 'delay' || d.k === 'dur' || d.k === 'attack' || d.k === 'crush') return;
      L[d.k] = fromN(d, clamp(toN(d, B[d.k] ?? d.d) + (Math.random() - 0.5) * amount, 0, 1));
    }));
  });
}
$('themeSelect').addEventListener('change', () => { gen.theme = +$('themeSelect').value; gen.preset = 0; fillPresetSelect(); loadPreset(); if (settings.autoPreview) previewDesign(gen.design); });
$('presetSelect').addEventListener('change', () => { gen.preset = +$('presetSelect').value; loadPreset(); if (settings.autoPreview) previewDesign(gen.design); });
$('genPlay').addEventListener('click', () => previewDesign(gen.design));
$('genVary').addEventListener('click', () => {
  gen.design.variants[0] = deepCopy(gen.base); varyLayers(gen.design.variants[0], gen.base, 0.25);
  gen.design.seed = (Math.random() * 1e9) | 0; previewDesign(gen.design);
});
$('genAdd').addEventListener('click', () => addClipAndAdvance({ name: gen.design.name, src: { kind: 'design', design: deepCopy(gen.design) } }));
$('openWorkshop').addEventListener('click', () => openWorkshop(deepCopy(gen.design), null));
$('newSoundBtn').addEventListener('click', () => openWorkshop(newDesign('My sound', [{ ...layerDefaults(T_SINE), id: uid() }]), null));

/* =====================================================================
   Sound Workshop — full-screen editor with layers, variants, its own
   undo/redo, a mix wave with playhead and per-layer waves.
   ===================================================================== */
const ws = { design: null, clipId: null, undo: [], redo: [], dirty: false, openLayers: new Set(), openSecs: new Set(), dials: [],
  pos: 0, play: null, relView: new Set(), npView: {}, kbOct: 4, pinned: false };
const wsLayers = () => curLayers(ws.design);
const layerCache = new Map();
function fillWsStart() {
  let h = '<option value="">Load a preset…</option><option value="empty">Simple sine (one layer)</option>';
  THEMES.forEach((t, ti) => { h += `<optgroup label="${t.name}">` + t.presets.map((p, pi) => `<option value="${ti}:${pi}">${p.name}</option>`).join('') + '</optgroup>'; });
  $('wsStart').innerHTML = h;
}
function openWorkshop(design, clipId) {
  stopPlayback();
  ws.design = design; ws.clipId = clipId; ws.undo = []; ws.redo = []; ws.dirty = false; ws.pos = 0;
  ws.design.variants.forEach(withIds);
  ws.openLayers = new Set([wsLayers()[0]?.id]); ws.openSecs = new Set(); ws.relView = new Set();
  $('wsUse').textContent = clipId ? 'Update clip' : 'Add to track';
  $('workshop').hidden = false; document.body.classList.add('ws-open');
  $('workshop').scrollTop = 0;
  setAutoButtons();
  renderWorkshop();
}
function closeWorkshop(force) {
  if (!force && ws.dirty && !confirm('Close the Sound Workshop and discard your changes?')) return;
  stopPlayback(); $('workshop').hidden = true; document.body.classList.remove('ws-open'); ws.dials = [];
}
function wsSnap() { return JSON.stringify(ws.design); }
function wsPush(snap) {
  ws.undo.push(snap || wsSnap()); while (ws.undo.length > settings.undo) ws.undo.shift();
  ws.redo = []; ws.dirty = true; wsUndoButtons();
}
function wsUndoButtons() { $('wsUndo').disabled = !ws.undo.length; $('wsRedo').disabled = !ws.redo.length; }
function wsRestore(s) { ws.design = JSON.parse(s); ws.dirty = true; renderWorkshop(); autoPlay(); }
$('wsUndo').addEventListener('click', () => { if (!ws.undo.length) return; ws.redo.push(wsSnap()); wsRestore(ws.undo.pop()); });
$('wsRedo').addEventListener('click', () => { if (!ws.redo.length) return; ws.undo.push(wsSnap()); wsRestore(ws.redo.pop()); });
$('wsClose').addEventListener('click', () => closeWorkshop());

/* ---------- Rendering helpers ---------- */
function mixBuf() { return renderDesignCached(wsLayers(), ws.design.seed); }
function layerRaw(li) { // un-normalized layer incl. leading silence (delay)
  const L = wsLayers()[li], key = ws.design.seed + ':' + li + ':' + JSON.stringify(L);
  if (!layerCache.has(key)) { if (layerCache.size > 24) layerCache.delete(layerCache.keys().next().value); layerCache.set(key, renderLayer(L, mulberry32(((ws.design.seed >>> 0) + li * 7919) >>> 0))); }
  return layerCache.get(key);
}
function mixLen() { return Math.max(0.01, ...wsLayers().map((L, i) => bufLen(layerRaw(i)) / SR)); }

/* ---------- Playback (mix and single layers) ---------- */
function wsPlayMix(from) {
  const b = mixBuf(), dur = bufLen(b) / SR;
  if (from == null) from = ws.pos >= dur - 0.01 ? 0 : ws.pos;
  playBuf(sliceBuf(b, from, dur), { onEnd: (stopped) => { const p = ws.play; ws.play = null; if (!stopped && p) ws.pos = p.from; wsPlayButtons(); wsDrawHeads(); } });
  ws.play = { kind: 'mix', from, t0: player.t0, dur: dur - from };
  wsPlayButtons(); requestAnimationFrame(wsTick);
}
function wsPlayLayer(li) {
  const L = wsLayers()[li], b = renderDesign(wsLayers(), ws.design.seed, li), from = Math.min(L.delay, bufLen(b) / SR - 0.01);
  playBuf(sliceBuf(b, from, bufLen(b) / SR), { onEnd: () => { ws.play = null; wsPlayButtons(); wsDrawHeads(); } });
  ws.play = { kind: 'layer', li, from, t0: player.t0, dur: bufLen(b) / SR - from };
  wsPlayButtons(); requestAnimationFrame(wsTick);
}
function wsCurPos() { return ws.play ? ws.play.from + Math.max(0, Math.min(ws.play.dur, actx.currentTime - ws.play.t0)) : ws.pos; }
function wsTick() { wsDrawHeads(); if (ws.play) requestAnimationFrame(wsTick); }
function wsPlayButtons() {
  const mixOn = ws.play && ws.play.kind === 'mix';
  $('wsPlay').textContent = mixOn ? '❚❚' : '▶';
  $('wsPlay').title = mixOn ? 'Pause' : 'Play';
  document.querySelectorAll('.layer').forEach((el, i) => {
    const b = el.querySelector('[data-a=solo]'); if (!b) return;
    const on = ws.play && ws.play.kind === 'layer' && ws.play.li === i;
    b.textContent = on ? '■' : '▶'; b.title = on ? 'Stop' : 'Play only this layer'; b.classList.toggle('playing', !!on);
  });
}
function autoPlay(li) {
  if (settings.wsAuto === 'off') return;
  if (settings.wsAuto === 'layer' && li != null) wsPlayLayer(li); else wsPlayMix(0);
}
$('wsPlay').addEventListener('click', () => {
  if (ws.play && ws.play.kind === 'mix') { ws.pos = wsCurPos(); stopPlayback(); return; } // pause
  wsPlayMix();
});
$('wsStop').addEventListener('click', () => { stopPlayback(); ws.pos = 0; wsDrawHeads(); });
function setAutoButtons() { document.querySelectorAll('#wsAuto button').forEach((b) => b.classList.toggle('active', b.dataset.v === settings.wsAuto)); }
$('wsAuto').addEventListener('click', (e) => { const b = e.target.closest('button'); if (!b) return; settings.wsAuto = b.dataset.v; saveSettings(); setAutoButtons(); });
$('wsPin').addEventListener('click', () => { ws.pinned = !ws.pinned; $('wsMix').classList.toggle('pinned', ws.pinned); $('wsPin').classList.toggle('active', ws.pinned); });
// Tap or drag on the mix wave to position the playhead
(() => {
  const cv = $('wsWave'); let down = false;
  const setPos = (e) => {
    const r = cv.getBoundingClientRect(), dur = bufLen(mixBuf()) / SR;
    ws.pos = clamp((e.clientX - r.left) / r.width, 0, 1) * dur; wsDrawHeads();
  };
  cv.addEventListener('pointerdown', (e) => { down = true; cv.setPointerCapture(e.pointerId); if (ws.play) stopPlayback(); setPos(e); });
  cv.addEventListener('pointermove', (e) => { if (down) setPos(e); });
  cv.addEventListener('pointerup', () => { down = false; });
})();

/* ---------- Drawing ---------- */
function drawWsWave() {
  if (!ws.design) return;
  const cv = $('wsWave'), W = cv.clientWidth || 300;
  let b; try { b = mixBuf(); } catch (e) { return; }
  drawWave(cv, b, W, 70);
  $('wsInfo').textContent = 'Mix · ' + (bufLen(b) / SR).toFixed(2) + ' s · ' + wsLayers().filter((l) => l.on).length + ' of ' + wsLayers().length + ' layers on';
  wsDrawLayerWaves(); wsDrawHeads();
}
function wsDrawLayerWaves() {
  const total = mixLen();
  document.querySelectorAll('#wsLayers .layer').forEach((el, li) => {
    const cv = el.querySelector('.layer-wave canvas'); if (!cv) return;
    const L = wsLayers()[li], raw = layerRaw(li), rel = ws.relView.has(L.id);
    const W = cv.clientWidth || 300, H = 36, dpr = window.devicePixelRatio || 1;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const start = Math.round(L.delay * SR), n = bufLen(raw);
    const s0 = rel ? 0 : start, s1 = rel ? Math.round(total * SR) : n;
    if (rel) { g.fillStyle = cssVar('--surface-2'); g.fillRect(W * start / s1, 0, W * (n - start) / s1, H); }
    const pk = Math.max(1e-6, peakOf(raw)), step = (s1 - s0) / W;
    g.fillStyle = cssVar('--wave');
    for (let x = 0; x < W; x++) {
      const a = Math.floor(s0 + x * step), e = Math.min(n, Math.floor(s0 + (x + 1) * step) + 1);
      let mx = 0; const inc = Math.max(1, ((e - a) / 48) | 0);
      for (let i = Math.max(0, a); i < e; i += inc) { const v = Math.max(Math.abs(raw.L[i]), Math.abs(raw.R[i])); if (v > mx) mx = v; }
      const h = Math.max(mx > 0 ? 0.5 : 0, (mx / pk) * (H / 2 - 2));
      g.fillRect(x, H / 2 - h, 1, h * 2);
    }
    el.querySelector('.layer-wave small').textContent = rel ? 'in the mix · ' + total.toFixed(2) + ' s' : 'layer only · ' + ((n - start) / SR).toFixed(2) + ' s';
  });
}
function wsDrawHeads() {
  const pos = wsCurPos(), dur = bufLen(mixBuf()) / SR;
  $('wsPh').style.left = clamp(pos / dur, 0, 1) * 100 + '%';
  $('wsTime').textContent = fmtTime(pos);
  const total = mixLen();
  document.querySelectorAll('#wsLayers .layer').forEach((el, li) => {
    const ph = el.querySelector('.layer-ph'); if (!ph) return;
    const L = wsLayers()[li], raw = layerRaw(li), rel = ws.relView.has(L.id);
    const playing = ws.play && (ws.play.kind === 'mix' || ws.play.li === li);
    const x = rel ? pos / total : (pos - L.delay) / Math.max(0.001, bufLen(raw) / SR - L.delay);
    ph.hidden = !playing && !(rel && pos > 0) || x < 0 || x > 1;
    ph.style.left = clamp(x, 0, 1) * 100 + '%';
  });
}

/* ---------- Layout ---------- */
function renderWorkshop() {
  const d = ws.design;
  $('wsName').value = d.name;
  const vc = $('wsVariants'); vc.innerHTML = '';
  d.variants.forEach((v, i) => {
    const b = document.createElement('button'); b.className = 'chip' + (i === d.active ? ' own' : ''); b.textContent = String.fromCharCode(65 + i);
    if (i === d.active && d.variants.length > 1) {
      const x = document.createElement('span'); x.className = 'x'; x.textContent = '✕'; b.appendChild(x);
      x.addEventListener('click', (e) => { e.stopPropagation(); wsPush(); d.variants.splice(i, 1); d.active = Math.max(0, i - 1); renderWorkshop(); });
    }
    b.addEventListener('click', () => { if (i === d.active) { wsPlayMix(0); return; } stopPlayback(); d.active = i; ws.openLayers = new Set([wsLayers()[0]?.id]); renderWorkshop(); wsPlayMix(0); });
    vc.appendChild(b);
  });
  if (d.variants.length < 8) {
    const add = document.createElement('button'); add.className = 'chip'; add.textContent = '＋ Copy as new variant';
    add.addEventListener('click', () => { wsPush(); d.variants.push(withIds(deepCopy(wsLayers()).map((l) => ({ ...l, id: uid() })))); d.active = d.variants.length - 1; renderWorkshop(); showStatus('Variant ' + String.fromCharCode(65 + d.active) + ' created — change it and compare'); });
    vc.appendChild(add);
  }
  const box = $('wsLayers'); box.innerHTML = ''; ws.dials = [];
  wsLayers().forEach((L, li) => box.appendChild(layerCard(L, li)));
  $('wsAddLayer').disabled = wsLayers().length >= MAX_LAYERS;
  $('wsAddLayer').textContent = wsLayers().length >= MAX_LAYERS ? 'Maximum of ' + MAX_LAYERS + ' layers reached' : '＋ Add layer';
  wsUndoButtons(); wsPlayButtons(); drawWsWave();
}
function layerCard(L, li) {
  const el = document.createElement('div'); el.className = 'layer' + (L.on ? '' : ' off');
  const open = ws.openLayers.has(L.id);
  el.innerHTML = `<div class="layer-head"><input type="checkbox" ${L.on ? 'checked' : ''} title="Layer on / off">
    <div class="title"><b>Layer ${li + 1} ${open ? '▾' : '▸'}</b><small></small></div>
    <button data-a="solo" title="Play only this layer">▶</button><button data-a="dup" title="Duplicate layer">⧉</button><button data-a="del" title="Remove layer">✕</button></div>
    <div class="layer-wave" title="Tap to switch view"><canvas></canvas><div class="layer-ph" hidden></div><small></small></div>
    <div class="layer-quick"></div>`;
  el.querySelector('.title small').textContent = layerSummary(L);
  el.querySelector('input').addEventListener('change', (e) => { wsPush(); L.on = e.target.checked; renderWorkshop(); autoPlay(); });
  el.querySelector('.title').addEventListener('click', () => { open ? ws.openLayers.delete(L.id) : ws.openLayers.add(L.id); renderWorkshop(); });
  el.querySelector('.layer-wave').addEventListener('click', () => { ws.relView.has(L.id) ? ws.relView.delete(L.id) : ws.relView.add(L.id); wsDrawLayerWaves(); wsDrawHeads(); });
  el.querySelectorAll('.layer-head button').forEach((b) => b.addEventListener('click', () => {
    const a = b.dataset.a, layers = wsLayers();
    if (a === 'solo') { if (ws.play && ws.play.kind === 'layer' && ws.play.li === li) stopPlayback(); else wsPlayLayer(li); return; }
    if (a === 'dup') { if (layers.length >= MAX_LAYERS) return showStatus('Maximum of ' + MAX_LAYERS + ' layers'); wsPush(); const c = { ...deepCopy(L), id: uid() }; layers.splice(li + 1, 0, c); ws.openLayers.add(c.id); }
    if (a === 'del') { if (layers.length <= 1) return showStatus('A sound needs at least one layer'); wsPush(); layers.splice(li, 1); }
    stopPlayback(); renderWorkshop(); autoPlay();
  }));
  // Level and Length are always reachable
  ws.dials.push(makeLayerDials(el.querySelector('.layer-quick'), QUICK_DEFS, L, li, el, null, true));
  if (!open) return el;
  const body = document.createElement('div'); body.className = 'layer-body';
  SECTIONS.forEach((sec) => {
    const defs = sec.defs(L);
    const key = L.id + ':' + sec.id, isOpen = ws.openSecs.has(key) || (sec.open && !ws.openSecs.has('x' + key));
    const s = document.createElement('div'); s.className = 'sec' + (isOpen ? ' open' : '');
    const h = document.createElement('button'); h.className = 'sec-head'; h.type = 'button'; h.dataset.sec = sec.id;
    h.innerHTML = `<span>${sec.name}</span><small></small><i>${isOpen ? '▾' : '▸'}</i>`;
    h.querySelector('small').textContent = secSummary(sec.id, L);
    h.addEventListener('click', () => {
      if (isOpen) { ws.openSecs.delete(key); ws.openSecs.add('x' + key); } else { ws.openSecs.add(key); ws.openSecs.delete('x' + key); }
      renderWorkshop();
    });
    s.appendChild(h);
    if (isOpen) {
      const dc = document.createElement('div'); dc.className = 'sec-body'; s.appendChild(dc);
      if (!defs.length && !(sec.id === 'pitch' && L.type === T_NOTES)) dc.innerHTML = '<p class="hint">Noise has no pitch — shape it with Brightness instead.</p>';
      else if (defs.length) ws.dials.push(makeLayerDials(dc, defs, L, li, el, h));
      if (sec.id === 'pitch' && L.type === T_NOTES) dc.appendChild(notePicker(L, li));
    }
    body.appendChild(s);
  });
  el.appendChild(body);
  return el;
}
function makeLayerDials(container, defs, L, li, el, head, compact) {
  const holder = document.createElement('div'); container.appendChild(holder);
  let snap = null;
  return new Dials(holder, defs, L, {
    compact, defaults: layerDefaults(L.type),
    onInput: () => { if (!snap) snap = wsSnap(); if (head) head.querySelector('small').textContent = secSummary(head.dataset.sec, L); },
    onCommit: (k) => {
      wsPush(snap || wsSnap()); snap = null;
      if (k === 'type' || k === 'mode' || k === 'inst') renderWorkshop();
      else { el.querySelector('.title small').textContent = layerSummary(L); drawWsWave(); }
      autoPlay(li);
    },
  });
}
function secSummary(id, L) {
  const f = (k, u) => fmtVal({ u }, L[k]);
  switch (id) {
    case 'source': return L.type === T_NOTES || L.type === T_NOISE ? layerSummary(L) : SRC_TYPES[L.type];
    case 'pitch': return L.type === T_NOISE ? '—' : L.type === T_NOTES ? (L.notes && L.notes.length ? L.notes.map(midiName).join(' ') : f('note', 'note')) + (L.glide ? ' · glide ' + f('glide', 'st') : '') : f('f0', 'Hz') + ' → ' + f('f1', 'Hz') + ' Hz';
    case 'volume': return (L.delay ? 'at ' + f('delay', 's') + ' · ' : '') + 'in ' + f('attack', 's') + ' · fade ' + L.decay + '%';
    case 'bright': return L.ftype === 0 && L.b0 >= 17000 && L.b1 >= 17000 ? 'open' : ['LP', 'HP', 'BP'][L.ftype] + ' ' + f('b0', 'Hz') + ' → ' + f('b1', 'Hz');
    case 'move': return [L.vib ? 'vibrato' : '', L.pulse ? 'pulse' : '', L.pan0 !== L.pan1 ? 'moves' : '', L.width ? 'wide' : ''].filter(Boolean).join(' · ') || 'still';
    case 'char': return [L.drive ? 'drive ' + L.drive + '%' : '', L.crush < 16 ? L.crush + ' bit' : ''].filter(Boolean).join(' · ') || 'clean';
  }
  return '';
}

/* ---------- Note picker: text, piano keyboard, guitar fretboard ---------- */
const STRINGS = [64, 59, 55, 50, 45, 40]; // E4 B3 G3 D3 A2 E2 (high string on top, like tabs)
function previewNote(inst, m) {
  const n = Math.round(0.9 * SR), b = newBuf(n);
  renderNote(inst, mtof(m), n, 0, b.L, b.R, 1, 1, 0.6, () => 1, mulberry32(7));
  playBuf(fadeEdges(b, 0.001, 0.05));
}
function notePicker(L, li) {
  const box = document.createElement('div'); box.className = 'notepick';
  const view = ws.npView[L.id] || (L.inst === 2 ? 'strings' : 'keys');
  box.innerHTML = `<div class="label-main">Notes <span class="muted">— pick your own, or leave empty for automatic notes</span></div>
    <div class="row"><input type="text" placeholder="e.g. C E G · Am · G7 · A3 · Fis"><button class="np-clear">Clear</button></div>
    <div class="segment mini np-tabs"><button data-v="keys">Keyboard</button><button data-v="strings">Strings</button></div>
    <div class="np-view"></div>
    <p class="hint">Tap to add or remove notes — they play in the order you pick them (Arpeggio). Text: note names with optional octave (A3), chords like Am, G7, Fmaj7, Dsus4. German H and Fis/Es work too.</p>`;
  const inp = box.querySelector('input');
  inp.value = (L.notes || []).map(midiName).join(' ');
  const setNotes = (arr) => { wsPush(); L.notes = arr; renderWorkshop(); autoPlay(li); };
  inp.addEventListener('change', () => {
    const r = parseNotes(inp.value);
    if (r.bad.length) showStatus('Not understood: ' + r.bad.join(', '));
    setNotes(r.notes);
  });
  box.querySelector('.np-clear').addEventListener('click', () => setNotes([]));
  const toggle = (m) => {
    const arr = (L.notes || []).slice(), i = arr.indexOf(m);
    if (i >= 0) arr.splice(i, 1); else { if (arr.length >= 16) return showStatus('Up to 16 notes'); arr.push(m); previewNote(L.inst, m); }
    setNotes(arr);
  };
  box.querySelectorAll('.np-tabs button').forEach((b) => {
    b.classList.toggle('active', b.dataset.v === view);
    b.addEventListener('click', () => { ws.npView[L.id] = b.dataset.v; renderWorkshop(); });
  });
  const v = box.querySelector('.np-view'), sel = new Set(L.notes || []);
  if (view === 'keys') {
    const nav = document.createElement('div'); nav.className = 'kb-nav';
    nav.innerHTML = `<button data-d="-1">◀</button><span>C${ws.kbOct} – B${ws.kbOct + 1}</span><button data-d="1">▶</button>`;
    nav.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { ws.kbOct = clamp(ws.kbOct + +b.dataset.d, 1, 7); renderWorkshop(); }));
    const kb = document.createElement('div'); kb.className = 'kb';
    const base = (ws.kbOct + 1) * 12, whites = [0, 2, 4, 5, 7, 9, 11];
    for (let o = 0; o < 2; o++) whites.forEach((pc) => {
      const m = base + o * 12 + pc, k = document.createElement('button');
      k.className = 'kw' + (sel.has(m) ? ' on' : ''); k.textContent = pc === 0 ? 'C' + (ws.kbOct + o) : '';
      k.addEventListener('click', () => toggle(m)); kb.appendChild(k);
    });
    [1, 3, 6, 8, 10].forEach((pc) => [0, 1].forEach((o) => {
      const m = base + o * 12 + pc, k = document.createElement('button');
      const wi = { 1: 0, 3: 1, 6: 3, 8: 4, 10: 5 }[pc] + o * 7;
      k.className = 'kb-black' + (sel.has(m) ? ' on' : ''); k.style.left = `calc(${(wi + 1) / 14 * 100}% - 3.2%)`;
      k.addEventListener('click', () => toggle(m)); kb.appendChild(k);
    }));
    v.append(nav, kb);
  } else {
    const fb = document.createElement('div'); fb.className = 'fret';
    let h = '<div class="fret-row fret-nums"><span></span>' + Array.from({ length: 13 }, (_, f) => `<span>${f}</span>`).join('') + '</div>';
    STRINGS.forEach((open, si) => {
      h += `<div class="fret-row"><span class="sname">${NOTE_NAMES[open % 12]}</span>` +
        Array.from({ length: 13 }, (_, f) => `<button data-m="${open + f}" class="${sel.has(open + f) ? 'on' : ''}${f === 0 ? ' open' : ''}"></button>`).join('') + '</div>';
    });
    fb.innerHTML = h;
    fb.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => toggle(+b.dataset.m)));
    v.appendChild(fb);
  }
  return box;
}
function redrawDials() { ws.dials.forEach((d) => d.draw()); if (trDials) trDials.draw(); }

$('wsName').addEventListener('change', () => { wsPush(); ws.design.name = $('wsName').value.trim() || 'Sound'; });
$('wsStart').addEventListener('change', (e) => {
  const v = e.target.value; e.target.value = ''; if (!v) return;
  wsPush(); stopPlayback();
  let layers, name;
  if (v === 'empty') { layers = [layerDefaults(T_SINE)]; name = 'My sound'; }
  else { const [ti, pi] = v.split(':').map(Number), pr = THEMES[ti].presets[pi]; layers = deepCopy(pr.layers); name = pr.name; }
  ws.design.variants[ws.design.active] = withIds(layers.map((l) => ({ ...l, id: uid() })));
  if (ws.design.variants.length === 1) ws.design.name = name;
  ws.openLayers = new Set([wsLayers()[0].id]); ws.pos = 0;
  renderWorkshop(); autoPlay();
});
$('wsVary').addEventListener('click', () => { wsPush(); varyLayers(wsLayers(), null, 0.12); ws.design.seed = (Math.random() * 1e9) | 0; renderWorkshop(); wsPlayMix(0); });
$('wsAddLayer').addEventListener('click', () => {
  if (wsLayers().length >= MAX_LAYERS) return;
  wsPush(); const L = { ...layerDefaults(T_SINE), id: uid(), level: 60 }; wsLayers().push(L); ws.openLayers.add(L.id); renderWorkshop();
});
$('wsUse').addEventListener('click', async () => {
  ws.design.name = $('wsName').value.trim() || ws.design.name;
  const design = deepCopy(ws.design);
  if (ws.clipId && getClip(ws.clipId)) {
    const c = getClip(ws.clipId); pushHistory();
    c.src = { kind: 'design', design }; c.name = design.name; c.trim = { a: 0, b: null };
    closeWorkshop(true); commit(); showStatus('Clip updated');
  } else {
    closeWorkshop(true); await addClipAndAdvance({ name: design.name, src: { kind: 'design', design } }); showStatus('Added to the track');
  }
});
$('wsSave').addEventListener('click', async () => {
  const name = await askText('Save to My Sounds', $('wsName').value.trim() || ws.design.name); if (!name) return;
  const design = deepCopy(ws.design); design.name = name;
  await libPut({ name, src: { kind: 'design', design }, chain: [], trim: { a: 0, b: null } });
  ws.dirty = false; showStatus('Saved to My Sounds');
});

/* =====================================================================
   My Sounds — a library shared by all projects
   ===================================================================== */
const libBuffers = new Map();
async function libPut(item) { item.id ||= uid(); item.created ||= Date.now(); await idb('library', 'readwrite', (s) => s.put(item)); return item; }
async function renderLibItem(item) {
  let src;
  if (item.blob) { src = libBuffers.get(item.id) || await decodeBlob(item.blob); libBuffers.set(item.id, src); }
  else if (item.src.kind === 'design') src = renderDesign(curLayers(item.src.design), item.src.design.seed);
  else src = generate(item.src.engine, item.src.params, item.src.seed);
  let b = item.chain && item.chain.some((s) => s.on) ? await applyChain(src, item.chain) : src;
  if (item.trim && (item.trim.a || item.trim.b != null)) b = sliceBuf(b, item.trim.a || 0, item.trim.b ?? bufLen(b) / SR);
  return b;
}
async function renderLibrary() {
  const list = (await idb('library', 'readonly', (s) => s.getAll())).sort((a, b) => b.created - a.created);
  const el = $('libList'); el.innerHTML = '';
  if (!list.length) { el.innerHTML = '<p class="hint">Nothing saved yet.</p>'; return; }
  list.forEach((it) => {
    const row = document.createElement('div'); row.className = 'proj';
    row.innerHTML = '<button data-a="play" title="Play">▶</button><div class="info"><b></b><small></small></div><button data-a="add">＋ Track</button><button data-a="ren">Rename</button><button data-a="del">✕</button>';
    row.querySelector('b').textContent = it.name;
    const kind = it.blob ? 'Audio' : it.src.kind === 'design' ? 'Workshop sound · ' + curLayers(it.src.design).length + ' layers' : 'Generated (v0.1)';
    row.querySelector('small').textContent = kind + (it.chain && it.chain.length ? ' · ' + it.chain.length + ' effects' : '') + ' · ' + new Date(it.created).toLocaleDateString();
    row.querySelectorAll('button').forEach((b) => b.addEventListener('click', async () => {
      const a = b.dataset.a;
      if (a === 'play') { try { playBuf(await renderLibItem(it)); } catch (e) { showStatus('Could not play this sound'); } }
      if (a === 'add') {
        const chain = (it.chain || []).map((s) => ({ ...deepCopy(s), id: uid() }));
        let src;
        if (it.blob) src = { kind: 'asset', assetId: await storeAsset(it.blob, it.name) };
        else src = deepCopy(it.src);
        await addClipAndAdvance({ name: it.name, src, chain, trim: deepCopy(it.trim || { a: 0, b: null }) });
        showStatus('Added "' + it.name + '"');
      }
      if (a === 'ren') { const n = await askText('Rename', it.name); if (!n) return; it.name = n; await libPut(it); renderLibrary(); }
      if (a === 'del') { if (!confirm(`Delete "${it.name}" from My Sounds?`)) return; await idb('library', 'readwrite', (s) => s.delete(it.id)); libBuffers.delete(it.id); renderLibrary(); }
    }));
    el.appendChild(row);
  });
}
$('clipSave').addEventListener('click', async () => {
  const c = selClip(); if (!c) return;
  const name = await askText('Save to My Sounds', c.name); if (!name) return;
  const item = { name, chain: deepCopy(c.chain), trim: deepCopy(c.trim) };
  if (c.src.kind === 'asset') {
    let meta = assetMeta.get(c.src.assetId) || await idb('assets', 'readonly', (s) => s.get(c.src.assetId));
    if (!meta) return showStatus('Audio not found');
    item.blob = meta.blob;
  } else item.src = deepCopy(c.src);
  await libPut(item); showStatus('Saved to My Sounds');
});

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
  if (project) drawTimeline(); redrawDials(); if (!$('workshop').hidden) drawWsWave();
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
  if (!$('workshop').hidden) { // Sound Workshop has its own shortcuts
    if (e.target.matches('input, select, textarea') || [...document.querySelectorAll('.modal-bg')].some((m) => !m.hidden)) return;
    const m = e.ctrlKey || e.metaKey, k = e.key.toLowerCase();
    if (e.code === 'Space') { e.preventDefault(); $('wsPlay').click(); }
    else if (m && k === 'z' && !e.shiftKey) { e.preventDefault(); $('wsUndo').click(); }
    else if (m && (k === 'y' || (k === 'z' && e.shiftKey))) { e.preventDefault(); $('wsRedo').click(); }
    else if (e.key === 'Escape') closeWorkshop();
    return;
  }
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
  fillThemeSelect(); loadPreset(); fillWsStart();
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
