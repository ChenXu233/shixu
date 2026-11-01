# 外部依据与快照口径

> **状态**：已核对（2026-10-31 落档）
> **日期**：2026-10-31
> **读者**：要溯源某个结论、或要更新生态数字的人
> **上游材料**：无
> **口径**：分「出处」（不会过期的指针）与「快照」（有测量日期的数字）两类，不许混写

本页只登记**外部**依据。设计本身的事实不在这里。

## 出处

DSH 官方文档：

- 插件开发基础 <https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/index.md>
- 插件配置（Schemastery Config） <https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/config.md>
- bundle / profile 分发 <https://deepseek-harness.github.io/deepseek-harness/en/develop/basic/publish.md>
- Core 参考（ctx.agents / ctx.sessions / ctx.tools / ctx.systemPrompt） <https://deepseek-harness.github.io/deepseek-harness/en/reference/subsystems/core.md>

DSH 包内 README（以安装目录为准）：

- Agent 包（followup / steer / inject / agent.ctx / initiator scope）`packages/core/agent/README.md`
- Tools 包（register / restrict / guard / pre-execute）`packages/core/tools/README.md`
- Scope 包（作用域注册）`packages/core/scope/README.md`
- Session 包（append-only SessionEventMap）`packages/core/session/README.md`
- 审批服务 `dsh-user-approval`（唯一最终应答者、ask / never 策略、审计事件）
- 命令服务 `dsh-commands`（register / handler 返回值 / 不产生模型消息）
- 凭据服务 `dsh-credentials`（credentialRef / credentialKey / modifyRecord）

生态先例：

- 渠道提示词先例 `xmanrui/dsh-im` 的 `docs/上下文增强.md`
- 审批桥先例 `zhuiyueya/dsh-im-gateway` README
- 协议现状（NoneBot2 / OneBot 11 / OneBot 12 / Lagrange v2 / Satori / Milky）：见下方登记的三份调研

## 调研材料（输入，不是设计的一部分）

调研是**输入**。正文不重复其内容，只在此登记去处。文件不在本仓库内，按文件名向维护者索取。

| 文档 | 回答了什么 |
|---|---|
| `dsh-multiplatform-adapter-research.md` | Adapter / Driver / Bot 三层、OneBot 11 vs 12 差异、go-cqhttp / Lagrange / NapCat / SnowLuma 现状、统一事件模型与能力声明该抄哪一版 |
| `dsh-im-ecosystem-report.md` | 13 个 IM 插件逐个拆解、协议覆盖、并装冲突与审批应答者竞争、凭据明文乱象、生态空白点 |
| `dsh-im-ecosystem-digest.md` | 上面那份的摘要版 |
| dsh-workspace-mesh 仓库的 `docs/spike-p3-bus-plane.md` | 跨节点消息总线的语义与边界、命名空间由 mesh 统一、载荷只过指针 |
| [Super-agent 调研](../research/super-agent.md) | DeepSeek 2026-10-31 发布的自主 Agent 架构与我们的逐条对照 |

### Super-agent（2026-10-31）

- 设计文章：《Super-agent 设计探索：迈向更自主的 Agent 系统》（DeepSeek Harness 团队发布，本机未能直接访问原文）
- 原型仓库：<https://github.com/deepseek-ai/dsh-superagent-prototype>（MIT，技术路线验证，非正式产品）
- 转述与实验数据：IT之家 2026-10-31 21:36 报道 <https://www.ithome.com/1/020/615.htm>
- **注意**：本机访问 github.com / raw.githubusercontent.com 全部超时，架构描述来自媒体转述，数字按「待核对」对待。

## 快照口径

以下数字**全部是测量值**，不是设计常量。引用时必须带上口径名称，不要自己重述数字。

| 口径名称 | 测量日期 | 范围 | 数值 | 来源 |
|---|---|---|---|---|
| 生态快照·dsh-im 规模 | 2026-10-24 | GitHub star + npm 近 30 天下载 | 2.8k★ / 85 625 次 | `dsh-im-ecosystem-report.md` |
| 生态快照·dsh-im 渠道数 | 2026-10-24 | 插件声明支持的渠道 | 11 个 | 同上 |
| 生态快照·官方包数量 | 2026-10-24 | DSH 官方发布的包 | 297 个，无 IM / 渠道抽象包 | 同上 |
| 生态快照·协议支持 | 2026-10-24 | 全生态 | OneBot 12 支持数 = 0 | 两份调研 |

**这张表会过期。** 生态变动很快，P1 动手前应重新核对；在代码或文档里引用这些数字时，务必带上口径名称与测量日期，不要写成永久结论。
