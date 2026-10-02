'use strict';
// ---------- Config ----------
const LANES = 6;
const COLORS = ['#ff3d81', '#ff7a3d', '#ffc83d', '#3dffb5', '#3db8ff', '#a07dff'];
const LABELS = ['A', 'S', 'D', 'J', 'K', 'L'];
const KEYMAP = { a: 0, s: 1, d: 2, j: 3, k: 4, l: 5 };
const WINDOWS = { perfect: 0.045, great: 0.09, good: 0.15 };
const NEAR_MISS = 0.35; // pressed near a note but outside the window: show "cedo"/"tarde"
const POINTS = { perfect: 300, great: 200, good: 100 };
const HEAL = { perfect: 0.02, great: 0.014, good: 0.004, miss: -0.09 };
const BASE_BPM = 96, BPM_STEP = 12, MAX_BPM = 192, BARS_PER_LEVEL = 8;
const LOOKAHEAD = 2.6; // seconds of chart generated ahead (classic mode)
const DIFFS = { easy: { speed: 0.6, label: 'FÁCIL' }, normal: { speed: 0.75, label: 'NORMAL' }, hard: { speed: 0.95, label: 'DIFÍCIL' } };

// A minor: Am - F - C - G. Six chord tones per bar, one per lane, low -> high.
const PROG = [
  { root: 45, pad: [57, 60, 64], lanes: [64, 69, 72, 76, 81, 84] },
  { root: 41, pad: [53, 57, 60], lanes: [65, 69, 72, 77, 81, 84] },
  { root: 48, pad: [55, 60, 64], lanes: [64, 67, 72, 76, 79, 84] },
  { root: 43, pad: [55, 59, 62], lanes: [62, 67, 71, 74, 79, 83] },
];
const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
const $ = id => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} },
};

// ---------- Canvas ----------
const canvas = $('c');
const ctx = canvas.getContext('2d');
let W, H, dpr;
function resize() {
  dpr = Math.min(window.devicePixelRatio || 1, 2);
  W = window.innerWidth; H = window.innerHeight;
  canvas.width = W * dpr; canvas.height = H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener('resize', resize);
resize();

// ---------- Audio ----------
let actx, master, musicBus, sfxBus, musicFilter, noiseBuf;
function initAudio() {
  if (actx) return;
  actx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
  const comp = actx.createDynamicsCompressor();
  master = actx.createGain();
  master.connect(comp).connect(actx.destination);
  musicFilter = actx.createBiquadFilter();
  musicFilter.type = 'lowpass';
  musicFilter.frequency.value = 18000;
  musicBus = actx.createGain();
  musicBus.connect(musicFilter).connect(master);
  sfxBus = actx.createGain();
  sfxBus.connect(master);
  noiseBuf = actx.createBuffer(1, actx.sampleRate, actx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
}

let offset = +store.get('pulso-offset', 0) || 0; // calibration, seconds (positive = you hear/press later)

// The audio-clock time the player is hearing at a given moment (default: now).
// Uses the output timestamp (what the speakers play right now) when the browser provides it,
// and the key event's own timestamp, so a busy frame doesn't make a hit look late.
function heardTime(eventTs) {
  const p = eventTs === undefined ? performance.now() : eventTs;
  let t = actx.currentTime - (actx.outputLatency || 0) - (actx.baseLatency || 0) - (performance.now() - p) / 1000;
  const ts = actx.getOutputTimestamp && actx.getOutputTimestamp();
  if (ts && ts.contextTime > 0 && ts.performanceTime > 0) {
    const est = ts.contextTime + (p - ts.performanceTime) / 1000;
    if (Math.abs(est - t) < 0.25) t = est;
  }
  return t - offset;
}

function env(g, t, a, peak, d) {
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + a);
  g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
}
function osc(type, freq, t, peak, a, d, dest = musicBus, endFreq) {
  const o = actx.createOscillator(), g = actx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (endFreq) o.frequency.exponentialRampToValueAtTime(endFreq, t + a + d);
  env(g, t, a, peak, d);
  o.connect(g).connect(dest); o.start(t); o.stop(t + a + d + 0.05);
}
function noise(t, type, freq, peak, dec, dest = musicBus) {
  const s = actx.createBufferSource(), f = actx.createBiquadFilter(), g = actx.createGain();
  s.buffer = noiseBuf; f.type = type; f.frequency.value = freq;
  env(g, t, 0.002, peak, dec);
  s.connect(f).connect(g).connect(dest);
  s.start(t, Math.random() * 0.5); s.stop(t + dec + 0.05);
}
const kick = t => osc('sine', 160, t, 0.9, 0.003, 0.32, musicBus, 42);
function snare(t) { noise(t, 'highpass', 1200, 0.35, 0.16); osc('triangle', 220, t, 0.25, 0.002, 0.1, musicBus, 140); }
const hat = (t, peak, dec) => noise(t, 'highpass', 7500, peak, dec);
function bass(t, m, dur) {
  const o = actx.createOscillator(), f = actx.createBiquadFilter(), g = actx.createGain();
  o.type = 'sawtooth'; o.frequency.value = mtof(m);
  f.type = 'lowpass'; f.Q.value = 6;
  f.frequency.setValueAtTime(900, t);
  f.frequency.exponentialRampToValueAtTime(180, t + dur);
  env(g, t, 0.005, 0.22, dur);
  o.connect(f).connect(g).connect(musicBus); o.start(t); o.stop(t + dur + 0.05);
}
function pad(t, ms, dur) {
  const f = actx.createBiquadFilter(), g = actx.createGain();
  f.type = 'lowpass'; f.frequency.value = 1400;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(0.05, t + dur * 0.25);
  g.gain.linearRampToValueAtTime(0.0001, t + dur);
  f.connect(g).connect(musicBus);
  for (const m of ms) for (const det of [-7, 7]) {
    const o = actx.createOscillator();
    o.type = 'sawtooth'; o.frequency.value = mtof(m); o.detune.value = det;
    o.connect(f); o.start(t); o.stop(t + dur + 0.05);
  }
}
const arp = (t, m) => osc('triangle', mtof(m), t, 0.06, 0.003, 0.12);

// Classic mode: hits play the melody (plus a click so every hit is felt).
function pluck(m, perfect) {
  const t = actx.currentTime;
  const o = actx.createOscillator(), f = actx.createBiquadFilter(), g = actx.createGain();
  o.type = 'square'; o.frequency.value = mtof(m);
  f.type = 'lowpass';
  f.frequency.setValueAtTime(5000, t);
  f.frequency.exponentialRampToValueAtTime(500, t + 0.3);
  env(g, t, 0.003, 0.2, 0.35);
  o.connect(f).connect(g).connect(sfxBus); o.start(t); o.stop(t + 0.4);
  if (perfect) osc('sine', mtof(m + 12), t, 0.12, 0.003, 0.5, sfxBus);
  noise(t, 'bandpass', 4000, 0.12, 0.025, sfxBus);
}
// Song mode: a crisp percussive hit that sits on top of any song.
function hitSound(perfect) {
  const t = actx.currentTime;
  noise(t, 'bandpass', 4200, 0.35, 0.03, sfxBus);
  osc('sine', 1500, t, 0.22, 0.002, 0.06, sfxBus, 900);
  if (perfect) osc('sine', 2400, t, 0.14, 0.002, 0.12, sfxBus);
}
function missSound() {
  const t = actx.currentTime;
  osc('sawtooth', 140, t, 0.1, 0.004, 0.2, sfxBus, 60);
  // Muffle the music briefly
  const fr = musicFilter.frequency;
  fr.cancelScheduledValues(t);
  fr.setValueAtTime(500, t);
  fr.exponentialRampToValueAtTime(18000, t + 0.6);
}

// ---------- Game state ----------
let state = 'menu';   // menu | playing | paused | over | calib
let mode = 'classic'; // classic | song
let difficulty = store.get('pulso-diff', 'normal');
let G = null;
let song = null;      // { key, id, title, buffer, analysis, chart, start, player, playerReady }
let songSrc = null;
const keyDown = new Array(LANES).fill(false);
const keyFlash = new Array(LANES).fill(0);
const hitFx = new Array(LANES).fill(null); // { at, j } per lane, for beams/rings

function newGame() {
  const t0 = actx.currentTime;
  G = {
    score: 0, combo: 0, maxCombo: 0, health: 1,
    hits: { perfect: 0, great: 0, good: 0, miss: 0 },
    notes: [], steps: [], texts: [], particles: [], banners: [], errors: [], judge: null,
    seqTime: t0 + 0.5, step: 0, bpm: BASE_BPM, level: 1,
    shownLevel: 1, shownBpm: BASE_BPM, lastNoteT: -1, lastLane: -1, frozenNow: 0,
  };
  musicFilter.frequency.cancelScheduledValues(t0);
  musicFilter.frequency.value = 18000;
  master.gain.cancelScheduledValues(t0);
  master.gain.setValueAtTime(0.85, t0);
  musicBus.gain.value = mode === 'song' ? 0.9 : 0.7;
  if (mode === 'classic') G.banners.push({ t: heardTime() + 0.3, text: 'NÍVEL 1', sub: BASE_BPM + ' BPM' });
}

const scrollSpeed = lvl => H * Math.min(0.55 + 0.07 * (lvl - 1), 1.15);

// ----- Classic mode: generated music + chart -----
function genStep() {
  const t = G.seqTime, s = G.step % 16, bar = Math.floor(G.step / 16);
  const stepDur = 60 / G.bpm / 4;
  const ev = { t, s, bar, ch: PROG[bar % 4], stepDur, lvl: G.level };
  G.steps.push(ev);
  if (bar >= 1) genNotes(ev);
  G.seqTime += stepDur;
  G.step++;
  if (G.step % (16 * BARS_PER_LEVEL) === 0) {
    G.level++;
    G.bpm = Math.min(G.bpm + BPM_STEP, MAX_BPM);
    G.banners.push({ t: G.seqTime, text: 'NÍVEL ' + G.level, sub: G.bpm + ' BPM', lvl: G.level, bpm: G.bpm });
  }
}

function genNotes(ev) {
  const { s, lvl: L } = ev;
  let p = 0;
  if (s % 4 === 0) p = s === 0 ? 1 : 0.7;
  else if (s % 2 === 0) p = L >= 2 ? 0.2 + 0.08 * L : 0;
  else p = L >= 4 ? 0.06 * (L - 3) : 0;
  p = Math.min(p, 0.85);
  if (Math.random() >= p || ev.t - G.lastNoteT < 0.11) return;
  let lane;
  do {
    lane = G.lastLane < 0 ? Math.floor(Math.random() * LANES)
      : Math.max(0, Math.min(LANES - 1, G.lastLane + [-2, -1, 1, 2][Math.floor(Math.random() * 4)]));
  } while (lane === G.lastLane);
  const v = scrollSpeed(L);
  G.notes.push({ t: ev.t, lane, midi: ev.ch.lanes[lane], v, done: false });
  if (L >= 3 && s % 8 === 0 && Math.random() < 0.1 + 0.05 * L) {
    const l2 = lane < 3 ? lane + 3 : lane - 3;
    G.notes.push({ t: ev.t, lane: l2, midi: ev.ch.lanes[l2], v, done: false });
  }
  G.lastNoteT = ev.t; G.lastLane = lane;
}

function playStep(e) {
  const t = Math.max(e.t, actx.currentTime), { s, lvl: L, stepDur: sd, ch } = e;
  if (s % 4 === 0) kick(t);
  if (s === 4 || s === 12) snare(t);
  if (s % 4 === 2) hat(t, 0.12, 0.05);
  else if (L >= 3 && s % 2 === 1) hat(t, 0.05, 0.03);
  if (L >= 4 && s === 14) hat(t, 0.1, 0.25);
  if (s % 4 === 2) bass(t, ch.root + 12, sd * 1.8);
  else if (L >= 2 && s % 4 === 0) bass(t, ch.root, sd * 1.8);
  else if (L >= 4 && s % 4 === 3) bass(t, ch.root + 7, sd * 0.9);
  if (s === 0) pad(t, ch.pad, sd * 16);
  if (L >= 5) arp(t, ch.pad[s % 3] + 12 + (s % 6 >= 3 ? 12 : 0));
}

function pump() {
  while (G.seqTime < actx.currentTime + LOOKAHEAD) genStep();
  while (G.steps.length && G.steps[0].t < actx.currentTime + 0.12) playStep(G.steps.shift());
}

// ----- Song mode: pre-analysed track played by the game, video follows it -----
// The YouTube download needs server.py, which only runs on the player's own machine.
const hasServer = ['localhost', '127.0.0.1'].includes(location.hostname);

function parseYouTubeId(url) {
  url = url.trim();
  const m = url.match(/(?:youtu\.be\/|[?&]v=|\/shorts\/|\/embed\/|\/live\/)([\w-]{11})/);
  if (m) return m[1];
  return /^[\w-]{11}$/.test(url) ? url : null;
}

function songMsg(text, err) {
  $('songMsg').textContent = text;
  $('songMsg').classList.toggle('err', !!err);
}

let loading = false;
async function loadFromYouTube() {
  if (loading) return;
  const id = parseYouTubeId($('ytUrl').value);
  if (!id) return songMsg('Link do YouTube inválido.', true);
  if (!hasServer) {
    return songMsg('Links do YouTube só funcionam com o jogo rodando no seu PC (jogar.bat). Aqui, use um arquivo de áudio.', true);
  }
  loading = true;
  $('songPlay').disabled = true;
  initAudio();
  try {
    songMsg('Baixando o áudio… (a primeira vez leva alguns segundos)');
    const r = await fetch('/api/song?v=' + id);
    const info = await r.json().catch(() => ({ error: 'O servidor não respondeu. O jogar.bat está aberto?' }));
    if (!r.ok) throw new Error(info.error || 'Falha ao baixar.');
    songMsg('Preparando o áudio…');
    const data = await (await fetch(info.url)).arrayBuffer();
    const buffer = await actx.decodeAudioData(data);
    await prepareSong({ key: 'yt-' + id, id, title: info.title, buffer });
  } catch (e) {
    songMsg(e.message || String(e), true);
  }
  loading = false;
}

async function loadFromFile(file) {
  if (!file || loading) return;
  loading = true;
  $('songPlay').disabled = true;
  initAudio();
  try {
    songMsg('Lendo o arquivo…');
    const buffer = await actx.decodeAudioData(await file.arrayBuffer());
    await prepareSong({ key: 'file-' + file.name, id: null, title: file.name.replace(/\.[^.]+$/, ''), buffer });
  } catch (e) {
    songMsg('Não consegui ler esse arquivo de áudio.', true);
  }
  loading = false;
}

async function prepareSong(s) {
  destroyVideo();
  song = null;
  s.analysis = await Analysis.analyze(s.buffer, p => songMsg('Analisando a música… ' + Math.round(p * 100) + '%'));
  song = s;
  refreshSongInfo();
  $('songPlay').disabled = false;
  if (s.id) setupVideo(s.id);
}

function refreshSongInfo() {
  if (!song) return;
  song.chart = Analysis.chart(song.analysis, difficulty);
  const m = Math.floor(song.buffer.duration / 60), sec = String(Math.floor(song.buffer.duration % 60)).padStart(2, '0');
  songMsg(`Pronto: ${song.title} · ${m}:${sec} · ~${Math.round(song.analysis.bpm)} BPM · ${song.chart.length} notas`);
}

function startSong() {
  if (!song || !song.chart.length) return;
  initAudio();
  actx.resume();
  mode = 'song';
  begin();
  playSongFromStart(2);
}

function playSongFromStart(lead, showTitle = true) {
  stopSongAudio();
  const t0 = actx.currentTime + lead;
  song.start = t0;
  songSrc = actx.createBufferSource();
  songSrc.buffer = song.buffer;
  songSrc.connect(musicBus);
  songSrc.start(t0);
  const v = H * DIFFS[difficulty].speed;
  G.notes = song.chart.map(n => ({ t: t0 + n.t, lane: n.lane, midi: null, v, done: false }));
  song.lastSeek = 0;
  if (showTitle) G.banners.push({ t: heardTime() + 0.2, text: song.title.length > 34 ? song.title.slice(0, 32) + '…' : song.title, sub: DIFFS[difficulty].label, small: true });
}

function stopSongAudio() {
  if (!songSrc) return;
  try { songSrc.stop(); } catch (e) {}
  songSrc.disconnect();
  songSrc = null;
}

// Seconds into the song that the player is hearing right now.
const songPos = () => heardTime() + offset - song.start;

// ----- YouTube video (muted, follows the game's audio clock) -----
let ytApi = null;
function loadYtApi() {
  if (!ytApi) ytApi = new Promise((resolve, reject) => {
    window.onYouTubeIframeAPIReady = () => resolve(window.YT);
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => { ytApi = null; reject(new Error('no api')); };
    document.head.appendChild(s);
  });
  return ytApi;
}

async function setupVideo(id) {
  if (location.protocol === 'file:') return;
  const target = song;
  try {
    const YT = await loadYtApi();
    if (song !== target) return;
    target.player = new YT.Player('ytPlayer', {
      videoId: id, width: 320, height: 180,
      playerVars: { controls: 0, disablekb: 1, rel: 0, playsinline: 1, iv_load_policy: 3, fs: 0, origin: location.origin },
      events: {
        onReady: e => { e.target.mute(); target.playerReady = true; },
        onError: () => { target.playerReady = false; target.videoBlocked = true; $('videoBox').classList.add('hidden'); },
      },
    });
  } catch (e) { /* no video, the audio still plays */ }
}

function destroyVideo() {
  if (song && song.player) { try { song.player.destroy(); } catch (e) {} }
  $('videoBox').innerHTML = '<div id="ytPlayer"></div>';
  $('videoBox').classList.add('hidden');
}

let videoVisible = store.get('pulso-video', '1') === '1';
function syncVideo() {
  const p = song && song.player;
  const want = mode === 'song' && state === 'playing' && p && song.playerReady && videoVisible && $('showVideo').checked;
  $('videoBox').classList.toggle('hidden', !(want || (state === 'paused' && mode === 'song' && p && song.playerReady && videoVisible)));
  if (!p || !song.playerReady || mode !== 'song') return;
  if (state !== 'playing') { if (p.getPlayerState() === 1) p.pauseVideo(); return; }
  if (!want) return;
  const pos = songPos(), ps = p.getPlayerState();
  if (pos < 0 || pos > song.buffer.duration) {
    if (ps === 1) p.pauseVideo();
    if (pos < 0 && Math.abs(p.getCurrentTime()) > 0.3) p.seekTo(0, true);
    return;
  }
  if (ps !== 1 && ps !== 3) p.playVideo();
  const now = performance.now();
  if (now - song.lastSeek > 1500 && Math.abs(p.getCurrentTime() - pos) > 0.15) {
    p.seekTo(pos + 0.1, true);
    song.lastSeek = now;
  }
}

// ---------- Judging ----------
function layout() {
  const lw = Math.min(W * 0.92 / 6.5, 100), gap = lw * 0.5;
  return { lw, gap, x0: (W - (lw * LANES + gap)) / 2 };
}
const laneWidth = () => layout().lw;
function laneX(l) {
  const { lw, gap, x0 } = layout();
  return x0 + l * lw + (l >= 3 ? gap : 0);
}
const hitY = () => H * 0.8;

function press(lane, ts) {
  keyDown[lane] = true;
  keyFlash[lane] = 1;
  if (state !== 'playing') return;
  const now = heardTime(ts);
  let best = null;
  for (const n of G.notes) {
    if (n.done || n.lane !== lane) continue;
    if (!best || Math.abs(n.t - now) < Math.abs(best.t - now)) best = n;
  }
  const err = best ? now - best.t : Infinity; // positive = late
  if (Math.abs(err) > WINDOWS.good) {
    if (Math.abs(err) < NEAR_MISS) {
      G.texts.push({ text: err < 0 ? 'CEDO' : 'TARDE', color: '#8f89ad', x: laneX(lane) + laneWidth() / 2, life: 1 });
    }
    return;
  }
  const a = Math.abs(err);
  const j = a <= WINDOWS.perfect ? 'perfect' : a <= WINDOWS.great ? 'great' : 'good';
  best.done = true;
  G.hits[j]++;
  G.combo++;
  G.maxCombo = Math.max(G.maxCombo, G.combo);
  const pts = POINTS[j] * multiplier();
  G.score += pts;
  G.health = Math.min(1, G.health + HEAL[j]);
  G.errors.push({ e: err, at: performance.now(), j });
  if (G.errors.length > 40) G.errors.shift();
  if (best.midi != null) pluck(best.midi, j === 'perfect'); else hitSound(j === 'perfect');
  hitFx[lane] = { at: performance.now(), j };
  G.judge = { j, at: performance.now(), pts, err };
  burst(lane, j === 'perfect' ? 16 : 10);
  if (G.combo % 50 === 0) G.banners.push({ t: now, text: G.combo + ' COMBO!', sub: '', small: true });
}

function miss(n) {
  n.done = true; n.missed = true;
  G.hits.miss++;
  G.combo = 0;
  G.health += HEAL.miss;
  G.judge = { j: 'miss', at: performance.now(), pts: 0 };
  missSound();
  if (G.health <= 0) restartFromZero();
}

// Too many misses: wipe score and start over without leaving the game.
function restartFromZero() {
  const last = G.score;
  saveBest(last);
  newGame();
  if (mode === 'song') playSongFromStart(2.5, false);
  G.banners.push({ t: heardTime(), text: 'DO ZERO!', sub: 'Última tentativa: ' + last.toLocaleString('pt-BR') + ' pts' });
}

const multiplier = () => Math.min(1 + Math.floor(G.combo / 10), 4);

function burst(lane, count) {
  const x = laneX(lane) + laneWidth() / 2, y = hitY();
  for (let i = 0; i < count; i++) {
    const a = -Math.PI * Math.random(), sp = 120 + Math.random() * 260;
    G.particles.push({ x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: 1, color: COLORS[lane], r: 2 + Math.random() * 2.5 });
  }
}

// ---------- Calibration ----------
let calib = null;
function startCalib() {
  initAudio();
  actx.resume().then(() => {
    const period = 0.6, n = 20, start = actx.currentTime + 1;
    calib = { start, period, n, errs: [], done: false };
    for (let i = 0; i < n; i++) {
      const t = start + i * period;
      osc('sine', i % 4 ? 1000 : 1500, t, 0.5, 0.001, 0.05, sfxBus);
      noise(t, 'highpass', 3000, 0.25, 0.015, sfxBus);
    }
    state = 'calib';
    $('calibTaps').innerHTML = '';
    $('calibResult').textContent = '';
    $('calibFoot').textContent = 'OUÇA E APERTE…';
    show('calib');
  });
}
function calibTap(ts) {
  if (!calib || calib.done) return;
  const raw = heardTime(ts) + offset;
  const k = Math.round((raw - calib.start) / calib.period);
  if (k < 3 || k >= calib.n) return; // first beats are for getting into the groove
  const e = raw - (calib.start + k * calib.period);
  if (Math.abs(e) > 0.25) return;
  calib.errs.push(e);
  $('calibTaps').insertAdjacentHTML('beforeend', '<i></i>');
}
function finishCalib() {
  calib.done = true;
  if (calib.errs.length < 6) {
    $('calibResult').textContent = 'Poucos toques registrados. Tente de novo.';
  } else {
    const s = calib.errs.slice().sort((a, b) => a - b);
    offset = Math.round(s[Math.floor(s.length / 2)] * 1000) / 1000;
    store.set('pulso-offset', offset);
    $('calibResult').textContent = 'Atraso ajustado: ' + Math.round(offset * 1000) + ' ms';
  }
  $('calibFoot').textContent = 'ESPAÇO REPETE · ESC VOLTA';
}

// ---------- Flow ----------
function show(id) {
  for (const o of ['menu', 'pause', 'over', 'calib']) $(o).classList.toggle('hidden', o !== id);
}
function begin() {
  if (document.activeElement) document.activeElement.blur();
  newGame();
  state = 'playing';
  show(null);
}
function startClassic() {
  initAudio();
  actx.resume();
  mode = 'classic';
  stopSongAudio();
  begin();
}
function avgError() {
  if (!G || G.errors.length < 8) return null;
  return G.errors.reduce((a, b) => a + b.e, 0) / G.errors.length;
}
function updatePauseInfo() {
  $('pauseInfo').textContent = 'Atraso atual: ' + Math.round(offset * 1000) + ' ms ([ e ] ajustam)';
  const m = avgError();
  $('pauseHint').textContent = m !== null && Math.abs(m) > 0.012
    ? `Seus acertos estão em média ${Math.abs(Math.round(m * 1000))} ms ${m > 0 ? 'atrasados' : 'adiantados'}. Aperte A para corrigir.`
    : '';
}
function togglePause() {
  if (state === 'playing') {
    G.frozenNow = heardTime();
    state = 'paused';
    actx.suspend();
    updatePauseInfo();
    show('pause');
    syncVideo();
  } else if (state === 'paused') {
    state = 'playing';
    actx.resume();
    show(null);
  }
}
function saveBest(score) {
  const key = mode === 'song' && song ? 'pulso-best-' + song.key + '-' + difficulty : 'pulso-best';
  const best = +store.get(key, 0) || 0;
  if (score > best) { store.set(key, score); return { best: score, record: true }; }
  return { best, record: false };
}
function endGame(reason, title) {
  if (!G || state === 'over' || state === 'menu') return;
  actx.resume();
  state = 'over';
  syncVideo();
  const t = actx.currentTime;
  master.gain.setValueAtTime(master.gain.value, t);
  master.gain.exponentialRampToValueAtTime(0.0001, t + 1);
  setTimeout(stopSongAudio, 1100);
  const h = G.hits, total = h.perfect + h.great + h.good + h.miss;
  const acc = total ? (h.perfect + h.great * 0.7 + h.good * 0.4) / total * 100 : 0;
  const { best, record } = saveBest(G.score);
  $('overTitle').textContent = title || 'FIM';
  $('overReason').textContent = reason || '';
  $('stats').innerHTML = [
    ['Pontos', G.score.toLocaleString('pt-BR')],
    mode === 'classic' ? ['Nível', G.shownLevel + ' (' + G.shownBpm + ' BPM)'] : ['Dificuldade', DIFFS[difficulty].label],
    ['Combo máximo', G.maxCombo], ['Precisão', acc.toFixed(1) + '%'],
    ['Perfeitos', h.perfect], ['Ótimos', h.great], ['Bons', h.good], ['Erros', h.miss],
  ].map(([k, v]) => `<span>${k}</span><span>${v}</span>`).join('');
  $('best').textContent = record ? '★ NOVO RECORDE ★' : 'Recorde: ' + best.toLocaleString('pt-BR');
  show('over');
}
function toMenu() {
  state = 'menu';
  G = null;
  stopSongAudio();
  syncVideo();
  show('menu');
}

// ---------- Input ----------
function setDifficulty(d) {
  difficulty = d;
  store.set('pulso-diff', d);
  for (const b of $('diff').children) b.classList.toggle('on', b.dataset.d === d);
  refreshSongInfo();
}
for (const b of $('diff').children) b.addEventListener('click', () => setDifficulty(b.dataset.d));
setDifficulty(DIFFS[difficulty] ? difficulty : 'normal');
$('showVideo').checked = videoVisible;
$('showVideo').addEventListener('change', () => { videoVisible = $('showVideo').checked; store.set('pulso-video', videoVisible ? '1' : '0'); });
$('classicBtn').addEventListener('click', startClassic);
$('ytLoad').addEventListener('click', loadFromYouTube);
$('fileIn').addEventListener('change', e => loadFromFile(e.target.files[0]));
$('songPlay').addEventListener('click', startSong);
$('calibBtn').addEventListener('click', startCalib);
if (!hasServer) songMsg('Links do YouTube precisam do jogo rodando no seu PC (jogar.bat). Arquivos de áudio funcionam direto.');

window.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' && e.target.type === 'text') {
    if (e.key === 'Enter') loadFromYouTube();
    return;
  }
  const k = e.key.toLowerCase();
  if (e.repeat && (k in KEYMAP || k === ' ')) { e.preventDefault(); return; }

  if (state === 'calib') {
    if (k === ' ' || k in KEYMAP) { e.preventDefault(); if (calib && calib.done && k === ' ') startCalib(); else calibTap(e.timeStamp); }
    if (k === 'escape') { calib = null; state = 'menu'; show('menu'); }
    return;
  }
  if (state === 'paused' && k === 'a') {
    const m = avgError();
    if (m !== null) {
      offset = Math.round((offset + m) * 1000) / 1000;
      store.set('pulso-offset', offset);
      G.errors = [];
      updatePauseInfo();
    }
    return;
  }
  if (k in KEYMAP) {
    e.preventDefault();
    press(KEYMAP[k], e.timeStamp);
    return;
  }
  if (k === ' ' || k === 'enter') {
    e.preventDefault();
    if (state === 'menu') startClassic();
    else if (state === 'over') toMenu();
    else if (state === 'paused') togglePause();
  }
  if (k === 'escape' || k === 'p') togglePause();
  if (k === 'q' && state === 'paused') endGame('');
  if (k === 'c' && state === 'menu') startCalib();
  if (k === 'v') { videoVisible = !videoVisible; $('showVideo').checked = videoVisible; store.set('pulso-video', videoVisible ? '1' : '0'); }
  if ((k === '[' || k === ']') && state !== 'menu') {
    offset = Math.round((offset + (k === ']' ? 0.01 : -0.01)) * 1000) / 1000;
    store.set('pulso-offset', offset);
    if (state === 'paused') updatePauseInfo();
    else if (G) G.banners.push({ t: heardTime(), text: 'Atraso ' + Math.round(offset * 1000) + ' ms', sub: '', small: true, short: true });
  }
});
window.addEventListener('keyup', e => {
  const k = e.key.toLowerCase();
  if (k in KEYMAP) keyDown[KEYMAP[k]] = false;
});
window.addEventListener('blur', () => { if (state === 'playing') togglePause(); });
canvas.addEventListener('pointerdown', e => {
  const lw = laneWidth();
  for (let l = 0; l < LANES; l++) if (e.clientX >= laneX(l) && e.clientX < laneX(l) + lw) press(l, e.timeStamp);
});
canvas.addEventListener('pointerup', () => keyDown.fill(false));

// ---------- Loop ----------
let lastFrame = performance.now(), lastVideoSync = 0;
function frame(ts) {
  requestAnimationFrame(frame);
  const dt = Math.min((ts - lastFrame) / 1000, 0.05);
  lastFrame = ts;
  let now = 0;
  if (G && actx) {
    tick();
    now = state === 'paused' ? G.frozenNow : heardTime();
    update(dt, now);
  }
  draw(now, dt);
}

// Game logic also runs on a timer, so audio never depends on the frame rate.
function tick() {
  if (state === 'calib' && calib && !calib.done && actx.currentTime > calib.start + calib.n * calib.period + 0.4) finishCalib();
  if (!G || state !== 'playing') return;
  const now = heardTime();
  if (mode === 'classic') pump();
  const game = G;
  for (const n of game.notes) if (!n.done && now - n.t > WINDOWS.good) { miss(n); if (G !== game || state !== 'playing') return; }
  for (const b of G.banners) if (b.lvl && now >= b.t) { G.shownLevel = b.lvl; G.shownBpm = b.bpm; }
  if (mode === 'song') {
    if (songPos() > song.buffer.duration + 0.8) return endGame(song.title, 'MÚSICA COMPLETA!');
    if (performance.now() - lastVideoSync > 250) { lastVideoSync = performance.now(); syncVideo(); }
  }
}
setInterval(tick, 25);

function update(dt, now) {
  if (state !== 'paused') {
    for (const p of G.particles) { p.x += p.vx * dt; p.y += p.vy * dt; p.vy += 700 * dt; p.life -= dt * 2.2; }
    for (const t of G.texts) t.life -= dt * 2;
  }
  G.particles = G.particles.filter(p => p.life > 0);
  G.texts = G.texts.filter(t => t.life > 0);
  G.notes = G.notes.filter(n => !n.done || (n.missed && now - n.t < 1));
  G.banners = G.banners.filter(b => now - b.t < 2.5);
}

// ---------- Render ----------
function roundRect(x, y, w, h, r) {
  ctx.beginPath();
  ctx.roundRect ? ctx.roundRect(x, y, w, h, r) : ctx.rect(x, y, w, h);
}
const FONT = 'Segoe UI, system-ui, sans-serif';
const JUDGE = { perfect: ['PERFEITO', '#7dfcff'], great: ['ÓTIMO', '#3dffb5'], good: ['BOM', '#ffc83d'], miss: ['ERROU', '#ff4d6d'] };
const easeOut = x => 1 - (1 - x) * (1 - x);

// Static background: only notes and hit feedback move.
function draw(now, dt) {
  ctx.fillStyle = '#0b0a14';
  ctx.fillRect(0, 0, W, H);
  const hy = hitY(), { lw } = layout(), pnow = performance.now();

  for (let l = 0; l < LANES; l++) {
    const x = laneX(l);
    ctx.fillStyle = l % 2 ? 'rgba(255,255,255,0.035)' : 'rgba(255,255,255,0.055)';
    ctx.fillRect(x, 0, lw, H);
    keyFlash[l] = keyDown[l] ? 1 : Math.max(0, keyFlash[l] - dt * 6);
    if (keyFlash[l] > 0) {
      const g = ctx.createLinearGradient(0, hy, 0, hy - H * 0.3);
      g.addColorStop(0, hexA(COLORS[l], 0.22 * keyFlash[l]));
      g.addColorStop(1, hexA(COLORS[l], 0));
      ctx.fillStyle = g;
      ctx.fillRect(x, hy - H * 0.3, lw, H * 0.3);
    }
    // Hit beam: bright column up the lane
    const fx = hitFx[l];
    if (fx) {
      const age = (pnow - fx.at) / 260;
      if (age >= 1) hitFx[l] = null;
      else {
        const a = (1 - age) * (fx.j === 'perfect' ? 0.75 : 0.5);
        const g = ctx.createLinearGradient(0, hy, 0, 0);
        g.addColorStop(0, hexA(fx.j === 'perfect' ? '#ffffff' : COLORS[l], a));
        g.addColorStop(0.15, hexA(COLORS[l], a * 0.7));
        g.addColorStop(1, hexA(COLORS[l], 0));
        ctx.fillStyle = g;
        ctx.fillRect(x + lw * 0.08, 0, lw * 0.84, hy);
      }
    }
  }
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.fillRect(laneX(0), hy - 2, lw * 3, 4);
  ctx.fillRect(laneX(3), hy - 2, lw * 3, 4);

  // Receptors with hit pop + expanding ring
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (let l = 0; l < LANES; l++) {
    const cx = laneX(l) + lw / 2, fx = hitFx[l];
    const age = fx ? (pnow - fx.at) / 260 : 1;
    const pop = fx ? 1 + 0.22 * Math.max(0, 1 - age * 2) : 1;
    const r = lw * 0.34 * pop;
    if (fx) {
      ctx.beginPath(); ctx.arc(cx, hy, lw * 0.34 * (1 + easeOut(age) * 0.9), 0, Math.PI * 2);
      ctx.lineWidth = 4 * (1 - age); ctx.strokeStyle = hexA(fx.j === 'perfect' ? '#ffffff' : COLORS[l], 1 - age); ctx.stroke();
    }
    ctx.beginPath(); ctx.arc(cx, hy, r, 0, Math.PI * 2);
    const lit = Math.max(keyFlash[l] * 0.6, fx ? 1 - age : 0);
    ctx.fillStyle = lit > 0 ? hexA(fx && fx.j === 'perfect' && age < 0.4 ? '#ffffff' : COLORS[l], 0.2 + 0.7 * lit) : 'rgba(11,10,20,0.92)';
    ctx.fill();
    ctx.lineWidth = 3; ctx.strokeStyle = COLORS[l]; ctx.stroke();
    ctx.fillStyle = lit > 0.45 ? '#0b0a14' : COLORS[l];
    ctx.font = `700 ${Math.round(lw * 0.26)}px ${FONT}`;
    ctx.fillText(LABELS[l], cx, hy + 1);
  }

  // Notes (drawn over the receptors so you see them reach the line)
  if (G) {
    const nh = Math.max(14, lw * 0.24);
    for (const n of G.notes) {
      if (n.done && !n.missed) continue;
      const y = hy - (n.t - now) * n.v;
      if (y < -nh || y > H + nh) continue;
      const x = laneX(n.lane) + lw * 0.1;
      roundRect(x, y - nh / 2, lw * 0.8, nh, nh / 2);
      if (n.missed) {
        ctx.fillStyle = `rgba(120,110,140,${Math.max(0, 1 - (now - n.t) * 1.5) * 0.6})`;
        ctx.fill();
      } else {
        ctx.fillStyle = COLORS[n.lane]; ctx.fill();
        roundRect(x + 5, y - nh / 2 + 3, lw * 0.8 - 10, nh * 0.28, nh * 0.14);
        ctx.fillStyle = 'rgba(255,255,255,0.45)'; ctx.fill();
      }
    }
  }

  if (!G) return;

  for (const p of G.particles) {
    ctx.globalAlpha = Math.max(0, p.life);
    ctx.fillStyle = p.color;
    ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2); ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Near-miss hints in the lane
  for (const t of G.texts) {
    ctx.globalAlpha = Math.min(1, t.life * 1.5);
    ctx.fillStyle = t.color;
    ctx.font = `700 ${Math.round(Math.max(11, lw * 0.16))}px ${FONT}`;
    ctx.fillText(t.text, t.x, hy - lw * 0.6);
  }
  ctx.globalAlpha = 1;

  // Big judgement in the middle of the playfield
  if (G.judge) {
    const age = (pnow - G.judge.at) / 1000;
    if (age < 0.6) {
      const [text, color] = JUDGE[G.judge.j];
      const s = 1 + 0.35 * Math.max(0, 1 - age / 0.09);
      ctx.globalAlpha = Math.min(1, (0.6 - age) / 0.2);
      ctx.fillStyle = color;
      ctx.font = `900 ${Math.round(Math.max(26, lw * 0.5) * s)}px ${FONT}`;
      ctx.fillText(text, W / 2, hy - H * 0.2);
      if (G.judge.pts) {
        ctx.font = `700 ${Math.round(Math.max(14, lw * 0.2))}px ${FONT}`;
        ctx.fillStyle = '#fff';
        ctx.fillText('+' + G.judge.pts, W / 2, hy - H * 0.2 + Math.max(30, lw * 0.45));
      }
      ctx.globalAlpha = 1;
    }
  }

  drawTimingMeter(hy, lw, pnow);
  if (state !== 'menu') drawHud(now, pnow);
}

// Where your recent hits landed: left = early, right = late.
function drawTimingMeter(hy, lw, pnow) {
  const mw = Math.min(lw * 3.2, 260), cx = W / 2, my = hy + lw * 0.34 + 26;
  if (my > H - 14) return;
  const half = mw / 2, sx = e => cx + Math.max(-1, Math.min(1, e / WINDOWS.good)) * half;
  ctx.fillStyle = 'rgba(255,200,61,0.25)';
  ctx.fillRect(cx - half, my - 3, mw, 6);
  ctx.fillStyle = 'rgba(61,255,181,0.35)';
  ctx.fillRect(sx(-WINDOWS.great), my - 3, sx(WINDOWS.great) - sx(-WINDOWS.great), 6);
  ctx.fillStyle = 'rgba(125,252,255,0.55)';
  ctx.fillRect(sx(-WINDOWS.perfect), my - 3, sx(WINDOWS.perfect) - sx(-WINDOWS.perfect), 6);
  ctx.fillStyle = '#fff';
  ctx.fillRect(cx - 1, my - 8, 2, 16);
  for (const h of G.errors) {
    const age = (pnow - h.at) / 4000;
    if (age > 1) continue;
    ctx.globalAlpha = 1 - age;
    ctx.fillStyle = JUDGE[h.j][1];
    ctx.fillRect(sx(h.e) - 1.5, my - 10, 3, 20);
  }
  ctx.globalAlpha = 1;
  ctx.font = `600 11px ${FONT}`;
  ctx.fillStyle = '#8f89ad';
  ctx.textAlign = 'right'; ctx.fillText('cedo', cx - half - 8, my);
  ctx.textAlign = 'left'; ctx.fillText('tarde', cx + half + 8, my);
  ctx.textAlign = 'center';
}

function drawHud(now, pnow) {
  const narrow = W < 560, top = narrow ? 64 : 0;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  ctx.fillStyle = '#fff';
  ctx.font = `800 30px ${FONT}`;
  ctx.fillText(G.score.toLocaleString('pt-BR'), 20, 18);
  ctx.font = `600 13px ${FONT}`;
  ctx.fillStyle = '#b9b3d6';
  ctx.fillText('PONTOS', 20, 54);

  ctx.textAlign = 'right';
  ctx.fillStyle = '#fff';
  ctx.font = `800 30px ${FONT}`;
  ctx.fillText(mode === 'classic' ? G.shownBpm + ' BPM' : DIFFS[difficulty].label, W - 20, 18);
  ctx.font = `600 13px ${FONT}`;
  ctx.fillStyle = '#b9b3d6';
  ctx.fillText(mode === 'classic' ? 'NÍVEL ' + G.shownLevel : '~' + Math.round(song.analysis.bpm) + ' BPM', W - 20, 54);

  if (mode === 'song') {
    const p = Math.max(0, Math.min(1, (now + offset - song.start) / song.buffer.duration));
    ctx.fillStyle = 'rgba(255,255,255,0.08)'; ctx.fillRect(0, 0, W, 3);
    ctx.fillStyle = '#a07dff'; ctx.fillRect(0, 0, W * p, 3);
  }

  const bw = narrow ? W - 40 : Math.min(W * 0.4, 320), bx = (W - bw) / 2, by = narrow ? 82 : 24;
  ctx.fillStyle = 'rgba(255,255,255,0.1)';
  roundRect(bx, by, bw, 10, 5); ctx.fill();
  ctx.fillStyle = G.health > 0.5 ? '#3dffb5' : G.health > 0.25 ? '#ffc83d' : '#ff4d6d';
  roundRect(bx, by, bw * Math.max(0, G.health), 10, 5); ctx.fill();
  ctx.textAlign = 'center';
  ctx.font = `600 11px ${FONT}`;
  ctx.fillStyle = '#8f89ad';
  ctx.fillText('ENERGIA', W / 2, by + 14);

  if (G.combo >= 5) {
    const age = G.judge && G.judge.j !== 'miss' ? (pnow - G.judge.at) / 1000 : 1;
    const s = 1 + 0.18 * Math.max(0, 1 - age / 0.1);
    ctx.fillStyle = '#fff';
    ctx.font = `900 ${Math.round(40 * s)}px ${FONT}`;
    ctx.fillText(G.combo, W / 2, 48 + top);
    ctx.font = `600 12px ${FONT}`;
    ctx.fillStyle = '#b9b3d6';
    ctx.fillText('COMBO', W / 2, 94 + top);
  }
  const m = multiplier();
  if (m > 1) {
    ctx.fillStyle = COLORS[m];
    ctx.font = `800 20px ${FONT}`;
    ctx.fillText('×' + m, W / 2, 112 + top);
  }

  if (G.health < 0.3) {
    ctx.strokeStyle = `rgba(255,60,90,${(0.3 - G.health) * 2})`;
    ctx.lineWidth = 6;
    ctx.strokeRect(3, 3, W - 6, H - 6);
  }

  ctx.textBaseline = 'middle';
  for (const b of G.banners) {
    const age = now - b.t, life = b.short ? 0.9 : 1.8;
    if (age < 0 || age > life) continue;
    ctx.globalAlpha = Math.min(1, age / 0.15, (life - age) / 0.5);
    ctx.fillStyle = '#fff';
    ctx.font = `900 ${b.small ? 30 : 54}px ${FONT}`;
    ctx.fillText(b.text, W / 2, H * 0.36);
    if (b.sub) {
      ctx.font = `700 20px ${FONT}`;
      ctx.fillStyle = '#ffc83d';
      ctx.fillText(b.sub, W / 2, H * 0.36 + 44);
    }
  }
  ctx.globalAlpha = 1;
}

function hexA(hex, a) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${Math.max(0, Math.min(1, a))})`;
}

requestAnimationFrame(frame);
