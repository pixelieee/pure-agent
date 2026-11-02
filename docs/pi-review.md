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

尚未采用 Pi 的完整消息与 usage/finish reason 协议、持久化会话、steering/follow-up 队列、上下文转换和扩展系统。终端渲染复用独立 pi-tui 库，不自行实现差分刷新。

当前 `Model.complete` 仍返回完整消息，并支持可选的第四个文本增量回调；核心通过 `assistant_delta` 事件转发增量，仅在最终回复验证成功后写入历史。OpenAI 适配器使用官方 Responses SDK 流式接口，保留不透明续接数据并验证完成状态、拒绝与截断，记录数字用量；未验证跨提供商兼容。TUI 更新单个 Markdown 块，保留草稿与手动滚动位置，中断时标记未保存的局部输出；管道输出仍仅呈现完整回复。

`onEvent` 是观察接口，不是授权接口。它的异常会被隔离，但异步回调必须及时结束；永不结束的回调仍会阻塞本轮运行。权限检查不应依赖观察回调。

没有复制 Pi 的源码。这里借鉴职责边界，保留自己的小规模实现和显式步数限制。
