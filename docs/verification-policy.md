# 当前验证规则与 CI 迁移

本页优先于旧 README、贡献指南和历史报告中的验收命令。禁止执行模拟模型响应测试，包括 HTTP 模型替身；禁止把组件检查或旧 CI 结果当作真实 API 验收。本轮仅使用 Linux，不运行 Windows 验收。

## 明确允许的组件检查

```sh
npm ci --ignore-scripts
npm run check:static
npm run test:nonmodel
npm run test:package:nonmodel
```

首次安装需要依赖源访问；已有完整 npm 缓存时可用 `npm ci --offline --ignore-scripts`。缓存路径通过 `npm_config_cache` 指定，不改变锁定依赖或生命周期限制。

- `check:static`：完整现有 Biome 质量范围、严格类型检查和构建。扫描历史测试源码但不执行它们；不放宽规则。
- `test:nonmodel`：固定列表仅含原有 `test/filesystem.test.ts` 、`test/verification-entrypoints.test.mjs` 、`test/snapshot-data-validation.test.ts` 和 `test/context-projection-data.test.ts`，没有通配符。前者直接调用真实文件工具、临时文件和搜索 worker，依赖 schema、filesystem-internal、filesystem-search，不创建 agent 或模型；原有断言不变。入口测试先核对默认命令及前后置钩子，再检查明确拒绝入口。快照测试仅把持久化数据传给真实校验函数，不构造 agent 或模型，不执行模型循环。投影测试只检查同一生产快照校验契约和独立回调类型，不调用 agent 或模型；真实循环中的投影顺序、取消和观察器隔离仍待真实 API 验证。
- `test:package:nonmodel`：构建并打包，独立 consumer 按锁文件运行时依赖图执行 `npm ci --offline --ignore-scripts`，核对版本、真实导出导入、消费者类型声明编译和两个 CLI 的 `--help`。不实例化或调用模型；类型探针只编译不执行。缓存缺失、安装失败或超时即失败。

这只是有限的文件工具、安装、入口和类型检查，不是完整 UT/IT/E2E、模型协议、任务执行或真实 API 验收。扩大列表前必须审查文件及传递依赖；不能为了提高数量加入模型替身。

`npm test`、`npm run check`、`npm run test:package` 只运行明确拒绝入口，退出码为 1，不自动运行组件检查或真实 API。历史测试文件和断言原样保留供审阅，直接执行历史模型套件仍被禁止。

## Linux 工作流

`.github/workflows/ci.yml` 仅在 Ubuntu 上执行上述三个明确检查命令，不配置模型凭据或调用真实 API。工作流名称为 `Linux non-model checks`，检查名称为 `Node 24 / Linux non-model components` 和 `Linux non-model checks gate`。门禁只接受组件作业成功，不把失败、取消或跳过当作通过。依赖下载与工具链设置可访问网络，不表示整个 CI 断网。

本地通过不能标为远端 CI 通过；远端结果须关联实际 head/merge SHA。新组件门禁不代表完整验收，更不满足旧 `Offline acceptance gate` 的同名保护要求。

## 安全发布顺序

GitHub 从事件关联的 SHA/ref 选择工作流；`push` 使用推送后的 tip，普通 `pull_request` 使用 PR merge ref。因此，发布已包含安全工作流的新分支不必先全局禁用旧工作流，但必须满足以下条件：

1. 发布前重新读取目标主干 SHA 和完整工作流目录，核对安全候选的工作流、npm 脚本与传递调用。检查主干是否新增 `pull_request_target`、`create`、`workflow_run` 或其他可能启动旧路径的监听器。若主干变化，重新审查预期合并树，不能依赖旧结论。
2. 只把新分支直接建立在已审阅的安全 tip；不得先从旧主干创建远端分支，再逐步补安全改动。通过 Git Data 上传对象时，先生成并验证安全树/提交，再暴露分支 ref；不要把中间不安全提交作为远端 tip。
3. 发布后读回实际分支 SHA、工作流和脚本，检查 push 作业；开 Draft PR 前再核对主干未变化。PR 创建后读取实际 merge ref/tree、head/base SHA 和工作流作业，确认都使用安全路径。Draft 状态本身不会禁止 CI。
4. 不重跑旧提交，不更新、重开或重定向仍带旧工作流的 PR，不顺手删除旧分支。分支删除的 push 事件可能回到默认分支定义。并发修改与外部自动化需要另行核对。

发布 Draft 不等于批准合并。主干若要求 `Offline acceptance gate`，新名称不会满足它；保留阻塞，不伪造旧门禁。变更保护、禁用工作流、取消已有运行、合并或部署都需要另行授权。只读观察到的队列状态不是未来不会触发旧运行的保证。

依据：[工作流按事件 ref 选择](https://docs.github.com/en/actions/concepts/workflows-and-actions/workflows#workflow-triggers)、[push 事件](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#push)、[pull_request 事件](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#pull_request)。

## 真实 API 验收仍待完成

本 CI 前置改动不新增或执行真实 API 验收入口，不包含后续产品分支能力。真实验收必须单独使用生产 provider、安全凭据、明确服务及费用范围、有限模型步数/输出/时限，并检查真实工具调用和可观察结果，不能仅凭 `completed` 判定。

凭据不得写入源码、命令参数、报告或聊天。不保存原始请求、响应或私密会话；报告仅保留脱敏状态、提交与数值用量。无有效凭据、权限、额度或网络时报告具体阻塞，不改用模拟响应，也不把静态/组件检查计为 API 通过。
