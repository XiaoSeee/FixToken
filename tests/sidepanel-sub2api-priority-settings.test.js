const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { readFlowRegistryBundle } = require('./helpers/script-bundles.js');

const html = fs.readFileSync('sidepanel/sidepanel.html', 'utf8');
const source = fs.readFileSync('sidepanel/sidepanel.js', 'utf8');
const flowRegistrySource = readFlowRegistryBundle();

test('sidepanel persists and locks SUB2API account priority setting', () => {
  const flowRegistryApi = new Function(
    'self',
    `${flowRegistrySource}; return self.MultiPageFlowRegistry;`
  )({});
  assert.match(
    source,
    /const rowSub2ApiAccountPriority = document\.getElementById\('row-sub2api-account-priority'\);/
  );
  assert.match(
    source,
    /const inputSub2ApiAccountPriority = document\.getElementById\('input-sub2api-account-priority'\);/
  );
  assert.match(source, /function normalizeSub2ApiAccountPriorityValue\(/);
  assert.match(source, /const sub2apiAccountPriorityNormalizer = typeof normalizeSub2ApiAccountPriorityValue === 'function'/);
  assert.match(source, /sub2apiAccountPriority: sub2apiAccountPriorityNormalizer\(/);
  assert.match(
    source,
    /inputSub2ApiAccountPriority\.value = String\(normalizeSub2ApiAccountPriorityValue\(state\?\.sub2apiAccountPriority\)\);/
  );
  assert.match(source, /applyFlowSettingsGroupVisibility\(visibleGroupIds\);/);
  assert.deepStrictEqual(
    flowRegistryApi.getSettingsGroupDefinition('openai-target-sub2api')?.rowIds?.includes('row-sub2api-account-priority'),
    true
  );
  assert.match(source, /inputSub2ApiAccountPriority\.disabled = locked;/);
  assert.match(
    source,
    /inputSub2ApiAccountPriority\.addEventListener\('input', \(\) => \{[\s\S]*scheduleSettingsAutoSave\(\);[\s\S]*\}\);/
  );
  assert.match(
    source,
    /inputSub2ApiAccountPriority\.addEventListener\('blur', \(\) => \{[\s\S]*saveSettings\(\{ silent: true \}\)/
  );
});
