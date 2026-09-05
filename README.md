# dsh-auto-continue

![lang](https://img.shields.io/badge/lang-JavaScript-informational) ![status](https://img.shields.io/badge/status-maintained-brightgreen)

> 嘻嘻，我一定要用 DeepSeek harness

DSH 回合被 **max-tokens 输出上限**截断（UI 提示"已达到输出 token 上限…发送'继续'"）时，
本插件自动补一条"请继续"；阿里 **Token Plan 429/token-limit** 触发时，冷却后自动重试。
目标只有一个：**输出不断档，不用你手动救场**。

## 安装 / 卸载

```bash
dsh plugin --profile web add link:E:/S_Software/deepseek-harness/plugins/dsh-auto-continue
# 装完必须完全重启 dsh web（Settings → Plugins 可见 dsh-auto-continue）
dsh plugin --profile web remove dsh-auto-continue
```

备份：`C:\Users\Lenovo\.dsh\profiles\web\cordis.yml.bak-*`（dsh plugin 自动生成）。

## 30 秒自检（不用盯 GUI）

```bash
# 1) 插件是否真的挂上了（每次启动一行）
tail -3 ~/.dsh/auto-continue.log

# 2) 是否真的续写过：会话存档里找插件署名的 user/message
python ~/dsh-fixes/scan_auto_continue.py --since "2026-09-05 22:43:00"
```

`auto-continue.log` 会记录 `已挂载（v0.3.1）…`、`max-tokens 截断（turn N）→ 自动续写`、
`检测到 429/token-limit … → Xs 后自动重试（第 k/3 次）`；不想留文件日志就 `DSH_AUTO_CONTINUE_LOG=off`。

## 机制（对 dsh 0.1.2-rc.1 编译产物实证）

| 假设 | 依据 |
|---|---|
| 根作用域 `ctx.on('agent/status')` 收得到所有 agent | `agentEvents()` 把 `agent` 融进 payload；官方插件（compaction-basic / goal-round-driver / sdk-jsonrpc-server）同款用法 |
| 收到 `idle` 时尾部 `turn/end` 已落盘 | `turn()` 的 `finally` 先 `session.append("turn/end")`，`kick()` 的 `finally` 才 `setPhase(idle)` |
| `reason.kind === 'max-tokens'` / `reason.error.{message,code}` | `dsh-session` `TurnEndReasonMap`、`LlmFailure` |
| `agent.followup(msg)` 必须传**完整 message** | `followup → send → inbox.splice(...,[message])`，字符串会被当成残缺消息 |
| `inbox.hasPending` 是 boolean getter | `dsh-agent` `Inbox`（不是函数，别写 `typeof === 'function'`） |
| 插件目录解析不到 `@deepseek-ai/dsh-llm` | 实测 `ERR_MODULE_NOT_FOUND`（profile 的 node_modules 无 `@deepseek-ai` 作用域）→ v0.3.1 自带完整消息构造 |
| **service 取值必须留在事件派发那一帧内** | 一旦 `await` 过再调 `agent.followup()`，cordis proxy 在 `fiber.store` 取不到 inject 服务，抛 `cannot get required service "agents" in inactive context`（ac-rig 实测）→ 所以消息构造**同步、零依赖**，max-tokens 分支**同帧投递**，只有 429 冷却才用定时器 |
| 真实 429 的 `error.code` 是 `QUOTA` 不是 `RATE_LIMIT` | 本机 `turn/end` 语料：`429: {"message":"Allocated quota exceeded … #token-limit","code":"insufficient_quota"}`；而 `Free quota exhausted / 余额不足` 也是 `QUOTA` 却**不可恢复** → 判定同时看 code 与文案，并用 `DEAD_QUOTA` 白名单排除 |

## 行为与守卫

- 触发：回合 `max-tokens` 截断，或 `429 / Allocated quota exceeded / token-limit / insufficient_quota`；
- 每 agent 每 60 秒最多 `DSH_AUTO_CONTINUE_MAX`（默认 4）次自动续写，**额度在排期时就预占**（v0.3 是发送后才计数，突发会冲破上限）；
- **429 熔断**：连续自动重试最多 `DSH_TP_429_MAX_RETRIES`（默认 3）次，之后停手等你手动继续——
  额度真尽时不会每分钟 4 次地无限重试；期间任何一次正常推进（`completed`）自动清零；
- **新鲜度窗口** `DSH_AUTO_CONTINUE_STALE_MS`（默认 10 分钟）：重启/恢复老会话时，
  不会隔几小时突然补一句"请重新执行我上一条请求"；
- 尊重你正在打的字：`inbox.hasPending` 为真、或 agent 已被别的输入唤醒（非 idle）就放弃这一发并让出额度；
- 全局错峰：自动消息之间至少间隔 `DSH_TP_PACING_MS`（默认 2.5s）+ 0~1.5s 抖动，平滑多会话的瞬时 TPM；
- 429 恢复文案里的"已等待 X 秒"取真实计算值（v0.3 的 `Math.max(C-p, C)` 恒等于 C，pacing 白写）；
- 任何异常只记日志，绝不打断 agent 主流程。

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_AUTO_CONTINUE` | `1` | `0` 整体关闭 |
| `DSH_AUTO_CONTINUE_MAX` | `4` | 每 agent 每 60s 最大续写次数 |
| `DSH_AUTO_CONTINUE_STALE_MS` | `600000` | 只处理 N 毫秒内的 `turn/end` |
| `DSH_TP_429_COOLDOWN_MS` | `60000` | 429 冷却（从 `turn/end` 时刻起算） |
| `DSH_TP_429_MAX_RETRIES` | `3` | 连续 429 自动重试上限（熔断） |
| `DSH_TP_PACING_MS` | `2500` | 自动消息全局最小间隔（另加抖动） |
| `DSH_TP_REMINDER` | `1` | 429 恢复消息带"仅本会话提示"文案 |
| `DSH_AUTO_CONTINUE_LOG` | `~/.dsh/auto-continue.log` | 行日志路径；`off`/`0`/空 关闭 |

## 回归测试（0 token，不连模型）

```bash
node --test test/          # 10 例：max-tokens 续写 / 429 冷却重试 / 熔断 / 上限 / 去重 / 消息完整性
```

## 版本

- **v0.3.1**：修 3 个实测缺陷（残缺消息缺 `role`/`id`、`hasPending` 守卫恒假、突发冲破每分钟上限），
  新增 429 熔断、新鲜度窗口、idle 二次确认、行日志与回归测试。
- **v0.3**：改为根作用域 `agent/status` + 读尾部 `turn/end`（v0.2 的 agent 作用域 `session/event` 收不到事件，故完全失效）。
- **v0.2**：加 429 冷却重试与并发错峰。

## 说明

- 自动续写继续消耗套餐 token（`tokenplan/qwen3.8-flash`），属"把订阅用出价值"的预期行为；
- 只统计/只影响套餐 provider 之外的会话不做特殊处理：任何 provider 的 `max-tokens` 都会续，429 只对 token-limit 类文案生效；
- 若官方将来内置 auto-resume，本插件即可废弃。
