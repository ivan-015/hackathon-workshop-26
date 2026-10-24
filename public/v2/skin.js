// v2 skin. app.js owns the state and the shared elements; this file only reads what app.js
// has already put on the page or in session storage and fills the v2-only panels:
//   - the ratchet strip's ticks (one per step boundary), from the step counter in #job-meta
//   - the job line on the identified screen
//   - the step list on the job screen
//   - the specs to verify on the done screen
// Everything here degrades to "panel stays hidden" when the data is not there.

const JOB_KEY = 'ghc:job:v1'; // the same key app.js persists under
const COUNTER = /\bof (\d+)\b/;

const $ = (id) => document.getElementById(id);
const isText = (v) => typeof v === 'string' && v.trim().length > 0;

// ---- data -----------------------------------------------------------------
function readJob() {
  try {
    const raw = sessionStorage.getItem(JOB_KEY);
    const saved = raw ? JSON.parse(raw) : null;
    const steps = saved?.plan?.steps;
    if (!Array.isArray(steps) || steps.length === 0) return null;
    const step = Number.isInteger(saved.step) ? Math.min(Math.max(saved.step, 0), steps.length - 1) : 0;
    return { plan: saved.plan, step, screen: saved.screen };
  } catch (err) {
    console.warn('v2 skin: could not read the saved job', err);
    return null;
  }
}

// ---- builders -------------------------------------------------------------
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function makeTick(index, total) {
  const tick = el('div', 'tick');
  tick.style.left = `${(index / total) * 100}%`;
  return tick;
}

function stepRow(step, index, current) {
  const state = index < current ? 'is-done' : index === current ? 'is-current' : 'is-next';
  const row = el('li', `step-row ${state}`);
  row.append(el('span', 'step-mark'), el('span', 'step-label', step.text));
  return row;
}

function specRow(step) {
  const row = el('li', 'spec-row');
  row.append(el('strong', 'spec-row-value', step.spec), el('span', 'spec-row-step', step.text));
  return row;
}

// ---- renderers ------------------------------------------------------------
function renderTicks(total) {
  const container = $('ratchet-ticks');
  if (!container) return;
  const ticks = total > 1 ? Array.from({ length: total - 1 }, (_, i) => makeTick(i + 1, total)) : [];
  container.replaceChildren(...ticks);
}

function renderJobLine(job) {
  const line = $('v2-job-line');
  if (!line) return;
  const text = isText(job?.plan?.job) ? job.plan.job : '';
  line.textContent = text;
  line.hidden = !text;
}

function renderSteps(job) {
  const panel = $('v2-steps');
  const list = $('v2-steps-list');
  if (!panel || !list) return;
  if (!job) {
    panel.hidden = true;
    return;
  }
  list.replaceChildren(...job.plan.steps.map((step, i) => stepRow(step, i, job.step)));
  panel.hidden = false;
}

function renderSpecs(job) {
  const panel = $('v2-specs');
  const list = $('v2-specs-list');
  const fallback = $('v2-no-specs');
  if (!panel || !list || !fallback) return;
  const withSpec = job ? job.plan.steps.filter((s) => isText(s.spec)) : [];
  list.replaceChildren(...withSpec.map(specRow));
  panel.hidden = withSpec.length === 0;
  fallback.hidden = withSpec.length > 0;
}

// ---- sync -----------------------------------------------------------------
let lastTotal = -1;
let queued = false;

function sync() {
  queued = false;
  const total = (() => {
    const match = COUNTER.exec($('job-meta')?.textContent ?? '');
    const n = match ? Number(match[1]) : 0;
    return Number.isInteger(n) && n > 0 ? n : 0;
  })();
  if (total !== lastTotal) {
    lastTotal = total;
    renderTicks(total);
  }
  const job = readJob();
  renderJobLine(job);
  renderSteps(job);
  renderSpecs(job);
}

function scheduleSync() {
  if (queued) return;
  queued = true;
  requestAnimationFrame(sync);
}

function init() {
  const app = $('app');
  if (!app) {
    console.warn('v2 skin: #app missing; panels not drawn');
    return;
  }
  // app.js persists, then renders: every render touches text or the hidden attribute under #app.
  new MutationObserver(scheduleSync).observe(app, {
    childList: true,
    characterData: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['hidden'],
  });
  sync();
}

init();
