// Voice layer: command parsing, a pure state machine, and a thin controller
// over Web Speech. No browser globals at import time so Node can test it.

const COMMAND_VARIANTS = Object.freeze({
  next: ['next', 'next step', 'go next', 'continue', 'forward'],
  back: ['back', 'go back', 'previous', 'previous step', 'last step'],
  repeat: ['repeat', 'repeat that', 'say again', 'again', 'say that again', 'what'],
  check: ['check', 'check it', 'check this', 'check my work'],
  snap: ['snap', 'snap it', 'snap part', 'take photo', 'take picture', 'photo'],
  retake: ['retake', 'retake photo', 'wrong part', 'try again'],
});

const UTTERANCE_TO_COMMAND = new Map(
  Object.entries(COMMAND_VARIANTS).flatMap(([cmd, variants]) => variants.map((v) => [v, cmd])),
);

const normalize = (text) =>
  text.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();

// Returns a command only when the WHOLE utterance is a command word or a listed
// variant. Step prose like "remove the back cover" never triggers "back".
export function parseCommand(transcript) {
  if (typeof transcript !== 'string') return null;
  const key = normalize(transcript);
  return key ? UTTERANCE_TO_COMMAND.get(key) ?? null : null;
}

// ---- State machine --------------------------------------------------------
// mode: listening | speaking | offline | idle
// active: whether the app wants hands-free listening (job flow on screen)
// reason: why offline ('network' | 'denied' | 'unsupported')

export const initialVoiceState = Object.freeze({ mode: 'idle', active: false, reason: null });

const FATAL_ERRORS = Object.freeze({
  network: 'network',
  'not-allowed': 'denied',
  'service-not-allowed': 'denied',
  'audio-capture': 'denied',
});

const next = (state, patch, effects = []) => ({
  state: Object.freeze({ ...state, ...patch }),
  effects,
});
const same = (state, effects = []) => ({ state, effects });

export function reduceVoice(state, event) {
  const { mode, active } = state;
  switch (event.type) {
    case 'ACTIVATE':
      if (active && mode !== 'idle') return same(state);
      if (mode === 'idle') return next(state, { active: true, mode: 'listening' }, ['startRec']);
      return next(state, { active: true });
    case 'DEACTIVATE':
      if (mode === 'listening') return next(state, { active: false, mode: 'idle' }, ['stopRec']);
      return active ? next(state, { active: false }) : same(state);
    case 'SPEAK':
      if (mode === 'listening') return next(state, { mode: 'speaking' }, ['stopRec']);
      if (mode === 'idle') return next(state, { mode: 'speaking' });
      return same(state);
    case 'SPEECH_END':
      if (mode !== 'speaking') return same(state);
      return active
        ? next(state, { mode: 'listening' }, ['startRec'])
        : next(state, { mode: 'idle' });
    case 'REC_END':
      return mode === 'listening' && active ? same(state, ['startRec']) : same(state);
    case 'REC_ERROR': {
      const reason = FATAL_ERRORS[event.error];
      if (!reason || mode === 'offline') return same(state);
      return next(state, { mode: 'offline', reason }, ['stopRec']);
    }
    case 'START_FAILED':
      if (event.name === 'InvalidStateError' || mode === 'offline') return same(state);
      return next(state, { mode: 'offline', reason: 'denied' }, ['stopRec']);
    case 'UNSUPPORTED':
      return next(state, { mode: 'offline', reason: 'unsupported' });
    default:
      return same(state);
  }
}

// ---- Voice selection ------------------------------------------------------

// Local (on-device) English voice so spoken steps keep working with wifi off.
// Returns null when none exists; the browser default is used then.
export function pickVoice(voices) {
  if (!Array.isArray(voices)) return null;
  return voices.find((v) => v && v.localService === true && /^en/i.test(v.lang || '')) ?? null;
}

// ---- Controller -----------------------------------------------------------

const MS_PER_CHAR = 90;
const SPEECH_FALLBACK_MIN_MS = 2500;
const SPEECH_FALLBACK_MAX_MS = 45000;

const speechFallbackMs = (text) =>
  Math.min(SPEECH_FALLBACK_MAX_MS, SPEECH_FALLBACK_MIN_MS + text.length * MS_PER_CHAR);

export function createVoice({
  Recognition,
  synth,
  Utterance,
  onCommand = () => {},
  onState = () => {},
  lang = 'en-US',
} = {}) {
  let state = initialVoiceState;
  let speechToken = 0;
  let pendingFinish = null;
  const recognition = Recognition ? new Recognition() : null;

  const runEffect = (effect) => {
    if (!recognition) return;
    if (effect === 'startRec') {
      try {
        recognition.start();
      } catch (err) {
        dispatch({ type: 'START_FAILED', name: err?.name });
      }
    } else if (effect === 'stopRec') {
      try {
        recognition.abort();
      } catch {
        // already stopped; nothing to do
      }
    }
  };

  function dispatch(event) {
    const out = reduceVoice(state, event);
    const changed = out.state !== state;
    state = out.state;
    out.effects.forEach(runEffect);
    if (changed) onState(state);
  }

  if (recognition) {
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.lang = lang;
    recognition.onresult = (event) => {
      if (state.mode !== 'listening') return;
      for (let i = event.resultIndex ?? 0; i < event.results.length; i += 1) {
        const result = event.results[i];
        if (result.isFinal === false) continue;
        const command = parseCommand(result[0]?.transcript);
        if (command) onCommand(command);
      }
    };
    recognition.onerror = (event) => dispatch({ type: 'REC_ERROR', error: event?.error });
    recognition.onend = () => dispatch({ type: 'REC_END' });
  } else {
    dispatch({ type: 'UNSUPPORTED' });
  }

  function speak(text) {
    speechToken += 1;
    const token = speechToken;
    pendingFinish?.();
    dispatch({ type: 'SPEAK' });

    if (!synth || !Utterance || !text) {
      dispatch({ type: 'SPEECH_END' });
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      let timer = null;
      const finish = () => {
        if (timer !== null) clearTimeout(timer);
        timer = null;
        resolve();
        if (token === speechToken) dispatch({ type: 'SPEECH_END' });
      };
      pendingFinish = () => {
        if (timer !== null) clearTimeout(timer);
        resolve();
      };
      try {
        synth.cancel();
        const utterance = new Utterance(text);
        const voice = pickVoice(synth.getVoices?.());
        if (voice) {
          utterance.voice = voice;
          utterance.lang = voice.lang;
        } else {
          utterance.lang = lang;
        }
        utterance.onend = finish;
        utterance.onerror = finish;
        // Chrome sometimes never fires onend; never stay deaf because of it.
        timer = setTimeout(finish, speechFallbackMs(text));
        timer?.unref?.();
        synth.speak(utterance);
      } catch {
        finish();
      }
    });
  }

  return {
    activate: () => dispatch({ type: 'ACTIVATE' }),
    deactivate: () => dispatch({ type: 'DEACTIVATE' }),
    speak,
    getState: () => state,
  };
}
