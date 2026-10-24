// JobPlan fixtures shared by the specs and the Claude stub in e2e/server.mjs.
// Each one passes lib/validate.js validateJobPlan.

export const STUB_PLAN = Object.freeze({
  part: { name: 'Oil filter', variant: 'spin-on cartridge', confidence: 0.88 },
  job: 'Change engine oil and filter',
  tools: ['Oil filter wrench', 'Drain pan', '17 mm socket'],
  safety: ['Let the engine cool before draining', 'Support the car on jack stands'],
  steps: [
    { n: 1, text: 'Place the drain pan under the oil pan.', spec: null, warning: null, check_goal: 'Pan under drain plug' },
    { n: 2, text: 'Remove the drain plug and let the oil drain.', spec: null, warning: 'Hot oil burns', check_goal: 'Plug out' },
    { n: 3, text: 'Reinstall the drain plug with a new washer.', spec: '30 Nm', warning: null, check_goal: 'Plug tight' },
  ],
  unidentified: false,
});

export const LOW_CONFIDENCE_PLAN = Object.freeze({
  ...STUB_PLAN,
  part: { name: 'Brake caliper', variant: '', confidence: 0.42 },
});

export const UNIDENTIFIED_PLAN = Object.freeze({
  part: { name: 'Unknown part', variant: '', confidence: 0.1 },
  job: 'Unknown',
  tools: [],
  safety: [],
  steps: [],
  unidentified: true,
});

export const MOCK_JOB_ID = '11111111-2222-4333-8444-555555555555';
