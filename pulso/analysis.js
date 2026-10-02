// Offline song analysis: onset detection, tempo, beat tracking and chart generation.
// Everything runs on the whole song before playing, so notes can be placed exactly.
const Analysis = (() => {
  const SR = 22050, N = 1024, HOP = 220, HOP_S = HOP / SR;
  const EDGES = [30, 120, 300, 800, 2000, 5000, 11000]; // 6 bands -> 6 lanes (bass left, treble right)
  const NB = EDGES.length - 1;
  const frameTime = f => (f * HOP + N / 2) / SR - HOP_S; // window centre, minus the flux lag bias

  const yieldUI = () => new Promise(r => setTimeout(r, 0));
  const std = a => {
    let m = 0; for (const v of a) m += v; m /= a.length || 1;
    let s = 0; for (const v of a) s += (v - m) ** 2;
    return Math.sqrt(s / (a.length || 1));
  };

  function makeFFT(n) {
    const levels = Math.log2(n), rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < levels; b++) r |= ((i >> b) & 1) << (levels - 1 - b);
      rev[i] = r;
    }
    const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(2 * Math.PI * i / n); sin[i] = -Math.sin(2 * Math.PI * i / n); }
    return (re, im) => {
      for (let i = 0; i < n; i++) {
        const j = rev[i];
        if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
      }
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >> 1, step = n / size;
        for (let i = 0; i < n; i += size) {
          for (let k = 0; k < half; k++) {
            const a = i + k, b = a + half, wr = cos[k * step], wi = sin[k * step];
            const tr = re[b] * wr - im[b] * wi, ti = re[b] * wi + im[b] * wr;
            re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
          }
        }
      }
    };
  }

  // Move an onset to the exact attack: the small window whose energy jumps most vs. the ~23 ms before it.
  function refine(x, t) {
    const S = 64, STEP = 16, BASE = 8;
    const from = Math.max(S * BASE, Math.floor((t - 0.05) * SR));
    const to = Math.min(x.length - S, Math.floor((t + 0.035) * SR));
    const energy = i => { let s = 0; for (let k = i; k < i + S; k++) s += x[k] * x[k]; return s; };
    let bestR = 0, bestI = -1;
    for (let i = from; i <= to; i += STEP) {
      let prev = 0;
      for (let k = 1; k <= BASE; k++) prev += energy(i - k * S);
      const r = energy(i) / (prev / BASE + 1e-7);
      if (r > bestR) { bestR = r; bestI = i; }
    }
    return bestR > 1.4 ? (bestI + S / 4) / SR : t;
  }

  async function analyze(buffer, onProgress = () => {}) {
    // Mono, 22 kHz (properly filtered by the browser's resampler).
    const off = new OfflineAudioContext(1, Math.ceil(buffer.duration * SR), SR);
    const src = off.createBufferSource();
    src.buffer = buffer; src.connect(off.destination); src.start();
    const x = (await off.startRendering()).getChannelData(0);

    const frames = Math.max(8, Math.floor((x.length - N) / HOP));
    const fft = makeFFT(N);
    const win = new Float64Array(N).map((_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (N - 1)));
    const binHz = SR / N;
    const bins = [];
    for (let b = 0; b < NB; b++) bins.push([Math.max(1, Math.round(EDGES[b] / binHz)), Math.round(EDGES[b + 1] / binHz)]);
    const logE = Array.from({ length: NB }, () => new Float32Array(frames));
    const rms = new Float32Array(frames);
    const re = new Float64Array(N), im = new Float64Array(N);

    for (let f = 0; f < frames; f++) {
      const o = f * HOP;
      let sq = 0;
      for (let i = 0; i < N; i++) { const v = x[o + i] || 0; sq += v * v; re[i] = v * win[i]; im[i] = 0; }
      rms[f] = Math.sqrt(sq / N);
      fft(re, im);
      for (let b = 0; b < NB; b++) {
        let s = 0;
        for (let k = bins[b][0]; k < bins[b][1]; k++) s += re[k] * re[k] + im[k] * im[k];
        logE[b][f] = Math.log10(1e-9 + s);
      }
      if ((f & 2047) === 0) { onProgress(0.9 * f / frames); await yieldUI(); }
    }

    // Spectral flux per band, each band normalised so treble counts as much as bass.
    const flux = logE.map(L => {
      const F = new Float32Array(frames);
      for (let f = 2; f < frames; f++) F[f] = Math.max(0, L[f] - L[f - 2]);
      const s = std(F) || 1;
      for (let f = 0; f < frames; f++) F[f] /= s;
      return F;
    });
    const raw = new Float32Array(frames);
    for (let f = 0; f < frames; f++) for (let b = 0; b < NB; b++) raw[f] += flux[b][f];
    const env = new Float32Array(frames);
    for (let f = 1; f < frames - 1; f++) env[f] = 0.25 * raw[f - 1] + 0.5 * raw[f] + 0.25 * raw[f + 1];
    const es = std(env) || 1;
    for (let f = 0; f < frames; f++) env[f] /= es;

    // Silence gate
    const sorted = Float32Array.from(rms).sort();
    const loud = sorted[Math.floor(sorted.length * 0.9)] || 0;
    const active = f => rms[Math.max(0, Math.min(frames - 1, f))] > loud * 0.08;

    // Tempo: autocorrelation of the onset envelope, weighted towards ~120 BPM.
    let mean = 0; for (const v of env) mean += v; mean /= frames;
    const minLag = Math.max(2, Math.floor(60 / 200 / HOP_S)), maxLag = Math.min(frames - 2, Math.ceil(60 / 60 / HOP_S));
    const ac = new Float64Array(maxLag + 2);
    for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
      let s = 0;
      for (let i = 0; i + lag < frames; i++) s += (env[i] - mean) * (env[i + lag] - mean);
      ac[lag] = s;
    }
    let bestLag = minLag, bestV = -Infinity;
    for (let lag = minLag; lag <= maxLag; lag++) {
      const bpm = 60 / (lag * HOP_S);
      const v = ac[lag] * Math.exp(-0.5 * (Math.log2(bpm / 120) / 0.9) ** 2);
      if (v > bestV) { bestV = v; bestLag = lag; }
    }
    const a = ac[bestLag - 1], b = ac[bestLag], c = ac[bestLag + 1];
    const den = a - 2 * b + c;
    const period = bestLag + (den ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den)) : 0);
    onProgress(0.93); await yieldUI();

    // Beat tracking by dynamic programming (Ellis 2007): beats land on strong onsets, spaced ~one period.
    const lo = Math.max(1, Math.round(period / 2)), hi = Math.round(period * 2);
    const pen = new Float32Array(hi + 1);
    for (let d = lo; d <= hi; d++) pen[d] = -100 * Math.log(d / period) ** 2;
    const score = new Float32Array(frames), back = new Int32Array(frames).fill(-1);
    for (let t = 0; t < frames; t++) {
      let bv = -Infinity, bi = -1;
      for (let d = lo; d <= hi && t - d >= 0; d++) {
        const v = score[t - d] + pen[d];
        if (v > bv) { bv = v; bi = t - d; }
      }
      if (bi >= 0 && bv > 0) { score[t] = env[t] + bv; back[t] = bi; } else score[t] = env[t];
    }
    let end = frames - 1;
    for (let t = Math.max(0, frames - hi); t < frames; t++) if (score[t] > score[end]) end = t;
    const beatFrames = [];
    for (let t = end; t >= 0; t = back[t]) beatFrames.push(t);
    beatFrames.reverse();
    const beats = beatFrames.filter(active).map(f => ({ f, t: frameTime(f) }));
    onProgress(0.96); await yieldUI();

    // Onset peaks: local maxima clearly above the surrounding half second.
    const P = new Float64Array(frames + 1);
    for (let f = 0; f < frames; f++) P[f + 1] = P[f] + env[f];
    const M = Math.round(0.5 / HOP_S), Wn = 3;
    const onsets = [];
    for (let f = Wn; f < frames - Wn; f++) {
      const v = env[f];
      let isPeak = true;
      for (let k = f - Wn; k <= f + Wn; k++) if (env[k] > v || (env[k] === v && k < f)) { isPeak = false; break; }
      if (!isPeak || !active(f)) continue;
      const l = Math.max(0, f - M), r = Math.min(frames, f + M);
      const s = v - (P[r] - P[l]) / (r - l);
      if (s < 0.35) continue;
      onsets.push({ t: refine(x, frameTime(f)), s, bands: flux.map(F => F[f]) });
    }
    onProgress(1);

    return { bpm: 60 / (period * HOP_S), duration: buffer.duration, beats, onsets };
  }

  const DIFF = {
    easy:   { sub: 1, minGap: 0.30, need: [0.0, Infinity, Infinity], chord: Infinity },
    normal: { sub: 2, minGap: 0.18, need: [0.0, 0.9, Infinity], chord: 2.4, chordGap: 3 },
    hard:   { sub: 4, minGap: 0.105, need: [0.0, 0.5, 1.0], chord: 1.6, chordGap: 1.2 },
  };

  // Notes go on real onsets that sit on the beat grid (beats, halves, quarters by difficulty).
  function chart(an, diff) {
    const cfg = DIFF[diff];
    const { onsets } = an;
    let beats = an.beats;
    if (diff === 'easy' && an.bpm > 140) beats = beats.filter((_, i) => i % 2 === 0);

    const nearest = (t, tol) => {
      let lo = 0, hi = onsets.length - 1;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (onsets[mid].t < t) lo = mid + 1; else hi = mid; }
      let best = null;
      for (const i of [lo - 1, lo]) {
        const o = onsets[i];
        if (o && Math.abs(o.t - t) <= tol && (!best || Math.abs(o.t - t) < Math.abs(best.t - t))) best = o;
      }
      return best;
    };

    const out = [];
    let lastT = -1, lastLane = -1, lastChord = -Infinity;
    for (let i = 0; i < beats.length; i++) {
      const b0 = beats[i].t;
      const b1 = i + 1 < beats.length ? beats[i + 1].t : b0 + 60 / an.bpm;
      const step = (b1 - b0) / cfg.sub;
      for (let k = 0; k < cfg.sub; k++) {
        const kind = k === 0 ? 0 : k * 2 === cfg.sub ? 1 : 2;
        const o = nearest(b0 + k * step, Math.min(0.07, step * 0.4));
        if (!o || o.s < cfg.need[kind] || o.t - lastT < cfg.minGap) continue;
        const order = o.bands.map((v, j) => [v, j]).sort((p, q) => q[0] - p[0]);
        let lane = order[0][1];
        if (lane === lastLane && o.t - lastT < 0.35) lane = order[1][1];
        out.push({ t: o.t, lane });
        // Chord: a strong hit with energy on both hands
        const other = order.find(([, j]) => (j < 3) !== (lane < 3));
        if (kind === 0 && o.s >= cfg.chord && o.t - lastChord >= cfg.chordGap && other && other[0] >= order[0][0] * 0.7) {
          out.push({ t: o.t, lane: other[1] });
          lastChord = o.t;
        }
        lastT = o.t; lastLane = lane;
      }
    }
    return out;
  }

  return { analyze, chart };
})();
