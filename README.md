# dsh-auto-continue

![lang](https://img.shields.io/badge/lang-JavaScript-informational) ![status](https://img.shields.io/badge/status-maintained-brightgreen)


> 嘻嘻，我一定要用 DeepSeek harness

DSH 回合因 **max-tokens 输出上限**被截断（UI 提示"已达到输出 token 上限…发送'继续'"）时，
本插件自动向同一 agent 补一条"请继续"，**不用你手动发'继续'**。

> 实验版注意：机制基于 dsh 0.1.2-rc.1 源码实证（turn/end 落盘后才 idle；idle 后
> `agent.followup()` 才能唤醒下一回合），但**尚未在真实 GUI 全链路回归**。
> 装上后请先开 1 个会话故意制造长输出，看日志确认自动续写发生且无失控循环。

## 安装 / 卸载
```bash
dsh plugin --profile web add link:E:/S_Software/deepseek-harness/plugins/dsh-auto-continue
# 完全重启 dsh web（Settings → Plugins 可见 dsh-auto-continue）
dsh plugin --profile web remove dsh-auto-continue   # 卸载
```
备份：`C:\Users\Lenovo\.dsh\profiles\web\cordis.yml.bak-*` 由 dsh plugin 自动生成。

## 行为与守卫
- 触发：`turn/end reason.kind === "max-tokens"`  等 agent 回 idle  自动 `followup('请继续')`；
- 每 agent **每 60 秒最多 4 次**自动续写（防失控循环），间隔 ≥1.2s；
- agent 收件箱已有待处理输入时不续写（尊重你正在打的字）；
- 任何异常只记日志，不打断 agent 主流程。

## 环境变量
| 变量 | 默认 | 说明 |
|---|---|---|
| `DSH_AUTO_CONTINUE` | `1` | `0` 关闭插件 |
| `DSH_AUTO_CONTINUE_MAX` | `4` | 每 agent 每分钟最大续写次数 |

## 监控（验证是否真的在工作）
```bash
# dsh 日志里搜 dsh-auto-continue：应看到 检测到 max-tokens 截断 / 已自动续写
# 会话 jsonl（zstd）看同一 turn 之后是否出现新的 step/turn 而不是停在截断
```
第一次冒烟建议：新开会话让它写一篇明显超长的长文  若插件生效，无需你发"继续"，页面自动继续产出。

## 说明
- 自动续写会继续消耗套餐 token（qwen3.8-flash），属"把订阅用出价值"的预期行为；
- 若官方未来提供内置 auto-resume，本插件即废弃。

## v0.2 新增：阿里 429 / 多会话并发分级排队
- 触发：会话 turn/end 报 `429 … Allocated quota exceeded … token-limit`；
- 行为：该会话**冷却 60s**（默认）后自动续写恢复；恢复消息里带一句
  "已自动等待 X 秒后恢复，仅本会话提示"——**提醒只出现在触发它的工作会话，其它对话不显示**；
- 并发：tokenplan 同跑会话超 `DSH_TP_MAX_PARALLEL`（默认 2）时，后续会话自动排队；
- 分级：近 1 分钟步骤多的会话记为 heavy（日志可见），排队优先级更保守；
- 环境变量：`DSH_TP_MAX_PARALLEL=2`、`DSH_TP_429_COOLDOWN_MS=60000`、
  `DSH_TP_PACING_MS=2000`、`DSH_TP_REMINDER=1`。
