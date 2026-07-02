const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const html = fs.readFileSync('sidepanel/sidepanel.html', 'utf8');
const source = fs.readFileSync('sidepanel/sidepanel.js', 'utf8');

function extractFunction(name) {
  let start = source.indexOf(`async function ${name}(`);
  if (start === -1) {
    start = source.indexOf(`function ${name}(`);
  }
  assert.notEqual(start, -1, `missing ${name}`);
  let depth = 0;
  let signatureEnded = false;
  let bodyStart = -1;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '(') depth += 1;
    if (ch === ')') {
      depth -= 1;
      if (depth === 0) signatureEnded = true;
    }
    if (ch === '{' && signatureEnded) {
      bodyStart = i;
      break;
    }
  }
  let braceDepth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === '{') braceDepth += 1;
    if (ch === '}') {
      braceDepth -= 1;
      if (braceDepth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${name}`);
}

test('sidepanel operation delay state is always normalized back to enabled', () => {
  const harness = new Function(`
    let latestState = { operationDelayEnabled: false };
    function syncLatestState(nextState) {
      latestState = { ...(latestState || {}), ...(nextState || {}) };
    }
    ${extractFunction('normalizeOperationDelayEnabled')}
    ${extractFunction('applyOperationDelayState')}
    return {
      normalizeOperationDelayEnabled,
      applyOperationDelayState,
      getLatestState: () => latestState,
    };
  `)();

  assert.equal(harness.normalizeOperationDelayEnabled(undefined), true);
  assert.equal(harness.normalizeOperationDelayEnabled(false), true);
  assert.equal(harness.normalizeOperationDelayEnabled(true), true);

  harness.applyOperationDelayState({ operationDelayEnabled: false });
  assert.equal(harness.getLatestState().operationDelayEnabled, true);
});
