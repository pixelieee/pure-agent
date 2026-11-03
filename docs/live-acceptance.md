> 历史记录：本页描述最初只读原型的验收。当前能力见 README；新验收说明见 developer-live-acceptance.md。下方历史脚本路径用于定位当时版本，不再作为当前运行入口。

# 当前验收记录 — 2026-11-02

## 离线门禁

PR #11 合并后的主干提交为 `eb054fed081bf06328f9b3f736498d74159967f4`，源码树为
`04197218ddaf848fa3073a0f5b6ff33b081cbd6a`。
[CI run 41502935573](https://github.com/pixelieee/pure-agent/actions/runs/41502935573)
中，Ubuntu、Windows 各通过 170 项离线测试和 2 项安装包测试，`Offline acceptance gate` 通过。
Biome 2.6.4 只读格式 / 推荐 lint、TypeScript 检查和构建已纳入门禁，并有负向回归测试；这不证明 GitHub 分支保护已配置。

## 真实模型：两次独立记录

两次均使用官方 OpenAI Responses 适配器、`gpt-5.6-luna`、`low` reasoning；每次请求最多 512 个 completion tokens，每轮最多 4 步，共三轮。宿主显式注入 `createWorkspaceFileTool`，仅允许读取项目根目录的 `package.json`、`README.md`，读取上限 24,576 字节。

### 18:40 原始手动脚本

- 完成时间：`2026-11-02T18:40:17.395Z`。
- 源码树：`63a773b406c9f022c03395c48a6cd7d66bf42b2a`，早于后续仅测试相关的门禁回归改动，不是可移植示例的运行记录。
- 三轮完成，共 5 步、2 次工具开始事件、5 次 usage 回调；流式片段为 17 / 29 / 39，共 85。
- 汇总用量：input 8,782、output 148、cached input 3,514、reasoning 9。
- 三轮答案经独立语义复核正确。但只留存工具开始事件和汇总用量，未留存工具结果及逐次 usage，不能追溯补证。

安全记录保留于 `artifacts/live-acceptance-current.json`，这里只发布摘要。

### 19:01 可移植示例

- 实际运行：`examples/live-workspace-check.mjs`，完成时间 `2026-11-02T19:01:03.474Z`。
- 提交：`f0088697bb6ce331636dfb1ed4f265d26d5eeb2f`；源码树：`8b53efc75e0d25c9fe025c9614f9d29150b0c680`。
- 脚本 SHA-256：`c6ffa365fa40166ef6455b789245c7171b401d831b760adf4741e6bfe38975cd`，可与该提交中的脚本核对。
- 三轮完成，共 5 步、5 次 usage 回调、2 次工具调用及结果；流式片段为 17 / 28 / 35，共 80。
- 逐次 usage 已留存，可重算为 input 8,923、output 144、cached input 3,579、reasoning 10。
- 留存的真实工具结果未经截断，独立复核确认与所读文件相符，三轮答案语义正确：第一轮准确复述 `scripts.check`；第二轮正确说明宿主显式注入与默认 CLI 权限不变；第三轮复用上下文、没有工具调用，用 50 个字符区分离线检查与模型效果 / 生产验收。

安全记录保留于 `artifacts/live-workspace-1793646063474.json`。只发布上述摘要，不提交原始工具内容或模型响应。自动检查全部通过，但字符串包含检查弱于对实际文件、工具结果和答案的人工语义复核。

### 证据边界

cached input、reasoning 分别是输入、输出的子集，不应再次加到总量。usage 回调不是 HTTP 抓包，两次都没有 HTTP 线级证据；SDK 流式增量不等于 GUI / 终端视觉验收。三道限定问题不能证明通用任务准确率、生产就绪、账户级花费上限或所有平台的真实模型支持。源码树只标识相应记录，不自动覆盖后续改动。历史 93 项测试基线及 `live-test-results.json` 均保持不变。

## 可选手动复现（付费，不加入 CI）

需要 Node.js >=24.2。先确认模型可用、调用授权和预算，再使用自己明确指定、位于仓库外的私有环境文件：

```sh
npm ci --ignore-scripts
node --env-file=/absolute/path/to/your-private.env examples/live-developer-check.mjs
```

环境文件仅提供 `OPENAI_API_KEY`；不要将其内容贴入日志、问题、源码或聊天。脚本不自动寻找环境文件，固定使用上述官方服务、模型及限制，不提供端点覆盖。三轮 × 四步约束请求次数，不是账户花费硬限额；重跑会产生新用量，不添加自动重试或 CI 真实调用。

工作区根目录由脚本位置确定，不依赖 shell 当前目录。Git 元数据可缺省，源码压缩包也可运行；`sourceTree` 记录 HEAD 的提交树，不能证明工作区没有未提交改动。报告留存脚本哈希、白名单数值用量、脱敏后的公开工具结果和逐轮答案，不导出 `providerData`、请求头、密钥或原始 SDK 异常；异常使用固定消息。

运行前检查两份公开文件的内容，分享前审阅报告。脱敏只移除注入的密钥，不是扫描公开文件中任意意外秘密的通用工具。报告以独占创建方式写入新的 `artifacts/live-workspace-<timestamp>.json`，请求权限 `0600`（平台权限语义可能不同），不会覆盖历史记录。

未设置 `OPENAI_API_KEY` 时，脚本在加载 provider 和请求 API 前以状态 1 退出；已验证此离线 smoke，但它本身不代表模型验收。
