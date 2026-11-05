# AGENTS.md

> 给编码 agent 的项目说明。人类入口见 [README.md](README.md)，文档索引见 [docs/README.md](docs/README.md)。
> **最后核对**：2026-10-31，依据 [docs/reference/](docs/reference/) 与 [docs/adr/](docs/adr/)。

## 元规则：本文件自己怎么演进

| # | 规则 | 判据 |
|---|---|---|
| M1 | 加规则必须先经维护者同意 | 在对话里提出、说明不加会出什么错，批准后才写 |
| M2 | 只加「不加就不知道」的规则；写稳定的抽象概念，不写易变细节 | 能从代码 / 工具 / 常识推出的不写；会随实现漂移的不写 |
| M3 | 规则必须可判 | 要么能被 `scripts/check_docs.py` 机检，要么有明确判据 |
| M4 | 同一规则只写一处，其余留指针 | 复制会漂移 |
| M5 | 规则失效就删，不保留历史 | 不写「历史上曾要求…」 |

## 1. 这个仓库是什么

**时煦（shixu）= 给 DSH 的渠道内核 + 人格引擎**：让一个人格同时活在多个聊天平台里。

心智模型只有一句：**驱动按协议归一化事件 → 已抽象的动作变成工具、没词表的能力变成 MCP 工具 → 人格在多个「场所」里同时在场、共享一份分层记忆。**

五层边界（细节见 [layering.md](docs/reference/layering.md)）：

| 层 | 一句话 |
|---|---|
| L0 DSH Core | 不动的底座 |
| L1 `dsh-shixu-channel` | 平台差异收敛处，独占审批应答与凭据 |
| L2 `dsh-shixu-driver-*` | 每协议一份，只懂自己那套协议；没词表的能力自带 MCP server |
| L3 `dsh-shixu-persona` | 人格、场所、记忆、权限、发布 |
| L4 人格包 | 可分发的人设 + 记忆 |

## 2. 事实优先级

发生冲突时，低优先级服从高优先级：

1. 代码与可执行的检查
2. 文件树（某文件 / 目录是否真的存在）
3. `docs/` 下的文档
4. 本文件与 README 的叙述

文档与事实冲突时**以事实为准，并在同一次改动里把文档改成事实**。不要写「勘误」「以前是…现在是…」。

代码刚起步，但优先级不因此改变：**涉及 DSH API 的结论必须回读 DSH 安装包**（见 [dsh-seams.md](docs/reference/dsh-seams.md)），不要信转述。

## 3. 现状

| 项 | 事实 | 依据 |
|---|---|---|
| 设计 | 已决议，写成文档 | `docs/` |
| 实现 | `packages/channel`（seam + driver-fake + 身份与权限判定）、`packages/driver-onebot11`（报文换算 + 反向 WS） | `packages/*/src` |
| 真实协议接入 | OneBot 11（NapCat 反向 WS）已在开发实例上跑通；其余协议未开始 | `packages/driver-onebot11/src` |
| 记忆 | 全局一份 SQLite（消息、事实、段落、画像、实体），`memory/md/` 是 git 可读的正文 | `packages/channel/src/store.ts` · `mirror.ts` |
| 契约类型包 | 只冻结了渠道层词汇表，其余未冻结 | [roadmap.md](docs/roadmap.md) |

**不要在本文件或 README 里写进度。** 进度只有一个家：[roadmap.md](docs/roadmap.md)。

## 4. 常用命令

```bash
python scripts/check_docs.py          # 文档自检，退出码 0 才算通过
pnpm test                             # 构建 + 跑全部测试（vitest）
pnpm run typecheck                    # 逐包类型检查
npx vitest run <spec> -t <名字>        # 只跑一条
node scripts/deploy.mjs --ssh <别名> --container <容器> --url <对外地址>   # 构建→打包→装进容器→重启→报地址
```

这是唯一一份命令块；其他文档只放指针。

## 5. 事实归属：改了什么 → 同步到哪

| 「事实」 | 唯一的家 |
|---|---|
| 层边界、bundle 名、依赖方向 | [reference/layering.md](docs/reference/layering.md) |
| DSH API 能否用、硬约束、原语落点 | [reference/dsh-seams.md](docs/reference/dsh-seams.md) |
| 事件模型 / 动作目录 / 账号与会话 / 降级 | [reference/contracts-channel.md](docs/reference/contracts-channel.md) |
| 人格目录、在场类型、身份与权限、凭据、发布器、控制台 | [reference/contracts-persona.md](docs/reference/contracts-persona.md) |
| 红线、风险判据、能力矩阵、默认参数、提交策略 | [reference/policies.md](docs/reference/policies.md) |
| 外部出处、调研登记、快照数字 | [reference/sources.md](docs/reference/sources.md) |
| 阶段、完成判据、当前进度 | [docs/roadmap.md](docs/roadmap.md) |
| 决策是否有效、有哪些待拍板 | [docs/adr/README.md](docs/adr/README.md) |
| 为什么这样设计 | `docs/explanation/` 下对应文档（一份一个主题） |
| 文档导航 | [docs/README.md](docs/README.md)（不建第二份索引） |
| 包与插件行的划分 | 各包的 `cordis.patch.yml`；为什么这么拆见最新一篇 ADR |

| 改了什么 | 同步到 |
|---|---|
| 新增 / 修改接口或字段 | 对应 `contracts-*.md`，并检查 `explanation/` 里的引用 |
| 调整阈值、默认值、判定条件 | [policies.md](docs/reference/policies.md)（数值只在这里） |
| 翻转或新增架构决策 | 先写 ADR，再改契约与解释；已冻结的被推翻要标 `superseded` |
| 阶段有进展 | [roadmap.md](docs/roadmap.md) 的状态列 |
| 引用新的生态数字 | [sources.md](docs/reference/sources.md) 的快照口径表（带测量日期与范围） |
| 任何文档改动 | 跑 `python scripts/check_docs.py` |

## 6. 写文档的规则

1. 一份文档一个 `#`；标题不跳级、不超过四级；代码围栏必须带语言。
2. 链接用相对路径，**禁止盘符绝对路径**。
3. 只写当前状态。不写变更日志、勘误、「以前是」、TODO 清单；历史交给 git。
4. 同一事实只写一处，其余放链接。
5. 不写无法从仓库验证的事实；必须保留时标「未核实」并写明缺什么依据。
6. 禁止占位内容 —— 篇幅必须对应信息量。
7. 每份文档开头写四行元信息：状态、日期、读者、上游材料。

## 7. 测试准入判据

一条测试必须能回答下面四问，答不上来就是覆盖率的装饰。

| # | 问题 | 反例 |
|---|---|---|
| 1 | **防的是哪一种用户可见的破损？** | 「这个函数应该被调用」—— 它被调用了，用户仍可能收不到回复 |
| 2 | **最小现场是什么？** | 要起十个插件才碰得到的分支，通常是设计问题，不是测试问题 |
| 3 | **更便宜的检查为什么抓不到？** | 类型系统能挡的、断言写进产品代码就能挡的，不写测试 |
| 4 | **它每天的成本，值它拦下的东西吗？** | 为「某个字段可能被写成 null」起三个进程跑十分钟；这条破损一年碰不到一次，测试却每次 CI 都跑 |

准入只有这四问。**「它可能被改坏」不是理由**：覆盖某一行、杀死某个变异，是变异测试的职责 —— 需要时明确跑一次并记下结论，不用日常测试堆出来。

**「概率低」也不是不写的理由**：一年一次但不可逆的破损（凭据泄漏、并发丢消息），一条便宜的守卫就该留。判断的是成本与收益，不是概率阈值。

还有一类不算守卫：**门禁式断言** —— 「代码里调用了某个函数」「文件里没出现某个字符串」「这个测试辅助函数行为如预期」。诚实的实现天然通过，绕开只要一行。它防君子不防小人，提供的不是安全性而是仪式感。要拦就拦在破损**可观测**的地方。

两条硬要求：

- **守卫必须能变红**：写完防回归测试，故意制造那个回归，看它变红再还原。没红过的守卫不是守卫。
- **测试跑 `dist`**：装载器真正加载的就是构建产物。跑 src 的话，「导出形状坏了」这类破损只能等线上发现。

## 8. 动手前必读

| 要做的事 | 先读 |
|---|---|
| 调任何 DSH API | [六条硬约束](docs/reference/dsh-seams.md#硬约束dsh-官方明文) |
| 写审批、权限、记忆写入 | [五条红线](docs/reference/policies.md#红线) |
| 改已决定的事 | [决策登记](docs/adr/README.md)，确认有没有被否决过 |
| 加一个文档 | [docs/README.md](docs/README.md) 的三步规则，默认折进已有文档 |

## 9. 禁止事项

1. **禁止新建 `00-x.md` 这类编号平铺文档** —— 用目录表达象限，不用文件名表达优先级。
2. **禁止为一次调研单独落一份长报告** —— 先压成结论，再决定折进哪份现有文档的哪一节。
3. **禁止在文档里写版本号、行数、当前进度、某函数怎么实现** —— 会漂。
4. **禁止只写一句「注意代码质量」「文档要写清楚」这类不可判的规则。**
5. **禁止删除文档前不确认独有内容已折入何处**（先查引用、再删）。
6. **禁止在 driver 里监听 `approval/request`** —— 红线 1，并装即冲突。
