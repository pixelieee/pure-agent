# TUI 参考与实现

## 实际安装与观察

2026-11-02，在独立目录、独立 HOME/XDG 配置和空工作区中安装并运行：

| 产品 | 版本 | 实际观察范围 |
| --- | --- | --- |
| OpenCode | 2.2.5，`@opencode/cli` | 输入区、slash 菜单、模型选择弹窗、退出行为；未提交推理任务。 |
| Pi | 1.5.0，`@earendil-works/pi-coding-agent` | 编辑区、状态栏、命令补全、设置、本地命令与取消；无模型凭据。 |
| Codex CLI | 0.166.0 | 启动与登录选择；登录后的编辑/对话能力仅参考公开源码和文档。 |
| Claude Code | 2.1.316 | 启动、主题与 diff 预览、登录选择、退出；不使用泄漏源码。 |

没有向参考工具配置项目 API Key，也没有通过它们发起付费推理。

来源：[OpenCode](https://opencode.ai/v2/docs)、[Pi](https://pi.dev)、[Codex CLI](https://learn.chatgpt.com/docs/codex/cli)、[Claude Code](https://code.claude.com/docs/en/interactive-mode)。

## 采用的实现边界

复用 `@earendil-works/pi-tui@1.5.0` 的独立终端库：Editor、Markdown、ScrollView、布局及差分渲染。不引入 Pi 的 coding-agent、认证或 agent-core。初版只需要字符宽度时不引入完整 TUI；现在需要成熟编辑器、滚动和交互，复用独立 TUI 库更合适。

Pure Agent 自己负责主题、会话命令、消息/工具视图，以及与自身 Agent 事件协议的适配。

- Controller 依赖 `SessionView`；TUI 依赖小型 `SessionActions` 接口。
- SDK 核心及模型适配器不导入终端模块。
- 只有交互式 TTY 启用完整 TUI；重定向和管道保留普通文本输出。
- 命令补全只枚举注册命令，不借用会自动扫描文件系统的通用补全器。

## 本轮改动

1. 消息区：移除重复大框，Markdown 正文与用户输入分层。
2. 工具区：默认显示紧凑摘要，Ctrl+O 展开；文件正文以真实换行显示，错误有明显提示。
3. 输入区：固定在底部，复用多行编辑、历史、粘贴、撤销和 Unicode 字素处理。
4. 状态区：原位显示工作/取消/完成；保留模型、快捷键与离线回放标记。
5. 会话：`/new`、`/create` 同时重置模型历史和可见历史，避免两者不一致。
6. 安全：工具 JSON 解码之后再清理控制字符；显示截断不修改模型收到的证据。

## 验证边界

108 项离线测试、类型检查、构建和独立安装包 smoke test 通过。新增真实 Pi 输入/渲染集成测试覆盖多行草稿、粘贴、emoji、历史、命令菜单、取消、窄屏与长草稿 resize。父流程也在原生终端观察了命令菜单、展开/折叠和固定输入区。

截图展示的是早先成功的真实 API 调用记录，在新版 TUI 中明确标记为离线回放；没有为了视觉迭代重复消费模型额度。当前仍未完成 Windows/macOS 实机验收，也没有因此宣称完整可访问性合规或生产任务质量通过。
