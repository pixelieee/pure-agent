# 当前运行时的真实 API 读取验收

此入口是等待有效凭据后的验收工具，**不是本次真实 API 已通过的声明**。没有使用模拟模型、预设模型输出、HTTP 替身或历史会话回放。旧密钥的 401 不能用预检成功替代；安全配置有效凭据后才执行真实运行。

## 无模型预检

需要 Node.js >=24.2。帮助和预检仅使用 Node 内置模块；真实运行和项目检查需要项目依赖。以下命令不读取密钥文件，不构造模型或运行时，也不发起网络请求：

```sh
node examples/live-read-acceptance.ts --help
node examples/live-read-acceptance.ts --preflight
npm run test:nonmodel
```

预检只验证参数和运行门槛，不验证凭据、模型权限、网络或 API。`--preflight` 返回零退出码时，JSON 中仍为 `passed:false`、`liveAttempted:false`、`code:"LIVE_PREFLIGHT_ONLY"`。无模式时返回 `LIVE_RUN_REQUIRED` 和退出码 2；模式冲突或无效参数也返回退出码 2。

定向测试只运行参数解析与预检。子进程在没有生产模块和依赖的临时目录中执行独立脚本副本，成功的帮助/预检因此无法越过动态导入门槛；没有创建或拦截模型请求。测试子进程不继承宿主密钥或 Node 预加载配置。

## 真实运行命令（尚待执行）

先通过安全方式配置有效 `OPENAI_API_KEY`，不要把密钥写进命令、聊天或报告。凭据文件入口沿用[显式凭据解析器](credentials.md)，仅提取 `OPENAI_API_KEY`，不加载 `NODE_OPTIONS`、端点、代理等设置；进程环境优先。以下是实际命令，文件路径需替换为私有文件的位置：

```sh
node examples/live-read-acceptance.ts --run --credentials-file /private/location/pure.env
```

已安全配置进程环境时：

```sh
node examples/live-read-acceptance.ts --run
```

真实运行使用上面的直接 `node` 命令，避免 npm 的脚本回显把私有文件路径写入终端或捕获日志。只有 `--run` 才允许读取凭据和调用真实 API。调用可能产生费用；这是步数和 token 限制，**不是美元金额硬上限**。默认沿用生产 provider 的 `gpt-5.6-luna`，low 思考；需明确选择其他已授权模型时使用 `--model <model>`，不自动切换模型。真实执行应由已获得对应 API/费用授权的操作者发起。

- 使用当前 `src/providers/openai.ts` 的 `createOpenAIModel` 与 `src/developer-agent.ts` 的 `createDeveloperAgent`，无注入 client/model，沿用生产 Responses API 流式路径。
- provider 固定 `https://api.openai.com/v1`，SDK 日志关闭，`store:false`；凭据文件不允许重定向端点。没有启用 hosted web search、Web 或 MCP。
- 最多 **3 个模型步骤**，每步最多 **1,024 输出 tokens**（含推理），最多 **3,072 输出 tokens**。输入包括生产运行时的工具定义和前序历史，也会计费；本工具不设置总输入 tokens 或金额上限。
- 整次运行 **60 秒协作式取消期限**，生产 provider 单次请求超时 **30 秒**；SDK 和 harness 均不自动重试。截止、取消或认证/额度失败不会换密钥、换模型或再次调用 API。取消不能保证服务端不计费；清理耗时不承诺在 60 秒内结束。
- 只允许 **一次 read**，目标是新建临时目录内的固定合成文件。任何其他工具、路径、重复读取或非首行分页请求都会拒绝并取消。无 shell、写入、外部目录读取、业务源码或用户材料访问。

## 验收证据与隐私边界

宿主用加密随机数生成 192-bit nonce，仅写入新建的临时文件；任务提示不含 nonce。成功必须同时满足：

1. 生产 `read` 工具确实执行一次，结果的相对路径、完整内容、SHA-256、字节数、行列和未截断标识匹配实际文件。
2. 运行状态为 completed，最终答案（去除首尾空白）精确匹配文件中的 nonce 与要求前缀，不能只检查状态或工具名。
3. 宿主独立重读确认文件未改变，没有越权工具请求，收到至少两次且与模型步骤相等的有效数字 usage 回调。
4. 释放运行时并删除本次创建的临时工作区。清理失败不记为通过。

只输出一份 JSON 摘要，其值仅包含固定代码、布尔值和数字，包括各项断言、模型步骤与 usage 数值。`liveAttempted` 只代表进入模型调用，不证明服务端收到请求；usage 回调次数不是独立抓取的 HTTP 请求数或账单。错误使用精确固定白名单，不回显任意异常文本。

不输出或持久化 API Key、凭据路径、私有目录、nonce、提示词、完整响应、工具原文或会话快照。不创建验收报告文件；如需保留，只保存这份脱敏 JSON。API 仍会收到合成提示、合成工具结果和生产工具定义。进程内凭据与模型历史不等于加密保险库；需要可信宿主和运行环境。

真实验收成功的唯一摘要标志是 `code:"LIVE_ACCEPTANCE_PASSED"`、`passed:true` 且退出码 0。其他真实运行退出码为 1，可能已有计费调用。此验收只覆盖当前 provider → runtime → 实际 read → 最终答案链路，不证明写入、进程、CLI/TUI、MCP、Web、Windows 或任意开发任务已通过。

当前 Linux 无模型工作流执行 `npm run check:static`、固定文件列表的 `npm run test:nonmodel`（包含本入口的三项预检测试）和 `npm run test:package:nonmodel`，不构造模型或调用 API。旧 `npm test`、`npm run check`、`npm run test:package` 已明确拒绝执行；历史模型测试仍禁止直接运行。组件检查和 CI 结果均不能作为真实 API 通过证据，详见[验证政策](verification-policy.md)。

真实 API 验收仍等待安全导入有效密钥后单独执行。脚本失败必须报告阻塞，不使用模型响应替身、不自动重试、不泄露凭据或任意异常内容。本入口仅覆盖基本读取，不包含项目上下文投影验收。
