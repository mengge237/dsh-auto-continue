# dsh-auto-continue

![lang](https://img.shields.io/badge/lang-JavaScript-informational) ![status](https://img.shields.io/badge/status-maintained-brightgreen)

> 嘻嘻，我一定要用 DeepSeek harness

DSH 回合被 **max-tokens 输出上限**截断（UI 提示"已达到输出 token 上限…发送'继续'"）时，
本插件自动补一条"请继续"；阿里 **Token Plan 429/token-limit** 触发时，冷却后自动重试；
**上下文压缩把一整轮吞掉**（检查点刚落、零产出就 `completed`）时，补一条"照检查点继续动手"。
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

`auto-continue.log` 会记录 `已挂载（v0.4.0）…`、`max-tokens 截断（turn N）→ 自动续写`、
`检测到 429/token-limit … → Xs 后自动重试（第 k/3 次）`、
`压缩检查点后零产出收尾（turn N，检查点之后 Xms 就 end 了）→ 补发续写`；
不想留文件日志就 `DSH_AUTO_CONTINUE_LOG=off`（回归测试默认写 off，不污染运维日志）。

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
| 压缩检查点是一条 `user/message`，`source = {kind:'plugin', plugin:'compact'}` | `dsh-compaction` 的 `COMPACT_CHECKPOINT_MARKER` / `isCompactCheckpointSource()`；UI 也靠它认折叠块 |
| **压缩能在轮内把整轮吞掉**（v0.4 的靶子） | 本机 69 份存档 29 次压缩实测：13 次照常干活、7 次"回一句即 `max-tokens`"（旧分支已覆盖）、**3 次 `turn/start → user[plugin:compact] → turn/end[completed]` 间隔仅 10~21ms 且零回复零工具**。compaction-basic 自己就在 log 里写 `shadowed N surface nodes`：open-turn 压缩事务会 shadow 掉排在前的 surface 节点，本来该在这一轮跑的续写就此蒸发。这种 `turn/end` 的 kind 是 `completed`，跟正常收尾一模一样，只能靠形状认 |

## 行为与守卫

- 触发：回合 `max-tokens` 截断、`429 / Allocated quota exceeded / token-limit / insufficient_quota`、
  或**压缩检查点之后零产出就 `completed`**（三者共用同一套额度与守卫）；
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
| `DSH_AUTO_CONTINUE_CP_WINDOW_MS` | `60000` | 检查点 → `turn/end` 的最大间隔，超过就不算"压缩吞轮"（调小更保守，实测真样本是 10~21ms） |
| `DSH_AUTO_CONTINUE_LOG` | `~/.dsh/auto-continue.log` | 行日志路径；`off`/`0`/空 关闭 |

## 回归测试（0 token，不连模型）

```bash
node --test test/          # 16 例：max-tokens 续写 / 429 冷却重试 / 熔断 / 上限 / 去重 / 消息完整性
                           # + 6 例压缩吞轮（补枪、有产出不插手、超窗不插手、同轮只一次、
                           #   max-tokens 优先走旧分支、无检查点的 completed 保持安静）
```

测试默认 `DSH_AUTO_CONTINUE_LOG=off`，不会往 `~/.dsh/auto-continue.log` 里灌假 agent 的决策行。

## 与官方 goal 的分工

goal（`create_goal` / `/goal`）才是"多轮自主推进"的正道：它有 `dsh-goal-round-driver`
在每次 idle 时排下一轮，且**能活过上下文压缩**——`SessionStartSource` 类型里虽然写了
`'compact'`，但 0.1.2-rc.1 的编译产物里没有任何调用方传它（只有 `"startup"` 与 `"resume"`），
而 `dsh-goal` 恰恰只在 `agent/session-start` 上无条件 `activation = "disarmed"`。
也就是说：**同进程压缩不会解除 goal 的续期权，跨进程恢复才会**（那种情况要人再 `resume` 一次）。

本插件管的是另一半：goal 只在**你显式建了目标**的会话里工作，而日常"我就想让它把这一件事做完"
的会话没有 goal，被 max-tokens / 429 / 压缩事务打断后就只能靠这里补一枪。
本机现状也印证两者互不重叠：5 份用过 goal 的存档一次都没触发压缩，29 次压缩全在没 goal 的长会话里。

## 版本

- **v0.4.0**：新增"压缩吞轮"补枪（形状判定，见机制表最后一行）；测试默认关文件日志，不再污染运维日志。
- **v0.3.1**：修 3 个实测缺陷（残缺消息缺 `role`/`id`、`hasPending` 守卫恒假、突发冲破每分钟上限），
  新增 429 熔断、新鲜度窗口、idle 二次确认、行日志与回归测试。
- **v0.3**：改为根作用域 `agent/status` + 读尾部 `turn/end`（v0.2 的 agent 作用域 `session/event` 收不到事件，故完全失效）。
- **v0.2**：加 429 冷却重试与并发错峰。

## 说明

- 自动续写继续消耗套餐 token（`tokenplan/qwen3.8-flash`），属"把订阅用出价值"的预期行为；
- 只统计/只影响套餐 provider 之外的会话不做特殊处理：任何 provider 的 `max-tokens` 都会续，429 只对 token-limit 类文案生效；
- 若官方将来内置 auto-resume，本插件即可废弃。
