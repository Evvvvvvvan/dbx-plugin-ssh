# issue #202 前端配合修复要点（web 刷新后连接恢复失败）

> 本文件由后端 agent 产出（分支 `codex/ssh/issue-202-web-refresh`，基线 main
> 4a33950d）。前端只读审查 + 后端审计的结论与建议，前端修复由前端 agent 实施。

## 根因链（已实锤）

1. 文案出处：**插件前端** `frontend/src/lib/i18n.ts:2828`
   （`connectionInactive`，七语齐全），由 `App.vue:4137-4138` 在
   `isConnectionInactiveError(cause)` 命中时渲染；匹配的 sidecar 错误串是
   `Connection is not active; reopen it from DBX`（后端连接注册表缺该
   connectionId 时的固定报错，见 `backend/src/ssh.rs` open_session 等处）。
2. 「正在连接（第 13 次尝试）…」= `connectCard.log.attempt`（i18n.ts:2848），
   由 `App.vue` openSession 的 `openRetryAttempt+1` 打点。**1 次首发 +
   12 次重试 = 13**，正好对应 boot-restore 专属重试窗口
   `BOOT_RESTORE_RETRY_MAX = 12 × 1000ms`（`frontend/src/lib/connectRetry.ts`，
   #144 为 docker/web 恢复加的）跑满后 `decideConnectRetry` 落 `fail`。
3. 永不成功的原因：boot-restore 路径**被动等待**宿主自动重放
   `connection/connect` 生命周期（#144 的假设：宿主启动时会为恢复的插件 tab
   重放）。web 版浏览器刷新时宿主进程不重启，不会触发那条启动重放链路；
   sidecar 的连接注册表（纯内存）里没有该连接的凭据，重试 12 秒注定失败。
   只有整库重载 DBX 才会重新走 connect 生命周期，所以「重载 DBX」能恢复。

## 后端已保证的契约（本次后端修复，前端可直接依赖）

- 未知/已失效 sessionId 的操作**立即返回结构化错误**，绝不 hang：
  - `ssh/session/open`：`Connection is not active; reopen it from DBX`
  - `ssh/session/attach`（无存活会话）：`No live SSH session is attached to this workbench`
  - `ssh/terminal/in`（写）：`SSH session was not found or expired`
  - `ssh/session/close`：`SSH session was not found`
  以上已用 rust 单测逐字锁定（`backend/src/ssh.rs` tests：
  `session_ops_fail_structured_when_connection_registry_is_empty` 等）。
- 同 connectionId 重复 `connection/connect` **幂等**：注册表替换为最新配置，
  并清扫上一轮注册的残留（绑定死会话的 sudo 保活、孤儿会话缓存、无会话的
  remote-forward 表）。重推 connect 后「从零 connect」路径必然可用，
  不会被旧状态卡死（单测 `store_connection_is_idempotent_and_sweeps_stale_residue`，
  协议文档 `docs/PROTOCOL.zh-CN.md` connection/connect 行已更新）。

## 建议的前端修复（按优先级）

1. **boot-restore 的 inactive 路径补一次主动 `requestHostReopenConnection`**
   （`App.vue` openSession catch，当前条件
   `if (inactive && !bootRestore && openRetryAttempt === 0 && !hostReopenAttempted)`，
   约 App.vue:4099-4101）。web 刷新后宿主不会自动重放，等价于手动路径的场景；
   `host.reopenConnection` 幂等且 webview 拿不到凭据，boot 态调用同样安全。
   改成 `if (inactive && openRetryAttempt === 0 && !hostReopenAttempted)` 即可，
   `hostReopenFailed` 置位逻辑不动。
2. **`decideConnectRetry` 让 boot-restore 也尊重 `hostReopenFailed`**
   （`frontend/src/lib/connectRetry.ts`：当前只有
   `inactive && !bootRestore && hostReopenFailed` 才立即 fail，boot 分支忽略
   该旗标继续烧 12 秒）。宿主明确拒绝重开后，继续轮询不可能自愈——改为
   立即 `fail`，避免用户看着「第 13 次尝试」干等。
3. 重试窗口与文案：修复 1+2 后 boot-restore 的预期行为是「请求宿主重开 →
   有界轮询（现有 12×1s 或与手动窗口统一为 10×3s 皆可）→ 成功或明确失败」，
   `connectionInactive` 现有文案（「请重新加载 DBX…」）在宿主重开被拒时仍然
   准确，可不改；若想更温和，可把 boot 失败文案改为「已请求重新建立连接但未
   成功，请从左侧连接列表重新打开」并补七语。
4. 顺带核对 `attachSession`（App.vue:4142-4185）：梯子耗尽回落
   `openSession(true)` 的语义与后端契约兼容（attach 对死会话立即返回结构化
   错误，不会 hang），无需改动。

## 涉及文件清单（前端侧，均只读审查）

- `frontend/src/lib/i18n.ts`：2828（connectionInactive）、2848（log.attempt）
- `frontend/src/lib/connectRetry.ts`：INACTIVE_RETRY_MAX / BOOT_RESTORE_RETRY_MAX /
  decideConnectRetry 的 hostReopenFailed 分支
- `frontend/src/lib/terminalReconnect.ts`：isConnectionInactiveError /
  isSessionGoneError（错误串分类契约，勿改正则）
- `frontend/src/App.vue`：4095-4140（openSession catch）、4142-4185（attachSession）、
  8095-8112（boot 恢复链：restored 早退 / panel 预拨 / openSession(false,true)）、
  719 附近（inactiveWaiting 注释）
