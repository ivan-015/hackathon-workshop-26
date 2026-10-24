import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCommand,
  reduceVoice,
  initialVoiceState,
  pickVoice,
  createVoice,
} from '../public/voice.js';

describe('parseCommand', () => {
  const cases = [
    ['next', 'next'],
    ['Next.', 'next'],
    ['  NEXT  ', 'next'],
    ['next step', 'next'],
    ['back', 'back'],
    ['go back', 'back'],
    ['previous', 'back'],
    ['repeat', 'repeat'],
    ['say again', 'repeat'],
    ['repeat that', 'repeat'],
    ['check', 'check'],
    ['check it', 'check'],
    ['snap', 'snap'],
    ['snap it!', 'snap'],
    ['retake', 'retake'],
    ['wrong part', 'retake'],
  ];
  for (const [input, expected] of cases) {
    test(`"${input}" -> ${expected}`, () => {
      assert.equal(parseCommand(input), expected);
    });
  }

  test('ignores command words inside longer utterances', () => {
    assert.equal(parseCommand('remove the back cover'), null);
    assert.equal(parseCommand('ok next one'), null);
    assert.equal(parseCommand('check the next bolt'), null);
  });

  test('returns null for empty or non-string input', () => {
    assert.equal(parseCommand(''), null);
    assert.equal(parseCommand('   '), null);
    assert.equal(parseCommand(undefined), null);
    assert.equal(parseCommand(null), null);
    assert.equal(parseCommand(42), null);
  });
});

describe('reduceVoice (state machine)', () => {
  const run = (events, start = initialVoiceState) =>
    events.reduce((acc, ev) => {
      const out = reduceVoice(acc.state, ev);
      return { state: out.state, effects: [...acc.effects, ...out.effects] };
    }, { state: start, effects: [] });

  test('starts idle and inactive', () => {
    assert.equal(initialVoiceState.mode, 'idle');
    assert.equal(initialVoiceState.active, false);
  });

  test('activate from idle -> listening and starts recognition', () => {
    const { state, effects } = run([{ type: 'ACTIVATE' }]);
    assert.equal(state.mode, 'listening');
    assert.deepEqual(effects, ['startRec']);
  });

  test('does not mutate the previous state', () => {
    const before = initialVoiceState;
    reduceVoice(before, { type: 'ACTIVATE' });
    assert.equal(before.mode, 'idle');
    assert.ok(Object.isFrozen(initialVoiceState));
  });

  test('speak while listening stops recognition first (no self-trigger)', () => {
    const { state, effects } = run([{ type: 'ACTIVATE' }, { type: 'SPEAK' }]);
    assert.equal(state.mode, 'speaking');
    assert.deepEqual(effects, ['startRec', 'stopRec']);
  });

  test('recognition onend while speaking does NOT restart', () => {
    const { state, effects } = run([{ type: 'ACTIVATE' }, { type: 'SPEAK' }, { type: 'REC_END' }]);
    assert.equal(state.mode, 'speaking');
    assert.deepEqual(effects, ['startRec', 'stopRec']);
  });

  test('speech end returns to listening and restarts when active', () => {
    const { state, effects } = run([{ type: 'ACTIVATE' }, { type: 'SPEAK' }, { type: 'SPEECH_END' }]);
    assert.equal(state.mode, 'listening');
    assert.deepEqual(effects, ['startRec', 'stopRec', 'startRec']);
  });

  test('speech end returns to idle when inactive', () => {
    const { state, effects } = run([{ type: 'SPEAK' }, { type: 'SPEECH_END' }]);
    assert.equal(state.mode, 'idle');
    assert.deepEqual(effects, []);
  });

  test('recognition onend while listening and active restarts (stays alive)', () => {
    const { state, effects } = run([{ type: 'ACTIVATE' }, { type: 'REC_END' }, { type: 'REC_END' }]);
    assert.equal(state.mode, 'listening');
    assert.deepEqual(effects, ['startRec', 'startRec', 'startRec']);
  });

  test('deactivate stops listening and onend does not restart', () => {
    const { state, effects } = run([{ type: 'ACTIVATE' }, { type: 'DEACTIVATE' }, { type: 'REC_END' }]);
    assert.equal(state.mode, 'idle');
    assert.deepEqual(effects, ['startRec', 'stopRec']);
  });

  for (const error of ['network', 'not-allowed', 'service-not-allowed']) {
    test(`fatal error "${error}" -> offline, no restart`, () => {
      const { state, effects } = run([
        { type: 'ACTIVATE' },
        { type: 'REC_ERROR', error },
        { type: 'REC_END' },
      ]);
      assert.equal(state.mode, 'offline');
      assert.equal(state.reason, error === 'network' ? 'network' : 'denied');
      assert.deepEqual(effects, ['startRec', 'stopRec']);
    });
  }

  test('non-fatal errors (no-speech, aborted) keep listening and onend restarts', () => {
    const { state, effects } = run([
      { type: 'ACTIVATE' },
      { type: 'REC_ERROR', error: 'no-speech' },
      { type: 'REC_END' },
    ]);
    assert.equal(state.mode, 'listening');
    assert.deepEqual(effects, ['startRec', 'startRec']);
  });

  test('offline is sticky: speak and activate keep offline', () => {
    const { state, effects } = run([
      { type: 'ACTIVATE' },
      { type: 'REC_ERROR', error: 'network' },
      { type: 'SPEAK' },
      { type: 'SPEECH_END' },
      { type: 'ACTIVATE' },
    ]);
    assert.equal(state.mode, 'offline');
    assert.deepEqual(effects, ['startRec', 'stopRec']);
  });

  test('UNSUPPORTED -> offline with reason unsupported', () => {
    const { state } = run([{ type: 'UNSUPPORTED' }, { type: 'ACTIVATE' }]);
    assert.equal(state.mode, 'offline');
    assert.equal(state.reason, 'unsupported');
  });

  test('START_FAILED with InvalidStateError is ignored', () => {
    const { state } = run([{ type: 'ACTIVATE' }, { type: 'START_FAILED', name: 'InvalidStateError' }]);
    assert.equal(state.mode, 'listening');
  });

  test('START_FAILED with another error -> offline', () => {
    const { state } = run([{ type: 'ACTIVATE' }, { type: 'START_FAILED', name: 'NotAllowedError' }]);
    assert.equal(state.mode, 'offline');
  });

  test('activate while speaking stays speaking, then listens after speech', () => {
    const { state, effects } = run([{ type: 'SPEAK' }, { type: 'ACTIVATE' }, { type: 'SPEECH_END' }]);
    assert.equal(state.mode, 'listening');
    assert.deepEqual(effects, ['startRec']);
  });

  test('unknown event is a no-op', () => {
    const out = reduceVoice(initialVoiceState, { type: 'WAT' });
    assert.equal(out.state, initialVoiceState);
    assert.deepEqual(out.effects, []);
  });
});

describe('pickVoice', () => {
  test('prefers a local English voice', () => {
    const voices = [
      { name: 'Google US', lang: 'en-US', localService: false },
      { name: 'Fr local', lang: 'fr-FR', localService: true },
      { name: 'Samantha', lang: 'en-US', localService: true },
    ];
    assert.equal(pickVoice(voices).name, 'Samantha');
  });

  test('falls back to null when no local English voice', () => {
    assert.equal(pickVoice([{ name: 'Google US', lang: 'en-US', localService: false }]), null);
    assert.equal(pickVoice([]), null);
    assert.equal(pickVoice(undefined), null);
  });
});

function makeFakes() {
  const recs = [];
  class FakeRecognition {
    constructor() {
      this.running = false;
      this.starts = 0;
      recs.push(this);
    }
    start() {
      if (this.running) {
        const err = new Error('already started');
        err.name = 'InvalidStateError';
        throw err;
      }
      this.running = true;
      this.starts += 1;
    }
    stop() { this.running = false; }
    abort() { this.running = false; }
    end() { this.running = false; this.onend?.(); }
    say(transcript) {
      this.onresult?.({
        resultIndex: 0,
        results: [Object.assign([{ transcript }], { isFinal: true })],
      });
    }
    fail(error) { this.onerror?.({ error }); this.end(); }
  }
  const spoken = [];
  const synth = {
    speaking: false,
    getVoices: () => [{ name: 'Local', lang: 'en-US', localService: true }],
    speak(u) { spoken.push(u); this.speaking = true; },
    cancel() { this.speaking = false; },
  };
  class FakeUtterance {
    constructor(text) { this.text = text; }
  }
  return { recs, FakeRecognition, synth, spoken, FakeUtterance };
}

describe('createVoice (controller with fakes)', () => {
  test('activate starts recognition; a command fires onCommand', () => {
    const f = makeFakes();
    const commands = [];
    const voice = createVoice({
      Recognition: f.FakeRecognition,
      synth: f.synth,
      Utterance: f.FakeUtterance,
      onCommand: (c) => commands.push(c),
    });
    voice.activate();
    assert.equal(voice.getState().mode, 'listening');
    assert.equal(f.recs[0].running, true);
    f.recs[0].say('Next');
    f.recs[0].say('remove the back cover');
    assert.deepEqual(commands, ['next']);
  });

  test('speak pauses recognition and resumes after utterance end', () => {
    const f = makeFakes();
    const voice = createVoice({ Recognition: f.FakeRecognition, synth: f.synth, Utterance: f.FakeUtterance });
    voice.activate();
    voice.speak('Step one');
    assert.equal(voice.getState().mode, 'speaking');
    assert.equal(f.recs[0].running, false);
    f.recs[0].end(); // onend fired by stop() must not restart mid-speech
    assert.equal(f.recs[0].running, false);
    assert.equal(f.spoken[0].text, 'Step one');
    assert.equal(f.spoken[0].voice.name, 'Local');
    f.spoken[0].onend();
    assert.equal(voice.getState().mode, 'listening');
    assert.equal(f.recs[0].running, true);
  });

  test('a superseded utterance ending does not resume listening early', () => {
    const f = makeFakes();
    const voice = createVoice({ Recognition: f.FakeRecognition, synth: f.synth, Utterance: f.FakeUtterance });
    voice.activate();
    voice.speak('first');
    voice.speak('second');
    f.spoken[0].onend();
    assert.equal(voice.getState().mode, 'speaking');
    f.spoken[1].onend();
    assert.equal(voice.getState().mode, 'listening');
  });

  test('commands heard while speaking are ignored', () => {
    const f = makeFakes();
    const commands = [];
    const voice = createVoice({
      Recognition: f.FakeRecognition, synth: f.synth, Utterance: f.FakeUtterance,
      onCommand: (c) => commands.push(c),
    });
    voice.activate();
    voice.speak('say next to continue');
    f.recs[0].say('next');
    assert.deepEqual(commands, []);
  });

  test('network error -> offline, onend does not restart, onState reports it', () => {
    const f = makeFakes();
    const states = [];
    const voice = createVoice({
      Recognition: f.FakeRecognition, synth: f.synth, Utterance: f.FakeUtterance,
      onState: (s) => states.push(s.mode),
    });
    voice.activate();
    f.recs[0].fail('network');
    assert.equal(voice.getState().mode, 'offline');
    assert.equal(f.recs[0].running, false);
    assert.equal(f.recs[0].starts, 1);
    assert.deepEqual(states, ['listening', 'offline']);
  });

  test('silence timeout onend restarts recognition while listening', () => {
    const f = makeFakes();
    const voice = createVoice({ Recognition: f.FakeRecognition, synth: f.synth, Utterance: f.FakeUtterance });
    voice.activate();
    f.recs[0].end();
    assert.equal(f.recs[0].running, true);
    assert.equal(f.recs[0].starts, 2);
  });

  test('no Recognition -> offline unsupported, speak still works', () => {
    const f = makeFakes();
    const voice = createVoice({ Recognition: undefined, synth: f.synth, Utterance: f.FakeUtterance });
    voice.activate();
    assert.equal(voice.getState().mode, 'offline');
    assert.equal(voice.getState().reason, 'unsupported');
    voice.speak('hello');
    assert.equal(f.spoken.length, 1);
  });

  test('no synth: speak resolves immediately and listening resumes', () => {
    const f = makeFakes();
    const voice = createVoice({ Recognition: f.FakeRecognition, synth: undefined, Utterance: undefined });
    voice.activate();
    voice.speak('hello');
    assert.equal(voice.getState().mode, 'listening');
    assert.equal(f.recs[0].running, true);
  });

  test('deactivate stops listening', () => {
    const f = makeFakes();
    const voice = createVoice({ Recognition: f.FakeRecognition, synth: f.synth, Utterance: f.FakeUtterance });
    voice.activate();
    voice.deactivate();
    f.recs[0].end();
    assert.equal(voice.getState().mode, 'idle');
    assert.equal(f.recs[0].running, false);
  });
});
