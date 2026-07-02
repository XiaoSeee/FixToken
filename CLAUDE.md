# FixToken 项目说明

> 本文件是 FixToken 项目的唯一总览文档，供后续 AI 协作与人工修改参考。所有代码注释、提交信息均使用简体中文。

## 1. 项目简介

FixToken（`manifest.json` 中插件名，版本 2.5）是一个 **Manifest V3 Chrome 侧边栏扩展**，职责单一：**批量重新授权 SUB2API 中状态异常的 OpenAI OAuth 账号**。

- **来源**：由 FlowPilot（一个批量注册 / 授权 / Plus 支付 ChatGPT 账号的侧边栏扩展）改造而来。`manifest.json` 描述已更新为当前职责，侧边栏 UI 已替换为轻量版（`sidepanel-lite.*`）。
- **现状**：仓库保留了 FlowPilot 约 80% 的遗留代码（各邮箱 provider、手机接码、PayPal/GoPay 支付、Kiro/Grok flow 等），reauth 链路只复用了其中的 **Cloudflare Temp Email 收码** 与 **OpenAI auth 页自动化** 两项能力。遗留代码说明见第 8 节，修改前务必先阅读，避免误改。

## 2. 技术栈与插件清单

- **MV3 service worker**：`background.js`（根目录大文件，通过 `importScripts` 顺序加载全部模块）。
- **侧边栏 UI**：`sidepanel/sidepanel.html`（唯一 HTML 入口），引用 `sidepanel/sidepanel-lite.css` 与 `sidepanel/sidepanel-lite.js`。
- **content_scripts**：仅注入以下三个域，`run_at: document_idle`：
  - `https://auth0.openai.com/*`
  - `https://auth.openai.com/*`
  - `https://accounts.openai.com/*`
  - 注入脚本见 `manifest.json` 的 `content_scripts[0].js`（共 11 个，核心是 `flows/openai/content/openai-auth.js`）。
- **权限**：`sidePanel`、`alarms`、`tabs`、`webNavigation`、`webRequest`、`webRequestAuthProvider`、`proxy`、`declarativeNetRequest`、`debugger`、`browsingData`、`cookies`、`storage`、`scripting`、`activeTab`；`host_permissions: <all_urls>`。
- **静态规则**：`rules.json`（declarativeNetRequest 规则）。
- **图标**：`icons/icon16.png`、`icon48.png`、`icon128.png`（manifest 硬引用，不可删除）。

## 3. 实际生效的入口与数据流

- **UI 层**：`sidepanel/sidepanel.html` + `sidepanel/sidepanel-lite.js` + `sidepanel-lite.css`。
  - ⚠️ `sidepanel/sidepanel.js` 与 `sidepanel/sidepanel.css` 是 **FlowPilot 遗留 UI（约 18509 行），未被 `sidepanel.html` 引用**，reauth 不依赖，修改时不要误以为是当前 UI。
- **后台层**：`background.js` 通过 `importScripts` 加载模块；消息总入口 `handleMessage`（`background.js`）→ `background/message-router.js` 的 `createMessageRouter`。
- **配置持久化**：表单输入 → `sidepanel-lite.js` 的 `scheduleSave`（450ms 防抖）→ `SAVE_SETTING` 消息 → `chrome.storage.local`。
- **运行态**：`chrome.storage.session`（关闭浏览器即丢失），由 `background.js` 的 `getState` / `setState` / `resetState` 管理。

## 4. 核心业务流程（批量重新授权）

reauth 链路分四个阶段，关键文件与函数如下：

### (a) 查询错误账号 — 消息 `SUB2API_LIST_ERROR_ACCOUNTS`

- 入口：`background/message-router.js` → `background/sub2api-api.js` 的 `listErrorAccounts`。
- **鉴权**：`POST /api/v1/auth/login`，body `{email, password}`，返回 `access_token`（Bearer）。
- **异常判定**：SUB2API 的 `status` 是单值，repo 层不支持逗号多值，因此分两次请求再按 id 合并去重：
  - `status=error`：状态为 error 的账号；
  - `status=unschedulable`：状态为 active 但 `schedulable=false`（手动关闭调度）的账号。
- 两次请求均带 `platform=openai` + `group=<groupId>` + `page_size=100`。
- **分组解析**：侧边栏配置的 `sub2apiGroupName`（默认 `codex`）→ `getGroupsByNames` → 数字 `groupId`。

### (b) 批量重新授权主循环 — 消息 `START_SUB2API_REAUTH`（`background/message-router.js`）

- **前置**：`prepareExclusiveSub2ApiReauthRun` 检测并清理残留的自动运行上下文（待重试计时、运行中节点、autoRun 锁、alarm），避免旧流程“复活”。
- **执行方式**：**顺序逐个处理**（非并发），账号间 `sleep 1000ms`。
- 每个账号的步骤：
  1. `resetState()` 重置当前步骤状态。
  2. `resolveReauthAccountEmail(account)` 解析 OAuth 登录邮箱（见第 6 节字段顺序 + 正则兜底）。
  3. `clearOpenAiCookies` 清空 `openai.com` / `auth.openai.com` / `auth0.openai.com` / `accounts.openai.com` 的 cookie。
  4. `sub2ApiApi.generateOpenAiAuthUrl(state)`：登录 SUB2API → 选分组 → 选代理 → `POST /api/v1/admin/openai/generate-auth-url`，拿到 `oauthUrl` / `sessionId` / `state`。
  5. `setState` 写入 `selectedAccountId`、`sub2apiReauthMode:true`、`reauthCompleted:false`、`stepExecutionRangeByFlow.openai = { fromStep:7, toStep:11 }` 等。
  6. `runAutoSequenceFromNode('oauth-login', ...)` 驱动流程引擎，只跑 OAuth 登录尾链（oauth-login → fetch-login-code → confirm-oauth → localhost 回调 → platform-verify）。
  7. 流程结束后用 `isSub2ApiReauthCompleted(state, accountId)` 检测是否已写回，未写回则抛错。
  8. `closeLocalhostCallbackTabs` 关闭残留回调 tab。
- **进度反馈**：每步 `addLog` 带 `[i/total]` 前缀；background 通过 `LOG_ENTRY` / `DATA_UPDATED` 推给 sidepanel 实时渲染。

### (c) OAuth 登录页自动化（content script）

- `flows/openai/content/openai-auth.js`：
  - `oauth-login` 节点 → `step6_login`：自动填邮箱 / 密码、处理登录验证码、处理超时重试页。
  - `confirm-oauth` 节点 → `step8_findAndClick`：在 OAuth 同意页找到“继续”按钮并点击（支持 `dispatchClick` / `debugger` 两种点击策略）。
- **登录验证码**：复用 Cloudflare Temp Email 轮询（`background/flow-mail-polling.js` + 根目录 `cloudflare-temp-email-utils.js`），由 `setEmailStateSilently` 让轮询认领当前邮箱。
- **localhost 回调捕获**：`background.js` 用 `chrome.webNavigation.onBeforeNavigate` / `onCommitted` 监听 `http://localhost:1455/auth/callback?code=...&state=...`。

### (d) 回调交换与凭据写回 — `platform-verify` 步骤

- 文件：`flows/openai/background/steps/platform-verify.js`，函数 `executeSub2ApiStep10`。
- **reauth 判定**：`isReauth = Boolean(state.selectedAccountId)`。
- reauth 分支：
  1. `api.submitOpenAiCallback({ ...state, skipAccountCreation:true })` —— 交换授权码得到 credentials，但 **跳过创建新账号**（`sub2api-api.js` 中 `skipAccountCreation` 直接 return）。
  2. `api.applyOAuthCredentials(state.selectedAccountId, state, credentials)` —— `POST /api/v1/admin/accounts/{id}/apply-oauth-credentials`，把新 OAuth 凭据写回原账号。
  3. `completeNodeFromBackground('platform-verify', { reauthCompleted:true })` —— 置 `reauthCompleted:true`，供主循环步骤 7 检测。
- **临时错误重试**：`isSub2ApiTransientExchangeError` 识别 `auth.openai.com/oauth/token` 相关的 EOF / connection refused / timeout / `token_exchange_user_error` 等信号；`maxExchangeAttempts = 3`，重试前 `sleep(1200 * attempt)`。

## 5. SUB2API 接口清单

| 操作 | 方法 | 路径 | 关键参数 / 返回 |
|---|---|---|---|
| 登录 | POST | `/api/v1/auth/login` | `{email, password}` → `access_token` |
| 查全部分组 | GET | `/api/v1/admin/groups/all` | 按 name + `platform=openai` 过滤 |
| 查全部代理 | GET | `/api/v1/admin/proxies/all?with_count=true` | 选默认代理 |
| 生成 OAuth 链接 | POST | `/api/v1/admin/openai/generate-auth-url` | `{redirect_uri, proxy_id?}` → `{auth_url, session_id, state}` |
| 交换授权码 | POST | `/api/v1/admin/openai/exchange-code` | `{session_id, code, state, proxy_id?}` → credentials |
| 创建账号 | POST | `/api/v1/admin/accounts` | reauth 路径不走（`skipAccountCreation`） |
| 查错误账号 | GET | `/api/v1/admin/accounts` | `status=error` 与 `status=unschedulable` 分查，`platform=openai` + `group` + `page_size=100` |
| 写回 OAuth 凭据 | POST | `/api/v1/admin/accounts/{id}/apply-oauth-credentials` | `{type:'oauth', credentials}` |

**关键常量**（`background/sub2api-api.js`）：
- `DEFAULT_REDIRECT_URI = 'http://localhost:1455/auth/callback'`（回调路径必须为 `/auth/callback`）。
- `DEFAULT_SUB2API_GROUP_NAME = 'codex'`。
- `DEFAULT_CONCURRENCY = 10`、`DEFAULT_PRIORITY = 1`、`DEFAULT_RATE_MULTIPLIER = 1`。
- 统一响应格式 `{code, data, message}`，`code===0` 取 `data`，否则抛错；`requestJson` 带 30s 超时。

## 6. 状态字段与数据结构

### reauth 相关 state 字段（`START_SUB2API_REAUTH` 写入）

| 字段 | 说明 |
|---|---|
| `selectedAccountId` | 当前正在重新授权的 SUB2API 账号 ID（reauth 模式标志） |
| `sub2apiReauthMode` | `true` 表示处于 reauth 模式 |
| `reauthCompleted` | 写回成功后置 `true`，供主循环检测 |
| `oauthUrl` / `sub2apiSessionId` / `sub2apiOAuthState` | generate-auth-url 返回的 OAuth 上下文 |
| `sub2apiGroupId` / `sub2apiGroupIds` | 解析后的分组 ID |
| `sub2apiProxyId` | 使用的代理 ID |
| `email` / `accountIdentifierType:'email'` / `signupMethod:'email'` | 当前账号登录邮箱 |
| `stepExecutionRangeByFlow.openai` | `{ fromStep:7, toStep:11 }`，限定只跑 OAuth 登录尾链 |
| `localhostUrl` | webNavigation 捕获的回调 URL |

### SUB2API 账号对象关键字段

`id` / `name` / `status`（`error` / `unschedulable` / `active`）/ `platform`（`openai`）/ `type`（`oauth`）/ `credentials` / `extra`。

### 邮箱解析字段顺序（`resolveReauthAccountEmail` / sidepanel `getAccountEmail`）

`email` → `account_email` → `accountEmail` → `username` → `name` → `credentials.email` → `credentials.account_email` → `extra.email` → `extra.account_email` → `metadata.email` → 兜底对整个 account `JSON.stringify` 后正则提取首个邮箱。`credentials` / `extra` 可能是对象或 JSON 字符串，需先解析。

## 7. UI 交互（侧边栏）

`sidepanel/sidepanel.html` 分四个 section：

1. **SUB2API 配置**：后台地址、账号邮箱 / 密码、OpenAI 登录密码、OpenAI 分组、默认代理；顶部 `save-status` 状态丸。
2. **Cloudflare Temp Email 配置**：服务地址、Admin Auth、Custom Auth、查询模式、接收邮箱、当前域名、域名列表、随机子域名开关。
3. **错误账号**：全选 / 取消全选 / 获取账号 / 重置当前步骤 / 开始授权；`account-summary` 摘要行；`account-list` 列表（checkbox + 账号名 + `#id · email · status`）。
4. **运行日志**：刷新按钮 + `log-area` 实时日志（按 level 着色）。

关键函数（`sidepanel/sidepanel-lite.js`）：
- `collectSettings` —— 读表单为配置补丁，**固定写入** `activeFlowId:'openai'`、`targetId:'sub2api'`、`plusModeEnabled:false`、`signupMethod:'email'`、`mailProvider:'cloudflare-temp-email'`，把侧边栏锁死在 reauth 链路。
- `fetchErrorAccounts` —— 先 `saveSettingsNow` 再发 `SUB2API_LIST_ERROR_ACCOUNTS`。
- `startReauth` —— 发 `START_SUB2API_REAUTH` 带勾选的 `accounts` 数组。
- `renderLogs` —— 渲染最近 120 条日志；监听 `LOG_ENTRY` / `DATA_UPDATED` 实时更新。

## 8. 遗留代码说明（重要：避免误改）

以下模块为 FlowPilot 原有功能，**reauth 链路不依赖**，修改 reauth 时无需触碰，也不要误以为是当前功能：

- `sidepanel/sidepanel.js` + `sidepanel/sidepanel.css`：FlowPilot 原 UI（约 18509 行），未被 `sidepanel.html` 引用。其中也有一份带每账号状态持久化的 reauth 卡片旧实现，属历史保留。
- `flows/openai/content/sub2api-panel.js`：在 SUB2API 后台页内直接操作的内容脚本，**未被 manifest 注入**，仅兼容手动单步场景；FixToken 批量 reauth 走 background 直连管理 API 的路径，不依赖它。
- `flows/openai/background/steps/sub2api-reauth.js`：单账号 reauth 节点（查错误账号 → 选定 → 生成 OAuth 链接 → `completeNode`），批量 UI 未走此节点，更像是给单步手动执行用的入口。
- 各邮箱 provider：根目录 `hotmail-utils.js` / `mail2925-utils.js` / `icloud-utils.js` / `luckmail-utils.js` / `yyds-mail-utils.js` / `cloudmail-utils.js` / `microsoft-email.js` / `managed-alias-utils.js` / `mail-provider-utils.js`，以及 `content/` 下的 `duck-mail.js` / `gmail-mail.js` / `icloud-mail.js` / `inbucket-mail.js` / `mail-163.js` / `mail-2925.js` / `qq-mail.js`。
- 手机接码：`phone-sms/providers/`（`five-sim.js` / `hero-sms.js` / `registry.js`）、`background/phone-verification-flow.js`、`flows/openai/content/phone-auth.js` / `phone-country-utils.js`。
- 支付：`paypal-utils.js`、`gopay-utils.js`、`background/paypal-account-store.js`、`flows/openai/content/paypal-flow.js` / `gopay-flow.js` / `plus-checkout.js`、`flows/openai/background/steps/paypal-approve.js` / `gopay-approve.js` / `gopay-manual-confirm.js` / `create-plus-checkout.js` / `fill-plus-checkout.js` / `plus-return-confirm.js`。
- 其他 flow：`flows/grok/`、`flows/kiro/`（含 `background/` 与 `content/` 子目录）、`shared/kiro-timeouts.js`。
- 贡献 / 导入：`background/contribution/`、`shared/contribution-registry.js`、`imports/legacy/`、`sidepanel/contribution-*.js`。
- 本地 helper：`scripts/`（Python `hotmail-helper.py` / `gpc_sms_helper_macos.py`）、`start-hotmail-helper.bat` / `.command`。
- 测试：`tests/`（约 190 个 `*.test.js`），多数针对 FlowPilot 遗留功能。

## 9. 后续修改指引

| 修改目标 | 关键文件 |
|---|---|
| reauth 主流程（循环 / 顺序 / 间隔 / 错误处理） | `background/message-router.js` 的 `START_SUB2API_REAUTH` handler |
| SUB2API 接口（端点 / 鉴权 / 字段） | `background/sub2api-api.js` |
| OAuth 页面自动化（填邮箱密码 / 点同意） | `flows/openai/content/openai-auth.js` |
| 回调交换与凭据写回 | `flows/openai/background/steps/platform-verify.js` 的 `executeSub2ApiStep10` |
| 侧边栏 UI | `sidepanel/sidepanel.html` + `sidepanel/sidepanel-lite.js` |
| 插件配置 / 权限 / 注入脚本 | `manifest.json` |
| 流程图节点定义 / 步骤串联 | `data/step-definitions.js`、`flows/openai/workflow.js`、`core/flow-kernel/workflow-engine.js` |

## 10. 代码风格约定

- **语言**：所有新编写的代码注释、文档、提交信息均使用简体中文；每个类、方法、关键步骤都需详细注释。
- **条件分支**：能清晰表达业务分支时优先 `if ... else ...`，不在 `if` 分支里提前 `return`。
- **级联分支**：对同一变量做三种及以上互斥判断时优先 `when`，避免级联 `if ... else if ...`。
- **单行分支**：`if` / `else` / `when` 分支体只有一条语句时不写花括号，后续会扩展为多条语句时才保留。
- **工具**：本项目为纯 JavaScript，无 Kotlin LSP 依赖；需要第三方库文档时使用 Context7 MCP，需要网页 / 代码搜索时使用 Exa MCP。
