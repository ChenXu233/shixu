# 时煦 · shixu

> 时，日 + 寸 —— 时间。
> 煦，日 + 昫 —— 暖而不烫。
> **时煦：时间沉淀下来的那点温度。**

让一个人格，同时活在很多个聊天平台里。

DSH（DeepSeek Harness）的**渠道内核 + 人格引擎**：适配器把不同协议接进来（OneBot 11 / OneBot 12 / Satori / Milky / 原生 API），人格层让同一个「人」同时出现在多个群与私聊，共享同一份记忆，并且能连同记忆一起搬到另一台机器上。

## 现在是什么状态

**只有设计，没有代码。** 本仓库当前收录全量设计文档 [`docs/design.md`](./docs/design.md)（约 1200 行），路线图见其中 §6。

| 阶段 | 目标 | 状态 |
|---|---|---|
| P0 契约 | 事件模型 / 能力声明 / 动作目录 / 渠道提示词 / 账号与场所键 / capability token | 设计完成，待冻结为类型包 |
| P1 单协议跑通 | `dsh-channel-core` + `dsh-driver-onebot11` | 未开始 |
| P2 人格层 | 人格工作区 / 场所会话 / 控制台 / 记忆分层 / 权限校验 | 未开始 |
| P3 注意力与自主 | 在场集合 / 注意力预算 / 做梦与记忆版本化 | 未开始 |
| P4 扩张与迁移 | 多协议多平台 / 自我复制（配合 dsh-workspace-mesh） | 未开始 |

## 三层结构

```
L0  DSH Core          agent · session log · tools · systemPrompt · approval      （不改动）
L1  dsh-channel-core  统一事件模型 · 账号注册表 · 会话绑定 · 动作目录→工具 · 唯一审批应答者
L2  dsh-driver-*      每平台一份：OneBot 11 / OneBot 12 / Satori / Milky / 原生
L3  dsh-persona-*     人格工作区 · 在场集合 · 跨场所记忆 · 沙箱与发布 · 权限
L4  人格包            人设 · 配置 · 记忆 · 场景
```

## 它与已有方案的区别

- **不是「一个机器人接了很多平台」，是「一个人同时活在很多地方」。** 平台差异收敛成一份*动作目录*，人格差异收敛成*场所*与*分层记忆*。
- **适配器声明动作，工具自动生成。** 一份 `ActionDescriptor` 同时决定模型能做什么、能不能自主做、要不要人点头。
- **权限跟着消息走。** 每条入站消息带一枚服务端签名的 capability token，随该轮继承；模型说了什么永远不构成授权。
- **记忆是 git 仓库。** 可回滚、可分叉、可夜间整理（做梦）、可连同人格一起搬到新机器。

## 相关

- [dsh-workspace-mesh](https://github.com/ChenXu233/dsh-workspace-mesh) —— 跨机工作区网格；人格的「身体」与「搬家」能力由它提供。

## 许可

Apache-2.0，见 [LICENSE](./LICENSE) 与 [NOTICE](./NOTICE)。
