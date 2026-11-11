# Pure Agent 产品边界

## 交付目标

面向开发者的可用 agent：检查项目、搜索、修改文件、执行构建与测试、处理长进程、保存并恢复会话。SDK 和 CLI/TUI 使用同一套工具与执行语义。核心小意味着职责和依赖边界清楚，不意味着只读或能力少。

产品不提供 scripted demo 模式。模拟模型仅作为自动化测试夹具；离线测试通过不代表真实模型完成任务。

## 分层

- Core：模型与工具契约、Schema 校验、模型/工具循环、取消、事件、完整消息配对、可验证快照。
- Runtime：默认文件与进程工具组合、宿主授权、资源释放。
- Services：会话文件存储、进程管理、输出日志。
- Adapters：模型供应商、HTTP 获取、MCP 协议桥接。
- CLI/TUI：配置、工作目录、授权选择、会话操作、交互与显示。

网页与 MCP 可随产品提供，但不进入核心循环。MCP 复用官方客户端；网页搜索复用模型供应商的真实托管搜索。没有配置时不虚构可用能力。

## 本地执行边界

文件工具可以约束所选工作目录。任意 shell 命令仍使用宿主账号权限，可以接触工作目录外的文件和网络。trusted workspace 模式不等于操作系统沙箱。

SDK 的 `createDeveloperAgent` 默认允许已注册的工具，包括文件、进程和传入的扩展工具。宿主可选提供 `authorize` 策略；配置后只有回调明确返回布尔值 `true` 才放行，拒绝、非布尔值或异常不会回退到默认允许。需要全部拒绝的应用应显式传入 `authorize: () => false`。文件工具的工作区限制、参数校验和取消仍然生效；命令拥有宿主权限，这不是沙箱。底层 `createAgent` 和直接构造的工具行为不变。CLI 继续显式提供只读或信任工作区策略，无显式授权时不能静默启用写文件、执行命令或启动 MCP 子进程。恢复历史不恢复权限，也不重放已有副作用。

## 验收

1. 在实际临时项目中定位问题，运行真实失败测试，修改源文件，独立重跑并通过。
2. 精确编辑不匹配、重复匹配、重叠或过期时保持原文件不变。
3. 长任务可查询、输入、取消、释放；显示真实退出状态与截断标记。
4. 会话可保存、恢复；损坏、不兼容与未完成工具协议不可伪装成可用历史。
5. MCP 使用实际本地协议服务验证连接、发现、调用和关闭。Web 获取用实际本地 HTTP 测试，真实外网/托管搜索证据单独记录。
6. SDK 安装包与 CLI 实际运行；UT、IT、E2E、真实模型测试分别标注，不互相替代。
7. 非作者交叉验收，负责人检查最终代码、测试内容与 CI 后决定合并。

参考公开实现：
- [Pi tools](https://github.com/earendil-works/pi/tree/main/packages/coding-agent/src/core/tools)
- [Codex unified execution](https://github.com/openai/codex/tree/main/codex-rs/core/src/unified_exec)
- [OpenCode core tools](https://github.com/anomalyco/opencode/tree/dev/packages/core/src/tool)
- [MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)

此文定义产品目标和验收要求，不将未验收分支描述为已发布能力。
