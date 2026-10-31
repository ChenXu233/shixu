# 沙箱与产物交付：它真的能把网页做出来

> **状态**：已决议
> **日期**：2026-10-31
> **读者**：写人格引擎沙箱、交付与发布链路的人
> **上游材料**：[人格引擎契约](../reference/contracts-persona.md)、[判据与默认值](../reference/policies.md#发布安全清单)
> **口径**：讲链路与边界；安全规则见判据页，类型见契约页

## 沙箱：目录隔离 + DSH 的进程沙箱

DSH 的 sandbox 子系统提供 `SandboxMode`：

- `read-only`：只允许必要 sink
- `workspace-write`：允许写 workspace root 与后端约定的临时区
- `danger-full-access`：不设防

后端：Linux bwrap / Landlock、macOS Seatbelt、**Windows ACL restricted-token**。它由 `dsh-bash-sandbox` / `dsh-pwsh-sandbox` 消费，即模型的 shell 与文件工具调用会被限制。

场所 session 的 cwd = `venues/<id>/scratch/` → workspace-write 沙箱只允许写自己的目录，天然隔离。目录布局见[人格工作区布局](../reference/contracts-persona.md#人格工作区布局)。

### 必须说清的三条边界

1. sandbox 只约束**模型的工具调用**（shell / 文件）；
2. **插件代码不受沙箱保护**（以宿主权限运行）→ 真正的权限边界仍然是「driver 能调用哪些平台动作」+ 沙箱模式；
3. `SandboxMode` 只管**文件系统效果**——「Network and process visibility are outside this vocabulary」→ 想要禁网 / 禁子进程得另想办法。

## 产物交付链路

```text
群友 A：@人格 帮我做个 XX 页面
  ↓ 渠道事件 → 场所 venue-A → 引擎唤醒 → followup
场所 agent 在 venues/A/scratch/ 里写文件（文件/终端工具，受 sandbox 约束）
  ↓ present / 工作区变更
deliverables（PresentedFile + WorkspaceChangesSummary）
  ↓ 渠道内核订阅 deliverables
driver.call('upload', …)   ← 需要 Capabilities.uploadFile 与对应动作
  ↓
群里发出：文本摘要 + 文件/图片
  ↓
归档 venues/A/artifacts/ + 写一条记忆（venue 或 public scope）→ 广播给其他在场场所
```

### 交付降级链（四档，按能力自动选）

| 档 | 方式 | 适用 | 代价 |
|---|---|---|---|
| 1 | 平台原生上传（QQ 群文件、Discord attachment、飞书文件） | 群里直接能看 | 受平台限制（群管理员权限、体积、类型） |
| 2 | **自有域名发布**（真 URL） | 网页 / 工具 / 长内容 | 需要发布管线 + 安全闸 |
| 3 | 局域网或本地链接 | 自己在同一网络 | 需要可达性（trusted-host / 端口） |
| 4 | 只发文本摘要，产物留在 DSH 控制台 | 平台啥都不支持 | 群里看不到东西 |

## 自有域名发布

发布属于**人格层（L3）**，与渠道无关 —— 渠道只负责把 URL 送出去，谁来托管由发布器决定。

`persona_deploy` 的四步，顺序不能换：

1. **路径消毒 + 凭据扫描 + 归档**（服务端强制，不靠提示词自觉）；
2. **公开 = 安全决策，必须人点头** —— `visibility === 'public'` 时走 `ctx.approval.request`；
3. **交给发布器换 URL**，并登记 `revoke` 句柄；
4. **记住这件事**（public scope）→ 其它场所也知道「我做过这个」。

### 托管方式的选择

实测 DSH 侧的约束：

- **DSH 自带的 `ctx.webServer` 是「浏览器 HTTP 载体」**，带 Host / Origin 信任模型，且属于 GUI 宿主进程 —— 拿它直接挂公网站点会被信任策略挡住，DSH 一停站点也就没了；
- 因此推荐**独立的静态服务进程**（在沙箱里起 `http.server` / `caddy file-server` / `node serve`），DSH 只做编排；公网可达用隧道或反代（Cloudflare tunnel 的现成实现可参考 `dsh-bridge`；或自建 VPS + Caddy / nginx 反代 + 泛解析域名）；
- DSH 的 `ctx.shell` / `ctx.subprocess` / jobs 子系统负责起与管理这些后台进程，`ctx.effect` 负责随插件卸载回收。

安全清单与默认可见性见[发布安全清单](../reference/policies.md#发布安全清单)和[默认参数](../reference/policies.md#默认参数)。

## 要在真实仓库里改代码时

用 worktree：DSH 有 `ctx.worktrees`（**实验性，官方 bundle 默认关闭**，需显式挂载 `dsh-experimental-worktree` + `dsh-experimental-tool-worktree`）。`create_worktree` 从调用 Session 的当前目录选源仓库，pin 本地 commit / branch / tag（缺省 HEAD），默认落在 `.agents/worktrees/`，且「调用 Session 现有的沙箱策略必须允许写目标目录与共享 git 管理目录」。

每个场所一个 worktree → 群 A 的改动不污染群 B，也不污染用户的项目目录；做完可整理成 patch 或 PR 交给用户。

> 实验性依赖，P2 先不用；P3 再作为「在真实仓库里干活」的可选能力。
