import { createVoice } from './voice.js';

// ---- Config ---------------------------------------------------------------
const IDENTIFY_URL = '/api/identify';
const PROGRESS_URL = '/api/progress';
const DEMO_PLAN_URL = '/cached/hero-part.json';
const CLIENT_TIMEOUT_MS = 15000;
const MAX_IMAGE_SIDE = 1024;
const JPEG_QUALITY = 0.8;
const LOW_CONFIDENCE = 0.6;
const DEMO_FAKE_DELAY_MS = 1200;
const JOB_KEY = 'ghc:job:v1';
const DEMO_PLAN_KEY = 'ghc:demo-plan:v1';

const IS_DEMO = new URLSearchParams(location.search).get('demo') === '1';

const MESSAGES = Object.freeze({
  failed: "Couldn't identify your part. Tap to retry.",
  server: 'Something went wrong on our side. Tap to retry.',
  too_large: 'Photo too large. Tap to retake.',
  rate_limited: 'Too many requests, wait a minute.',
  camera_denied: 'Camera blocked. Tap to choose a photo instead.',
  low_confidence: 'Not sure. Retake closer, with the part number facing the camera.',
});

// ---- State (replaced, never mutated) --------------------------------------
let state = Object.freeze({
  screen: 'capture', // capture | identified | job | done
  camera: 'off', // off | starting | live | fallback
  uploading: false,
  error: null, // key of MESSAGES
  plan: null,
  jobId: null,
  step: 0,
  thumb: null,
  voice: { mode: 'idle', reason: null },
});

let lastImage = null; // JPEG data URL of the last snap, for "tap to retry"
let demoPlan = null;
let stream = null;

const $ = (id) => document.getElementById(id);

function setState(patch) {
  state = Object.freeze({ ...state, ...patch });
  persist();
  render();
}

// ---- Plan helpers ---------------------------------------------------------
const isNonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0;

function isRenderablePlan(plan) {
  if (!plan || typeof plan !== 'object' || !plan.part || typeof plan.part !== 'object') return false;
  if (plan.unidentified === true) return true;
  return isNonEmptyString(plan.part.name)
    && Array.isArray(plan.steps)
    && plan.steps.length > 0
    && plan.steps.every((s) => s && isNonEmptyString(s.text));
}

const isLowConfidence = (plan) =>
  plan.unidentified === true
  || (typeof plan.part.confidence === 'number' && plan.part.confidence < LOW_CONFIDENCE);

const canStartJob = (plan) => plan && plan.unidentified !== true && Array.isArray(plan.steps) && plan.steps.length > 0;

const listOf = (v) => (Array.isArray(v) ? v.filter(isNonEmptyString) : []);

// ---- Persistence (sessionStorage) -----------------------------------------
function persist() {
  try {
    if (state.screen === 'capture' || !state.plan) {
      sessionStorage.removeItem(JOB_KEY);
      return;
    }
    const saved = { plan: state.plan, jobId: state.jobId, step: state.step, screen: state.screen };
    sessionStorage.setItem(JOB_KEY, JSON.stringify(saved));
  } catch (err) {
    console.warn('sessionStorage write failed', err);
  }
}

function readSaved(key) {
  try {
    const raw = sessionStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function restoreJob() {
  const saved = readSaved(JOB_KEY);
  if (!saved || !isRenderablePlan(saved.plan)) return false;
  if (!['identified', 'job', 'done'].includes(saved.screen)) return false;
  const steps = saved.plan.steps ?? [];
  const step = Number.isInteger(saved.step) ? Math.min(Math.max(saved.step, 0), Math.max(steps.length - 1, 0)) : 0;
  const screen = saved.screen === 'identified' || canStartJob(saved.plan) ? saved.screen : 'identified';
  setState({
    screen,
    plan: saved.plan,
    jobId: typeof saved.jobId === 'string' ? saved.jobId : null,
    step,
  });
  return true;
}

// ---- Network --------------------------------------------------------------
function reportProgress(currentStep, status) {
  if (!state.jobId) return;
  try {
    fetch(PROGRESS_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ job_id: state.jobId, current_step: currentStep, status }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    // fire-and-forget; progress is best-effort
  }
}

function errorKeyForStatus(status) {
  if (status === 413) return 'too_large';
  if (status === 429) return 'rate_limited';
  if (status === 502) return 'server'; // bad_model_output or upstream_error
  return 'failed'; // 504 upstream_timeout, 400, network, client timeout
}

async function requestIdentify(imageDataUrl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);
  try {
    const res = await fetch(IDENTIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ image: imageDataUrl }),
      signal: controller.signal,
    });
    if (!res.ok) return { error: errorKeyForStatus(res.status) };
    const body = await res.json();
    if (!body || !isRenderablePlan(body.plan)) {
      console.warn('identify returned an unrenderable plan', body);
      return { error: 'server' };
    }
    return { plan: body.plan, jobId: typeof body.job_id === 'string' ? body.job_id : null };
  } catch (err) {
    console.warn('identify failed', err?.name, err?.message);
    return { error: 'failed' };
  } finally {
    clearTimeout(timer);
  }
}

async function loadDemoPlan() {
  const cached = readSaved(DEMO_PLAN_KEY);
  if (isRenderablePlan(cached)) demoPlan = cached;
  try {
    const res = await fetch(DEMO_PLAN_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const plan = await res.json();
    if (!isRenderablePlan(plan)) throw new Error('cached plan failed validation');
    demoPlan = plan;
    try {
      sessionStorage.setItem(DEMO_PLAN_KEY, JSON.stringify(plan));
    } catch {
      // memory copy is enough while the page stays open
    }
  } catch (err) {
    console.warn('demo plan not loaded', err?.message);
  }
  render();
}

// ---- Camera + image -------------------------------------------------------
function scaleToFit(width, height, maxSide) {
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
}

function encodeJpeg(source, srcWidth, srcHeight) {
  const { width, height } = scaleToFit(srcWidth, srcHeight, MAX_IMAGE_SIDE);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(source, 0, 0, width, height);
  return { dataUrl: canvas.toDataURL('image/jpeg', JPEG_QUALITY) };
}

async function decodeFile(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      // fall through to <img> decoding
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    return img;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function startCamera() {
  if (!navigator.mediaDevices?.getUserMedia) {
    setState({ camera: 'fallback' });
    return;
  }
  setState({ camera: 'starting' });
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false,
    });
    const video = $('preview');
    video.srcObject = stream;
    await video.play().catch(() => {});
    setState({ camera: 'live' });
  } catch (err) {
    console.warn('camera unavailable, using file input', err?.name);
    stopCamera();
    setState({ camera: 'fallback' });
  }
}

function stopCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  const video = $('preview');
  if (video) video.srcObject = null;
}

function grabFrame() {
  const video = $('preview');
  if (!video.videoWidth) return null;
  return encodeJpeg(video, video.videoWidth, video.videoHeight);
}

// ---- Flow -----------------------------------------------------------------
async function identify(image) {
  if (state.uploading) return;
  lastImage = image.dataUrl;
  setState({ uploading: true, error: null, thumb: image.dataUrl });
  voice.speak('Looking at your part');

  if (IS_DEMO && demoPlan) {
    await new Promise((r) => setTimeout(r, DEMO_FAKE_DELAY_MS));
    acceptPlan(demoPlan, null);
    return;
  }

  const result = await requestIdentify(image.dataUrl);
  if (result.error) {
    setState({ uploading: false, error: result.error });
    voice.speak(MESSAGES[result.error]);
    return;
  }
  acceptPlan(result.plan, result.jobId);
}

function acceptPlan(plan, jobId) {
  stopCamera();
  setState({ screen: 'identified', uploading: false, error: null, camera: 'off', plan, jobId, step: 0 });
  speakSummary();
}

function speakSummary() {
  const { plan } = state;
  if (isLowConfidence(plan)) {
    voice.speak(MESSAGES.low_confidence);
    return;
  }
  const tools = listOf(plan.tools);
  const safety = listOf(plan.safety);
  const parts = [
    `This looks like a ${plan.part.name}.`,
    tools.length ? `You'll need: ${tools.join(', ')}.` : '',
    safety.length ? `Safety: ${safety.join('. ')}.` : '',
    'Say next to start the job.',
  ];
  voice.speak(parts.filter(Boolean).join(' '));
}

function speakStep() {
  const { plan, step } = state;
  const s = plan.steps[step];
  const parts = [
    `Step ${step + 1} of ${plan.steps.length}.`,
    s.text,
    isNonEmptyString(s.spec) ? `Spec: ${s.spec}. Verify with the service manual.` : '',
    isNonEmptyString(s.warning) ? `Warning: ${s.warning}.` : '',
  ];
  voice.speak(parts.filter(Boolean).join(' '));
}

function startJob() {
  if (!canStartJob(state.plan)) return;
  setState({ screen: 'job', step: 0 });
  reportProgress(0, 'active');
  speakStep();
}

function goToStep(index) {
  const total = state.plan.steps.length;
  if (index < 0) {
    voice.speak('This is the first step.');
    return;
  }
  if (index >= total) {
    setState({ screen: 'done' });
    reportProgress(total, 'completed');
    voice.speak('Job done. Nice work. Verify every torque spec with the service manual.');
    return;
  }
  setState({ step: index });
  reportProgress(index, 'active');
  speakStep();
}

function retake() {
  if (state.screen === 'job') reportProgress(state.step, 'abandoned');
  lastImage = null;
  setState({ screen: 'capture', plan: null, jobId: null, step: 0, error: null, uploading: false, thumb: null });
  startCamera();
}

async function onFileChosen(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  try {
    const bitmap = await decodeFile(file);
    const image = encodeJpeg(bitmap, bitmap.width, bitmap.height);
    bitmap.close?.();
    identify(image);
  } catch (err) {
    console.warn('could not read photo', err);
    setState({ error: 'failed' });
  }
}

function snap() {
  if (state.uploading) return;
  if (state.camera === 'live') {
    const image = grabFrame();
    if (image) identify(image);
    return;
  }
  if (state.camera === 'fallback') $('file-input').click();
}

function onCaptureTap() {
  voice.activate();
  if (state.uploading) return;
  if (state.error === 'too_large') {
    lastImage = null;
    setState({ error: null });
  }
  if (state.error && lastImage) {
    identify({ dataUrl: lastImage });
    return;
  }
  if (state.camera === 'off') {
    startCamera();
    return;
  }
  snap();
}

// ---- Voice ----------------------------------------------------------------
function onCommand(command) {
  const handlers = {
    capture: { snap: () => (state.camera === 'live' ? snap() : voice.speak('Tap the button to choose a photo.')) },
    identified: {
      next: () => (canStartJob(state.plan) ? startJob() : speakSummary()),
      retake,
      snap: retake,
      repeat: speakSummary,
    },
    job: {
      next: () => goToStep(state.step + 1),
      back: () => goToStep(state.step - 1),
      repeat: speakStep,
      retake,
      check: () => voice.speak('Photo check is not available yet. Say next to continue.'),
    },
    done: { retake, snap: retake },
  };
  handlers[state.screen]?.[command]?.();
}

const voice = createVoice({
  Recognition: window.SpeechRecognition || window.webkitSpeechRecognition,
  synth: window.speechSynthesis,
  Utterance: window.SpeechSynthesisUtterance,
  onCommand,
  onState: (v) => setState({ voice: { mode: v.mode, reason: v.reason } }),
});

// ---- Render ---------------------------------------------------------------
function show(el, visible) {
  el.hidden = !visible;
}

function fillList(ul, items) {
  ul.replaceChildren(...items.map((text) => {
    const li = document.createElement('li');
    li.textContent = text;
    return li;
  }));
}

function micHint() {
  const { mode, reason } = state.voice;
  if (mode === 'listening') return { text: '🎙 Listening... say next · back · repeat', offline: false };
  if (mode === 'speaking') return { text: '🔊 Speaking...', offline: false };
  if (mode === 'offline' && reason === 'network') return { text: 'Voice offline, use buttons', offline: true };
  return null;
}

const SNAP_LABELS = Object.freeze({
  off: '📷 OPEN CAMERA',
  starting: '📷 STARTING...',
  live: '📷 SNAP PART',
  fallback: '📷 CHOOSE PHOTO',
});

function renderCapture() {
  const { camera, uploading, error } = state;
  show($('preview'), camera === 'live');
  show($('viewfinder-placeholder'), camera !== 'live');
  show($('uploading'), uploading);
  $('viewfinder-placeholder').textContent = camera === 'fallback' ? '[ camera unavailable ]' : '[ camera viewfinder ]';

  const errorText = error ? MESSAGES[error] : camera === 'fallback' ? MESSAGES.camera_denied : '';
  $('capture-error').textContent = errorText;
  show($('capture-error'), Boolean(errorText));

  const btn = $('snap-btn');
  btn.disabled = uploading || camera === 'starting';
  btn.textContent = error && error !== 'too_large' && lastImage ? '↻ RETRY' : SNAP_LABELS[camera];

  show($('demo-badge'), IS_DEMO);
  $('capture-note').textContent = IS_DEMO
    ? (demoPlan ? `Demo part ready: ${demoPlan.part.name} (cached)` : 'Demo mode: loading cached part...')
    : '';
}

function renderIdentified() {
  const { plan, thumb } = state;
  const low = isLowConfidence(plan);
  $('part-name').textContent = plan.unidentified ? 'Part not identified' : plan.part.name;
  const confidence = typeof plan.part.confidence === 'number' ? `${Math.round(plan.part.confidence * 100)}% confident` : '';
  $('part-detail').textContent = [plan.part.variant, confidence].filter(isNonEmptyString).join(' · ');
  $('part-thumb').src = thumb ?? '';
  show($('part-thumb'), Boolean(thumb));
  show($('low-confidence'), low);

  const tools = listOf(plan.tools);
  const safety = listOf(plan.safety);
  fillList($('tools-list'), tools);
  fillList($('safety-list'), safety);
  show($('tools-card'), tools.length > 0);
  show($('safety-card'), safety.length > 0);

  const startable = canStartJob(plan);
  const start = $('start-btn');
  show(start, startable);
  start.textContent = low ? `START ANYWAY · ${plan.steps.length} steps` : `START JOB · ${startable ? plan.steps.length : 0} steps`;
  start.classList.toggle('btn-primary', !low);
  $('retake-btn').classList.toggle('btn-primary', low);
  show($('retake-hint'), state.voice.mode === 'listening' || state.voice.mode === 'speaking');
}

function renderJob() {
  const { plan, step } = state;
  const s = plan.steps[step];
  const total = plan.steps.length;
  $('job-meta').textContent = `${plan.part.name} · Step ${step + 1} of ${total}`;
  $('job-progress').style.width = `${((step + 1) / total) * 100}%`;
  $('step-text').textContent = s.text;
  $('spec-text').textContent = isNonEmptyString(s.spec) ? s.spec : '';
  show($('spec-box'), isNonEmptyString(s.spec));
  $('step-warning').textContent = isNonEmptyString(s.warning) ? `⚠ ${s.warning}` : '';
  show($('step-warning'), isNonEmptyString(s.warning));
  $('back-btn').disabled = step === 0;
  $('next-btn').textContent = step === total - 1 ? 'DONE ✔' : 'NEXT ▶';

  const hint = micHint();
  show($('mic-hint'), Boolean(hint));
  $('mic-hint').textContent = hint?.text ?? '';
  $('mic-hint').classList.toggle('is-offline', Boolean(hint?.offline));
}

function renderDone() {
  $('done-meta').textContent = state.plan.part.name;
  $('done-job').textContent = state.plan.job ?? '';
}

function render() {
  document.querySelectorAll('[data-screen]').forEach((el) => {
    el.hidden = el.dataset.screen !== state.screen;
  });
  const renderers = { capture: renderCapture, identified: renderIdentified, job: renderJob, done: renderDone };
  renderers[state.screen]();
}

// ---- Wire up --------------------------------------------------------------
function bind() {
  $('snap-btn').addEventListener('click', onCaptureTap);
  $('viewfinder').addEventListener('click', onCaptureTap);
  $('viewfinder').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onCaptureTap();
    }
  });
  $('file-input').addEventListener('change', onFileChosen);
  $('start-btn').addEventListener('click', () => { voice.activate(); startJob(); });
  $('retake-btn').addEventListener('click', () => { voice.activate(); retake(); });
  $('back-btn').addEventListener('click', () => { voice.activate(); goToStep(state.step - 1); });
  $('repeat-btn').addEventListener('click', () => { voice.activate(); speakStep(); });
  $('next-btn').addEventListener('click', () => { voice.activate(); goToStep(state.step + 1); });
  $('new-part-btn').addEventListener('click', () => { voice.activate(); retake(); });
}

async function autoStartCameraIfGranted() {
  try {
    const status = await navigator.permissions?.query({ name: 'camera' });
    if (status?.state === 'granted' && state.screen === 'capture') startCamera();
  } catch {
    // permissions API unsupported for camera; wait for the first tap
  }
}

function init() {
  bind();
  if (IS_DEMO) loadDemoPlan();
  if (!restoreJob()) {
    render();
    autoStartCameraIfGranted();
  }
}

init();
