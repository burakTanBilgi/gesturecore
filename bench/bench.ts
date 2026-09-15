/**
 * gesturecore tuning bench.
 *
 * This file is an adapter: it owns the camera, MediaPipe, the DOM, the clock and
 * localStorage. The core only ever sees `update(hands, t)`, `setConfig()` and reads.
 */
import { FilesetResolver, HandLandmarker, type HandLandmarkerResult } from '@mediapipe/tasks-vision';
import {
  DEFAULT_MOTIONS,
  DEFAULT_POSES,
  GestureCore,
  defaultConfig,
  type Features,
  type GestureCoreConfig,
  type GestureCoreConfigPatch,
  type GestureEvent,
  type Hand,
  type HandLabel,
  type Landmark,
  type MotionAxis,
  type MotionDescription,
  type PinchFinger,
  type PoseDescription,
  PINCH_FINGERS,
} from '../src/index';
import { extractFeatures } from '../src/features/extract';
import { LandmarkSmoother } from '../src/filter/oneEuro';
import { matchPoses } from '../src/poses/match';

// ── tiny DOM helpers ─────────────────────────────────────────────────────────

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  for (const c of children) node.append(c);
  return node;
}

const fmt = (v: number, d = 3) => (Number.isFinite(v) ? v.toFixed(d) : '–');

// ── persistence (bench only; the core never touches storage) ─────────────────

const LS = {
  config: 'gesturecore.bench.config.v1',
  settingsV1: 'gesturecore.bench.settings.v1',
  settings: 'gesturecore.bench.settings.v2',
  sessions: 'gesturecore.bench.sessions.v1',
};

function load<T>(key: string): T | undefined {
  try {
    const s = localStorage.getItem(key);
    return s === null ? undefined : (JSON.parse(s) as T);
  } catch {
    return undefined;
  }
}

function save(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: settings just won't persist */
  }
}

type BenchSettings = {
  tab: string;
  mirror: boolean;
  flipHandedness: boolean;
  deviceId: string;
  resolution: string;
  delegate: 'GPU' | 'CPU';
  minHandDetectionConfidence: number;
  minHandPresenceConfidence: number;
  minTrackingConfidence: number;
  showRaw: boolean;
  showSmoothed: boolean;
  showVideo: boolean;
  showMoves: boolean;
  scrollHand: 'any' | HandLabel;
  scrollFinger: 'any' | PinchFinger;
  scrollGain: number;
  scrollInvert: boolean;
};

const DEFAULT_SETTINGS: BenchSettings = {
  tab: 'tuning',
  mirror: true,
  // Verified on the target laptop: MediaPipe's label is already anatomical for the unmirrored frame.
  flipHandedness: false,
  deviceId: '',
  resolution: '640x480',
  delegate: 'GPU',
  minHandDetectionConfidence: 0.5,
  minHandPresenceConfidence: 0.5,
  minTrackingConfidence: 0.5,
  showRaw: true,
  showSmoothed: true,
  showVideo: true,
  showMoves: false,
  scrollHand: 'any',
  scrollFinger: 'any',
  scrollGain: 4,
  scrollInvert: false,
};

/** v1 settings carried a wrong handedness-flip default; keep everything else from them. */
function loadSettings(): Partial<BenchSettings> {
  const v2 = load<Partial<BenchSettings>>(LS.settings);
  if (v2) return v2;
  const { flipHandedness: _dropped, ...rest } = load<Partial<BenchSettings>>(LS.settingsV1) ?? {};
  return rest;
}

const settings: BenchSettings = { ...DEFAULT_SETTINGS, ...loadSettings() };
const saveSettings = () => save(LS.settings, settings);

// ── core ─────────────────────────────────────────────────────────────────────

const core = new GestureCore(load<GestureCoreConfigPatch>(LS.config));
const saveConfig = () => save(LS.config, core.getConfig());

function applyConfig(patch: GestureCoreConfigPatch): void {
  core.setConfig(patch);
  saveConfig();
  for (const s of smoothers.values()) s.setParams(core.getConfig().smoothing);
}

// Visual-only smoothing so the overlay can show what the core's filter is doing.
const smoothers = new Map<HandLabel, LandmarkSmoother>();

// ── state shared across the loop ─────────────────────────────────────────────

const LABELS: HandLabel[] = ['Left', 'Right'];
const video = $<HTMLVideoElement>('video');
const canvas = $<HTMLCanvasElement>('overlay');
const ctx = canvas.getContext('2d')!;
const stageMsg = $('stageMsg');

let landmarker: HandLandmarker | null = null;
let stream: MediaStream | null = null;
let running = false;
let paused = false;
let lastVideoTime = -1;
let lastHands: Hand[] = [];
let lastSmoothed = new Map<HandLabel, Landmark[]>();
const t0 = performance.now();

const perf = { frames: 0, since: performance.now(), fps: 0, detectMs: 0, coreMs: 0 };

/** The core requires non-decreasing time; stopping the camera pushes the clock forward once. */
let lastCoreT = 0;
function coreTime(t: number): number {
  lastCoreT = Math.max(lastCoreT, t);
  return lastCoreT;
}

function setMessage(text: string, isError = false): void {
  stageMsg.textContent = text;
  stageMsg.classList.toggle('error', isError);
  stageMsg.hidden = text === '';
}

// ── MediaPipe source adapter ─────────────────────────────────────────────────

async function createLandmarker(): Promise<void> {
  landmarker?.close();
  landmarker = null;
  const fileset = await FilesetResolver.forVisionTasks('/node_modules/@mediapipe/tasks-vision/wasm');
  const options = (delegate: 'GPU' | 'CPU') => ({
    baseOptions: { modelAssetPath: '/bench/models/hand_landmarker.task', delegate },
    runningMode: 'VIDEO' as const,
    numHands: 2,
    minHandDetectionConfidence: settings.minHandDetectionConfidence,
    minHandPresenceConfidence: settings.minHandPresenceConfidence,
    minTrackingConfidence: settings.minTrackingConfidence,
  });
  try {
    landmarker = await HandLandmarker.createFromOptions(fileset, options(settings.delegate));
    $('stDelegate').textContent = settings.delegate;
  } catch (err) {
    if (settings.delegate === 'CPU') throw err;
    console.warn('GPU delegate failed, falling back to CPU', err);
    landmarker = await HandLandmarker.createFromOptions(fileset, options('CPU'));
    $('stDelegate').textContent = 'CPU (GPU failed)';
  }
}

/** MediaPipe result → core Hands: optional selfie mirroring, anatomical handedness. */
function toHands(res: HandLandmarkerResult): Hand[] {
  return res.landmarks.map((lms, i) => {
    const cat = res.handedness[i]?.[0];
    let label: HandLabel = cat?.categoryName === 'Left' ? 'Left' : 'Right';
    if (settings.flipHandedness) label = label === 'Left' ? 'Right' : 'Left';
    return {
      handedness: label,
      score: cat?.score ?? 0,
      landmarks: lms.map((p) => ({ x: settings.mirror ? 1 - p.x : p.x, y: p.y, z: p.z })),
    };
  });
}

const TIP: Record<PinchFinger, number> = { index: 8, middle: 12, ring: 16, pinky: 20 };

async function startCamera(): Promise<void> {
  const btn = $<HTMLButtonElement>('btnCamera');
  btn.disabled = true;
  try {
    setMessage('Loading hand model…');
    if (!landmarker) await createLandmarker();
    setMessage('Waiting for camera permission…');
    const [w = 640, h = 480] = settings.resolution.split('x').map(Number);
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        width: { ideal: w },
        height: { ideal: h },
        ...(settings.deviceId ? { deviceId: { exact: settings.deviceId } } : { facingMode: 'user' }),
      },
    });
    video.srcObject = stream;
    await video.play();
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const aspect = video.videoWidth / video.videoHeight;
    applyConfig({ aspect });
    $('srcAspect').textContent = `${fmt(aspect, 4)} (${video.videoWidth}×${video.videoHeight})`;
    $('stCamera').textContent = `${video.videoWidth}×${video.videoHeight}`;
    setMessage('');
    running = true;
    btn.textContent = 'Stop camera';
    await listDevices();
    requestAnimationFrame(loop);
  } catch (err) {
    console.error(err);
    stopCamera();
    const name = (err as { name?: string }).name;
    setMessage(
      name === 'NotAllowedError'
        ? 'Camera permission was denied. Allow it in the address bar, then press Start camera again.'
        : `Could not start: ${String((err as Error).message ?? err)}`,
      true,
    );
  } finally {
    btn.disabled = false;
  }
}

function stopCamera(): void {
  running = false;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
  lastVideoTime = -1;
  $('btnCamera').textContent = 'Start camera';
  $('stCamera').textContent = 'off';
  // Let the core see the hands disappear so lost events fire and state clears.
  handleEvents(core.update([], coreTime(performance.now() + core.getConfig().lostAfterMs + 1)));
  lastHands = [];
  lastSmoothed.clear();
  draw();
  renderReadout();
}

async function listDevices(): Promise<void> {
  const sel = $<HTMLSelectElement>('srcDevice');
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
  sel.replaceChildren(el('option', { value: '', textContent: 'default' }));
  devices.forEach((d, i) => sel.append(el('option', { value: d.deviceId, textContent: d.label || `camera ${i + 1}` })));
  sel.value = settings.deviceId;
}

// ── frame loop ───────────────────────────────────────────────────────────────

function loop(): void {
  if (!running) return;
  if (!paused && landmarker && video.readyState >= 2 && video.currentTime !== lastVideoTime) {
    lastVideoTime = video.currentTime;
    const now = performance.now();
    const res = landmarker.detectForVideo(video, now);
    const tDetect = performance.now();
    perf.detectMs = perf.detectMs * 0.9 + (tDetect - now) * 0.1;
    processFrame(toHands(res), now);
  }
  const t = performance.now();
  if (t - perf.since >= 500) {
    perf.fps = (perf.frames * 1000) / (t - perf.since);
    perf.frames = 0;
    perf.since = t;
    $('stFps').textContent = fmt(perf.fps, 1);
    $('stDetect').textContent = `${fmt(perf.detectMs, 1)} ms`;
    $('stCore').textContent = `${fmt(perf.coreMs, 2)} ms`;
  }
  session.tick();
  requestAnimationFrame(loop);
}

/** Everything after detection. Also driven directly by `window.gesturecoreBench.feed` for debugging. */
function processFrame(hands: Hand[], now: number): GestureEvent[] {
  const tCore = performance.now();
  const events = core.update(hands, coreTime(now));
  perf.coreMs = perf.coreMs * 0.9 + (performance.now() - tCore) * 0.1;
  perf.frames++;
  lastHands = hands;
  updateVisualSmoothing(hands, now);
  handleEvents(events);
  capture.onFrame(hands);
  poseRecorder.onFrame();
  draw();
  renderReadout();
  return events;
}

function updateVisualSmoothing(hands: Hand[], t: number): void {
  const next = new Map<HandLabel, Landmark[]>();
  for (const h of hands) {
    let s = smoothers.get(h.handedness);
    if (!s) smoothers.set(h.handedness, (s = new LandmarkSmoother(core.getConfig().smoothing)));
    next.set(h.handedness, s.filter(h.landmarks, t));
  }
  lastSmoothed = next;
}

// ── events: log, scroll adapter, session meter ───────────────────────────────

const logEl = $('log');
const LOG_LIMIT = 250;
const moveLines = new Map<HandLabel, { node: HTMLElement; count: number }>();

function handleEvents(events: GestureEvent[]): void {
  for (const e of events) {
    scroll.onEvent(e);
    session.onEvent(e);
    if (e.type === 'lost') smoothers.delete(e.hand);
    log(e);
  }
}

function log(e: GestureEvent): void {
  if (e.type === 'pinch:move' && !settings.showMoves) {
    const line = moveLines.get(e.hand);
    if (line) {
      line.count++;
      line.node.lastChild!.textContent = ` → moves ×${line.count}, value ${fmt(e.value, 3)}`;
    }
    return;
  }
  const cls = e.type === 'pinch:move' ? 'move' : e.type.startsWith('pinch') ? 'pinch' : e.type;
  let detail = '';
  if (e.type === 'pose' || e.type === 'motion') detail = ` ${e.name}`;
  if (e.type === 'pinch:start' || e.type === 'pinch:end') detail = ` ${e.finger}`;
  if (e.type === 'pinch:move') detail = ` ${e.finger} ${fmt(e.value, 3)}`;
  const node = el('div', {}, [
    el('span', { className: 't', textContent: ((e.t - t0) / 1000).toFixed(2) }),
    el('span', { className: `h ${e.hand}`, textContent: e.hand }),
    el('span', { className: cls, textContent: e.type + detail }),
    el('span', { className: 'move', textContent: '' }),
  ]);
  logEl.prepend(node);
  if (e.type === 'pinch:start') moveLines.set(e.hand, { node, count: 0 });
  if (e.type === 'pinch:end' || e.type === 'lost') moveLines.delete(e.hand);
  while (logEl.childElementCount > LOG_LIMIT) logEl.lastElementChild!.remove();
}

/** Pinch-drag scrolling: the thin "browser adapter" this library exists for. */
const scroll = (() => {
  const box = $('scrollBox');
  let drag: { hand: HandLabel; y0: number; s0: number } | null = null;

  const words = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet'];
  for (let i = 1; i <= 80; i++) {
    const text = Array.from({ length: 14 + (i % 9) }, (_, j) => words[(i * 7 + j * 3) % words.length]).join(' ');
    box.append(el('p', {}, [el('b', { textContent: `§${i} ` }), text]));
  }

  function onEvent(e: GestureEvent): void {
    const wants =
      (settings.scrollHand === 'any' || settings.scrollHand === e.hand) &&
      (e.type !== 'pinch:start' || settings.scrollFinger === 'any' || settings.scrollFinger === e.finger);
    if (e.type === 'pinch:start' && wants && !drag) {
      const f = core.getFeatures(e.hand);
      if (f) drag = { hand: e.hand, y0: f.centroid.y, s0: box.scrollTop };
    } else if (e.type === 'pinch:move' && drag?.hand === e.hand) {
      const f = core.getFeatures(e.hand);
      if (f) {
        const dy = f.centroid.y - drag.y0;
        const sign = settings.scrollInvert ? 1 : -1;
        box.scrollTop = drag.s0 + sign * dy * settings.scrollGain * box.clientHeight;
      }
    } else if ((e.type === 'pinch:end' || e.type === 'lost') && drag?.hand === e.hand) {
      drag = null;
    }
    box.classList.toggle('dragging', drag !== null);
  }
  return { onEvent };
})();

/** False-activation meter for the definition-of-done check. */
const session = (() => {
  type Record = { date: string; minutes: number; activations: number; falses: number };
  let active = false;
  let startedAt = 0;
  let elapsedBefore = 0;
  let activations = 0;
  let falses = 0;

  const elapsed = () => elapsedBefore + (active ? performance.now() - startedAt : 0);

  function render(): void {
    const ms = elapsed();
    const s = Math.floor(ms / 1000);
    $('mElapsed').textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    $('mActs').textContent = String(activations);
    $('mFalse').textContent = String(falses);
    const minutes = ms / 60000;
    const rate = minutes > 0 ? (falses / minutes) * 10 : NaN;
    $('mRate').textContent = minutes >= 0.5 ? fmt(rate, 2) : '–';
    const verdict = $('mVerdict');
    if (minutes >= 10) {
      const pass = rate < 2;
      verdict.textContent = pass ? 'PASS: under 2 per 10 min' : 'FAIL: retune defaults';
      verdict.className = `verdict ${pass ? 'pass' : 'fail'}`;
    } else {
      verdict.textContent = minutes > 0 ? `run at least 10 min (${fmt(10 - minutes, 1)} to go)` : '';
      verdict.className = 'verdict';
    }
  }

  function renderHistory(): void {
    const list = load<Record[]>(LS.sessions) ?? [];
    $('sessionHistory').replaceChildren(
      ...list
        .slice(-6)
        .reverse()
        .map((r) =>
          el('div', {
            textContent: `${r.date}  ${fmt(r.minutes, 1)} min  starts ${r.activations}  false ${r.falses}  → ${fmt((r.falses / Math.max(r.minutes, 1e-9)) * 10, 2)}/10min`,
          }),
        ),
    );
  }

  function toggle(): void {
    if (active) {
      elapsedBefore = elapsed();
      active = false;
      const list = load<Record[]>(LS.sessions) ?? [];
      list.push({ date: new Date().toLocaleString(), minutes: elapsedBefore / 60000, activations, falses });
      save(LS.sessions, list.slice(-50));
      renderHistory();
    } else {
      active = true;
      startedAt = performance.now();
    }
    $('btnSession').textContent = active ? 'Stop session' : elapsedBefore > 0 ? 'Resume session' : 'Start session';
    render();
  }

  function reset(): void {
    active = false;
    elapsedBefore = 0;
    activations = 0;
    falses = 0;
    $('btnSession').textContent = 'Start session';
    render();
  }

  $('btnSession').addEventListener('click', toggle);
  $('btnSessionReset').addEventListener('click', reset);
  renderHistory();

  let lastRender = 0;
  return {
    onEvent(e: GestureEvent) {
      if (active && e.type === 'pinch:start') activations++;
    },
    markFalse() {
      if (!active) return;
      falses++;
      render();
    },
    tick() {
      const t = performance.now();
      if (t - lastRender > 250) {
        lastRender = t;
        render();
      }
    },
  };
})();

// ── overlay ──────────────────────────────────────────────────────────────────

const CONNECTIONS: [number, number][] = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];

const css = (name: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const COLORS = { engage: css('--engage'), pose: css('--pose'), pinch: css('--pinch'), Left: css('--left'), Right: css('--right') };

function drawSkeleton(pts: Landmark[], color: string, width: number, dots: boolean): void {
  const W = canvas.width;
  const H = canvas.height;
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.beginPath();
  for (const [a, b] of CONNECTIONS) {
    ctx.moveTo(pts[a]!.x * W, pts[a]!.y * H);
    ctx.lineTo(pts[b]!.x * W, pts[b]!.y * H);
  }
  ctx.stroke();
  if (!dots) return;
  ctx.fillStyle = color;
  for (const p of pts) {
    ctx.beginPath();
    ctx.arc(p.x * W, p.y * H, width + 1, 0, Math.PI * 2);
    ctx.fill();
  }
}

function ring(x: number, y: number, r: number, progress: number, color: string, done: boolean): void {
  ctx.lineWidth = done ? 5 : 3;
  ctx.strokeStyle = 'rgba(255,255,255,0.15)';
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
  if (progress <= 0) return;
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
  ctx.stroke();
}

function draw(): void {
  const W = canvas.width;
  const H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  if (settings.showVideo && running && !settings.mirror) {
    ctx.drawImage(video, 0, 0, W, H);
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(0, 0, W, H);
  } else if (settings.showVideo && running) {
    ctx.save();
    ctx.translate(W, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(video, 0, 0, W, H);
    ctx.restore();
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    ctx.fillRect(0, 0, W, H);
  }

  const cfg = core.getConfig();
  for (const h of lastHands) {
    if (settings.showRaw) drawSkeleton(h.landmarks, 'rgba(160,160,160,0.7)', 1, !settings.showSmoothed);
    const sm = lastSmoothed.get(h.handedness);
    if (settings.showSmoothed && sm) drawSkeleton(sm, COLORS[h.handedness], 2.5, true);
  }

  for (const label of LABELS) {
    const f = core.getFeatures(label);
    const st = core.getHandState(label);
    if (!f || !st) continue;
    const spanPx = (f.span / cfg.aspect) * W; // span is in frame-height units; convert to px
    const cx = f.centroid.x * W;
    const cy = f.centroid.y * H;
    const r = Math.max(18, spanPx * 0.75);

    if (cfg.engage.pose !== '') ring(cx, cy, r + 10, st.engageProgress, COLORS.engage, st.engaged);
    ring(cx, cy, r, st.poseProgress, COLORS.pose, st.poseProgress >= 1);

    const src = lastSmoothed.get(label) ?? lastHands.find((h) => h.handedness === label)?.landmarks;
    if (src && st.pinchFinger) {
      const tip = src[TIP[st.pinchFinger]]!;
      const mx = ((src[4]!.x + tip.x) / 2) * W;
      const my = ((src[4]!.y + tip.y) / 2) * H;
      ring(mx, my, 14, st.pinchProgress, COLORS.pinch, st.pinched);
    }

    const pinchText = st.pinched ? ` · PINCH ${st.pinchFinger}` : '';
    const text = `${label}${st.pose ? ` · ${st.pose}` : ''}${st.engaged ? ' · engaged' : ''}${pinchText}`;
    ctx.font = '600 14px system-ui, sans-serif';
    const tw = ctx.measureText(text).width;
    const tx = Math.min(Math.max(cx - tw / 2, 4), W - tw - 4);
    const ty = Math.min(cy + r + 30, H - 8);
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillRect(tx - 4, ty - 15, tw + 8, 20);
    ctx.fillStyle = COLORS[label];
    ctx.fillText(text, tx, ty);
  }
}

// ── readout ──────────────────────────────────────────────────────────────────

type RowRefs = { row: HTMLElement; fill: HTMLElement; value: HTMLElement; ticks: HTMLElement[] };

function makeRow(parent: HTMLElement, label: string, extraClass = '', ticks = 0, centered = false): RowRefs {
  const fill = el('div', { className: 'fill' });
  const tickEls = Array.from({ length: ticks }, (_, i) => el('div', { className: `tick${i === 1 ? ' release' : ''}` }));
  const bar = el('div', { className: `bar${centered ? ' centered' : ''}` }, [fill, ...tickEls]);
  const value = el('div', { className: 'v' });
  const row = el('div', { className: `row ${extraClass}` }, [el('div', { className: 'k', textContent: label }), bar, value]);
  parent.append(row);
  return { row, fill, value, ticks: tickEls };
}

const FINGER_NAMES = ['thumb', 'index', 'middle', 'ring', 'pinky'];

type FingerBars = { value: HTMLElement; bars: Record<PinchFinger, { bar: HTMLElement; fill: HTMLElement; ticks: HTMLElement[] }> };

/** One row, four small bars: thumb-tip ↔ index/middle/ring/pinky tip, with close/release ticks. */
function makeFingerRow(parent: HTMLElement): FingerBars {
  const grid = el('div', { className: 'multibar' });
  const bars = {} as FingerBars['bars'];
  for (const f of PINCH_FINGERS) {
    const fill = el('div', { className: 'fill' });
    const ticks = [el('div', { className: 'tick' }), el('div', { className: 'tick release' })];
    const bar = el('div', { className: 'bar', title: `thumb ↔ ${f}` }, [fill, ...ticks]);
    grid.append(bar);
    bars[f] = { bar, fill, ticks };
  }
  const value = el('div', { className: 'v' });
  parent.append(el('div', { className: 'row' }, [el('div', { className: 'k', textContent: 'thumb→i m r p' }), grid, value]));
  return { value, bars };
}

function buildHandCard(label: HandLabel) {
  const rows = el('div', { className: 'rows' });
  const badges = {
    engaged: el('span', { className: 'badge engage', textContent: 'engaged' }),
    pinched: el('span', { className: 'badge pinch', textContent: 'pinch' }),
    pose: el('span', { className: 'badge pose', textContent: '–' }),
  };
  const card = el('div', { className: `hand ${label} absent` }, [
    el('h2', {}, [el('span', { className: 'name', textContent: label }), badges.engaged, badges.pinched, badges.pose]),
    rows,
  ]);
  const r = {
    pinch: makeRow(rows, 'pinch'),
    pinchRaws: makeFingerRow(rows),
    openness: makeRow(rows, 'openness'),
    curls: FINGER_NAMES.map((n) => makeRow(rows, `curl ${n}`)),
    tilt: makeRow(rows, 'tilt', '', 0, true),
    span: makeRow(rows, 'span'),
    centroid: makeRow(rows, 'centroid'),
  };
  rows.append(el('div', { className: 'sep' }));
  const progress = {
    engage: makeRow(rows, 'engage dwell', 'engage'),
    pinch: makeRow(rows, 'pinch dwell', 'pinch'),
    pose: makeRow(rows, 'pose dwell', 'pose'),
  };
  rows.append(el('div', { className: 'sep' }));
  const poseRows = el('div');
  rows.append(poseRows);
  const motionRows = el('div');
  rows.append(el('div', { className: 'sep' }), motionRows);
  return { card, badges, r, progress, poseRows, poseRefs: [] as RowRefs[], poseKey: '', motionRows, motionRefs: [] as RowRefs[], motionKey: '' };
}

const cards = new Map(LABELS.map((l) => [l, buildHandCard(l)] as const));
$('readout').append(...[...cards.values()].map((c) => c.card));

function setBar(ref: RowRefs, frac: number, text: string): void {
  ref.fill.style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
  ref.value.textContent = text;
}

function renderReadout(): void {
  const cfg = core.getConfig();
  const RAW_SCALE = 1.2; // pinchRaw bar spans 0..1.2
  for (const [label, c] of cards) {
    const f: Features | null = core.getFeatures(label);
    const st = core.getHandState(label);
    c.card.classList.toggle('absent', !f);
    c.badges.engaged.classList.toggle('on', !!st?.engaged);
    c.badges.pinched.classList.toggle('on', !!st?.pinched);
    c.badges.pinched.textContent = st?.pinchFinger ? `pinch ${st.pinchFinger}` : 'pinch';
    c.badges.pose.classList.toggle('on', !!st?.pose && st.poseProgress >= 1);
    c.badges.pose.textContent = st?.pose ?? 'no pose';

    const key = cfg.poses.map((p) => p.name).join('|');
    if (key !== c.poseKey) {
      c.poseKey = key;
      c.poseRows.replaceChildren();
      c.poseRefs = cfg.poses.map((p) => makeRow(c.poseRows, `≈ ${p.name}`));
    }
    const mKey = cfg.motions.map((m) => m.name).join('|');
    if (mKey !== c.motionKey) {
      c.motionKey = mKey;
      c.motionRows.replaceChildren();
      c.motionRefs = cfg.motions.map((m) => makeRow(c.motionRows, `↝ ${m.name}`, 'motion'));
    }
    if (!f || !st) {
      for (const ref of c.poseRefs) ref.row.classList.remove('best');
      continue;
    }
    st.motionProgress.forEach((m, i) => {
      const ref = c.motionRefs[i];
      if (ref) setBar(ref, m.progress, fmt(m.progress, 2));
    });

    setBar(c.r.pinch, f.pinch, fmt(f.pinch));
    const h = cfg.pinch.hysteresis;
    let closest: PinchFinger = 'index';
    for (const finger of PINCH_FINGERS) {
      const b = c.r.pinchRaws.bars[finger];
      const enabled = cfg.pinch.fingers.includes(finger);
      b.fill.style.width = `${Math.min(1, f.pinchRaws[finger] / RAW_SCALE) * 100}%`;
      b.bar.style.opacity = enabled ? '1' : '0.3';
      b.bar.classList.toggle('active', st.pinchFinger === finger);
      b.ticks[0]!.style.left = `${((cfg.pinch.closed + h) / RAW_SCALE) * 100}%`;
      b.ticks[1]!.style.left = `${((cfg.pinch.closed + 3 * h) / RAW_SCALE) * 100}%`;
      if (f.pinchRaws[finger] < f.pinchRaws[closest]) closest = finger;
    }
    c.r.pinchRaws.value.textContent = `${closest[0]} ${fmt(f.pinchRaws[closest], 2)}`;
    setBar(c.r.openness, f.openness, fmt(f.openness));
    f.curls.forEach((v, i) => setBar(c.r.curls[i]!, v, fmt(v)));
    const tiltFrac = f.tilt / Math.PI / 2; // -0.5..0.5 of the bar, drawn from centre
    c.r.tilt.fill.style.left = tiltFrac >= 0 ? '50%' : `${(0.5 + tiltFrac) * 100}%`;
    c.r.tilt.fill.style.width = `${Math.abs(tiltFrac) * 100}%`;
    c.r.tilt.value.textContent = `${fmt((f.tilt * 180) / Math.PI, 1)}°`;
    setBar(c.r.span, f.span / 0.6, fmt(f.span));
    setBar(c.r.centroid, 0, `${fmt(f.centroid.x, 2)},${fmt(f.centroid.y, 2)}`);

    setBar(c.progress.engage, st.engageProgress, cfg.engage.pose === '' ? 'always' : fmt(st.engageProgress, 2));
    setBar(c.progress.pinch, st.pinchProgress, fmt(st.pinchProgress, 2));
    setBar(c.progress.pose, st.poseProgress, fmt(st.poseProgress, 2));

    st.poseScores.forEach((m, i) => {
      const ref = c.poseRefs[i];
      if (!ref) return;
      setBar(ref, m.score, fmt(m.score, 2));
      ref.row.classList.toggle('best', m.name === st.pose);
    });
  }
}

// ── tuning sliders ───────────────────────────────────────────────────────────

type SliderSpec = {
  path: [keyof GestureCoreConfig] | [keyof GestureCoreConfig, string];
  label: string;
  min: number;
  max: number;
  step: number;
  log?: boolean;
  title?: string;
};

const SLIDER_GROUPS: { legend: string; specs: SliderSpec[] }[] = [
  {
    legend: 'Smoothing (One Euro)',
    specs: [
      { path: ['smoothing', 'minCutoff'], label: 'minCutoff Hz', min: 0.01, max: 30, step: 0.01, log: true, title: 'Lower = smoother at rest, more lag' },
      { path: ['smoothing', 'beta'], label: 'beta', min: 0.0001, max: 100, step: 0.0001, log: true, title: 'Higher = less lag during fast motion' },
      { path: ['smoothing', 'dCutoff'], label: 'dCutoff Hz', min: 0.01, max: 30, step: 0.01, log: true },
    ],
  },
  {
    legend: 'Pinch (thresholds on pinchRaw)',
    specs: [
      { path: ['pinch', 'closed'], label: 'closed', min: 0, max: 1, step: 0.005 },
      { path: ['pinch', 'open'], label: 'open', min: 0, max: 2, step: 0.005 },
      { path: ['pinch', 'hysteresis'], label: 'hysteresis h', min: 0, max: 0.3, step: 0.005, title: 'Closes below closed+h, releases above closed+3h' },
    ],
  },
  {
    legend: 'Timing',
    specs: [
      { path: ['dwellMs'], label: 'dwellMs', min: 0, max: 2000, step: 10 },
      { path: ['engage', 'dwellMs'], label: 'engage dwellMs', min: 0, max: 3000, step: 10 },
      { path: ['lostAfterMs'], label: 'lostAfterMs', min: 0, max: 2000, step: 10 },
    ],
  },
  {
    legend: 'Curl mapping (radians) and pose scoring',
    specs: [
      { path: ['curl', 'straight'], label: 'finger straight', min: 0, max: Math.PI, step: 0.01 },
      { path: ['curl', 'bent'], label: 'finger bent', min: 0, max: Math.PI, step: 0.01 },
      { path: ['curl', 'thumbStraight'], label: 'thumb straight', min: 0, max: Math.PI, step: 0.01 },
      { path: ['curl', 'thumbBent'], label: 'thumb bent', min: 0, max: Math.PI, step: 0.01 },
      { path: ['poseFalloff'], label: 'pose falloff', min: 0.01, max: 1, step: 0.01 },
    ],
  },
];

const sliderRefresh: (() => void)[] = [];

function readPath(cfg: GestureCoreConfig, path: SliderSpec['path']): number {
  const [a, b] = path;
  const v = cfg[a] as unknown;
  return (b === undefined ? v : (v as Record<string, unknown>)[b]) as number;
}

function patchFor(path: SliderSpec['path'], value: number): GestureCoreConfigPatch {
  const [a, b] = path;
  return (b === undefined ? { [a]: value } : { [a]: { [b]: value } }) as GestureCoreConfigPatch;
}

function buildSliders(): void {
  const root = $('sliders');
  const defaults = defaultConfig();

  // engage pose select lives with timing
  const engageSel = el('select');
  const refreshEngage = () => {
    const cfg = core.getConfig();
    engageSel.replaceChildren(
      el('option', { value: '', textContent: '(none: always engaged)' }),
      ...cfg.poses.map((p) => el('option', { value: p.name, textContent: p.name })),
    );
    if (cfg.engage.pose !== '' && !cfg.poses.some((p) => p.name === cfg.engage.pose)) {
      engageSel.append(el('option', { value: cfg.engage.pose, textContent: `${cfg.engage.pose} (missing!)` }));
    }
    engageSel.value = cfg.engage.pose;
  };
  engageSel.addEventListener('change', () => applyConfig({ engage: { pose: engageSel.value } }));
  sliderRefresh.push(refreshEngage);

  for (const group of SLIDER_GROUPS) {
    const fs = el('fieldset', {}, [el('legend', { textContent: group.legend })]);
    if (group.legend === 'Timing') {
      fs.append(el('div', { className: 'ctl' }, [el('label', { textContent: 'engage pose' }), engageSel, el('span')]));
    }
    if (group.legend.startsWith('Pinch')) {
      const boxes = PINCH_FINGERS.map((finger) => {
        const box = el('input', { type: 'checkbox' });
        box.addEventListener('change', () => {
          const fingers = PINCH_FINGERS.filter((x, i) => (x === finger ? box.checked : boxes[i]!.checked));
          applyConfig({ pinch: { fingers } });
        });
        return box;
      });
      sliderRefresh.push(() => {
        const on = core.getConfig().pinch.fingers;
        PINCH_FINGERS.forEach((x, i) => (boxes[i]!.checked = on.includes(x)));
      });
      fs.append(
        el('div', { className: 'ctl' }, [
          el('label', { textContent: 'pinch fingers' }),
          el('div', { className: 'fingers' }, PINCH_FINGERS.map((x, i) => el('label', { className: 'check' }, [boxes[i]!, x]))),
          el('span'),
        ]),
      );
    }
    for (const spec of group.specs) {
      const range = el('input', { type: 'range', min: '0', max: '1000', step: '1', title: spec.title ?? '' });
      const num = el('input', { type: 'number', min: String(spec.min), max: String(spec.max), step: String(spec.step) });
      const row = el('div', { className: 'ctl', title: spec.title ?? '' }, [el('label', { textContent: spec.label }), range, num]);

      const toRange = (v: number) =>
        spec.log
          ? (Math.log(Math.max(v, spec.min) / spec.min) / Math.log(spec.max / spec.min)) * 1000
          : ((v - spec.min) / (spec.max - spec.min)) * 1000;
      const fromRange = (r: number) =>
        spec.log ? spec.min * Math.pow(spec.max / spec.min, r / 1000) : spec.min + (r / 1000) * (spec.max - spec.min);
      const round = (v: number) => {
        const decimals = Math.max(0, -Math.floor(Math.log10(spec.step)));
        return Number(v.toFixed(decimals));
      };
      const sync = () => {
        const v = readPath(core.getConfig(), spec.path);
        range.value = String(toRange(v));
        num.value = String(v);
        row.classList.toggle('changed', Math.abs(v - readPath(defaults, spec.path)) > 1e-9);
      };
      range.addEventListener('input', () => {
        applyConfig(patchFor(spec.path, round(fromRange(Number(range.value)))));
        sync();
      });
      num.addEventListener('change', () => {
        const v = Number(num.value);
        if (Number.isFinite(v)) applyConfig(patchFor(spec.path, v));
        sync();
      });
      sliderRefresh.push(sync);
      fs.append(row);
    }
    root.append(fs);
  }
  refreshAll();
}

function refreshAll(): void {
  for (const f of sliderRefresh) f();
  const cfg = core.getConfig();
  $<HTMLTextAreaElement>('posesText').value = JSON.stringify(cfg.poses, null, 2);
  $<HTMLTextAreaElement>('motionsText').value = JSON.stringify(cfg.motions, null, 2);
  const mvPose = $<HTMLSelectElement>('mvPose');
  const keep = mvPose.value;
  mvPose.replaceChildren(
    el('option', { value: '', textContent: '(any hand shape)' }),
    ...cfg.poses.map((p) => el('option', { value: p.name, textContent: p.name })),
  );
  mvPose.value = cfg.poses.some((p) => p.name === keep) ? keep : '';
}

function flash(target: string, text: string, ok = true): void {
  const node = $(target);
  node.textContent = text;
  node.className = ok ? 'okmsg' : 'err';
  if (ok) setTimeout(() => node.textContent === text && (node.textContent = ''), 2500);
}

$('btnResetConfig').addEventListener('click', () => {
  const aspect = core.getConfig().aspect;
  const d = defaultConfig();
  applyConfig({ ...d, aspect });
  refreshAll();
  flash('configMsg', 'Defaults restored.');
});
$('btnCopyConfig').addEventListener('click', async () => {
  await navigator.clipboard.writeText(JSON.stringify(core.getConfig(), null, 2));
  flash('configMsg', 'Config copied to clipboard.');
});
$('btnImportToggle').addEventListener('click', () => {
  $('importBox').hidden = !$('importBox').hidden;
});
$('btnImportApply').addEventListener('click', () => {
  try {
    const parsed = JSON.parse($<HTMLTextAreaElement>('importText').value) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('expected a JSON object');
    const aspect = core.getConfig().aspect;
    applyConfig({ ...(parsed as GestureCoreConfigPatch), aspect });
    refreshAll();
    flash('configMsg', 'Config imported.');
  } catch (err) {
    flash('configMsg', `Import failed: ${(err as Error).message}`, false);
  }
});

// ── poses editor ─────────────────────────────────────────────────────────────

function validatePoses(value: unknown): PoseDescription[] {
  if (!Array.isArray(value)) throw new Error('poses must be a JSON array');
  const fingers = new Set(FINGER_NAMES);
  const names = new Set<string>();
  value.forEach((p, i) => {
    const where = `pose ${i}`;
    if (typeof p !== 'object' || p === null) throw new Error(`${where}: not an object`);
    const pose = p as Record<string, unknown>;
    if (typeof pose.name !== 'string' || pose.name === '') throw new Error(`${where}: name must be a non-empty string`);
    if (names.has(pose.name)) throw new Error(`${where}: duplicate name "${pose.name}"`);
    names.add(pose.name);
    if (typeof pose.fingers !== 'object' || pose.fingers === null) throw new Error(`${pose.name}: fingers must be an object`);
    for (const [finger, spec] of Object.entries(pose.fingers)) {
      if (!fingers.has(finger)) throw new Error(`${pose.name}: unknown finger "${finger}"`);
      const curl = (spec as { curl?: unknown }).curl;
      if (curl !== undefined && !(Array.isArray(curl) && curl.length === 2 && curl.every((n) => typeof n === 'number' && n >= 0 && n <= 1))) {
        throw new Error(`${pose.name}.${finger}.curl must be [min, max] within 0..1`);
      }
    }
    if (pose.minScore !== undefined && !(typeof pose.minScore === 'number' && pose.minScore >= 0 && pose.minScore <= 1)) {
      throw new Error(`${pose.name}: minScore must be within 0..1`);
    }
  });
  return value as PoseDescription[];
}

$('btnPosesApply').addEventListener('click', () => {
  try {
    const poses = validatePoses(JSON.parse($<HTMLTextAreaElement>('posesText').value));
    applyConfig({ poses });
    refreshAll();
    flash('posesMsg', `Applied ${poses.length} poses.`);
  } catch (err) {
    flash('posesMsg', (err as Error).message, false);
  }
});
$('btnPosesReset').addEventListener('click', () => {
  applyConfig({ poses: JSON.parse(JSON.stringify(DEFAULT_POSES)) as PoseDescription[] });
  refreshAll();
  flash('posesMsg', 'Default poses restored.');
});

// ── movements editor and builder ─────────────────────────────────────────────

const AXES: MotionAxis[] = ['x', 'y', 'depth', 'tilt'];

function validateMotions(value: unknown): MotionDescription[] {
  if (!Array.isArray(value)) throw new Error('movements must be a JSON array');
  const names = new Set<string>();
  value.forEach((m, i) => {
    if (typeof m !== 'object' || m === null) throw new Error(`movement ${i}: not an object`);
    const d = m as Record<string, unknown>;
    const who = typeof d.name === 'string' && d.name ? d.name : `movement ${i}`;
    if (typeof d.name !== 'string' || d.name === '') throw new Error(`${who}: name must be a non-empty string`);
    if (names.has(d.name)) throw new Error(`${who}: duplicate name`);
    names.add(d.name);
    if (!AXES.includes(d.axis as MotionAxis)) throw new Error(`${who}: axis must be one of ${AXES.join(', ')}`);
    if (!(typeof d.distance === 'number' && d.distance > 0)) throw new Error(`${who}: distance must be a number > 0`);
    if (!(typeof d.withinMs === 'number' && d.withinMs > 0)) throw new Error(`${who}: withinMs must be a number > 0`);
    if (d.direction !== undefined && d.direction !== 1 && d.direction !== -1) throw new Error(`${who}: direction must be 1 or -1`);
    if (d.reversals !== undefined && !(Number.isInteger(d.reversals) && (d.reversals as number) >= 0)) {
      throw new Error(`${who}: reversals must be a whole number ≥ 0`);
    }
    if (d.pose !== undefined && typeof d.pose !== 'string') throw new Error(`${who}: pose must be a string`);
    if (d.cooldownMs !== undefined && !(typeof d.cooldownMs === 'number' && d.cooldownMs >= 0)) {
      throw new Error(`${who}: cooldownMs must be a number ≥ 0`);
    }
  });
  return value as MotionDescription[];
}

$('btnMotionsApply').addEventListener('click', () => {
  try {
    const motions = validateMotions(JSON.parse($<HTMLTextAreaElement>('motionsText').value));
    applyConfig({ motions });
    refreshAll();
    flash('motionsMsg', `Applied ${motions.length} movements.`);
  } catch (err) {
    flash('motionsMsg', (err as Error).message, false);
  }
});
$('btnMotionsReset').addEventListener('click', () => {
  applyConfig({ motions: JSON.parse(JSON.stringify(DEFAULT_MOTIONS)) as MotionDescription[] });
  refreshAll();
  flash('motionsMsg', 'Default movements restored.');
});

(() => {
  const axisSel = $<HTMLSelectElement>('mvAxis');
  const dirSel = $<HTMLSelectElement>('mvDir');
  const dist = $<HTMLInputElement>('mvDist');
  const rev = $<HTMLInputElement>('mvRev');
  const AXIS_INFO: Record<MotionAxis, { plus: string; minus: string; unit: string; distance: number }> = {
    x: { plus: 'right →', minus: '← left', unit: 'hand sizes', distance: 1.5 },
    y: { plus: 'down ↓', minus: '↑ up', unit: 'hand sizes', distance: 1.5 },
    depth: { plus: 'toward camera', minus: 'away from camera', unit: '× size change (0.25 = 25 %)', distance: 0.25 },
    tilt: { plus: 'clockwise on screen', minus: 'counter-clockwise', unit: 'radians (0.5 ≈ 29°)', distance: 0.6 },
  };
  const update = (axisChanged: boolean) => {
    const info = AXIS_INFO[axisSel.value as MotionAxis];
    const keep = dirSel.value;
    dirSel.replaceChildren(el('option', { value: '1', textContent: info.plus }), el('option', { value: '-1', textContent: info.minus }));
    dirSel.value = keep === '-1' ? '-1' : '1';
    $('mvUnit').textContent = info.unit;
    if (axisChanged) dist.value = String(info.distance);
    const waves = Number(rev.value) > 0;
    dirSel.disabled = waves;
    $('mvHint').textContent = waves
      ? `A back-and-forth of ${Number(rev.value) + 1} strokes, each at least the distance, all within the time. Direction does not matter.`
      : 'One stroke of at least the distance, within the time.' +
        (axisSel.value === 'x' && !settings.mirror ? ' Mirror view is off, so right/left are the camera\'s, not yours.' : '');
  };
  axisSel.addEventListener('change', () => update(true));
  rev.addEventListener('input', () => update(false));
  update(true);

  $('mvAdd').addEventListener('click', () => {
    const name = $<HTMLInputElement>('mvName').value.trim();
    if (!name) return flash('mvMsg', 'Give the movement a name.', false);
    const reversals = Math.max(0, Math.floor(Number(rev.value) || 0));
    const pose = $<HTMLSelectElement>('mvPose').value;
    const motion: MotionDescription = {
      name,
      axis: axisSel.value as MotionAxis,
      distance: Number(dist.value),
      withinMs: Number($<HTMLInputElement>('mvWithin').value),
      cooldownMs: Number($<HTMLInputElement>('mvCool').value),
      ...(reversals > 0 ? { reversals } : { direction: dirSel.value === '-1' ? -1 : 1 }),
      ...(pose ? { pose } : {}),
    };
    try {
      const motions = core.getConfig().motions.filter((m) => m.name !== name);
      motions.push(motion);
      applyConfig({ motions: validateMotions(motions) });
      refreshAll();
      flash('mvMsg', `Added "${name}". Try it: engage, then move.`);
    } catch (err) {
      flash('mvMsg', (err as Error).message, false);
    }
  });
})();

// ── pose recorder ────────────────────────────────────────────────────────────

const poseRecorder = (() => {
  const NEED = 15;
  let collecting: { hand: HandLabel; name: string; curls: number[][] } | null = null;
  let countdown: number | undefined;
  bindPair('grTol', 'grTolN');
  bindPair('grDelay', 'grDelayN');
  const status = (text: string): void => {
    $('grStatus').textContent = text;
  };

  $('grRecord').addEventListener('click', () => {
    const name = $<HTMLInputElement>('grName').value.trim();
    if (!name) return status('Give the pose a name first.');
    clearInterval(countdown);
    const hand = $<HTMLSelectElement>('grHand').value as HandLabel;
    let left = Number($<HTMLInputElement>('grDelay').value);
    const begin = () => {
      collecting = { hand, name, curls: [] };
      status(`Hold it… reading your ${hand} hand`);
    };
    if (left <= 0) return begin();
    status(`Make the "${name}" shape with your ${hand} hand… ${left}`);
    countdown = window.setInterval(() => {
      left--;
      if (left > 0) return status(`Make the "${name}" shape with your ${hand} hand… ${left}`);
      clearInterval(countdown);
      begin();
    }, 1000);
  });

  function onFrame(): void {
    if (!collecting) return;
    const f = core.getFeatures(collecting.hand);
    if (!f) return status(`Waiting for your ${collecting.hand} hand…`);
    collecting.curls.push(f.curls);
    if (collecting.curls.length < NEED) return status(`Reading ${collecting.curls.length}/${NEED}…`);

    const { name, curls } = collecting;
    collecting = null;
    const tol = Number($<HTMLInputElement>('grTol').value);
    const withThumb = $<HTMLInputElement>('grThumb').checked;
    const r2 = (v: number) => Math.round(v * 100) / 100;
    const fingers: PoseDescription['fingers'] = {};
    FINGER_NAMES.forEach((finger, i) => {
      if (i === 0 && !withThumb) return;
      const mean = curls.reduce((s, c) => s + c[i]!, 0) / curls.length;
      fingers[finger as keyof PoseDescription['fingers']] = {
        curl: [r2(Math.max(0, mean - tol)), r2(Math.min(1, mean + tol))],
      };
    });
    const pose: PoseDescription = { name, fingers };
    const poses = core.getConfig().poses.filter((p) => p.name !== name);
    poses.push(pose);
    applyConfig({ poses });
    refreshAll();
    status(`Saved pose "${name}": ${Object.entries(fingers).map(([k, v]) => `${k} ${v.curl![0]}–${v.curl![1]}`).join(', ')}`);
  }

  return { onFrame };
})();

// ── fixture capture ──────────────────────────────────────────────────────────

const capture = (() => {
  let collecting: { hand: HandLabel; need: number; frames: Landmark[][] } | null = null;
  let countdown: number | undefined;
  let captured: Landmark[] | null = null;

  const nameSel = $<HTMLSelectElement>('fxName');
  const fixtureName = () => (nameSel.value === 'custom' ? $<HTMLInputElement>('fxCustom').value.trim() : nameSel.value);
  nameSel.addEventListener('change', () => {
    $('fxCustomRow').hidden = nameSel.value !== 'custom';
  });
  bindPair('fxFrames', 'fxFramesN');
  bindPair('fxDelay', 'fxDelayN');

  function status(text: string) {
    $('fxStatus').textContent = text;
  }

  $('btnCapture').addEventListener('click', () => {
    if (!running) return status('Start the camera first.');
    clearInterval(countdown);
    const hand = $<HTMLSelectElement>('fxHand').value as HandLabel;
    const need = Number($<HTMLInputElement>('fxFrames').value);
    let left = Number($<HTMLInputElement>('fxDelay').value);
    const begin = () => {
      collecting = { hand, need, frames: [] };
      status(`Hold still… collecting ${need} frames of your ${hand} hand`);
    };
    if (left <= 0) return begin();
    status(`Get into pose with your ${hand} hand… ${left}`);
    countdown = window.setInterval(() => {
      left--;
      if (left > 0) return status(`Get into pose with your ${hand} hand… ${left}`);
      clearInterval(countdown);
      begin();
    }, 1000);
  });

  function onFrame(hands: Hand[]): void {
    if (!collecting) return;
    const h = hands.find((x) => x.handedness === collecting!.hand);
    if (!h) return status(`Waiting for your ${collecting.hand} hand to be visible…`);
    collecting.frames.push(h.landmarks);
    if (collecting.frames.length < collecting.need) {
      return status(`Collecting ${collecting.frames.length}/${collecting.need}…`);
    }
    finish(collecting.frames);
    collecting = null;
  }

  function finish(frames: Landmark[][]): void {
    const aspect = core.getConfig().aspect;
    const n = frames.length;
    const round = (v: number) => Number(v.toFixed(5));
    captured = frames[0]!.map((_, i) => {
      let x = 0, y = 0, z = 0;
      for (const f of frames) {
        x += f[i]!.x;
        y += f[i]!.y;
        z += f[i]!.z;
      }
      // isotropic: fixtures are stored with aspect already applied
      return { x: round((x / n) * aspect), y: round(y / n), z: round((z / n) * aspect) };
    });
    $<HTMLTextAreaElement>('fxJson').value = JSON.stringify(captured, null, 2);
    const cfg = { ...core.getConfig(), aspect: 1 };
    const f = extractFeatures(captured, cfg);
    const scores = matchPoses(f, cfg.poses, cfg.poseFalloff)
      .map((m) => `${m.name} ${fmt(m.score, 2)}`)
      .join('  ');
    $('fxPreview').textContent =
      `pinchRaw ${fmt(f.pinchRaw)}  openness ${fmt(f.openness)}  curls [${f.curls.map((c) => fmt(c, 2)).join(', ')}]\n` +
      `scores: ${scores}`;
    status(`Captured ${n} frames. Check the preview, then save.`);
  }

  $('btnFxSave').addEventListener('click', async () => {
    const name = fixtureName();
    let body: string;
    try {
      body = JSON.stringify(JSON.parse($<HTMLTextAreaElement>('fxJson').value));
    } catch {
      return flash('fxMsg', 'The JSON box does not contain valid JSON.', false);
    }
    if (!/^[a-z][a-z0-9-]{0,40}$/.test(name)) return flash('fxMsg', 'Name must be lowercase letters, digits or dashes.', false);
    const res = await fetch(`/__fixtures/${name}`, { method: 'POST', body });
    flash('fxMsg', await res.text(), res.ok);
  });
  $('btnFxCopy').addEventListener('click', async () => {
    await navigator.clipboard.writeText($<HTMLTextAreaElement>('fxJson').value);
    flash('fxMsg', 'Copied.');
  });

  return { onFrame };
})();

// ── source tab and misc bindings ─────────────────────────────────────────────

function bindPair(rangeId: string, numId: string, onChange?: (v: number) => void): void {
  const r = $<HTMLInputElement>(rangeId);
  const n = $<HTMLInputElement>(numId);
  r.addEventListener('input', () => {
    n.value = r.value;
    onChange?.(Number(r.value));
  });
  n.addEventListener('change', () => {
    r.value = n.value;
    onChange?.(Number(n.value));
  });
}

function bindCheck(id: string, key: { [K in keyof BenchSettings]: BenchSettings[K] extends boolean ? K : never }[keyof BenchSettings], after?: () => void): void {
  const c = $<HTMLInputElement>(id);
  c.checked = settings[key];
  c.addEventListener('change', () => {
    settings[key] = c.checked;
    saveSettings();
    after?.();
  });
}

const resetTracking = () => {
  core.reset();
  smoothers.clear();
  lastHands = [];
  lastSmoothed.clear();
  $('legendMirror').textContent = settings.mirror ? 'view is mirrored' : 'view is not mirrored';
  draw();
  renderReadout();
};
bindCheck('hdrSwap', 'flipHandedness', resetTracking);
bindCheck('hdrMirror', 'mirror', resetTracking);
$('legendMirror').textContent = settings.mirror ? 'view is mirrored' : 'view is not mirrored';

const scrollFingerSel = $<HTMLSelectElement>('scrollFinger');
scrollFingerSel.value = settings.scrollFinger;
scrollFingerSel.addEventListener('change', () => {
  settings.scrollFinger = scrollFingerSel.value as BenchSettings['scrollFinger'];
  saveSettings();
});
bindCheck('ovRaw', 'showRaw', draw);
bindCheck('ovSmooth', 'showSmoothed', draw);
bindCheck('ovVideo', 'showVideo', draw);
bindCheck('chkMoves', 'showMoves');
bindCheck('scrollInvert', 'scrollInvert');

const scrollHandSel = $<HTMLSelectElement>('scrollHand');
scrollHandSel.value = settings.scrollHand;
scrollHandSel.addEventListener('change', () => {
  settings.scrollHand = scrollHandSel.value as BenchSettings['scrollHand'];
  saveSettings();
});
$<HTMLInputElement>('scrollGain').value = String(settings.scrollGain);
$<HTMLInputElement>('scrollGainN').value = String(settings.scrollGain);
bindPair('scrollGain', 'scrollGainN', (v) => {
  settings.scrollGain = v;
  saveSettings();
});

async function restartCameraIfRunning(): Promise<void> {
  if (!running) return;
  stopCamera();
  await startCamera();
}

const resSel = $<HTMLSelectElement>('srcRes');
resSel.value = settings.resolution;
resSel.addEventListener('change', () => {
  settings.resolution = resSel.value;
  saveSettings();
  void restartCameraIfRunning();
});
const devSel = $<HTMLSelectElement>('srcDevice');
devSel.addEventListener('change', () => {
  settings.deviceId = devSel.value;
  saveSettings();
  void restartCameraIfRunning();
});
const delSel = $<HTMLSelectElement>('srcDelegate');
delSel.value = settings.delegate;
delSel.addEventListener('change', async () => {
  settings.delegate = delSel.value as BenchSettings['delegate'];
  saveSettings();
  const wasRunning = running;
  if (wasRunning) stopCamera();
  landmarker?.close();
  landmarker = null;
  if (wasRunning) await startCamera();
});

(() => {
  const root = $('mpSliders');
  const specs: [keyof BenchSettings & `min${string}`, string][] = [
    ['minHandDetectionConfidence', 'detection conf.'],
    ['minHandPresenceConfidence', 'presence conf.'],
    ['minTrackingConfidence', 'tracking conf.'],
  ];
  for (const [key, label] of specs) {
    const range = el('input', { type: 'range', min: '0', max: '1', step: '0.05', value: String(settings[key]) });
    const num = el('input', { type: 'number', min: '0', max: '1', step: '0.05', value: String(settings[key]) });
    const apply = (v: number) => {
      settings[key] = v;
      saveSettings();
      void landmarker?.setOptions({ [key]: v });
    };
    range.addEventListener('input', () => {
      num.value = range.value;
      apply(Number(range.value));
    });
    num.addEventListener('change', () => {
      range.value = num.value;
      apply(Number(num.value));
    });
    root.append(el('div', { className: 'ctl' }, [el('label', { textContent: label }), range, num]));
  }
})();

// tabs
const tabButtons = [...document.querySelectorAll<HTMLButtonElement>('#tabs button')];
function showTab(name: string): void {
  if (!tabButtons.some((b) => b.dataset.tab === name)) name = 'tuning';
  settings.tab = name;
  saveSettings();
  for (const b of tabButtons) b.classList.toggle('active', b.dataset.tab === name);
  for (const pane of document.querySelectorAll<HTMLElement>('.tabpane')) pane.hidden = pane.dataset.pane !== name;
}
tabButtons.forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab!)));
showTab(settings.tab);

$('btnCamera').addEventListener('click', () => (running ? stopCamera() : void startCamera()));
$('btnClearLog').addEventListener('click', () => {
  logEl.replaceChildren();
  moveLines.clear();
});

window.addEventListener('keydown', (e) => {
  const target = e.target as HTMLElement;
  if (target.matches('input[type="text"], input[type="number"], textarea, select')) return;
  if (e.key === 'f' || e.key === 'F') session.markFalse();
  if (e.key === 'r' || e.key === 'R') {
    core.reset();
    smoothers.clear();
  }
  if (e.key === ' ') {
    e.preventDefault();
    paused = !paused;
    setMessage(paused ? 'Paused (Space to resume)' : '');
  }
});

buildSliders();
renderReadout();
draw();

// Debug hook: drive the bench without a camera, e.g. from the devtools console.
(window as unknown as { gesturecoreBench: object }).gesturecoreBench = {
  core,
  feed: (hands: Hand[], t: number) => processFrame(hands, t),
};
