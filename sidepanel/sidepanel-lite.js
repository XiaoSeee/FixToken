// 轻量侧边栏脚本：只保留 FixToken 重新授权所需的配置、账号列表、执行入口和日志展示。
const dom = {
  saveStatus: document.getElementById('save-status'),
  sub2apiUrl: document.getElementById('input-sub2api-url'),
  sub2apiEmail: document.getElementById('input-sub2api-email'),
  sub2apiPassword: document.getElementById('input-sub2api-password'),
  openaiPassword: document.getElementById('input-openai-password'),
  sub2apiGroup: document.getElementById('input-sub2api-group'),
  sub2apiProxy: document.getElementById('input-sub2api-proxy'),
  tempBaseUrl: document.getElementById('input-temp-base-url'),
  tempAdminAuth: document.getElementById('input-temp-admin-auth'),
  tempCustomAuth: document.getElementById('input-temp-custom-auth'),
  tempLookupMode: document.getElementById('select-temp-lookup-mode'),
  tempReceiveMailbox: document.getElementById('input-temp-receive-mailbox'),
  tempDomain: document.getElementById('input-temp-domain'),
  tempDomains: document.getElementById('input-temp-domains'),
  tempRandomSubdomain: document.getElementById('input-temp-random-subdomain'),
  selectAllAccounts: document.getElementById('btn-select-all-accounts'),
  selectEmptyAccounts: document.getElementById('btn-select-empty-accounts'),
  selectFailedAccounts: document.getElementById('btn-select-failed-accounts'),
  deselectAllAccounts: document.getElementById('btn-deselect-all-accounts'),
  fetchAccounts: document.getElementById('btn-fetch-accounts'),
  resetStep: document.getElementById('btn-reset-step'),
  startReauth: document.getElementById('btn-start-reauth'),
  stop: document.getElementById('btn-stop'),
  refreshState: document.getElementById('btn-refresh-state'),
  accountSummary: document.getElementById('account-summary'),
  accountList: document.getElementById('account-list'),
  logArea: document.getElementById('log-area'),
};

let latestState = {};
let errorAccounts = [];
let saveTimer = 0;
let isSaving = false;
// 账号重新授权统计：{ [accountId]: { totalAttempts, successCount, failureCount, lastResult, lastUpdatedAt } }
// 持久化在 chrome.storage.local，重新加载插件也不会丢失。
let reauthStats = {};

/**
 * 统一封装 Chrome Runtime 消息请求。
 *
 * @param {object} message 要发送给后台 service worker 的消息。
 * @returns {Promise<object>} 后台返回结果；当后台返回 error 字段时会抛出异常。
 */
async function sendMessage(message) {
  const response = await chrome.runtime.sendMessage({
    source: 'sidepanel',
    ...(message || {}),
  });
  if (response?.error) {
    throw new Error(response.error);
  }
  return response;
}

/**
 * 将输入内容转为去重后的域名数组。
 *
 * @param {string} value 用户输入的逗号、空格或换行分隔域名列表。
 * @returns {string[]} 规范化后的域名列表。
 */
function parseDomains(value) {
  const seen = new Set();
  return String(value || '')
    .split(/[\s,，;；]+/)
    .map((item) => item.trim())
    .filter((item) => {
      const key = item.toLowerCase();
      if (!key || seen.has(key)) {
        return false;
      }
      seen.add(key);
      return true;
    });
}

/**
 * 从表单读取需要持久化的核心配置。
 *
 * @returns {object} 可直接传给 SAVE_SETTING 的配置补丁。
 */
function collectSettings() {
  const groupName = dom.sub2apiGroup.value.trim() || 'codex';
  const activeDomain = dom.tempDomain.value.trim();
  const domains = parseDomains(dom.tempDomains.value);
  if (activeDomain && !domains.some((item) => item.toLowerCase() === activeDomain.toLowerCase())) {
    domains.unshift(activeDomain);
  }

  return {
    activeFlowId: 'openai',
    targetId: 'sub2api',
    plusModeEnabled: false,
    signupMethod: 'email',
    sub2apiUrl: dom.sub2apiUrl.value.trim(),
    sub2apiEmail: dom.sub2apiEmail.value.trim(),
    sub2apiPassword: dom.sub2apiPassword.value,
    customPassword: dom.openaiPassword.value,
    sub2apiGroupName: groupName,
    sub2apiGroupNames: [groupName],
    sub2apiAccountPriority: '1',
    sub2apiDefaultProxyName: dom.sub2apiProxy.value.trim(),
    mailProvider: 'cloudflare-temp-email',
    cloudflareTempEmailBaseUrl: dom.tempBaseUrl.value.trim(),
    cloudflareTempEmailAdminAuth: dom.tempAdminAuth.value,
    cloudflareTempEmailCustomAuth: dom.tempCustomAuth.value,
    cloudflareTempEmailLookupMode: dom.tempLookupMode.value,
    cloudflareTempEmailReceiveMailbox: dom.tempReceiveMailbox.value.trim(),
    cloudflareTempEmailUseRandomSubdomain: dom.tempRandomSubdomain.checked,
    cloudflareTempEmailDomain: activeDomain,
    cloudflareTempEmailDomains: domains,
  };
}

/**
 * 更新顶部保存状态。
 *
 * @param {string} text 展示文本。
 * @param {string} mode 状态样式，支持 ok / warn / 空。
 */
function setSaveStatus(text, mode = '') {
  dom.saveStatus.textContent = text;
  dom.saveStatus.classList.toggle('ok', mode === 'ok');
  dom.saveStatus.classList.toggle('warn', mode === 'warn');
}

/**
 * 保存当前配置到后台持久化状态。
 *
 * @returns {Promise<void>} 保存完成后更新本地最新状态。
 */
async function saveSettingsNow() {
  if (isSaving) {
    return;
  }
  isSaving = true;
  setSaveStatus('保存中', 'warn');
  try {
    const response = await sendMessage({
      type: 'SAVE_SETTING',
      payload: collectSettings(),
    });
    latestState = response?.state || latestState;
    setSaveStatus('已保存', 'ok');
  } catch (error) {
    setSaveStatus('保存失败', 'warn');
    renderTransientLog(`保存配置失败：${error.message}`, 'error');
  } finally {
    isSaving = false;
  }
}

/**
 * 对频繁输入做防抖保存，避免每次按键都触发后台状态重算。
 */
function scheduleSave() {
  setSaveStatus('待保存', 'warn');
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => {
    saveSettingsNow().catch((error) => {
      renderTransientLog(`保存配置失败：${error.message}`, 'error');
    });
  }, 450);
}

/**
 * 将后台状态回填到表单。
 *
 * @param {object} state 后台完整运行状态。
 */
function fillFormFromState(state = {}) {
  latestState = state || {};
  dom.sub2apiUrl.value = latestState.sub2apiUrl || '';
  dom.sub2apiEmail.value = latestState.sub2apiEmail || '';
  dom.sub2apiPassword.value = latestState.sub2apiPassword || '';
  dom.openaiPassword.value = latestState.customPassword || '';
  dom.sub2apiGroup.value = latestState.sub2apiGroupName || 'codex';
  dom.sub2apiProxy.value = latestState.sub2apiDefaultProxyName || '';
  dom.tempBaseUrl.value = latestState.cloudflareTempEmailBaseUrl || '';
  dom.tempAdminAuth.value = latestState.cloudflareTempEmailAdminAuth || '';
  dom.tempCustomAuth.value = latestState.cloudflareTempEmailCustomAuth || '';
  dom.tempLookupMode.value = latestState.cloudflareTempEmailLookupMode === 'registration-email'
    ? 'registration-email'
    : 'receive-mailbox';
  dom.tempReceiveMailbox.value = latestState.cloudflareTempEmailReceiveMailbox || '';
  dom.tempDomain.value = latestState.cloudflareTempEmailDomain || '';
  dom.tempDomains.value = Array.isArray(latestState.cloudflareTempEmailDomains)
    ? latestState.cloudflareTempEmailDomains.join(', ')
    : '';
  dom.tempRandomSubdomain.checked = Boolean(latestState.cloudflareTempEmailUseRandomSubdomain);
  setSaveStatus('已同步', 'ok');
}

/**
 * 生成账号展示名，优先使用名称，其次使用邮箱或凭据里的邮箱。
 *
 * @param {object} account SUB2API 账号记录。
 * @returns {string} 可展示的账号名称。
 */
function getAccountLabel(account = {}) {
  return account.name
    || account.email
    || account.credentials?.email
    || `账号 #${account.id || 'unknown'}`;
}

/**
 * 从 SUB2API 账号对象里解析用于 OAuth 登录的邮箱。
 *
 * @param {object} account SUB2API 错误账号记录。
 * @returns {string} 解析出的邮箱，找不到时返回空字符串。
 */
function getAccountEmail(account = {}) {
  const candidates = [
    account.email,
    account.account_email,
    account.accountEmail,
    account.username,
    account.name,
    account.credentials?.email,
    account.credentials?.account_email,
    account.extra?.email,
    account.extra?.account_email,
    account.metadata?.email,
  ];
  for (const candidate of candidates) {
    const match = String(candidate || '').match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
    if (match) {
      return match[0].toLowerCase();
    }
  }
  return '';
}

/**
 * 渲染错误账号列表和批量执行按钮状态。
 *
 * 每个账号项展示：勾选框、账号名、元信息（#id · email · status）、
 * 重新授权统计（总次数 / 成功 / 失败 / 最近结果徽标）以及尾部删除按钮。
 */
function renderAccounts() {
  if (!errorAccounts.length) {
    dom.accountSummary.textContent = '未找到状态为 error 的 OpenAI 账号。';
    dom.accountList.innerHTML = '<div class="empty-state">暂无可重新授权账号。</div>';
    dom.selectAllAccounts.disabled = true;
    dom.selectEmptyAccounts.disabled = true;
    dom.selectFailedAccounts.disabled = true;
    dom.deselectAllAccounts.disabled = true;
    dom.startReauth.disabled = true;
    return;
  }

  dom.accountSummary.textContent = `已加载 ${errorAccounts.length} 个错误账号，请勾选要重新授权的账号。`;
  dom.accountList.innerHTML = errorAccounts.map((account) => {
    const id = String(account.id || '');
    const label = escapeHtml(getAccountLabel(account));
    const email = escapeHtml(getAccountEmail(account));
    const status = escapeHtml(account.status || 'error');
    const stats = renderAccountStatsHtml(reauthStats[id]);
    return `
      <div class="account-item">
        <label class="account-main-label">
          <input type="checkbox" name="reauth-account" value="${escapeHtml(id)}">
          <span class="account-main">
            <span class="account-name">${label}</span>
            <span class="account-meta">#${escapeHtml(id)}${email ? ` · ${email}` : ''} · ${status}</span>
            ${stats}
          </span>
        </label>
        <button class="button secondary account-delete" type="button" data-account-id="${escapeHtml(id)}" title="删除该账号的本地统计并从列表移除">删除</button>
      </div>
    `;
  }).join('');
  dom.selectAllAccounts.disabled = false;
  dom.selectEmptyAccounts.disabled = false;
  dom.selectFailedAccounts.disabled = false;
  dom.deselectAllAccounts.disabled = false;
  updateStartButtonState();
}

/**
 * 生成账号项的统计行 HTML，包含总次数、成功 / 失败计数与最近结果徽标。
 *
 * @param {object} stats 该账号的本地统计；为空时显示“未授权”。
 * @returns {string} 统计行 HTML。
 */
function renderAccountStatsHtml(stats) {
  if (!stats) {
    return '<span class="account-stats">未授权 <span class="last-result none">最近:—</span></span>';
  }
  const total = Number(stats.totalAttempts) || 0;
  const success = Number(stats.successCount) || 0;
  const failure = Number(stats.failureCount) || 0;
  let badgeClass = 'none';
  let badgeText = '最近:—';
  if (stats.lastResult === 'success') {
    badgeClass = 'success';
    badgeText = '最近:成功';
  } else if (stats.lastResult === 'failure') {
    badgeClass = 'failure';
    badgeText = '最近:失败';
  }
  return `<span class="account-stats">授权 ${total} 次 · 成功 ${success} · 失败 ${failure} <span class="last-result ${badgeClass}">${badgeText}</span></span>`;
}

/**
 * 根据当前勾选数量刷新开始按钮和摘要文案。
 */
function updateStartButtonState() {
  const selectedCount = dom.accountList.querySelectorAll('input[name="reauth-account"]:checked').length;
  dom.startReauth.disabled = selectedCount === 0;
  if (errorAccounts.length) {
    dom.accountSummary.textContent = `已加载 ${errorAccounts.length} 个错误账号，已选择 ${selectedCount} 个。`;
  }
}

/**
 * 批量设置当前账号列表的勾选状态。
 *
 * @param {boolean} checked 是否选中全部账号。
 */
function setAllAccountsChecked(checked) {
  dom.accountList.querySelectorAll('input[name="reauth-account"]').forEach((input) => {
    input.checked = checked;
  });
  updateStartButtonState();
}

/**
 * 按最近一次授权记录排他式勾选账号。
 *
 * @param {string|null} target 目标最近结果：null 表示空记录（含本地无记录），
 *                              'failure' 表示最近一次失败。匹配项被勾选，其余项取消勾选。
 */
function selectAccountsByLastResult(target) {
  dom.accountList.querySelectorAll('input[name="reauth-account"]').forEach((input) => {
    const id = String(input.value || '');
    const stats = reauthStats[id];
    const lastResult = stats?.lastResult || null;
    const matched = target === null
      ? lastResult === null
      : lastResult === target;
    input.checked = matched;
  });
  updateStartButtonState();
}

/**
 * 防止账号字段中的特殊字符破坏列表 HTML。
 *
 * @param {string} value 原始文本。
 * @returns {string} HTML 安全文本。
 */
function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * 读取用户勾选的账号对象。
 *
 * @returns {object[]} 需要提交给后台批量重新授权的账号列表。
 */
function getSelectedAccounts() {
  const selectedIds = new Set(Array.from(
    dom.accountList.querySelectorAll('input[name="reauth-account"]:checked')
  ).map((input) => String(input.value)));
  return errorAccounts.filter((account) => selectedIds.has(String(account.id)));
}

/**
 * 判断后台返回的重新授权结果是否应该计入“失败记录”。
 *
 * 只有明确需要手机号验证的账号失败才会带 failureRecorded/status=failed；
 * 未完成、用户停止、超时等结果不进入失败统计，也不会被“选失败记录”选中。
 *
 * @param {object} item 后台 START_SUB2API_REAUTH 返回的单账号结果。
 * @returns {boolean} 应计入本地失败统计时返回 true。
 */
function shouldRecordReauthFailure(item = {}) {
  return Boolean(item?.failureRecorded)
    || item?.status === 'failed'
    || Boolean(item?.phoneVerificationRequired);
}

/**
 * 渲染后台持久化日志。
 *
 * @param {Array<object>} logs 后台状态中的日志数组。
 */
function renderLogs(logs = []) {
  const visibleLogs = Array.isArray(logs) ? logs.slice(-120) : [];
  if (!visibleLogs.length) {
    dom.logArea.innerHTML = '<div class="log-entry"><span class="log-time">暂无日志</span></div>';
    return;
  }

  dom.logArea.innerHTML = visibleLogs.map((entry) => buildLogEntryHtml(entry)).join('');
  dom.logArea.scrollTop = dom.logArea.scrollHeight;
}

/**
 * 生成单条日志 HTML。
 *
 * @param {object} entry 后台日志对象。
 * @returns {string} 单条日志 HTML。
 */
function buildLogEntryHtml(entry = {}) {
  const level = ['ok', 'warn', 'error'].includes(entry.level) ? entry.level : '';
  const time = entry.timestamp ? new Date(entry.timestamp).toLocaleTimeString('zh-CN', { hour12: false }) : '--:--:--';
  const step = entry.step ? `步骤 ${entry.step} · ` : '';
  return `
    <div class="log-entry ${level}">
      <span class="log-time">${escapeHtml(time)} · ${escapeHtml(step)}${escapeHtml(entry.level || 'info')}</span>
      <span>${escapeHtml(entry.message || '')}</span>
    </div>
  `;
}

/**
 * 在无法写入后台日志时，临时向当前日志面板追加一条本地提示。
 *
 * @param {string} message 提示内容。
 * @param {string} level 日志级别。
 */
function renderTransientLog(message, level = 'warn') {
  const current = dom.logArea.innerHTML;
  const html = buildLogEntryHtml({ message, level, timestamp: Date.now() });
  dom.logArea.innerHTML = current && !current.includes('暂无日志') ? `${current}${html}` : html;
  dom.logArea.scrollTop = dom.logArea.scrollHeight;
}

/**
 * 从后台刷新完整状态，并同步表单与日志。
 */
async function refreshState() {
  const state = await sendMessage({ type: 'GET_STATE' });
  fillFormFromState(state);
  renderLogs(state.logs || []);
}

/**
 * 查询 SUB2API 错误账号列表。
 */
async function fetchErrorAccounts() {
  await saveSettingsNow();
  dom.fetchAccounts.disabled = true;
  dom.resetStep.disabled = true;
  dom.accountSummary.textContent = '正在查询 SUB2API 错误账号...';
  try {
    const response = await sendMessage({ type: 'SUB2API_LIST_ERROR_ACCOUNTS' });
    const fetched = Array.isArray(response.accounts) ? response.accounts : [];
    // 获取后所有账号都保留展示。仅对“最近一次成功”的账号清空最近记录
    // （成功后又回到 error，说明上次成功已不相关，按新账号重新处理）；
    // 失败与空记录账号保持原样，失败记录保留可见，不重置、不新建。
    let clearedSuccess = 0;
    for (const account of fetched) {
      const id = String(account.id || '');
      const stats = reauthStats[id];
      if (stats && stats.lastResult === 'success') {
        stats.lastResult = null;
        stats.lastUpdatedAt = null;
        clearedSuccess += 1;
      }
    }
    if (clearedSuccess) {
      await saveReauthStats();
    }
    errorAccounts = fetched;
    renderAccounts();
    if (clearedSuccess) {
      dom.accountSummary.textContent = `已加载 ${errorAccounts.length} 个错误账号（已重置 ${clearedSuccess} 个最近成功记录）。`;
    }
    await refreshState();
  } catch (error) {
    errorAccounts = [];
    dom.accountSummary.textContent = `获取失败：${error.message}`;
    dom.accountList.innerHTML = '<div class="empty-state">请检查 SUB2API 地址、账号密码和后台网络。</div>';
    dom.selectAllAccounts.disabled = true;
    dom.selectEmptyAccounts.disabled = true;
    dom.selectFailedAccounts.disabled = true;
    dom.deselectAllAccounts.disabled = true;
    dom.startReauth.disabled = true;
    renderTransientLog(`获取错误账号失败：${error.message}`, 'error');
  } finally {
    dom.fetchAccounts.disabled = false;
    dom.resetStep.disabled = false;
  }
}

/**
 * 重置后台当前步骤状态，避免上一次中断位置影响下一轮重新授权。
 *
 * @returns {Promise<void>} 重置完成后刷新状态和日志。
 */
async function resetCurrentStep() {
  dom.resetStep.disabled = true;
  dom.startReauth.disabled = true;
  dom.fetchAccounts.disabled = true;
  dom.accountSummary.textContent = '正在重置当前步骤状态...';
  try {
    await sendMessage({ type: 'RESET', payload: {} });
    await refreshState();
    updateStartButtonState();
    renderTransientLog('当前步骤已重置，可以重新开始授权。', 'ok');
  } catch (error) {
    renderTransientLog(`重置当前步骤失败：${error.message}`, 'error');
  } finally {
    dom.resetStep.disabled = false;
    dom.fetchAccounts.disabled = false;
    updateStartButtonState();
  }
}

/**
 * 提交选中的错误账号给后台，后台会逐个跑 OAuth 登录并写回凭据。
 */
async function startReauth() {
  await saveSettingsNow();
  const selectedAccounts = getSelectedAccounts();
  if (!selectedAccounts.length) {
    renderTransientLog('请至少选择一个需要重新授权的账号。', 'warn');
    return;
  }

  dom.startReauth.disabled = true;
  dom.fetchAccounts.disabled = true;
  dom.resetStep.disabled = true;
  dom.accountSummary.textContent = `已提交 ${selectedAccounts.length} 个账号，正在后台执行重新授权。`;
  try {
    const response = await sendMessage({
      type: 'START_SUB2API_REAUTH',
      accounts: selectedAccounts,
    });
    const results = Array.isArray(response.results) ? response.results : [];
    // 按账号回写本地统计：只记录成功和明确手机号验证失败，未完成不改变统计。
    for (const item of results) {
      const id = String(item.accountId || '');
      if (!id) {
        continue;
      }
      const recordFailure = shouldRecordReauthFailure(item);
      if (!item.success && !recordFailure) {
        continue;
      }
      const stats = reauthStats[id] || {
        totalAttempts: 0,
        successCount: 0,
        failureCount: 0,
        lastResult: null,
        lastUpdatedAt: null,
      };
      stats.totalAttempts = (Number(stats.totalAttempts) || 0) + 1;
      if (item.success) {
        stats.successCount = (Number(stats.successCount) || 0) + 1;
        stats.lastResult = 'success';
      } else {
        stats.failureCount = (Number(stats.failureCount) || 0) + 1;
        stats.lastResult = 'failure';
      }
      stats.lastUpdatedAt = Date.now();
      reauthStats[id] = stats;
    }
    await saveReauthStats();
    const successCount = results.filter((item) => item.success).length;
    const failCount = results.filter((item) => shouldRecordReauthFailure(item)).length;
    const incompleteCount = results.filter((item) => !item.success && !shouldRecordReauthFailure(item)).length;
    dom.accountSummary.textContent = `批量重新授权结束：成功 ${successCount} 个，失败 ${failCount} 个，未完成 ${incompleteCount} 个。`;
    renderAccounts();
    await refreshState();
  } catch (error) {
    dom.accountSummary.textContent = `重新授权失败：${error.message}`;
    renderTransientLog(`重新授权失败：${error.message}`, 'error');
  } finally {
    dom.startReauth.disabled = false;
    dom.fetchAccounts.disabled = false;
    dom.resetStep.disabled = false;
    updateStartButtonState();
  }
}

/**
 * 注册所有事件监听，让配置自动保存、按钮动作进入后台。
 */
function bindEvents() {
  [
    dom.sub2apiUrl,
    dom.sub2apiEmail,
    dom.sub2apiPassword,
    dom.openaiPassword,
    dom.sub2apiGroup,
    dom.sub2apiProxy,
    dom.tempBaseUrl,
    dom.tempAdminAuth,
    dom.tempCustomAuth,
    dom.tempLookupMode,
    dom.tempReceiveMailbox,
    dom.tempDomain,
    dom.tempDomains,
    dom.tempRandomSubdomain,
  ].forEach((element) => {
    element.addEventListener('input', scheduleSave);
    element.addEventListener('change', scheduleSave);
  });

  dom.fetchAccounts.addEventListener('click', () => {
    fetchErrorAccounts().catch((error) => renderTransientLog(error.message, 'error'));
  });
  dom.selectAllAccounts.addEventListener('click', () => {
    setAllAccountsChecked(true);
  });
  dom.selectEmptyAccounts.addEventListener('click', () => {
    selectAccountsByLastResult(null);
  });
  dom.selectFailedAccounts.addEventListener('click', () => {
    selectAccountsByLastResult('failure');
  });
  dom.deselectAllAccounts.addEventListener('click', () => {
    setAllAccountsChecked(false);
  });
  dom.resetStep.addEventListener('click', () => {
    resetCurrentStep().catch((error) => renderTransientLog(error.message, 'error'));
  });
  dom.accountList.addEventListener('change', (event) => {
    if (event.target?.matches?.('input[name="reauth-account"]')) {
      updateStartButtonState();
    }
  });
  // 删除按钮委托：仅在此处点击删除才会清掉该账号的本地统计并从列表移除。
  dom.accountList.addEventListener('click', (event) => {
    const button = event.target?.closest?.('.account-delete');
    if (!button) {
      return;
    }
    const id = String(button.dataset.accountId || '');
    if (!id) {
      return;
    }
    if (reauthStats[id] !== undefined) {
      delete reauthStats[id];
      saveReauthStats();
    }
    errorAccounts = errorAccounts.filter((account) => String(account.id) !== id);
    renderAccounts();
  });
  dom.startReauth.addEventListener('click', () => {
    startReauth().catch((error) => renderTransientLog(error.message, 'error'));
  });
  dom.refreshState.addEventListener('click', () => {
    refreshState().catch((error) => renderTransientLog(error.message, 'error'));
  });
  dom.stop.addEventListener('click', () => {
    sendMessage({ type: 'STOP_FLOW', payload: {} })
      .then(() => refreshState())
      .catch((error) => renderTransientLog(`停止失败：${error.message}`, 'error'));
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'LOG_ENTRY') {
      latestState.logs = [...(latestState.logs || []), message.payload].slice(-500);
      renderLogs(latestState.logs);
    }
    if (message?.type === 'DATA_UPDATED') {
      latestState = { ...latestState, ...(message.payload || {}) };
      renderLogs(latestState.logs || []);
    }
  });
}

/**
 * 折叠状态在 chrome.storage.local 中的持久化键。
 */
const COLLAPSE_STORAGE_KEY = 'sidepanelCollapseState';

/**
 * 账号重新授权统计在 chrome.storage.local 中的持久化键。
 * 结构：{ [accountId]: { totalAttempts, successCount, failureCount, lastResult, lastUpdatedAt } }。
 */
const REAUTH_STATS_STORAGE_KEY = 'reauthAccountStats';

/**
 * 读取已持久化的账号重新授权统计。
 *
 * @returns {Promise<object>} accountId 到统计对象的映射；读取失败时返回空对象。
 */
async function loadReauthStats() {
  try {
    const stored = await chrome.storage.local.get(REAUTH_STATS_STORAGE_KEY);
    reauthStats = stored?.[REAUTH_STATS_STORAGE_KEY] || {};
    if (!reauthStats || typeof reauthStats !== 'object') {
      reauthStats = {};
    }
  } catch (error) {
    reauthStats = {};
  }
}

/**
 * 持久化当前账号重新授权统计。持久化失败不影响使用，静默忽略。
 */
function saveReauthStats() {
  try {
    chrome.storage.local.set({ [REAUTH_STATS_STORAGE_KEY]: reauthStats });
  } catch (error) {
    /* 持久化失败不影响使用，忽略 */
  }
}

/**
 * 读取已持久化的折叠状态。
 *
 * @returns {Promise<Record<string, boolean>>} 卡片 ID 到是否收起的映射。
 */
async function loadCollapseState() {
  try {
    const stored = await chrome.storage.local.get(COLLAPSE_STORAGE_KEY);
    return stored?.[COLLAPSE_STORAGE_KEY] || {};
  } catch (error) {
    return {};
  }
}

/**
 * 持久化当前折叠状态。
 *
 * @param {Record<string, boolean>} state 卡片 ID 到是否收起的映射。
 */
function saveCollapseState(state) {
  try {
    chrome.storage.local.set({ [COLLAPSE_STORAGE_KEY]: state });
  } catch (error) {
    /* 持久化失败不影响使用，忽略 */
  }
}

/**
 * 设置某个可折叠卡片的展开 / 收起状态，并同步无障碍属性。
 *
 * @param {HTMLElement} section 卡片根节点。
 * @param {boolean} collapsed 是否收起。
 */
function applyCollapseState(section, collapsed) {
  section.classList.toggle('collapsed', collapsed);
  const toggle = section.querySelector('.collapse-toggle');
  if (toggle) {
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  }
}

/**
 * 初始化可折叠卡片：回填持久化状态并绑定点击切换。
 */
async function initCollapsibleCards() {
  const toggles = Array.from(document.querySelectorAll('.collapse-toggle'));
  const stored = await loadCollapseState();
  toggles.forEach((toggle) => {
    const sectionId = toggle.dataset.collapseTarget;
    const section = document.getElementById(sectionId);
    if (!section) {
      return;
    }
    applyCollapseState(section, Boolean(stored[sectionId]));
    toggle.addEventListener('click', () => {
      const collapsed = !section.classList.contains('collapsed');
      applyCollapseState(section, collapsed);
      stored[sectionId] = collapsed;
      saveCollapseState(stored);
    });
  });
}

bindEvents();
initCollapsibleCards();
loadReauthStats();
refreshState().catch((error) => {
  setSaveStatus('同步失败', 'warn');
  renderTransientLog(`初始化失败：${error.message}`, 'error');
});
