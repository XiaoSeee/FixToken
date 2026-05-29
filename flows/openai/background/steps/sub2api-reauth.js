(function attachBackgroundSub2ApiReauth(root, factory) {
  root.MultiPageBackgroundSub2ApiReauth = factory();
})(typeof self !== 'undefined' ? self : globalThis, function createBackgroundSub2ApiReauthModule() {
  function createSub2ApiReauthExecutor(deps = {}) {
    const {
      addLog: rawAddLog = async () => {},
      chrome,
      completeNodeFromBackground,
      normalizeSub2ApiUrl = (value) => value,
      throwIfStopped = () => {},
      DEFAULT_SUB2API_GROUP_NAME = 'codex',
    } = deps;

    let sub2ApiApi = null;

    function addStepLog(step, message, level = 'info') {
      return rawAddLog(message, level, {
        step,
        stepKey: 'sub2api-reauth',
      });
    }

    function getSub2ApiApi() {
      if (sub2ApiApi) {
        return sub2ApiApi;
      }
      const factory = deps.createSub2ApiApi
        || self.MultiPageBackgroundSub2ApiApi?.createSub2ApiApi;
      if (typeof factory !== 'function') {
        throw new Error('SUB2API 接口模块未加载，无法执行重新授权。');
      }
      sub2ApiApi = factory({
        addLog: rawAddLog,
        normalizeSub2ApiUrl,
        DEFAULT_SUB2API_GROUP_NAME,
      });
      return sub2ApiApi;
    }

    function normalizeString(value = '') {
      return String(value || '').trim();
    }

    function resolveVisibleStep(state = {}) {
      const visibleStep = Math.floor(Number(state?.visibleStep) || 0);
      return visibleStep > 0 ? visibleStep : 10;
    }

    function formatAccountDisplayName(account = {}) {
      const id = account.id || 'unknown';
      const name = normalizeString(account.name);
      const email = normalizeString(account.email);
      const identifier = name || email || '未命名';
      return `#${id}（${identifier}）`;
    }

    async function executeSub2ApiReauth(state = {}) {
      throwIfStopped();
      const visibleStep = resolveVisibleStep(state);
      const api = getSub2ApiApi();

      await addStepLog(visibleStep, '正在查询 SUB2API 错误账号...', 'info');
      const errorAccounts = await api.listErrorAccounts(state, {
        logLabel: `步骤 ${visibleStep}`,
        timeoutMs: 30000,
      });

      if (!errorAccounts || errorAccounts.length === 0) {
        throw new Error(`步骤 ${visibleStep}：未找到需要重新授权的错误账号，请确认 SUB2API 中存在状态为 error 的 OpenAI 账号。`);
      }

      await addStepLog(visibleStep, `找到 ${errorAccounts.length} 个错误账号。`, 'ok');

      const selectedAccountId = normalizeString(state.selectedAccountId) || String(errorAccounts[0]?.id || '');
      if (!selectedAccountId) {
        throw new Error(`步骤 ${visibleStep}：无法确定要重新授权的账号 ID。`);
      }

      const selectedAccount = errorAccounts.find((acc) => String(acc.id) === selectedAccountId);
      if (!selectedAccount) {
        const availableList = errorAccounts
          .slice(0, 10)
          .map((acc) => formatAccountDisplayName(acc))
          .join('、');
        throw new Error(
          `步骤 ${visibleStep}：未找到 ID 为 ${selectedAccountId} 的错误账号。`
          + `可用的错误账号：${availableList}${errorAccounts.length > 10 ? '...' : ''}`
        );
      }

      await addStepLog(
        visibleStep,
        `已选择账号 ${formatAccountDisplayName(selectedAccount)} 进行重新授权。`,
        'info'
      );

      throwIfStopped();

      await addStepLog(visibleStep, '正在生成新的 OpenAI OAuth 授权链接...', 'info');
      const oauthResult = await api.generateOpenAiAuthUrl(state, {
        logLabel: `步骤 ${visibleStep}`,
        timeoutMs: 30000,
      });

      throwIfStopped();

      const result = {
        reauthAccountId: selectedAccountId,
        reauthAccountName: normalizeString(selectedAccount.name),
        reauthAccountEmail: normalizeString(selectedAccount.email),
        reauthErrorAccounts: errorAccounts,
        ...oauthResult,
      };

      await addStepLog(
        visibleStep,
        `已生成 OAuth 授权链接，请继续完成 OAuth 登录流程以重新授权账号 ${formatAccountDisplayName(selectedAccount)}。`,
        'ok'
      );

      await completeNodeFromBackground(state?.nodeId || 'sub2api-reauth', result);
      return result;
    }

    return {
      executeSub2ApiReauth,
    };
  }

  return {
    createSub2ApiReauthExecutor,
  };
});
