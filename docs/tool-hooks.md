# 工具生命周期 hooks

核心 `AgentOptions` 和 `DeveloperAgentOptions` 支持 `beforeToolCall` / `afterToolCall`，类型 `ToolHooks`、`ToolCallContext`、`AfterToolCallContext` 从根入口和 `pure-agent/core` 导出。它们是宿主控制接口，原有 `onEvent` 仍只是不可控制执行的观察器。不新增插件总线、自动重试、参数重写、持久化或恢复。

```ts
const hooks: ToolHooks = {
  beforeToolCall(call) {
    if (call.name === 'write') return { block: true, reason: '本次只读' };
    return undefined;
  },
  afterToolCall(call) {
    // 可记录宿主审计，或显式返回 JSON 可序列化的结果替代值。
    // return { result: { summary: '已保存' } };
  },
};
```

## 顺序与权限

每个调用：查找工具 → JSON / Schema / 业务校验 → before hook → `tool_start` → `execute`（运行时授权仍在这里）→ 结果序列化 → after hook → `tool_end`。验证失败不调用 hooks。before 返回 `undefined` 继续；返回 `{ block: true, reason? }` 拒绝，抛错或无效返回值也阻止执行。before 抛错（包括读取返回值时抛错）仅公开固定 `beforeToolCall failed`，不保留任意异常文本。拒绝不会产生 `tool_start`，但仍有一个有序工具结果和 `tool_end`。`reason` 是宿主明确公开给模型的消息，不应含秘密。

before hook 不是授权替代物，不能绕过运行时 `authorize`、文件路径规则或工具自身审批。`tool_start` 表示准备进入执行，观察期间取消仍可阻止执行；它不声称副作用已经发生。只有真正调用过 `execute` 才运行 after hook，授权包装器抛出拒绝也属于调用过 `execute`，不表示底层工具执行过。

## 数据与失败

hooks 接收独立的 `{ id, name, args }`，`args` 是校验后数据的副本。after 的参数快照不会包含工具对参数的修改；`result` 是序列化后的 JSON 副本。变更这些对象不会重写待执行参数或原始结果。配置中的函数引用在 Agent 创建时捕获，后来替换 options 属性不改变已创建 Agent。调用 hooks 不绑定内部配置对象作为 `this`，不能通过接收者覆盖其他回调。

after 的 `outcome` 描述 `execute` 的返回路径：`returned`、`threw` 或 `serialization_error`，不是对外部副作用有无的判决。即使抛错也可能已写入文件。工具返回 `{ ok: false }` 而未抛错仍是 `returned`。

after 返回 `undefined` 保留原结果；返回 `{ result }` 替换模型可见的整个结果，不合并，也不能撤销执行过的副作用。替代值沿用工具结果的 JSON 序列化规则（顶层 null/undefined 归一为 null）。抛错、格式错误或序列化失败保留原结果，`tool_end.hookError` 固定为 `afterToolCall failed`，不暴露 hook 异常文本。它不是持久化审计字段；需要持久记录的宿主自行处理事件。after 替换可隐藏原错误或输出，因此只应交给可信宿主，不应让模型或第三方响应配置这些函数。

## 并发与取消

hooks、执行和结果处理都占用同一个并发槽；串行工具仍是屏障。`parallelSafe` 承诺必须覆盖 hooks、工具和授权回调的共享状态。并行安全调用的 hooks 可交错运行，不保证 before/after 按调用顺序执行；宿主负责安全并发，或保持 `maxToolConcurrency: 1`。最终工具结果始终按原调用顺序配对，观察回调仍串行。

取消不启动排队中的调用；before hook 返回后重新检查取消。已经进入的 hook/工具会被等待结算，不用竞速超时留下脱离运行的副作用。after 即使收到已取消 signal 也会调用，以处理实际执行结果。hooks 应及时响应 signal 并结算；永不结束的 hook 会阻塞运行。没有自动重试，hook 失败不重做工具。

## 参考与验证边界

参考 pinned [Pi agent-loop.ts](https://github.com/earendil-works/pi/blob/e8504dfab5fb3aa023322a7e89b43c0eb49e6120/packages/agent/src/agent-loop.ts) 的 prepare/execute/finalize 顺序与 [types.ts](https://github.com/earendil-works/pi/blob/e8504dfab5fb3aa023322a7e89b43c0eb49e6120/packages/agent/src/types.ts) 的 before veto / after override。未复制实现。Pure 故意在 after 失败时保留执行结果，而非用 hook 错误覆盖结果；并发策略也仍是有界且显式声明安全。

直接组件检查使用生产调度边界、真实临时文件与 shell 进程，覆盖校验、拒绝、隔离、替换、异常、取消、并发槽、运行时授权和文件路径边界。安装包检查编译消费者声明。没有模拟模型/HTTP 响应；真实 API 的模型→工具→下一轮链路、完整 SDK 装配和远端 CI 仍待单独验收，不能以组件通过代替。
