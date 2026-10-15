/**
 * ThroatEngine — a full articulatory speech synthesizer.
 *
 * A digital recreation of the human voice-production chain:
 *
 *   LUNGS (air pressure)
 *     -> GLOTTIS / VOCAL FOLDS (LF glottal-pulse source)
 *        voiced tone, breathiness (adduction), pitch (tension), fry (creak)
 *     -> VOCAL TRACT (44-cell Kelly-Lochbaum waveguide)
 *        tongue/jaw/lips/velum shape the resonances -> formants
 *        + turbulence noise (sibilants) + transients (plosives)
 *     -> LIP RADIATION -> sound
 *
 * Based on Neil Thapen's Pink Trombone (MIT, chdh/pink-trombone-mod port).
 * Adapted so a 1B LLM can drive every parameter: the LLM's muscle channels
 * (air, tension, adduction, fry, jaw, pucker, tongue, velum) are the inputs,
 * and its words are phonemized to schedule the articulators.
 */

"use strict";

// ---------------------------------------------------------------------------
// Deterministic PRNG + simplex noise (needed for natural jitter/breathiness)
// ---------------------------------------------------------------------------
class SimplexNoise {
  constructor(seed = 1337) {
    const p = [
      151,160,137,91,90,15,131,13,201,95,96,53,194,233,7,225,140,36,103,30,
      69,142,8,99,37,240,21,10,23,190,6,148,247,120,234,75,0,26,197,62,94,
      252,219,203,117,35,11,32,57,177,33,88,237,149,56,87,174,20,125,136,
      171,168,68,175,74,165,71,134,139,48,27,166,77,146,158,231,83,111,229,
      122,60,211,133,230,220,105,92,41,55,46,245,40,244,102,143,54,65,25,63,
      161,1,216,80,73,209,76,132,187,208,89,18,169,200,196,135,130,116,188,
      159,86,164,100,109,198,173,186,3,64,52,217,226,250,124,123,5,202,38,
      147,118,126,255,82,85,212,207,206,59,227,47,16,58,17,182,189,28,42,223,
      183,170,213,119,248,152,2,44,154,163,70,221,153,101,155,167,43,172,9,
      129,22,39,253,19,98,108,110,79,113,224,232,178,185,112,104,218,246,97,
      228,251,34,242,193,238,210,144,12,191,179,162,241,81,51,145,235,249,14,
      239,107,49,192,214,31,181,199,106,157,184,84,204,176,115,121,50,45,127,
      4,150,254,138,236,205,93,222,114,67,29,24,72,243,141,128,195,78,66,215,
      61,156,180
    ];
    const perm = new Array(512);
    const grad = [[1,1,0],[-1,1,0],[1,-1,0],[-1,-1,0],[1,0,1],[-1,0,1],[1,0,-1],
      [-1,0,-1],[0,1,1],[0,-1,1],[0,1,-1],[0,-1,-1]];
    const gradP = new Array(512);
    let s = seed | 0;
    for (let i = 0; i < 256; i++) {
      let v = p[i] ^ ((i & 1) ? (s & 255) : ((s >> 8) & 255));
      perm[i] = perm[i + 256] = v;
      gradP[i] = gradP[i + 256] = grad[v % 12];
    }
    this.perm = perm;
    this.gradP = gradP;
    this.grad = grad;
  }
  noise(xin, yin = 0) {
    const { perm, gradP, grad } = this;
    const f2 = 0.5 * (Math.sqrt(3) - 1);
    const g2 = (3 - Math.sqrt(3)) / 6;
    const s = (xin + yin) * f2;
    let i = Math.floor(xin + s);
    let j = Math.floor(yin + s);
    const t = (i + j) * g2;
    const x0 = xin - i + t;
    const y0 = yin - j + t;
    let i1, j1;
    if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }
    const x1 = x0 - i1 + g2, y1 = y0 - j1 + g2;
    const x2 = x0 - 1 + 2 * g2, y2 = y0 - 1 + 2 * g2;
    i &= 255; j &= 255;
    const gi0 = gradP[i + perm[j]], gi1 = gradP[i + i1 + perm[j + j1]], gi2 = gradP[i + 1 + perm[j + 1]];
    let n0 = 0, n1 = 0, n2 = 0;
    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 >= 0) { t0 *= t0; n0 = t0 * t0 * (gi0[0] * x0 + gi0[1] * y0); }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 >= 0) { t1 *= t1; n1 = t1 * t1 * (gi1[0] * x1 + gi1[1] * y1); }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 >= 0) { t2 *= t2; n2 = t2 * t2 * (gi2[0] * x2 + gi2[1] * y2); }
    return 70 * (n0 + n1 + n2);
  }
}

// ---------------------------------------------------------------------------
// Filtered noise source (for aspiration + fricatives)
// ---------------------------------------------------------------------------
function createBandPass(f0, q, sampleRate) {
  const w0 = 2 * Math.PI * f0 / sampleRate;
  const alpha = Math.sin(w0) / (2 * q);
  const b0 = alpha, b1 = 0, b2 = -alpha;
  const a0 = 1 + alpha, a1 = -2 * Math.cos(w0), a2 = 1 - alpha;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  return (x) => {
    const y = (b0 * x + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    return y;
  };
}

// ---------------------------------------------------------------------------
// GLOTTIS — the vocal folds
//   tension   -> fundamental frequency (f0)
//   adduction -> tenseness (0 whisper / 100 crisp voicing)
//   air       -> intensity (loudness)
//   fry       -> creaky voice (jitter + subharmonic drop)
// ---------------------------------------------------------------------------
class Glottis {
  constructor(sampleRate) {
    this.sampleRate = sampleRate;
    this.noise = new SimplexNoise(0x1234);
    this.aspiration = createBandPass(500, 0.5, sampleRate);

    // control targets (0..1)
    this.tensionTarget = 0.5;
    this.adductionTarget = 0.8;
    this.airTarget = 0.6;
    this.fryTarget = 0.0;

    // smoothed state
    this.intensity = 0;
    this.smoothFrequency = 140;
    this.oldFrequency = 140;
    this.newFrequency = 140;
    this.oldTenseness = 0.6;
    this.newTenseness = 0.6;
    this.sampleCount = 0;
    this.timeInWaveform = 0;
    this.waveformLength = 1 / 140;
    this.loudness = 1;
    this.alpha = 0; this.e0 = 0; this.epsilon = 0; this.shift = 0;
    this.delta = 1; this.te = 0; this.omega = 0;
    this.freqJitter = 0;
    this.setupWaveform(0);
  }

  setTargets({ tension = 0.5, adduction = 0.8, air = 0.6, fry = 0.0 }) {
    this.tensionTarget = tension;
    this.adductionTarget = adduction;
    this.airTarget = air;
    this.fryTarget = fry;
  }

  get f0Hz() {
    // map tension 0..1 -> 55..270 Hz
    return 55 + Math.pow(this.tensionTarget, 1.4) * 215;
  }

  adjustParameters(deltaTime) {
    // smooth toward targets
    const attack = this.airTarget > this.intensity ? 0.25 : 0.12;
    this.intensity += (this.airTarget - this.intensity) * Math.min(1, attack * deltaTime * 20);
    this.intensity = Math.max(0, Math.min(1, this.intensity));

    // vocal fry: irregular jitter on frequency (creak) + subharmonic feel
    const t = this.sampleCount / this.sampleRate;
    const jitter = this.noise.noise(t * 60) * 0.02;
    this.freqJitter = jitter * (1 + this.fryTarget * 6) + this.fryTarget * this.noise.noise(t * 31);

    const targetFreq = this.f0Hz * (1 + this.freqJitter) * (1 - this.fryTarget * 0.45);
    if (this.intensity === 0) {
      this.smoothFrequency = targetFreq;
    } else if (targetFreq > this.smoothFrequency) {
      this.smoothFrequency = Math.min(this.smoothFrequency * (1 + 0.1 * deltaTime * 60), targetFreq);
    } else if (targetFreq < this.smoothFrequency) {
      this.smoothFrequency = Math.max(this.smoothFrequency / (1 + 0.1 * deltaTime * 60), targetFreq);
    }

    // vibrato + natural drift
    const vib = 0.005 * Math.sin(2 * Math.PI * t * 6)
      + 0.02 * this.noise.noise(t * 4.07) + 0.04 * this.noise.noise(t * 2.15)
      + 0.2 * this.noise.noise(t * 0.98) + 0.4 * this.noise.noise(t * 0.5);

    this.oldFrequency = this.newFrequency;
    this.newFrequency = Math.max(10, this.smoothFrequency * (1 + vib));

    // tenseness: adduction drives voicing quality, fry makes it creaky-harsh
    let tenseness = this.adductionTarget;
    tenseness = Math.max(0, tenseness + 0.1 * this.noise.noise(t * 0.46) + 0.05 * this.noise.noise(t * 0.36));
    tenseness = Math.min(1, tenseness * (1 - this.fryTarget * 0.35) + this.fryTarget * 0.2);
    this.oldTenseness = this.newTenseness;
    this.newTenseness = tenseness;
  }

  step(lambda) {
    const time = this.sampleCount / this.sampleRate;
    if (this.timeInWaveform > this.waveformLength) {
      this.timeInWaveform -= this.waveformLength;
      this.setupWaveform(lambda);
    }
    const out1 = this.normalizedLFWaveform(this.timeInWaveform / this.waveformLength);
    // breathiness: more noise when adduction is low (whisper / aspirate)
    const breathiness = (1 - this.adductionTarget);
    const aspiration1 = this.intensity * breathiness * this.getNoiseModulator() * this.aspiration(Math.random() * 2 - 1);
    const aspiration2 = aspiration1 * (0.2 + 0.02 * this.noise.noise(time * 1.99));
    this.sampleCount++;
    this.timeInWaveform += 1 / this.sampleRate;
    return out1 + aspiration2;
  }

  getNoiseModulator() {
    const voiced = 0.1 + 0.2 * Math.max(0, Math.sin(Math.PI * 2 * this.timeInWaveform / this.waveformLength));
    const tenseness = this.newTenseness;
    return tenseness * this.intensity * voiced + (1 - tenseness * this.intensity) * 0.3;
  }

  // LF (Liljencrants-Fant) glottal waveform setup
  setupWaveform(lambda) {
    const freq = this.oldFrequency + (this.newFrequency - this.oldFrequency) * lambda;
    const tenseness = this.oldTenseness + (this.newTenseness - this.oldTenseness) * lambda;
    this.waveformLength = 1 / Math.max(10, freq);
    this.loudness = Math.pow(Math.max(0, tenseness), 0.25);
    const rd = Math.min(2.7, Math.max(0.5, 3 * (1 - tenseness)));
    const ra = -0.01 + 0.048 * rd;
    const rk = 0.224 + 0.118 * rd;
    const rg = (rk / 4) * (0.5 + 1.2 * rk) / (0.11 * rd - ra * (0.5 + 1.2 * rk));
    const ta = ra;
    const tp = 1 / (2 * rg);
    const te = tp + tp * rk;
    const epsilon = 1 / ta;
    const shift = Math.exp(-epsilon * (1 - te));
    const delta = 1 - shift;
    const rhsIntegral = ((1 / epsilon) * (shift - 1) + (1 - te) * shift) / delta;
    const totalLowerIntegral = rhsIntegral - (te - tp) / 2;
    const totalUpperIntegral = -totalLowerIntegral;
    const omega = Math.PI / tp;
    const s = Math.sin(omega * te);
    const y = -Math.PI * s * totalUpperIntegral / (tp * 2);
    const z = Math.log(y);
    const alpha = z / (tp / 2 - te);
    const e0 = -1 / (s * Math.exp(alpha * te));
    this.alpha = alpha; this.e0 = e0; this.epsilon = epsilon;
    this.shift = shift; this.delta = delta; this.te = te; this.omega = omega;
  }

  normalizedLFWaveform(t) {
    let output;
    if (t > this.te) {
      output = (-Math.exp(-this.epsilon * (t - this.te)) + this.shift) / this.delta;
    } else {
      output = this.e0 * Math.exp(this.alpha * t) * Math.sin(this.omega * t);
    }
    return output * this.intensity * this.loudness;
  }
}

// ---------------------------------------------------------------------------
// VOCAL TRACT — 44-cell digital waveguide + nasal tract
// ---------------------------------------------------------------------------
class Tract {
  constructor(glottis, tractSampleRate) {
    this.glottis = glottis;
    this.sampleRate = tractSampleRate;
    this.n = 44;
    this.bladeStart = 10;
    this.tipStart = 32;
    this.lipStart = 39;
    this.noseLength = 28;
    this.noseStart = this.n - this.noseLength + 1; // 17
    this.glottalReflection = 0.75;
    this.lipReflection = -0.85;
    this.sampleCount = 0;
    this.time = 0;

    this.diameter = new Float64Array(this.n);
    this.right = new Float64Array(this.n);
    this.left = new Float64Array(this.n);
    this.reflection = new Float64Array(this.n);
    this.newReflection = new Float64Array(this.n);
    this.junctionOutputRight = new Float64Array(this.n);
    this.junctionOutputLeft = new Float64Array(this.n + 1);
    this.maxAmplitude = new Float64Array(this.n);

    this.noseDiameter = new Float64Array(this.noseLength);
    this.noseRight = new Float64Array(this.noseLength);
    this.noseLeft = new Float64Array(this.noseLength);
    this.noseReflection = new Float64Array(this.noseLength);
    this.noseJunctionOutputRight = new Float64Array(this.noseLength);
    this.noseJunctionOutputLeft = new Float64Array(this.noseLength + 1);
    this.noseMaxAmplitude = new Float64Array(this.noseLength);

    this.transients = [];
    this.turbulencePoints = [];
    this.fricationNoise = createBandPass(1000, 0.5, tractSampleRate);

    this.reflectionLeft = 0; this.reflectionRight = 0; this.reflectionNose = 0;
    this.newReflectionLeft = 0; this.newReflectionRight = 0; this.newReflectionNose = 0;

    this.calculateNoseReflections();
  }

  calculateNoseReflections() {
    const a = new Float64Array(this.noseLength);
    for (let i = 0; i < this.noseLength; i++) a[i] = Math.max(1e-6, this.noseDiameter[i] ** 2);
    for (let i = 1; i < this.noseLength; i++) {
      this.noseReflection[i] = (a[i - 1] - a[i]) / (a[i - 1] + a[i]);
    }
  }

  calculateNewBlockParameters() {
    // main tract reflections
    const a = new Float64Array(this.n);
    for (let i = 0; i < this.n; i++) a[i] = this.diameter[i] ** 2;
    for (let i = 1; i < this.n; i++) {
      this.reflection[i] = this.newReflection[i];
      const sum = a[i - 1] + a[i];
      this.newReflection[i] = Math.abs(sum) > 1e-6 ? (a[i - 1] - a[i]) / sum : 1;
    }
    // nose junction
    this.reflectionLeft = this.newReflectionLeft;
    this.reflectionRight = this.newReflectionRight;
    this.reflectionNose = this.newReflectionNose;
    const velumA = this.noseDiameter[0] ** 2;
    const an0 = this.diameter[this.noseStart] ** 2;
    const an1 = this.diameter[this.noseStart + 1] ** 2;
    const sum = an0 + an1 + velumA;
    this.newReflectionLeft = Math.abs(sum) > 1e-6 ? (2 * an0 - sum) / sum : 1;
    this.newReflectionRight = Math.abs(sum) > 1e-6 ? (2 * an1 - sum) / sum : 1;
    this.newReflectionNose = Math.abs(sum) > 1e-6 ? (2 * velumA - sum) / sum : 1;
  }

  step(glottalOutput, lambda) {
    this.processTransients();
    this.addTurbulenceNoise();

    this.junctionOutputRight[0] = this.left[0] * this.glottalReflection + glottalOutput;
    this.junctionOutputLeft[this.n] = this.right[this.n - 1] * this.lipReflection;

    for (let i = 1; i < this.n; i++) {
      const r = this.reflection[i] + (this.newReflection[i] - this.reflection[i]) * lambda;
      const w = r * (this.right[i - 1] + this.left[i]);
      this.junctionOutputRight[i] = this.right[i - 1] - w;
      this.junctionOutputLeft[i] = this.left[i] + w;
    }

    // nose junction
    {
      const i = this.noseStart;
      let r = this.reflectionLeft + (this.newReflectionLeft - this.reflectionLeft) * lambda;
      this.junctionOutputLeft[i] = r * this.right[i - 1] + (1 + r) * (this.noseLeft[0] + this.left[i]);
      r = this.reflectionRight + (this.newReflectionRight - this.reflectionRight) * lambda;
      this.junctionOutputRight[i] = r * this.left[i] + (1 + r) * (this.right[i - 1] + this.noseLeft[0]);
      r = this.reflectionNose + (this.newReflectionNose - this.reflectionNose) * lambda;
      this.noseJunctionOutputRight[0] = r * this.noseLeft[0] + (1 + r) * (this.left[i] + this.right[i - 1]);
    }

    for (let i = 0; i < this.n; i++) {
      const right = this.junctionOutputRight[i] * 0.999;
      const left = this.junctionOutputLeft[i + 1] * 0.999;
      this.right[i] = right;
      this.left[i] = left;
      const amplitude = Math.abs(right + left);
      this.maxAmplitude[i] = Math.max(this.maxAmplitude[i] * 0.9999, amplitude);
    }

    const lipOutput = this.right[this.n - 1];

    this.noseJunctionOutputLeft[this.noseLength] = this.noseRight[this.noseLength - 1] * this.lipReflection;
    for (let i = 1; i < this.noseLength; i++) {
      const w = this.noseReflection[i] * (this.noseRight[i - 1] + this.noseLeft[i]);
      this.noseJunctionOutputRight[i] = this.noseRight[i - 1] - w;
      this.noseJunctionOutputLeft[i] = this.noseLeft[i] + w;
    }
    for (let i = 0; i < this.noseLength; i++) {
      const right = this.noseJunctionOutputRight[i];
      const left = this.noseJunctionOutputLeft[i + 1];
      this.noseRight[i] = right;
      this.noseLeft[i] = left;
    }
    const noseOutput = this.noseRight[this.noseLength - 1];

    this.sampleCount++;
    this.time = this.sampleCount / this.sampleRate;
    return lipOutput + noseOutput;
  }

  processTransients() {
    for (let i = this.transients.length - 1; i >= 0; i--) {
      const tr = this.transients[i];
      const alive = this.time - tr.startTime;
      if (alive > tr.lifeTime) { this.transients.splice(i, 1); continue; }
      const amp = tr.strength * Math.pow(2, -tr.exponent * alive);
      this.right[tr.position] += amp / 2;
      this.left[tr.position] += amp / 2;
    }
  }

  addTurbulenceNoise() {
    const attack = 0.1;
    for (const p of this.turbulencePoints) {
      if (p.position < 2 || p.position > this.n || p.diameter <= 0) continue;
      let intensity;
      if (isNaN(p.endTime)) {
        intensity = Math.min(1, Math.max(0, (this.time - p.startTime) / attack));
      } else {
        intensity = Math.min(1, Math.max(0, 1 - (this.time - p.endTime) / attack));
      }
      if (intensity <= 0) continue;
      const turbNoise = 0.66 * this.fricationNoise(Math.random() * 2 - 1) * intensity * this.glottis.getNoiseModulator();
      this.addTurbulenceAt(turbNoise, p.position, p.diameter);
    }
  }

  addTurbulenceAt(noise, position, diameter) {
    const i = Math.floor(position);
    const delta = position - i;
    const thinness = Math.min(1, Math.max(0, 8 * (0.7 - diameter)));
    const openness = Math.min(1, Math.max(0, 30 * (diameter - 0.3)));
    const n0 = noise * (1 - delta) * thinness * openness;
    const n1 = noise * delta * thinness * openness;
    if (i + 1 < this.n) { this.right[i + 1] += n0 / 2; this.left[i + 1] += n0 / 2; }
    if (i + 2 < this.n) { this.right[i + 2] += n1 / 2; this.left[i + 2] += n1 / 2; }
  }
}

// ---------------------------------------------------------------------------
// ARTICULATOR — maps muscles + phonemes onto tract diameters
// ---------------------------------------------------------------------------
const TRACT_N = 44;
const BLADE = 10, TIP = 32, LIP = 39, NOSE_START = 17;

class Articulator {
  constructor(tract) {
    this.tract = tract;
    this.targetDiameter = new Float64Array(TRACT_N);
    this.velumTarget = 0.01;
    this.tongueIndex = 12.9;
    this.tongueDiameter = 2.43;
    this.restShape();
    this.applyRest();
  }

  restShape() {
    for (let i = 0; i < TRACT_N; i++) {
      this.targetDiameter[i] = this.getRestDiameter(i);
    }
  }

  getRestDiameter(i) {
    if (i < 7) return 0.6;
    if (i < BLADE) return 1.1;
    if (i >= LIP) return 1.5;
    const t = 1.1 * Math.PI * (this.tongueIndex - i) / (TIP - BLADE);
    const fixed = 2 + (this.tongueDiameter - 2) / 1.5;
    let curve = (1.5 - fixed + 1.7) * Math.cos(t);
    if (i === BLADE - 2 || i === LIP - 1) curve *= 0.8;
    if (i === BLADE || i === LIP - 2) curve *= 0.94;
    return 1.5 - curve;
  }

  setShape({ jaw = 0.3, pucker = 0.05, tongue = 0.5, velum = 0.0, lips = 1.0 }) {
    // tongue position: 0 = low-back "ah", 1 = high-front "ee"
    this.tongueIndex = 17 + tongue * 15;              // 17..32
    this.tongueDiameter = 3.4 - jaw * 0.6 - tongue * 1.2;   // open/back -> bigger
    // lips: pucker closes the lip opening, jaw opens it
    const lipDiam = Math.min(3.0, Math.max(0.15, lips * (0.5 + jaw * 0.8) - pucker * 1.2));
    this.velumTarget = 0.01 + velum * 0.4;

    for (let i = 0; i < TRACT_N; i++) {
      let d = this.getRestDiameter(i);
      // lip constriction at the very end
      if (i >= LIP) {
        d = Math.min(d, Math.max(0.1, lipDiam));
      }
      this.targetDiameter[i] = d;
    }
  }

  setConstriction(index, diameter) {
    // a temporary narrowing anywhere in the tract (for consonants)
    if (index >= 0 && index < TRACT_N) {
      this.targetDiameter[Math.floor(index)] = Math.max(0.01, diameter);
    }
  }

  applyRest() {
    for (let i = 0; i < TRACT_N; i++) {
      this.tract.diameter[i] = this.targetDiameter[i];
    }
  }

  adjust(deltaTime) {
    const amount = deltaTime * 15; // movement speed cm/s
    for (let i = 0; i < TRACT_N; i++) {
      const cur = this.tract.diameter[i];
      const tgt = this.targetDiameter[i];
      this.tract.diameter[i] = cur < tgt
        ? Math.min(cur + 2 * amount, tgt)
        : Math.max(cur - 0.6 * amount, tgt);
    }
    // velum
    const vcur = this.tract.noseDiameter[0];
    this.tract.noseDiameter[0] = vcur < this.velumTarget
      ? Math.min(vcur + amount * 0.1, this.velumTarget)
      : Math.max(vcur - amount * 0.25, this.velumTarget);
  }
}

// ---------------------------------------------------------------------------
// PHONEMIZER — crude grapheme->phoneme so words make real sounds
// ---------------------------------------------------------------------------
// Each phone: { idx: tract index for constriction (or -1), d: constriction diameter,
//              lip: lip diameter target, tongue: tongue position, velum: nasality }
const PHONES = {
  // vowels (tongue + lip)
  'ee': { tongue: 0.95, lip: 1.2, velum: 0, voiced: true },
  'ih': { tongue: 0.80, lip: 1.2, velum: 0, voiced: true },
  'eh': { tongue: 0.55, lip: 1.3, velum: 0, voiced: true },
  'ae': { tongue: 0.40, lip: 1.5, velum: 0, voiced: true },
  'ah': { tongue: 0.25, lip: 1.6, velum: 0, voiced: true },
  'uh': { tongue: 0.15, lip: 1.1, velum: 0, voiced: true },
  'ao': { tongue: 0.20, lip: 0.8, velum: 0, voiced: true },
  'oo': { tongue: 0.10, lip: 0.4, velum: 0, voiced: true },
  'er': { tongue: 0.30, lip: 0.9, velum: 0, voiced: true },
  'ai': { tongue: 0.70, lip: 1.3, velum: 0, voiced: true },
  'oi': { tongue: 0.45, lip: 0.8, velum: 0, voiced: true },
  'ow': { tongue: 0.30, lip: 0.7, velum: 0, voiced: true },
  'aw': { tongue: 0.20, lip: 1.4, velum: 0, voiced: true },
  'schwa': { tongue: 0.40, lip: 1.0, velum: 0, voiced: true },
  // consonants (constriction)
  'p': { idx: 38, d: 0.0, velum: 0, voiced: false, plosive: true },
  'b': { idx: 38, d: 0.0, velum: 0, voiced: true, plosive: true },
  't': { idx: 30, d: 0.0, velum: 0, voiced: false, plosive: true },
  'd': { idx: 30, d: 0.0, velum: 0, voiced: true, plosive: true },
  'k': { idx: 18, d: 0.0, velum: 0, voiced: false, plosive: true },
  'g': { idx: 18, d: 0.0, velum: 0, voiced: true, plosive: true },
  's': { idx: 29, d: 0.35, velum: 0, voiced: false, fric: true },
  'z': { idx: 29, d: 0.35, velum: 0, voiced: true, fric: true },
  'sh': { idx: 32, d: 0.30, velum: 0, voiced: false, fric: true },
  'zh': { idx: 32, d: 0.30, velum: 0, voiced: true, fric: true },
  'f': { idx: 38, d: 0.20, velum: 0, voiced: false, fric: true },
  'v': { idx: 38, d: 0.20, velum: 0, voiced: true, fric: true },
  'th': { idx: 33, d: 0.25, velum: 0, voiced: false, fric: true },
  'dh': { idx: 33, d: 0.25, velum: 0, voiced: true, fric: true },
  'm': { idx: 38, d: 0.0, velum: 0.9, voiced: true, nasal: true },
  'n': { idx: 30, d: 0.0, velum: 0.9, voiced: true, nasal: true },
  'ng': { idx: 18, d: 0.0, velum: 0.9, voiced: true, nasal: true },
  'l': { idx: 30, d: 0.7, velum: 0, voiced: true },
  'r': { idx: 30, d: 0.8, velum: 0, voiced: true },
  'w': { tongue: 0.10, lip: 0.5, velum: 0, voiced: true },
  'y': { tongue: 0.90, lip: 1.3, velum: 0, voiced: true },
  'h': { tongue: 0.40, lip: 1.3, velum: 0, voiced: false, breathy: true },
};

// very small digraph table for the most common English spellings
function phonemize(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return [];
  const out = [];
  const digraphs = {
    'ee': 'ee', 'ea': 'ee', 'ie': 'ee', 'oo': 'oo', 'ou': 'ow', 'ow': 'ow',
    'oa': 'ow', 'ai': 'ai', 'ay': 'ai', 'ei': 'ai', 'sh': 'sh', 'ch': 'ch',
    'th': 'th', 'ph': 'f', 'wh': 'w', 'ck': 'k', 'ng': 'ng', 'er': 'er',
    'ar': 'ah', 'or': 'ao', 'ir': 'er', 'ur': 'er', 'aw': 'aw',
    'au': 'aw', 'oy': 'oi', 'oi': 'oi', 'qu': 'kw',
  };
  let i = 0;
  while (i < w.length) {
    const two = w.slice(i, i + 2);
    if (digraphs[two]) {
      const p = digraphs[two];
      if (p === 'kw') { out.push('k'); out.push('w'); }
      else if (p === 'ch') { out.push('t'); out.push('sh'); } // affricate
      else out.push(p);
      i += 2;
    } else {
      const c = w[i];
      let phone = c;
      if (c === 'a') phone = 'ae';
      else if (c === 'e') phone = 'eh';
      else if (c === 'i') phone = 'ih';
      else if (c === 'o') phone = 'ah';
      else if (c === 'u') phone = 'uh';
      else if (c === 'c') phone = 'k';
      else if (c === 'x') { out.push('k'); out.push('s'); i++; continue; }
      else if (c === 'q') { out.push('k'); out.push('w'); i++; continue; }
      else if (c === 'j') { out.push('d'); out.push('zh'); i++; continue; }
      else if (c === 'y') phone = 'y';
      else if (c === 'g') phone = 'g';
      out.push(phone);
      i++;
    }
  }
  // final silent-e simplification: drop trailing schwa-ish e
  if (out.length > 1 && out[out.length - 1] === 'eh' && w.endsWith('e')) {
    out.pop();
  }
  return out;
}

// ---------------------------------------------------------------------------
// THROAT ENGINE — ties it all together, LLM-muscle driven
// ---------------------------------------------------------------------------
class ThroatEngine {
  constructor(sampleRate = 44100) {
    this.sampleRate = sampleRate;
    this.glottis = new Glottis(sampleRate);
    this.tract = new Tract(this.glottis, sampleRate * 2);
    this.articulator = new Articulator(this.tract);
    this.tractSampleRate = sampleRate * 2;

    // phone scheduling state
    this.phoneQueue = [];     // {phone, dur, idx, d, lip, tongue, velum}
    this.phoneIndex = 0;
    this.phoneTimeLeft = 0;
    this.currentMuscles = { jaw: 0.3, smile: 0.2, pucker: 0.05, brows: 0.5,
      upperLip: 0, lowerLip: 0, squint: 0, air: 0.55, tension: 0.5,
      adduction: 0.75, velum: 0.05, fry: 0.05, tongue: 0.5 };
    this.voiced = true;
    this._activePhone = null;
  }

  setMuscles(m) {
    this.currentMuscles = { ...this.currentMuscles, ...m };
  }

  /** Speak the words for this frame over `durationSec`. */
  speak(words, durationSec) {
    const clean = words.replace(/[*#]/g, "").trim();
    const phones = phonemize(clean);
    if (phones.length === 0) return;
    const per = durationSec / phones.length;
    this.phoneQueue = phones.map((p) => ({ phone: p, dur: per }));
    this.phoneIndex = 0;
    this.phoneTimeLeft = this.phoneQueue[0].dur;
    this._activePhone = null;
    this.tract.turbulencePoints.length = 0;
    this.tract.transients.length = 0;
  }

  stop() {
    this.phoneQueue = [];
    this.glottis.airTarget = 0;
    this.tract.turbulencePoints.length = 0;
    this.tract.transients.length = 0;
    this._activePhone = null;
  }

  // called once per output block; advances scheduling
  advance(deltaTime) {
    const m = this.currentMuscles;

    // drive glottis from the LLM's throat muscles
    this.glottis.setTargets({
      tension: m.tension,
      adduction: m.adduction,
      air: m.air * (this.phoneQueue.length ? 1 : 0.25),
      fry: m.fry,
    });

    // current phone (if any) -> articulation override
    let phoneArtic = null;
    if (this.phoneQueue.length > 0) {
      const idx = Math.min(this.phoneIndex, this.phoneQueue.length - 1);
      let cur = this.phoneQueue[idx];
      this.phoneTimeLeft -= deltaTime;
      if (this.phoneTimeLeft <= 0) {
        // advance to next phone
        this.phoneIndex++;
        if (this.phoneIndex >= this.phoneQueue.length) {
          this.phoneQueue = [];
          this.tract.turbulencePoints.length = 0;
          this.tract.transients.length = 0;
          this._activePhone = null;
          cur = null;
        } else {
          cur = this.phoneQueue[this.phoneIndex];
          this.phoneTimeLeft = cur.dur;
        }
      }
      if (cur) {
        const newArtic = PHONES[cur.phone] || null;
        if (newArtic !== this._activePhone) {
          // phone changed: silence old noise sources, then add the new phone's
          this.tract.transients.length = 0;
          if (this._activePhone && this._activePhone.plosive && this._activePhone.idx != null) {
            // release burst of the plosive we just left
            this.tract.transients.push({
              position: this._activePhone.idx, strength: 0.6,
              lifeTime: 0.03, exponent: 100, startTime: this.tract.time,
            });
          }
          this.tract.turbulencePoints.length = 0;
          if (newArtic && newArtic.fric && newArtic.idx != null) {
            this.tract.turbulencePoints.push({
              position: newArtic.idx, diameter: newArtic.d,
              startTime: this.tract.time, endTime: NaN,
            });
          }
          this._activePhone = newArtic;
        }
        phoneArtic = newArtic;
      }
    }

    // base articulation from LLM muscles
    this.articulator.setShape({
      jaw: m.jaw, pucker: m.pucker, tongue: m.tongue, velum: m.velum,
      lips: 1 - m.smile * 0.3 + m.pucker * 0.4,
    });

    // phone overrides
    if (phoneArtic) {
      if (phoneArtic.tongue != null) {
        this.articulator.setShape({
          jaw: m.jaw, pucker: m.pucker, tongue: phoneArtic.tongue,
          velum: phoneArtic.velum != null ? phoneArtic.velum : m.velum,
          lips: phoneArtic.lip != null ? phoneArtic.lip : 1.0,
        });
      }
      if (phoneArtic.idx != null && phoneArtic.d > 0) {
        this.articulator.setConstriction(phoneArtic.idx, phoneArtic.d);
      }
      if (phoneArtic.idx != null && phoneArtic.d === 0) {
        this.articulator.setConstriction(phoneArtic.idx, 0.01); // closure
      }
      if (phoneArtic.nasal) {
        this.articulator.velumTarget = 0.4;
      }
      // unvoiced consonants: drop tenseness (aspirate) or keep voiced
      if (phoneArtic.voiced === false) {
        this.glottis.setTargets({ tension: m.tension, adduction: 0.15, air: m.air, fry: 0 });
      }
    }

    this.glottis.adjustParameters(deltaTime);
    this.articulator.adjust(deltaTime);
    this.tract.calculateNewBlockParameters();
  }

  /** Render `n` samples of audio into `output` (Float32Array). */
  render(output) {
    const n = output.length;
    const block = 64;
    for (let i = 0; i < n; i++) {
      // advance block parameters + phone scheduling every 64 samples (~1.45ms)
      if (i % block === 0) {
        this.advance(block / this.sampleRate);
      }
      const lambda1 = (i % block) / block;
      const lambda2 = ((i % block) + 0.5) / block;
      const glottalOutput = this.glottis.step(lambda1);
      const out1 = this.tract.step(glottalOutput, lambda1);
      const out2 = this.tract.step(glottalOutput, lambda2);
      output[i] = (out1 + out2) * 0.125;
    }
    return output;
  }
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { ThroatEngine, phonemize, PHONES };
}
