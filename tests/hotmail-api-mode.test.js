const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('Hotmail API对接应接入微软邮箱 helper 而不是旧远程服务占位', () => {
  const background = fs.readFileSync('background.js', 'utf8');

  assert.match(background, /importScripts\([^)]*microsoft-email\.js[^)]*\)/, 'background 应加载微软邮箱 helper');
  assert.match(background, /fetchMicrosoftMailboxMessages/, '账号校验和最新验证码应接入微软邮箱列表 helper');
  assert.match(
    background,
    /fetchMicrosoftMailboxMessages\(\{[\s\S]*mailbox,[\s\S]*top:\s*10,/,
    '微软邮箱 helper 应按请求的邮箱夹读取消息'
  );
  assert.match(
    background,
    /for \(const mailbox of mailboxes\) \{\s*const result = await requestHotmailRemoteMailbox\(workingAccount, mailbox\);/s,
    'API对接模式不应丢掉 INBOX\/Junk 的逐邮箱夹轮询'
  );
  assert.match(
    background,
    /pickVerificationMessageWithTimeFallback\(fetchResult\.messages, \{/,
    '步骤 4\/7 应继续复用现有验证码筛选与时间回退逻辑'
  );
});
