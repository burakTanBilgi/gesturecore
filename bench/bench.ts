/**
 * gesturecore tuning bench.
 *
 * This file is an adapter: it owns the camera, MediaPipe, the DOM, the clock and
 * localStorage. The core only ever sees `update(hands, t)`, `setConfig()` and reads.
 */
import 'virtual:dockview.css';
import type { HandLandmarker, HandLandmarkerResult } from '@mediapipe/tasks-vision';
import {
  createDockview,
  type DockviewApi,
  type DockviewTheme,
  type IContentRenderer,
  type ITabRenderer,
  type SerializedDockview,
} from 'dockview-core';
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
  type MotionFit,
  type MotionSample,
  fitMotion,
  fitPose,
  PINCH_FINGERS,
  LandmarkSmoother,
  bestPose,
  extractFeatures,
  matchPoses,
} from 'gesturecore';
import {
  DEFAULT_CUES,
  GestureSound,
  THEREMIN,
  midiToHz,
  readerFor,
  type ControlDescription,
  type CueDescription,
  type SoundName,
} from 'gesturecore-sound';

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
  sound: 'gesturecore.bench.sound.v1',
  settings: 'gesturecore.bench.settings.v3',
  layout: 'gesturecore.bench.layout.v1',
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
  glass: boolean;
  animatedBg: boolean;
};

const DEFAULT_SETTINGS: BenchSettings = {
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
  glass: true,
  animatedBg: true,
};

const stored = load<Partial<BenchSettings>>(LS.settings) ?? {};
const settings: BenchSettings = { ...DEFAULT_SETTINGS };
for (const key of Object.keys(DEFAULT_SETTINGS) as (keyof BenchSettings)[]) {
  const value = stored[key];
  if (typeof value === typeof DEFAULT_SETTINGS[key]) Object.assign(settings, { [key]: value });
}
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

/** Which dock panels are on screen; hidden ones are not drawn or updated. */
const visible = new Map<string, boolean>();
const shows = (panel: string) => visible.get(panel) !== false;

let landmarker: HandLandmarker | null = null;
let stream: MediaStream | null = null;
let running = false;
let paused = false;
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

/** Header readouts: measured values stay cyan, `on`/`off` mark a live or idle source. */
function setStat(id: string, text: string, state: '' | 'on' | 'off' = ''): void {
  const node = $(id);
  node.textContent = text;
  node.className = state;
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
  // Loaded on demand: opening the bench without starting the camera costs nothing.
  let vision: typeof import('@mediapipe/tasks-vision');
  try {
    vision = await import('@mediapipe/tasks-vision');
  } catch (err) {
    // The dev server re-bundled its dependencies since this page loaded; a reload
    // picks up the new addresses. Only once, so a real failure still shows.
    if (sessionStorage.getItem('gesturecore.reloaded') === null) {
      sessionStorage.setItem('gesturecore.reloaded', '1');
      setMessage('The bench was updated — reloading…');
      location.reload();
      await new Promise(() => {});
    }
    throw err;
  }
  sessionStorage.removeItem('gesturecore.reloaded');
  const { FilesetResolver, HandLandmarker } = vision;
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
    setStat('stDelegate', settings.delegate, 'on');
  } catch (err) {
    if (settings.delegate === 'CPU') throw err;
    console.warn('GPU delegate failed, falling back to CPU', err);
    landmarker = await HandLandmarker.createFromOptions(fileset, options('CPU'));
    setStat('stDelegate', 'CPU (GPU failed)', 'on');
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
  btn.textContent = 'Starting…';
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
    setStat('stCamera', `${video.videoWidth}×${video.videoHeight}`, 'on');
    setMessage('');
    running = true;
    btn.textContent = 'Stop camera';
    await listDevices();
    video.requestVideoFrameCallback(onVideoFrame);
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
  paused = false;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
  $('btnCamera').textContent = 'Start camera';
  setStat('stCamera', 'off', 'off');
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

/** One pass per delivered camera frame — no polling, and nothing runs while the tab is hidden. */
function onVideoFrame(): void {
  if (!running) return;
  if (!paused && landmarker) {
    const now = performance.now();
    const res = landmarker.detectForVideo(video, now);
    perf.detectMs = perf.detectMs * 0.9 + (performance.now() - now) * 0.1;
    processFrame(toHands(res), now);
  }
  const t = performance.now();
  if (t - perf.since >= 500) {
    perf.fps = (perf.frames * 1000) / (t - perf.since);
    perf.frames = 0;
    perf.since = t;
    setStat('stFps', fmt(perf.fps, 1));
    setStat('stDetect', `${fmt(perf.detectMs, 1)} ms`);
    setStat('stCore', `${fmt(perf.coreMs, 2)} ms`);
  }
  video.requestVideoFrameCallback(onVideoFrame);
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
  motionRecorder.onFrame(coreTime(now));
  draw();
  renderReadout();
  moves.update();
  return events;
}

function updateVisualSmoothing(hands: Hand[], t: number): void {
  if (!shows('stage') || !settings.showSmoothed) {
    if (lastSmoothed.size) lastSmoothed = new Map();
    return;
  }
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
    session.onEvent(e);
    if (e.type === 'lost') smoothers.delete(e.hand);
    if (e.type === 'pinch:start' || e.type === 'motion') backdrop.ripple(0.5);
    else if (e.type === 'engage' || e.type === 'pose') backdrop.ripple(0.25);
    log(e);
  }
  // every frame, even without events: sustained voices follow the hands
  soundBrick.update(events);
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
  const cls = e.type.replace(':', '').replace('pinchmove', 'move');
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

/** False-activation meter for the definition-of-done check. Measures the core; changes nothing. */
const session = (() => {
  type Record = { date: string; minutes: number; activations: number; falses: number };
  let active = false;
  let startedAt = 0;
  let elapsedBefore = 0;
  let activations = 0;
  let falses = 0;
  let ticker: number | undefined;

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
    clearInterval(ticker);
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
      ticker = window.setInterval(render, 500);
    }
    $('btnSession').textContent = active ? 'Stop' : elapsedBefore > 0 ? 'Resume' : 'Start';
    render();
  }

  function reset(): void {
    clearInterval(ticker);
    active = false;
    elapsedBefore = 0;
    activations = 0;
    falses = 0;
    $('btnSession').textContent = 'Start';
    render();
  }

  $('btnSession').addEventListener('click', toggle);
  $('btnSessionReset').addEventListener('click', reset);
  renderHistory();

  return {
    onEvent(e: GestureEvent) {
      if (active && (e.type === 'pinch:start' || e.type === 'motion')) activations++;
    },
    markFalse() {
      if (!active) return;
      falses++;
      render();
    },
  };
})();

// ── sound brick ──────────────────────────────────────────────────────────────

/**
 * gesturecore-sound, wired in as an optional brick: it only ever reads what the core
 * produced. With sound off it costs nothing — update() returns at once.
 */
const soundBrick = (() => {
  type Saved = { volume?: number; cues?: CueDescription[]; controls?: ControlDescription[] };
  const saved = load<Saved>(LS.sound) ?? {};
  const sound = new GestureSound({
    volume: saved.volume ?? 0.7,
    cues: saved.cues ?? structuredClone(DEFAULT_CUES),
    controls: saved.controls ?? [],
  });
  const read = readerFor(core);
  const SOUNDS: SoundName[] = ['click', 'blip', 'chime', 'pluck', 'swoosh', 'thud', 'rise', 'fall'];
  const persist = () => {
    const c = sound.getConfig();
    save(LS.sound, { volume: c.volume, cues: c.cues, controls: c.controls });
  };

  const power = $<HTMLButtonElement>('sndPower');
  const showState = () => {
    power.textContent = sound.running ? 'Turn sound off' : 'Turn sound on';
    $('sndState').textContent = sound.running ? 'on' : 'off';
  };
  power.addEventListener('click', async () => {
    power.disabled = true;
    try {
      if (sound.running) await sound.stop();
      else await sound.start();
    } finally {
      power.disabled = false;
      showState();
    }
  });

  const vol = $<HTMLInputElement>('sndVol');
  const volN = $<HTMLInputElement>('sndVolN');
  vol.value = volN.value = String(sound.getConfig().volume);
  bindPair('sndVol', 'sndVolN', (v) => {
    sound.setConfig({ volume: v });
    persist();
  });

  const isTheremin = (c: ControlDescription) => c.voice === 'theremin';
  const theremin = $<HTMLInputElement>('sndTheremin');
  theremin.addEventListener('change', () => {
    const others = sound.getConfig().controls.filter((c) => !isTheremin(c));
    sound.setConfig({ controls: theremin.checked ? [...others, ...structuredClone(THEREMIN)] : others });
    persist();
    refresh();
  });

  for (const name of SOUNDS) {
    const b = el('button', { type: 'button', textContent: name });
    b.addEventListener('click', async () => {
      if (!sound.running) await sound.start();
      showState();
      sound.engine.apply([{ kind: 'play', sound: name, frequency: midiToHz(name === 'thud' ? 43 : 72), gain: 0.5, pan: 0 }]);
    });
    $('sndPalette').append(b);
  }

  const SOUND_SET = new Set<string>(SOUNDS);
  const EVENT_TYPES = new Set(['engage', 'disengage', 'pinch:start', 'pinch:move', 'pinch:end', 'pose', 'motion', 'lost']);
  const parseList = (id: string): unknown[] => {
    const value = JSON.parse($<HTMLTextAreaElement>(id).value) as unknown;
    if (!Array.isArray(value)) throw new Error('expected a JSON array');
    return value;
  };

  $('sndCuesApply').addEventListener('click', () => {
    try {
      const cues = parseList('sndCues');
      cues.forEach((c, i) => {
        const d = c as Record<string, unknown>;
        if (!EVENT_TYPES.has(String(d.on))) throw new Error(`cue ${i}: "on" must be an event type such as pinch:start`);
        if (!SOUND_SET.has(String(d.sound))) throw new Error(`cue ${i}: "sound" must be one of ${SOUNDS.join(', ')}`);
      });
      sound.setConfig({ cues: cues as CueDescription[] });
      persist();
      flash('sndCuesMsg', `Applied ${cues.length} cues.`);
    } catch (err) {
      flash('sndCuesMsg', (err as Error).message, false);
    }
  });
  $('sndCuesReset').addEventListener('click', () => {
    sound.setConfig({ cues: structuredClone(DEFAULT_CUES) });
    persist();
    refresh();
    flash('sndCuesMsg', 'Default cues restored.');
  });
  $('sndControlsApply').addEventListener('click', () => {
    try {
      const controls = parseList('sndControls');
      controls.forEach((c, i) => {
        const d = c as Record<string, unknown>;
        if (typeof d.voice !== 'string' || !d.voice) throw new Error(`control ${i}: "voice" must be a name`);
        if (d.hand !== 'Left' && d.hand !== 'Right') throw new Error(`control ${i}: "hand" must be Left or Right`);
        if (!Array.isArray(d.range) || d.range.length !== 2) throw new Error(`control ${i}: "range" must be [from, to]`);
      });
      sound.setConfig({ controls: controls as ControlDescription[] });
      persist();
      refresh();
      flash('sndControlsMsg', `Applied ${controls.length} controls.`);
    } catch (err) {
      flash('sndControlsMsg', (err as Error).message, false);
    }
  });

  function refresh(): void {
    const c = sound.getConfig();
    $<HTMLTextAreaElement>('sndCues').value = JSON.stringify(c.cues, null, 2);
    $<HTMLTextAreaElement>('sndControls').value = JSON.stringify(c.controls, null, 2);
    theremin.checked = c.controls.some(isTheremin);
  }
  refresh();
  showState();

  return {
    update(events: readonly GestureEvent[]): void {
      sound.update(events, read);
    },
  };
})();

// ── backdrop ─────────────────────────────────────────────────────────────────

/**
 * Flowing wave field behind everything, drawn on a small canvas that CSS blurs to
 * full size. It repaints ~16×/s (never while the tab is hidden or the setting is
 * off), so the cost stays in the noise next to hand tracking.
 *
 * The hands only lean on it, and every influence is heavily smoothed so it reads as
 * atmosphere rather than a readout:
 *   palm tilt    → the whole field tilts
 *   open / fist  → wave height
 *   fingers up   → how tight the waves are
 *   palm x, y    → where the waves sit and how fast they travel
 *   which hand   → colour, violet for Left, cyan for Right
 *   engaged      → brightness; pinch, pose and movement events send a ripple
 */
const backdrop = (() => {
  const cv = $<HTMLCanvasElement>('bg');
  const c = cv.getContext('2d', { alpha: false })!;
  const panelCv = $<HTMLCanvasElement>('fieldCanvas');
  const panelC = panelCv.getContext('2d', { alpha: false })!;
  const BANDS = 6;
  const still = window.matchMedia('(prefers-reduced-motion: reduce)');

  // live values, each eased toward the hands' current reading
  const s = { tilt: 0, amp: 0.35, freq: 1, x: 0.5, y: 0.5, side: 0, energy: 0, ripple: 0 };
  let raf = 0;
  let last = 0;

  const resize = () => {
    const ratio = window.innerHeight / Math.max(1, window.innerWidth);
    cv.width = 420;
    cv.height = Math.max(140, Math.round(420 * ratio));
  };

  /** Where the hands want the field to be. Absent hands let it drift back to rest. */
  function readHands(): void {
    const ease = (key: keyof typeof s, to: number, rate = 0.06) => {
      s[key] += (to - s[key]) * rate;
    };
    let n = 0;
    let tilt = 0;
    let open = 0;
    let up = 0;
    let x = 0;
    let y = 0;
    let side = 0;
    let energy = 0;
    for (const label of LABELS) {
      const f = core.getFeatures(label);
      if (!f) continue;
      n++;
      tilt += f.tilt;
      open += f.openness;
      up += f.curls.filter((curl) => curl < 0.4).length;
      x += f.centroid.x;
      y += f.centroid.y;
      side += label === 'Left' ? -1 : 1;
      if (core.getHandState(label)?.engaged) energy += 1;
    }
    if (n === 0) {
      ease('amp', 0.35, 0.02);
      ease('tilt', 0, 0.02);
      ease('energy', 0, 0.03);
      ease('side', 0, 0.02);
      return;
    }
    ease('tilt', Math.max(-0.5, Math.min(0.5, tilt / n)) * 0.3);
    ease('amp', 0.22 + (open / n) * 0.55);
    ease('freq', 0.9 + (up / n) * 0.22);
    ease('x', x / n, 0.05);
    ease('y', y / n, 0.05);
    ease('side', side / n, 0.03);
    ease('energy', energy / n, 0.05);
  }

  function paint(now: number): void {
    readHands();
    s.ripple *= 0.92;
    if (!cv.hidden) paintTo(c, cv.width, cv.height, now);
    if (shows('field')) {
      const box = panelCv.parentElement!;
      const w = Math.max(160, Math.min(560, box.clientWidth));
      const h = Math.max(120, Math.round((w * box.clientHeight) / Math.max(1, box.clientWidth)));
      if (panelCv.width !== w || panelCv.height !== h) {
        panelCv.width = w;
        panelCv.height = h;
      }
      paintTo(panelC, w, h, now);
    }
  }

  /** The same scene, drawn into whichever canvas asks for it. */
  function paintTo(c: CanvasRenderingContext2D, w: number, h: number, now: number): void {
    const t = now / 1000;
    const base = c.createLinearGradient(0, 0, 0, h);
    base.addColorStop(0, '#05090f');
    base.addColorStop(1, '#03070b');
    c.fillStyle = base;
    c.fillRect(0, 0, w, h);

    // Left leans violet, Right leans cyan; engagement brightens the whole field.
    const mix = (s.side + 1) / 2;
    const r0 = Math.round(150 - 90 * mix);
    const g0 = Math.round(120 + 80 * mix);
    const b0 = Math.round(255 - 30 * mix);
    const glow = 0.18 + s.energy * 0.16 + s.ripple * 0.25;

    c.save();
    c.translate(w / 2, h / 2);
    c.rotate(s.tilt);
    c.scale(1.35, 1.35); // cover the corners once tilted
    c.translate(-w / 2, -h / 2);
    c.globalCompositeOperation = 'lighter';
    c.lineCap = 'round';

    for (let i = 0; i < BANDS; i++) {
      const p = i / (BANDS - 1);
      const amp = h * s.amp * (0.10 + 0.05 * Math.sin(i * 1.7)) + s.ripple * h * 0.05;
      const baseY = h * (0.18 + 0.64 * p) + (s.y - 0.5) * h * 0.18 + Math.sin(t * 0.17 + i) * h * 0.015;
      const k = s.freq * (1 + i * 0.07) * Math.PI * 2;
      const phase = t * (0.22 + i * 0.035) + s.x * 3;

      c.beginPath();
      for (let step = 0; step <= 48; step++) {
        const xn = step / 48;
        const y = baseY + amp * Math.sin(k * xn + phase) + amp * 0.45 * Math.sin(k * 1.7 * xn - phase * 0.6);
        if (step === 0) c.moveTo(xn * w, y);
        else c.lineTo(xn * w, y);
      }
      const line = c.createLinearGradient(0, 0, w, 0);
      const a = (0.18 + glow) * (1 - p * 0.45);
      line.addColorStop(0, `rgba(${r0}, ${g0}, ${b0}, 0)`);
      line.addColorStop(0.5, `rgba(${r0}, ${g0}, ${b0}, ${a})`);
      line.addColorStop(1, `rgba(${Math.round(r0 * 0.5)}, ${g0}, ${b0}, 0)`);
      c.strokeStyle = line;
      c.lineWidth = 1.4 + (1 - p) * 2.2 + s.ripple * 1.5;
      c.stroke();
    }

    c.globalCompositeOperation = 'source-over';
    c.restore();
  }

  function loop(now: number): void {
    raf = requestAnimationFrame(loop);
    if (now - last < 60) return; // ~16 fps: soft motion, negligible cost
    last = now;
    paint(now);
  }

  /** Runs only while something is actually showing the field. */
  function sync(): void {
    const wanted = !cv.hidden || shows('field');
    const running = raf > 0;
    if (wanted === running) return;
    if (!wanted) {
      cancelAnimationFrame(raf);
      raf = 0;
      return;
    }
    resize();
    paint(performance.now());
    // A still frame is enough when the viewer asked for less motion.
    if (!still.matches) raf = requestAnimationFrame(loop);
  }

  function setEnabled(on: boolean): void {
    cv.hidden = !on;
    sync();
  }

  let resizeTimer: number | undefined;
  window.addEventListener('resize', () => {
    if (cv.hidden) return;
    clearTimeout(resizeTimer);
    resizeTimer = window.setTimeout(() => {
      resize();
      paint(performance.now());
    }, 200);
  });

  return {
    setEnabled,
    sync,
    /** A gesture happened: nudge the field. */
    ripple(strength: number) {
      s.ripple = Math.min(1, s.ripple + strength);
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
const COLORS = {
  data: css('--data'),
  pending: css('--pending'),
  active: css('--active'),
  fault: css('--fault'),
  limit: css('--limit'),
  raw: css('--raw'),
  text: css('--text'),
};

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

/** Charging arcs are amber; a completed one turns green and thickens. */
function ring(x: number, y: number, r: number, progress: number, done: boolean): void {
  ctx.lineWidth = done ? 5 : 3;
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.stroke();
  if (progress <= 0) return;
  ctx.strokeStyle = done ? COLORS.active : COLORS.pending;
  ctx.beginPath();
  ctx.arc(x, y, r, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * progress);
  ctx.stroke();
}

function draw(): void {
  if (!shows('stage')) return;
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
    if (settings.showRaw) drawSkeleton(h.landmarks, COLORS.raw, 1, !settings.showSmoothed);
    const sm = lastSmoothed.get(h.handedness);
    // Smoothed points are a measurement (cyan) until the hand is engaged (green).
    if (settings.showSmoothed && sm) {
      drawSkeleton(sm, core.getHandState(h.handedness)?.engaged ? COLORS.active : COLORS.data, 2.5, true);
    }
  }

  for (const label of LABELS) {
    const f = core.getFeatures(label);
    const st = core.getHandState(label);
    if (!f || !st) continue;
    const spanPx = (f.span / cfg.aspect) * W; // span is in frame-height units; convert to px
    const cx = f.centroid.x * W;
    const cy = f.centroid.y * H;
    const r = Math.max(18, spanPx * 0.75);

    if (cfg.engage.pose !== '') ring(cx, cy, r + 10, st.engageProgress, st.engaged);
    ring(cx, cy, r, st.poseProgress, st.poseProgress >= 1);

    const src = lastSmoothed.get(label) ?? lastHands.find((h) => h.handedness === label)?.landmarks;
    if (src && st.pinchFinger) {
      const tip = src[TIP[st.pinchFinger]]!;
      const mx = ((src[4]!.x + tip.x) / 2) * W;
      const my = ((src[4]!.y + tip.y) / 2) * H;
      ring(mx, my, 14, st.pinchProgress, st.pinched);
    }

    const pinchText = st.pinched ? ` · PINCH ${st.pinchFinger}` : '';
    const text = `${label}${st.pose ? ` · ${st.pose}` : ''}${st.engaged ? ' · engaged' : ''}${pinchText}`;
    ctx.font = '600 13px Consolas, monospace';
    const tw = ctx.measureText(text).width;
    const tx = Math.min(Math.max(cx - tw / 2, 4), W - tw - 4);
    const ty = Math.min(cy + r + 30, H - 8);
    ctx.fillStyle = 'rgba(0,0,0,0.65)';
    ctx.fillRect(tx - 4, ty - 15, tw + 8, 20);
    ctx.fillStyle = st.engaged ? COLORS.active : COLORS.text;
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
    engaged: el('span', { className: 'badge', textContent: 'engaged' }),
    pinched: el('span', { className: 'badge', textContent: 'pinch' }),
    pose: el('span', { className: 'badge', textContent: '–' }),
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
    engage: makeRow(rows, 'engage dwell', 'dwell'),
    pinch: makeRow(rows, 'pinch dwell', 'dwell'),
    pose: makeRow(rows, 'pose dwell', 'dwell'),
  };
  rows.append(el('div', { className: 'sep' }));
  const poseRows = el('div');
  rows.append(poseRows);
  const motionRows = el('div');
  rows.append(el('div', { className: 'sep' }), motionRows);
  return { card, badges, r, progress, poseRows, poseRefs: [] as RowRefs[], poseKey: '', motionRows, motionRefs: [] as RowRefs[], motionKey: '' };
}

const cards = new Map(LABELS.map((l) => [l, buildHandCard(l)] as const));
$('handRight').append(cards.get('Right')!.card);
$('handLeft').append(cards.get('Left')!.card);

function setBar(ref: RowRefs, frac: number, text: string): void {
  ref.fill.style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
  ref.value.textContent = text;
}

function renderReadout(): void {
  const cfg = core.getConfig();
  const RAW_SCALE = 1.2; // pinchRaw bar spans 0..1.2
  for (const [label, c] of cards) {
    if (!shows(label === 'Left' ? 'hand-left' : 'hand-right')) continue;
    const f: Features | null = core.getFeatures(label);
    const st = core.getHandState(label);
    c.card.classList.toggle('absent', !f);
    c.badges.engaged.className = `badge${st?.engaged ? ' on' : st?.engageProgress ? ' pending' : ''}`;
    c.badges.pinched.className = `badge${st?.pinched ? ' on' : st?.pinchFinger ? ' pending' : ''}`;
    c.badges.pinched.textContent = st?.pinchFinger ? `pinch ${st.pinchFinger}` : 'pinch';
    c.badges.pose.className = `badge${st?.pose ? (st.poseProgress >= 1 ? ' on' : ' pending') : ''}`;
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
      for (const ref of c.poseRefs) ref.row.className = 'row';
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
      const closing = enabled && f.pinchRaws[finger] < cfg.pinch.closed + h;
      b.fill.style.width = `${Math.min(1, f.pinchRaws[finger] / RAW_SCALE) * 100}%`;
      b.bar.className = `bar${!enabled ? ' off' : st.pinched && st.pinchFinger === finger ? ' pinched' : closing ? ' closing' : ''}`;
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

    const dwell = (ref: RowRefs, value: number, done: boolean, text: string) => {
      setBar(ref, value, text);
      ref.row.classList.toggle('done', done);
    };
    dwell(c.progress.engage, st.engageProgress, st.engaged, cfg.engage.pose === '' ? 'always' : fmt(st.engageProgress, 2));
    dwell(c.progress.pinch, st.pinchProgress, st.pinched, fmt(st.pinchProgress, 2));
    dwell(c.progress.pose, st.poseProgress, st.poseProgress >= 1, fmt(st.poseProgress, 2));

    st.poseScores.forEach((m, i) => {
      const ref = c.poseRefs[i];
      if (!ref) return;
      setBar(ref, m.score, fmt(m.score, 2));
      // amber while this pose is the held one, green once its event has fired
      ref.row.className = `row${m.name === st.pose ? (st.poseProgress >= 1 ? ' fired' : ' held') : ''}`;
    });
  }
}

// ── moves: what the core ships with, and what is happening right now ─────────

const moves = (() => {
  const list = $('movesList');
  const HOW: Record<string, string> = {
    openPalm: 'Hold your hand open, fingers straight, palm to the camera.',
    fist: 'Close every finger into a fist.',
    point: 'Extend the index finger, curl the rest.',
    swipeLeft: 'Engaged and not pinching, sweep your hand left.',
    swipeRight: 'Engaged and not pinching, sweep your hand right.',
    wave: 'Hold an open palm and wave it side to side.',
  };
  const AXIS: Record<string, string> = { x: 'sideways', y: 'up or down', depth: 'toward or away from the camera', tilt: 'twisting the palm' };
  const DIR: Record<string, [string, string]> = {
    x: ['left', 'right'],
    y: ['up', 'down'],
    depth: ['away from the camera', 'toward the camera'],
    tilt: ['anticlockwise', 'clockwise'],
  };
  const UNIT: Record<string, string> = { x: 'hand-lengths', y: 'hand-lengths', depth: '× size change', tilt: 'radians' };

  type Row = { el: HTMLElement; live: HTMLElement; on: () => boolean };
  let rows: Row[] = [];
  let key = '';

  const held = (name: string) => LABELS.some((l) => core.getHandState(l)?.pose === name);

  function row(kind: string, name: string, how: string, num: string, on: () => boolean): Row {
    const live = el('div', { className: 'live', textContent: 'idle' });
    const box = el('div', { className: 'move' }, [
      el('div', { className: 'top' }, [el('span', { className: 'nm', textContent: name }), el('span', { className: 'kind', textContent: kind }), live]),
      el('p', { className: 'how', textContent: how }),
      el('div', { className: 'num', textContent: num }),
    ]);
    return { el: box, live, on };
  }

  function build(): void {
    const cfg = core.getConfig();
    list.replaceChildren();
    rows = [];
    const add = (r: Row) => {
      rows.push(r);
      list.append(r.el);
    };
    const group = (text: string) => list.append(el('div', { className: 'movegroup', textContent: text }));

    group('gate');
    add(
      row(
        'engage',
        cfg.engage.pose === '' ? 'always engaged' : cfg.engage.pose,
        cfg.engage.pose === ''
          ? 'The safety catch is off: hands can pinch and move straight away.'
          : `Hold this pose to unlock pinches and movements for that hand. It stays unlocked until the hand leaves the frame.`,
        cfg.engage.pose === '' ? '' : `held for ${cfg.engage.dwellMs} ms`,
        () => LABELS.some((l) => core.getHandState(l)?.engaged),
      ),
    );

    group('poses — hand shapes');
    for (const p of cfg.poses) {
      const ranges = Object.entries(p.fingers)
        .map(([finger, spec]) => `${finger} ${spec?.curl ? `${spec.curl[0]}–${spec.curl[1]}` : '—'}`)
        .join('   ');
      add(row('pose', p.name, HOW[p.name] ?? 'Custom pose recorded from your hand.', `curl ${ranges}`, () => held(p.name)));
    }

    group('pinches — thumb to a fingertip');
    for (const finger of cfg.pinch.fingers) {
      add(
        row(
          'pinch',
          `pinch ${finger}`,
          `Engaged, touch your thumb tip to the ${finger} fingertip and hold.`,
          `closes under ${fmt(cfg.pinch.closed + cfg.pinch.hysteresis, 2)}, releases over ${fmt(cfg.pinch.closed + 3 * cfg.pinch.hysteresis, 2)} spans, after ${cfg.dwellMs} ms`,
          () => LABELS.some((l) => core.getHandState(l)?.pinched && core.getHandState(l)?.pinchFinger === finger),
        ),
      );
    }

    group('movements — how the hand travels');
    for (const m of cfg.motions) {
      const dirName = m.direction === -1 ? DIR[m.axis]![0] : DIR[m.axis]![1];
      const how =
        HOW[m.name] ??
        (m.reversals
          ? `Engaged, move ${AXIS[m.axis]} back and forth ${m.reversals + 1} times${m.pose ? ` while holding ${m.pose}` : ''}.`
          : `Engaged and not pinching, move ${dirName}${m.pose ? ` while holding ${m.pose}` : ''}.`);
      const num = `${m.distance} ${UNIT[m.axis]} per stroke, within ${m.withinMs} ms${m.reversals ? `, ${m.reversals} reversals` : ''}`;
      add(
        row('movement', m.name, how, num, () => {
          const p = LABELS.map((l) => core.getHandState(l)?.motionProgress.find((x) => x.name === m.name)?.progress ?? 0);
          return Math.max(...p) > 0.15;
        }),
      );
    }
  }

  function update(): void {
    if (!shows('moves')) return;
    const cfg = core.getConfig();
    const k = [cfg.engage.pose, ...cfg.poses.map((p) => p.name), ...cfg.pinch.fingers, ...cfg.motions.map((m) => m.name)].join('|');
    if (k !== key) {
      key = k;
      build();
    }
    for (const r of rows) {
      const on = r.on();
      r.el.classList.toggle('on', on);
      r.live.textContent = on ? 'now' : 'idle';
    }
  }

  return { update };
})();

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
  for (const id of ['mvPose', 'mvrPose']) {
    const sel = $<HTMLSelectElement>(id);
    const keep = sel.value;
    sel.replaceChildren(
      el('option', { value: '', textContent: '(any hand shape)' }),
      ...cfg.poses.map((p) => el('option', { value: p.name, textContent: p.name })),
    );
    sel.value = cfg.poses.some((p) => p.name === keep) ? keep : '';
  }
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

// ── movement recorder: learn a movement by watching it ───────────────────────

const motionRecorder = (() => {
  type Phase = { take: number; samples: MotionSample[] };
  let phase: Phase | null = null;
  let countdown: number | undefined;
  let stopTake: number | undefined;
  let fit: MotionFit | null = null;

  bindPair('mvrTakes', 'mvrTakesN');
  bindPair('mvrSecs', 'mvrSecsN');
  bindPair('mvrDelay', 'mvrDelayN');

  const status = (text: string): void => {
    $('mvrStatus').textContent = text;
  };
  const num = (id: string) => Number($<HTMLInputElement>(id).value);
  const takes: MotionSample[][] = [];

  function begin(): void {
    const name = $<HTMLInputElement>('mvrName').value.trim();
    if (!name) return status('Give the movement a name first.');
    clearInterval(countdown);
    clearTimeout(stopTake);
    phase = null;
    takes.length = 0;
    fit = null;
    $<HTMLButtonElement>('mvrAdd').disabled = true;
    $('mvrResult').textContent = '';
    nextTake();
  }

  function nextTake(): void {
    if (takes.length >= num('mvrTakes')) return finish();
    const hand = $<HTMLSelectElement>('mvrHand').value;
    let left = num('mvrDelay');
    const go = () => {
      phase = { take: takes.length, samples: [] };
      status(`Take ${takes.length + 1} of ${num('mvrTakes')} — do it now with your ${hand} hand`);
      // The clock ends the take, not the frames: a stalled camera must not hang it.
      stopTake = window.setTimeout(endTake, num('mvrSecs') * 1000);
    };
    if (left <= 0) return go();
    const tick = () => status(`Take ${takes.length + 1} of ${num('mvrTakes')} — ready… ${left}`);
    tick();
    countdown = window.setInterval(() => {
      left--;
      if (left > 0) return tick();
      clearInterval(countdown);
      go();
    }, 1000);
  }

  /** Called every frame: collect what movements are judged on. */
  function onFrame(t: number): void {
    if (!phase) return;
    const hand = $<HTMLSelectElement>('mvrHand').value as HandLabel;
    const f = core.getFeatures(hand);
    if (f) {
      const aspect = core.getConfig().aspect;
      phase.samples.push({
        t,
        x: f.centroid.x * (aspect > 0 ? aspect : 1),
        y: f.centroid.y,
        span: f.span,
        tilt: f.tilt,
        pose: core.getHandState(hand)?.pose ?? null,
      });
    }
  }

  function endTake(): void {
    if (!phase) return;
    const done = phase.samples;
    phase = null;
    if (done.length < 2) return status('That take saw no hand — press Record takes to try again.');
    takes.push(done);
    nextTake();
  }

  function finish(): void {
    const name = $<HTMLInputElement>('mvrName').value.trim();
    const pose = $<HTMLSelectElement>('mvrPose').value;
    try {
      fit = fitMotion(name, takes, pose ? { pose } : {});
    } catch (err) {
      return status((err as Error).message);
    }
    const m = fit.motion;
    const shape = m.reversals ? `${m.reversals + 1} strokes back and forth` : `one stroke ${m.direction === -1 ? '−' : '+'}`;
    const ambiguous = fit.margin < 1.5;
    status(
      `Learnt from ${takes.length} take(s): ${m.axis}, ${shape}, ${m.distance} per stroke within ${m.withinMs} ms.` +
        (ambiguous ? ' The axis was not clear-cut — try a bigger, cleaner movement.' : ''),
    );
    $('mvrResult').textContent =
      `takes ${fit.takes.map((s) => fmt(s, 2)).join(' ')}   axis ${Object.entries(fit.axisScores)
        .map(([a, v]) => `${a} ${fmt(v, 2)}`)
        .join(' ')}\n` + JSON.stringify(m);
    $<HTMLButtonElement>('mvrAdd').disabled = false;
  }

  $('mvrRecord').addEventListener('click', begin);
  $('mvrDiscard').addEventListener('click', () => {
    clearInterval(countdown);
    clearTimeout(stopTake);
    phase = null;
    takes.length = 0;
    fit = null;
    $<HTMLButtonElement>('mvrAdd').disabled = true;
    status('');
    $('mvrResult').textContent = '';
  });
  $('mvrAdd').addEventListener('click', () => {
    if (!fit) return;
    const motions = core.getConfig().motions.filter((m) => m.name !== fit!.motion.name);
    motions.push(fit.motion);
    applyConfig({ motions });
    refreshAll();
    status(`Added "${fit.motion.name}". Engage, then do it.`);
    $<HTMLButtonElement>('mvrAdd').disabled = true;
  });

  return { onFrame };
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
    // The spread across the hold sets the range; a finger that wandered is left out.
    const fitted = fitPose(name, curls.map((c) => ({ curls: c })), { margin: tol });
    const fingers: PoseDescription['fingers'] = { ...fitted.pose.fingers };
    if (!withThumb) delete fingers.thumb;
    const pose: PoseDescription = { name, fingers };
    const poses = core.getConfig().poses.filter((p) => p.name !== name);
    poses.push(pose);
    applyConfig({ poses });
    refreshAll();

    // Saving is not the same as winning: say so if another pose still beats it.
    const cfg = core.getConfig();
    const mean = FINGER_NAMES.map((_, i) => curls.reduce((s, c) => s + c[i]!, 0) / curls.length);
    const winner = bestPose(matchPoses({ curls: mean }, cfg.poses, cfg.poseFalloff), cfg.poses);
    const ranges = Object.entries(fingers)
      .map(([k, v]) => `${k} ${v.curl![0]}–${v.curl![1]}`)
      .join(', ');
    status(
      winner?.name === name
        ? `Saved "${name}": ${ranges}. Make the shape to fire it.`
        : `Saved "${name}": ${ranges} — but "${winner?.name ?? 'no pose'}" still wins for this hand. Narrow the tolerance, or tick include thumb if the thumb is what makes it different.`,
    );
  }

  return { onFrame };
})();

// ── fixture capture ──────────────────────────────────────────────────────────

/**
 * A fixture is a set of views of one hand shape, not a single snapshot: hand
 * tracking is least reliable away from a square-on view, so the tests replay every
 * angle and require the same reading from all of them.
 */
const FIXTURE_VIEWS: { id: string; how: string }[] = [
  { id: 'front', how: 'square on to the camera' },
  { id: 'left', how: 'turned about 30° to your left' },
  { id: 'right', how: 'turned about 30° to your right' },
  { id: 'up', how: 'tilted so the fingers point up and away' },
  { id: 'down', how: 'tilted so the fingers point down and toward you' },
  { id: 'near', how: 'the same shape, close to the camera' },
  { id: 'far', how: 'the same shape, at arm’s length' },
];

const capture = (() => {
  let collecting: { hand: HandLabel; need: number; frames: Landmark[][]; view: string } | null = null;
  let countdown: number | undefined;
  let queue: string[] = [];
  const taken = new Map<string, Landmark[]>();

  const nameSel = $<HTMLSelectElement>('fxName');
  const fixtureName = () => (nameSel.value === 'custom' ? $<HTMLInputElement>('fxCustom').value.trim() : nameSel.value);
  nameSel.addEventListener('change', () => {
    $('fxCustomRow').hidden = nameSel.value !== 'custom';
  });
  bindPair('fxFrames', 'fxFramesN');
  bindPair('fxDelay', 'fxDelayN');

  const status = (text: string): void => {
    $('fxStatus').textContent = text;
  };

  const rows = new Map<string, { row: HTMLElement; state: HTMLElement }>();
  for (const v of FIXTURE_VIEWS) {
    const state = el('div', { className: 'state', textContent: '—' });
    const btn = el('button', { type: 'button', textContent: 'Capture' });
    btn.addEventListener('click', () => start([v.id]));
    const row = el('div', { className: 'view' }, [
      el('div', { className: 'nm', textContent: v.id }),
      el('div', { className: 'tip', textContent: v.how }),
      el('div', {}, [state, btn]),
    ]);
    rows.set(v.id, { row, state });
    $('fxViews').append(row);
  }
  // state and button share the last cell
  for (const { row } of rows.values()) (row.lastElementChild as HTMLElement).style.cssText = 'display:flex;gap:6px;align-items:center';

  function start(views: string[]): void {
    if (!running) return status('Start the camera first.');
    clearInterval(countdown);
    queue = [...views];
    next();
  }

  function next(): void {
    const view = queue.shift();
    if (view === undefined) {
      collecting = null;
      return status(`Done. ${taken.size} view(s) captured.`);
    }
    const hand = $<HTMLSelectElement>('fxHand').value as HandLabel;
    const need = Number($<HTMLInputElement>('fxFrames').value);
    const how = FIXTURE_VIEWS.find((v) => v.id === view)!.how;
    let left = Number($<HTMLInputElement>('fxDelay').value);
    const begin = () => {
      collecting = { hand, need, frames: [], view };
      status(`Hold still — "${view}": ${how}`);
    };
    if (left <= 0) return begin();
    status(`"${view}": hold your ${hand} hand ${how}… ${left}`);
    countdown = window.setInterval(() => {
      left--;
      if (left > 0) return status(`"${view}": hold your ${hand} hand ${how}… ${left}`);
      clearInterval(countdown);
      begin();
    }, 1000);
  }

  function onFrame(hands: Hand[]): void {
    if (!collecting) return;
    const h = hands.find((x) => x.handedness === collecting!.hand);
    if (!h) return status(`Waiting for your ${collecting.hand} hand to be visible…`);
    collecting.frames.push(h.landmarks);
    if (collecting.frames.length < collecting.need) {
      return status(`"${collecting.view}": ${collecting.frames.length}/${collecting.need}…`);
    }
    finish(collecting.view, collecting.frames);
    collecting = null;
    next();
  }

  function finish(view: string, frames: Landmark[][]): void {
    const aspect = core.getConfig().aspect;
    const n = frames.length;
    const round = (v: number) => Number(v.toFixed(5));
    const mean = frames[0]!.map((_, i) => {
      let x = 0, y = 0, z = 0;
      for (const f of frames) {
        x += f[i]!.x;
        y += f[i]!.y;
        z += f[i]!.z;
      }
      // isotropic: fixtures are stored with aspect already applied
      return { x: round((x / n) * aspect), y: round(y / n), z: round((z / n) * aspect) };
    });
    taken.set(view, mean);
    render();
  }

  /** Reading of one view, and whether it agrees with the others. */
  function readOf(pts: Landmark[]): { pose: string; line: string } {
    const cfg = { ...core.getConfig(), aspect: 1 };
    const f = extractFeatures(pts, cfg);
    const scores = matchPoses(f, cfg.poses, cfg.poseFalloff);
    const best = [...scores].sort((a, b) => b.score - a.score)[0];
    return {
      pose: best?.name ?? '–',
      line: `open ${fmt(f.openness, 2)} pinch ${fmt(f.pinchRaw, 2)} ${best ? `${best.name} ${fmt(best.score, 2)}` : ''}`,
    };
  }

  function render(): void {
    const reads = [...taken].map(([view, pts]) => ({ view, ...readOf(pts) }));
    const agreed = reads.length > 0 ? reads[0]!.pose : '';
    for (const v of FIXTURE_VIEWS) {
      const row = rows.get(v.id)!;
      const read = reads.find((r) => r.view === v.id);
      row.row.className = `view${read ? (read.pose === agreed ? ' done' : ' warn') : ''}`;
      row.state.textContent = read ? read.line : '—';
      row.state.title = read && read.pose !== agreed ? `reads as ${read.pose}, but "front" reads as ${agreed}` : '';
    }
    const disagree = reads.filter((r) => r.pose !== agreed).map((r) => r.view);
    $('fxPreview').textContent = reads.length
      ? `${reads.length} view(s), all reading "${agreed}"${disagree.length ? ` except ${disagree.join(', ')} — tune before saving` : ''}`
      : '';
    $<HTMLTextAreaElement>('fxJson').value = reads.length
      ? JSON.stringify(
          {
            name: fixtureName(),
            hand: $<HTMLSelectElement>('fxHand').value,
            views: [...taken].map(([view, landmarks]) => ({ view, landmarks })),
          },
          null,
          2,
        )
      : '';
  }

  $('btnCaptureAll').addEventListener('click', () => start(FIXTURE_VIEWS.map((v) => v.id)));
  $('btnFxClear').addEventListener('click', () => {
    taken.clear();
    queue = [];
    collecting = null;
    clearInterval(countdown);
    status('');
    render();
  });

  $('btnFxSave').addEventListener('click', async () => {
    const name = fixtureName();
    let body: string;
    try {
      body = JSON.stringify(JSON.parse($<HTMLTextAreaElement>('fxJson').value));
    } catch {
      return flash('fxMsg', 'Capture at least one view first.', false);
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
  $('keyMirror').textContent = settings.mirror ? 'view mirrored' : 'view not mirrored';
  draw();
  renderReadout();
};
bindCheck('hdrSwap', 'flipHandedness', resetTracking);
bindCheck('hdrMirror', 'mirror', resetTracking);
$('keyMirror').textContent = settings.mirror ? 'view mirrored' : 'view not mirrored';

const applyGlass = () => document.body.classList.toggle('glass', settings.glass);
bindCheck('apGlass', 'glass', applyGlass);
bindCheck('apBg', 'animatedBg', () => backdrop.setEnabled(settings.animatedBg));
applyGlass();
backdrop.setEnabled(settings.animatedBg);

bindCheck('ovRaw', 'showRaw', draw);
bindCheck('ovSmooth', 'showSmoothed', draw);
bindCheck('ovVideo', 'showVideo', draw);
bindCheck('chkMoves', 'showMoves');

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

// ── dock: every panel is a draggable window ──────────────────────────────────

const PANELS: { id: string; title: string }[] = [
  { id: 'stage', title: 'Camera' },
  { id: 'events', title: 'Events' },
  { id: 'hand-right', title: 'Hand · R' },
  { id: 'hand-left', title: 'Hand · L' },
  { id: 'tuning', title: 'Tuning' },
  { id: 'moves', title: 'Moves' },
  { id: 'gestures', title: 'Gestures' },
  { id: 'sound', title: 'Sound' },
  { id: 'reliability', title: 'Reliability' },
  { id: 'fixtures', title: 'Fixtures' },
  { id: 'source', title: 'Source' },
  { id: 'field', title: 'Field' },
  { id: 'docs', title: 'Docs' },
];

const bodies = new Map(
  PANELS.map(({ id }) => [id, document.querySelector<HTMLElement>(`#panels [data-panel="${id}"]`)!] as const),
);

const FUI_THEME: DockviewTheme = { name: 'fui', className: 'dockview-theme-fui', colorScheme: 'dark' };

/** Our own tab face: centred label, and a close button we draw ourselves. */
function createTab(): ITabRenderer {
  const label = el('span', { className: 'label' });
  const close = el('button', { className: 'x', type: 'button', title: 'Close panel' });
  const element = el('div', { className: 'tabface' }, [label, close]);
  return {
    element,
    init(params) {
      label.textContent = params.title ?? '';
      close.setAttribute('aria-label', `Close ${params.title ?? 'panel'}`);
      close.addEventListener('click', (e) => {
        e.stopPropagation(); // closing is not selecting
        params.api.close();
      });
      params.api.onDidTitleChange((e) => (label.textContent = e.title));
    },
  };
}

const dock: DockviewApi = createDockview($('dock'), {
  theme: FUI_THEME,
  // A lone panel's name spans its whole tab strip.
  singleTabMode: 'fullwidth',
  defaultTabComponent: 'fui',
  createTabComponent: createTab,
  // Panels stay mounted when hidden: the canvas, the log and every form keep their
  // state and their element ids. Per-frame work is skipped via `visible` instead.
  defaultRenderer: 'always',
  createComponent: (options): IContentRenderer => {
    const element = bodies.get(options.name)!;
    return {
      element,
      init(params) {
        visible.set(options.name, params.api.isVisible);
        params.api.onDidVisibilityChange((e) => {
          visible.set(options.name, e.isVisible);
          backdrop.sync();
          if (!e.isVisible) return;
          draw();
          renderReadout();
        });
      },
      dispose() {
        visible.set(options.name, false);
        // Keep the DOM (and its listeners) alive so the panel can be reopened.
        $('panels').append(element);
      },
    };
  },
});

function defaultLayout(): void {
  dock.clear();
  const add = (id: string, position?: Parameters<DockviewApi['addPanel']>[0]['position']) =>
    dock.addPanel({ id, component: id, title: PANELS.find((p) => p.id === id)!.title, ...(position ? { position } : {}) });
  add('stage');
  add('events', { referencePanel: 'stage', direction: 'below' });
  add('hand-right', { referencePanel: 'stage', direction: 'right' });
  add('hand-left', { referencePanel: 'hand-right', direction: 'below' });
  add('tuning', { referencePanel: 'hand-right', direction: 'right' });
  for (const id of ['moves', 'gestures', 'sound', 'reliability', 'fixtures', 'source', 'field', 'docs']) {
    add(id, { referencePanel: 'tuning', direction: 'within' });
  }
  dock.getPanel('stage')?.api.group.api.setSize({ height: window.innerHeight * 0.62 });
  dock.getPanel('hand-right')?.api.group.api.setSize({ width: 300 });
  dock.getPanel('tuning')?.api.setActive();
}

const saved = load<SerializedDockview>(LS.layout);
try {
  if (saved) dock.fromJSON(saved);
  else defaultLayout();
} catch {
  defaultLayout();
}
if (dock.panels.length === 0) defaultLayout();

let layoutSave: number | undefined;
dock.onDidLayoutChange(() => {
  clearTimeout(layoutSave);
  layoutSave = window.setTimeout(() => save(LS.layout, dock.toJSON()), 400);
});

function openPanel(id: string): void {
  const panel = dock.getPanel(id);
  if (panel) panel.api.setActive();
  else {
    const active = dock.activePanel?.id;
    dock.addPanel({
      id,
      component: id,
      title: PANELS.find((p) => p.id === id)!.title,
      ...(active ? { position: { referencePanel: active, direction: 'within' as const } } : {}),
    });
  }
}

// Panels menu: a view menu. A filled mark means the panel is open; clicking toggles it.
const panelMenu = (() => {
  const button = $('btnPanels');
  const pop = $('panelMenuList');
  const rows = PANELS.map((p) => {
    const row = el('button', { type: 'button' }, [el('span', { className: 'mark' }), p.title]);
    row.addEventListener('click', () => {
      const panel = dock.getPanel(p.id);
      if (panel) panel.api.close();
      else openPanel(p.id);
      refresh();
    });
    return { id: p.id, row };
  });
  const reset = el('button', { type: 'button', className: 'plain' }, ['Reset layout']);
  reset.addEventListener('click', () => {
    defaultLayout();
    refresh();
  });
  pop.append(...rows.map((r) => r.row), el('div', { className: 'sep' }), reset);

  function refresh(): void {
    for (const r of rows) r.row.classList.toggle('on', !!dock.getPanel(r.id));
  }
  let shown = false;
  function setOpen(open: boolean): void {
    shown = open;
    pop.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    if (!open) return;
    const r = button.getBoundingClientRect();
    pop.style.top = `${Math.round(r.bottom + 4)}px`;
    pop.style.right = `${Math.max(4, Math.round(window.innerWidth - r.right))}px`;
    refresh();
  }

  button.addEventListener('click', (e) => {
    e.stopPropagation();
    setOpen(!shown);
  });
  document.addEventListener('click', (e) => {
    if (shown && !pop.contains(e.target as Node)) setOpen(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setOpen(false);
  });
  dock.onDidLayoutChange(() => {
    if (shown) refresh();
  });
  return { refresh };
})();
panelMenu.refresh();

$('btnDocs').addEventListener('click', () => openPanel('docs'));

// In-page doc links scroll the docs panel without touching the URL.
bodies.get('docs')!.addEventListener('click', (e) => {
  const link = (e.target as HTMLElement).closest<HTMLAnchorElement>('a[href^="#doc-"]');
  if (!link) return;
  e.preventDefault();
  document.getElementById(link.getAttribute('href')!.slice(1))?.scrollIntoView({ behavior: 'smooth', block: 'start' });
});

$('btnCamera').addEventListener('click', () => (running ? stopCamera() : void startCamera()));
$('btnClearLog').addEventListener('click', () => {
  logEl.replaceChildren();
  moveLines.clear();
});

const typing = (target: EventTarget | null) =>
  target instanceof HTMLElement && target.matches('input[type="text"], input[type="number"], textarea, select');

// Space pauses detection and R resets tracking — both only mean something while the
// camera is running, so they do nothing before it.
window.addEventListener('keydown', (e) => {
  if (typing(e.target)) return;
  if (e.key === 'f' || e.key === 'F') session.markFalse();
  if (!running) return;
  if (e.key === 'r' || e.key === 'R') {
    core.reset();
    smoothers.clear();
  }
  if (e.key === ' ') {
    // Space would also press whichever button has focus, such as Stop camera.
    e.preventDefault();
    if (e.repeat) return;
    paused = !paused;
    setMessage(paused ? 'Paused (Space to resume)' : '');
  }
});
window.addEventListener('keyup', (e) => {
  if (e.key === ' ' && running && !typing(e.target)) e.preventDefault();
});

buildSliders();
renderReadout();
draw();

// Debug hook: drive the bench without a camera, e.g. from the devtools console.
(window as unknown as { gesturecoreBench: object }).gesturecoreBench = {
  core,
  feed: (hands: Hand[], t: number) => processFrame(hands, t),
};
