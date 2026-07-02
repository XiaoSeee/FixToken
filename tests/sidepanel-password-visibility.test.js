const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('shared form dialog adds visibility toggles for password fields', () => {
  const source = fs.readFileSync('sidepanel/form-dialog.js', 'utf8');

  assert.match(source, /field\.type === 'password' \|\| field\.masked === true/);
  assert.match(source, /shouldMaskInput[\s\S]*data-input-with-icon/);
  assert.match(source, /syncPasswordToggleButton\(toggleButton,\s*input,\s*labels\)/);
  assert.match(source, /input\.type = input\.type === 'password' \? 'text' : 'password'/);
});

test('sidepanel masks video-sensitive settings with reusable visibility controls', () => {
  const source = fs.readFileSync('sidepanel/sidepanel.js', 'utf8');

  [
    'input-sub2api-url',
    'input-sub2api-email',
    'input-codex2api-url',
    'input-kiro-rs-url',
    'input-email',
    'input-hotmail-email',
    'input-mail2925-email',
    'input-ip-proxy-host',
    'input-signup-phone',
  ].forEach((inputId) => {
    assert.match(source, new RegExp(`'${inputId}'`));
  });

  assert.match(source, /function installPrivacyMaskControls/);
  assert.match(source, /installPrivacyMaskControls\(\);\s*bindPasswordVisibilityToggles\(\);/);
});

test('sidepanel masks bulk text areas with an eye toggle', () => {
  const source = fs.readFileSync('sidepanel/sidepanel.js', 'utf8');
  const css = fs.readFileSync('sidepanel/sidepanel.css', 'utf8');

  [
    'input-custom-mail-provider-pool',
    'input-custom-email-pool-import',
    'input-hotmail-import',
    'input-mail2925-import',
    'input-ip-proxy-account-list',
  ].forEach((textareaId) => {
    assert.match(source, new RegExp(`'${textareaId}'`));
  });

  assert.match(source, /data-privacy-textarea-toggle/);
  assert.match(css, /-webkit-text-security:\s*disc/);
});
