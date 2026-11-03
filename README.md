# Pure Agent

可组合的开发者 agent。简称 **pure**，CLI 主命令为 `pure`，保留 `pure-agent` 兼容别名。小核心，完整工具能力，代码与自然语言两种使用入口。

- **Core**：模型/工具循环、Schema 校验、事件、取消与可恢复会话快照。
- **SDK Runtime**：文件读写、精确编辑、项目搜索、命令与后台进程管理。
- **CLI/TUI**：共享 SDK 运行时，工作目录、权限模式、保存/恢复、流式输出。
- **扩展层**：HTTP 页面获取、OpenAI 托管搜索、官方 MCP 客户端桥接。

不提供 demo 模式。产品入口使用真实模型；自动化测试中的模拟模型只用于测试，不代表真实模型任务表现。

## 运行

需要 Node.js >=24.2。安装依赖后，使用环境变量提供自己的 OpenAI API Key，不要提交密钥。

```bash
npm ci --ignore-scripts
npm start -- --cwd ./your-project --trust-workspace
npm start -- --cwd ./your-project --read-only --prompt "介绍这个项目的入口和测试方式"
```

`--trust-workspace` 授予文件修改和宿主权限命令执行。**命令不是沙箱隔离的，可以访问工作目录外的文件与网络。** 交互启动时会询问；非交互必须明确选择 `--trust-workspace` 或 `--read-only`。

默认模型为 gpt-5.6-luna、low 思考。`--model`、`--reasoning`、`--max-steps`、`--max-output-tokens` 可覆盖设置；实际费用和模型能力由供应商决定。工具错误、限制和取消不会被包装成成功。

```bash
npm start -- --cwd ./your-project --trust-workspace --session .pure-agent/session.json
npm start -- --cwd ./your-project --read-only --resume .pure-agent/session.json
npm start -- --cwd ./your-project --read-only --web-search --web-fetch
npm start -- --cwd ./your-project --trust-workspace --mcp-config /path/to/servers.json
```

会话文件包含对话、项目内容和工具结果，未加密，应保持私有。会话路径相对于 `--cwd`。恢复不会重放已有工具副作用，也不会恢复旧权限或已经结束的进程。

MCP 配置必须显式指定，格式为 `{ "servers": [...] }`。每个 server 必须有 `namespace` 和 `transport`。stdio 使用 `command`、可选 `args/cwd/env`；HTTP 使用精确 `url` 和可选 `headers`。配置可能含凭据，不要提交。连接持续到 CLI 退出；`/new` 不会重置外部 MCP 服务器状态。

## 默认工具

| 能力 | 工具 | 行为 |
| --- | --- | --- |
| 文件 | read / write / edit | 分页 UTF-8 读取、原子写入、唯一精确替换、可选内容哈希前置条件 |
| 项目搜索 | grep / find / ls | gitignore 与 glob、隐藏项目文件、稳定输出和截断标识 |
| 命令 | exec_command | 真实退出码、超时、取消、stdout/stderr 与日志 |
| 后台进程 | start_process / process_status / read_process / write_process / kill_process | 会话所有权、增量输出、输入、终止与清理 |
| 网页 | web_fetch（显式开启） | 公网静态文本/HTML 获取，来源、大小限制、重定向校验 |
| 搜索 | OpenAI hosted web_search（显式开启） | 实际供应商搜索与来源引用；可能产生额外费用 |
| MCP | 显式配置服务器的命名空间工具 | 官方协议连接、发现、调用、取消和关闭 |

文件工具限制工作目录，支持目录内安全符号链接。搜索/编辑不是二进制文件编辑器。进程目前使用 pipes，不是 PTY。POSIX 进程组无法阻止主动脱离进程组的程序；Windows 清理能力以实际平台验收为准，不能据此宣称安全沙箱。

Web 获取不执行 JavaScript，不登录、不自动发送凭据，不是浏览器。MCP 图片/音频/资源内容会明确报告当前表示限制；工具列表变化需要重新连接。取消远端调用不保证回滚远端副作用。

## SDK

安装包导出分离入口，让应用按需组合能力：

```ts
import { createAgent } from 'pure-agent/core';
import { createDeveloperAgent } from 'pure-agent/runtime';
import { createOpenAIModel } from 'pure-agent/providers/openai';

const runtime = createDeveloperAgent({
  model: createOpenAIModel({ apiKey: process.env.OPENAI_API_KEY, model: 'gpt-5.6-luna', reasoningEffort: 'low' }),
  root: process.cwd(),
  // 宿主明确授予能力；生产应用可以替换成自己的批准流程。
  authorize: async () => true,
});
try {
  const result = await runtime.agent.run('检查项目测试，定位并修复失败，然后重新验证。');
  console.log(result);
} finally {
  await runtime.dispose();
}
```

`createAgent` 接受任意实现通用契约的模型和工具，不依赖特定供应商、MCP 或 TUI。独立模块还包括 `pure-agent/session`、`pure-agent/tools/filesystem`、`pure-agent/tools/process`、`pure-agent/extensions/web`、`pure-agent/extensions/mcp`。

## 检查与验收

```bash
npm run check
npm run test:package
```

UT、IT、安装包 E2E 使用实际文件/子进程/本地协议服务和明确标注的模型测试夹具，不需要 API Key。真实模型运行须单独执行并保存脱敏证据；历史结果不代表当前所有能力已通过真实模型验收。

main 已设置分支保护：PR 合入、必需 `Offline acceptance gate`、禁止强推和删除，管理员也不可绕过。Windows/Ubuntu 的必需检查任一失败、取消或跳过，汇总门禁不会放行。独立交叉验收后由负责人决定合并。

- [产品边界与验收要求](docs/product-boundaries.md)
- [开发者工具真实模型验收](docs/developer-live-acceptance.md)
- [历史只读原型运行证据](docs/live-acceptance.md)
- [参与贡献](CONTRIBUTING.md)

这是持续开发中的产品。具体支持范围与限制以上述实现和对应版本验收为准，不把未实现或未验证能力标成已完成。
