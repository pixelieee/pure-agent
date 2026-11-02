# Pure Agent

一个独立工作的基本 Agent，同一核心用于 SDK 和终端入口。当前是可测试的早期原型，不是完整产品发布。

## 范围

- 单个会话内的模型 → 工具 → 观察 → 模型循环。
- 注入模型与工具；有界执行、可观察事件、协作式取消。
- SDK、CLI 和 Dark Deco 风格终端界面共用执行核心。
- 提供显式离线演示与 OpenAI 适配器；真实模式需要安全配置 API Key，已通过三轮真实项目资料交互测试（范围见 docs/live-test-results.json）。
- 不实现 Team、多 Agent 编排、后台调度或管理平台。

## 本地运行

需要 Node.js 24.2 或更高版本。运行 TypeScript 源文件不需要构建。

```sh
npm ci --ignore-scripts
node examples/basic.ts
node --test test/*.test.ts
node src/cli.ts --demo
node src/cli.ts --demo --prompt "整理这条演示笔记"
```

演示模型是确定性的测试替身，不具备自然语言推理能力。它用于检查真实执行循环、工具调用和界面；不要用演示输出判断模型效果。

## SDK

源码入口为 `src/index.ts`；构建后的安装包通过 `import { createAgent } from 'pure-agent'` 使用，并包含声明文件。注入 `Model` 和 `Tool`，完整可运行示例见源码包中的 `examples/basic.ts`。

模型适配器负责把提供商协议转换为 SDK 的消息格式。工具 Schema 声明参数结构，Ajv 在执行前强制校验；工具可额外提供业务校验，再执行操作。执行核心不导入 CLI、模型 SDK、数据库或第三方服务。

`run()` 返回 `completed`、`blocked`、`cancelled` 或 `limit`。其中 `completed` 只表示模型结束本轮工具循环，**不证明任务结果正确**。业务验收由调用方完成。

`messages` 返回独立快照。同一个 Agent 实例保留会话上下文，但不允许重叠运行。需要独立会话时创建新实例。

## 设计约束

只针对已经存在的职责建立边界：模型协议、工具执行、会话循环、终端交互。通过接口注入依赖，不为未来的组合功能创建空壳类或多层工厂。

核心不自动重试工具，防止重复写入等副作用。观察回调出错不会触发工具重跑。工具调用按顺序执行；取消后，未执行工具得到明确的取消结果，保持消息协议完整。

## 安全和已知边界

- `Tool.parameters` 使用同步 JSON Schema draft-07，注册时通过 Ajv 编译，执行前强制校验。不自动转换类型、插入默认值或删除多余字段；是否禁止额外字段由 Schema 决定。可选 `Tool.validate` 只增加业务约束，不能绕过 Schema，也不能修改待执行参数。
- 取消是协作式的。模型适配器与工具必须响应 `AbortSignal`；不响应的实现仍可能阻塞。取消不会撤销已经完成的外部操作。
- 核心不是沙箱。工具拥有宿主进程赋予的权限；不应直接把未审批的 shell、文件写入或账号操作暴露给模型。
- 暂无上下文压缩、持久化恢复、完整权限审批系统或自动重试；真实适配器限制每次输出与步骤，不提供账户级花费硬限额。
- API 密钥不要写入源码、提交到 Git 或输出到日志。真实联调前另行确认模型服务、凭据注入和调用预算。

## Build in public

公开小步实现、取舍与可复现证据，不把计划写成已交付能力。[路线图](docs/roadmap.md) 区分已合并主干、待合并 PR 与后续方向；[贡献指南](CONTRIBUTING.md) 说明验收和草稿 PR 流程。

先验证单 Agent 的任务完成质量，再补必要的工具与可靠性机制；多 Agent 组合放在基本单元成熟之后。公开进展不包含密钥、私人笔记或原始调用轨迹；这类本地材料放在忽略的 `.private/`，凭据优先由宿主注入。Git 忽略规则不是保密或访问控制机制。

## 当前验证

2026-11-02 状态快照：主干已合并初始化、显式配置、流式输出与 Windows 安装包验收。独立验收及 [双平台 CI](https://github.com/pixelieee/pure-agent/actions/runs/41493013469) 记录：Ubuntu、Windows 均通过 139 项离线测试及 1 项安装包测试；冷缓存安装包问题已修复。本文档更新未重新运行测试，后续状态以对应提交的检查为准。

终端已有交互输入、窄屏降级、重定向输出、取消后继续运行与退出的验证记录。真实模型记录只覆盖三轮限定项目资料交互与 Token 用量，不代表流式功能的真实模型验收、通用任务准确率或生产验收。

安装开发依赖后执行 `npm run check`。运行时复用 Ajv、string-width、官方 OpenAI SDK 和独立 Pi TUI 模块，安装使用锁文件；不把零依赖当作目标。

架构图见 `docs/architecture.png`，可编辑源文件为 `docs/architecture.dot`，矢量版本为 `docs/architecture.svg`。

## 定位

面向极客与开发者。公开 SDK 承载执行能力，CLI 不隐藏专属能力。配置、工具、模型与执行过程应可检查、可替换、可扩展。当前没有确定开源许可证，也没有发布 npm 包或部署服务。

## SDK / CLI 安装包验证

```sh
npm run check
npm run test:package
npm run build
npm pack --ignore-scripts
```

`test:package` 在临时目录安装本地 tarball，验证真实包入口、TypeScript 消费者和 CLI 可执行链接；没有发布到 npm，也没有调用模型 API。测试根据仓库 lockfile 的运行时依赖图和打包产物的 integrity 构造消费者 lockfile，使用 `npm ci --offline --ignore-scripts` 安装并核对依赖版本，不需要 registry 元数据（packument）。依赖 tarball 需要先通过上面的 `npm ci --ignore-scripts` 缓存；这一步可联网，之后的测试不调用模型。CI 每次使用全新缓存，避免本地热缓存掩盖缺失依赖。也可以在 POSIX shell 中从空缓存复现：

```bash
export npm_config_cache="$(mktemp -d)"
export npm_config_registry=https://registry.npmjs.org
npm ci --ignore-scripts
npm run check
npm run test:package
```

CI 配置包含 Ubuntu 和 Windows（Node.js 24），两者均执行完整离线检查与安装包验收；实际支持以对应提交的 runner 结果为准。包测试使用带空格的临时目录，通过 npm 的平台 CLI shim 执行多词 prompt。Windows 的文件/目录符号链接测试需要启用开发者模式或具有创建符号链接权限；权限不足会明确失败，不会跳过安全断言。

安装本地 tarball 后，SDK 入口为 `pure-agent`，CLI 命令为 `pure-agent --demo`。npm 包仅包含编译后的 JS/类型声明、README、Markdown 文档和 SVG；完整源码 ZIP 另含测试、DOT 和 PNG。

## 显式会话配置

真实模式可通过 `--config ./agent-config.json` 显式选择 JSON 配置；优先级为内置默认值 < 配置文件 < 显式 CLI 参数。配置不能包含密钥、替换端点或新增工具权限。字段、范围与失败行为见 [配置文档](docs/configuration.md)。

## 真实模型与只读项目工具

```sh
node --use-env-proxy --env-file=.env.local src/cli.ts --openai --reasoning low
```

密钥仅放本地忽略文件或由宿主注入，不能提交。CLI 默认 GPT-5.6 Luna、low；SDK 通过 `pure-agent/providers/openai` 导入适配器。当前适配器使用官方 OpenAI Responses SDK 流式接口，不自行解析 SSE；交互式 TUI 增量更新同一个 Markdown 块，管道输出仍仅显示完整回复。中断的局部文本会标记为未保存，不写入会话历史。每次回复默认最多 1024 输出 token（包括 reasoning），每轮 Agent 最多 4 个模型步骤。

当前 CLI 的真实模式只提供 `read_project_file`，允许 README、package.json、依赖决策和测试前基线四个指定文件；不提供任意文件读取、shell、写入或网络工具。SDK 可注入其他工具，但宿主必须负责授权和隔离。`/create` 只修改当前 Agent 指令，不动态生成工具。

模型续接数据作为 `providerData` 由适配器持有在消息中，核心仅复制保留；真实测试导出记录不包含它。`onUsage` 只回传数值用量，SDK 错误不回显请求头或密钥。

手动付费检查：`examples/live-project-check.ts`。结果快照见 `docs/live-test-results.json`；完整本地调用轨迹位于忽略的 artifacts 目录，不提交到 Git。终端截图是成功调用轨迹的明确标记回放；云桌面 GUI 进程直接联网仍有执行环境问题。

## 交互式 TUI

交互式终端使用独立 Pi TUI 库实现底部编辑区、Markdown、滚动与命令补全；`Ctrl+O` 展开工具详情，`Esc` 取消执行，`Ctrl+C` 在空闲时退出。`/new` 重置会话，`/create` 设置指令。重定向和管道仍输出普通文本。参考过程与验证范围见 `docs/tui-reference-study.md`。
