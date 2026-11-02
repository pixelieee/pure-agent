# Pi 源码对照

审查版本：[earendil-works/pi @ e8504df](https://github.com/earendil-works/pi/tree/e8504dfab5fb3aa023322a7e89b43c0eb49e6120)。这是源码阅读，不表示运行过 Pi 测试。

## 已采用的原则

- Agent 执行与终端显示分离，CLI 作为装配入口。
- 模型适配器只接收工具声明，不接收可执行回调。
- 用可区分联合类型描述事件，避免 UI 猜测字段。
- 工具运行前必须验证参数。Pure Agent 使用成熟的 Ajv 做强制 Schema 校验，可选 validator 只承担额外的业务约束。

参考源码：

- [SDK 装配](https://github.com/earendil-works/pi/blob/e8504dfab5fb3aa023322a7e89b43c0eb49e6120/packages/coding-agent/src/core/sdk.ts)
- [执行循环](https://github.com/earendil-works/pi/blob/e8504dfab5fb3aa023322a7e89b43c0eb49e6120/packages/agent/src/agent-loop.ts)
- [事件与状态类型](https://github.com/earendil-works/pi/blob/e8504dfab5fb3aa023322a7e89b43c0eb49e6120/packages/agent/src/types.ts)
- [终端组件接口](https://github.com/earendil-works/pi/blob/e8504dfab5fb3aa023322a7e89b43c0eb49e6120/packages/tui/src/tui.ts)

## 尚未采用

Pi 的流式消息、usage/finish reason、持久化会话、steering/follow-up 队列、上下文转换、扩展系统和差分终端渲染没有在当前原型中实现。

当前 `Model.complete` 是完整消息接口，归一化消息格式仍接近 Chat Completions。OpenAI 适配器实际使用 Responses，保留不透明续接数据并验证完成状态、拒绝与截断，记录数字用量；没有验证跨提供商兼容，也没有实现流式输出。

`onEvent` 是观察接口，不是授权接口。它的异常会被隔离，但异步回调必须及时结束；永不结束的回调仍会阻塞本轮运行。权限检查不应依赖观察回调。

没有复制 Pi 的源码。这里借鉴职责边界，保留自己的小规模实现和显式步数限制。
