# 自研与复用边界

目标是面向开发者的可控 Agent，不是零依赖展示项目。决策以实际源码和行为测试为依据。

## 当前采用

| 能力 | 选择 | 理由 |
| --- | --- | --- |
| 执行循环、状态、事件、取消策略 | 自有实现 | 这是产品的基本行为，需要清晰、可测试、可修改。 |
| 真实模型传输 | 官方 OpenAI SDK 7.47.0 + 薄 Responses 适配器 | 复用传输与协议处理，规范化输出、取消、截断和数值用量；不手写 SSE，也不把用量等同于费用硬限额。 |
| 参数校验 | Ajv 8.20.0，MIT | 复用成熟的 draft-07 实现，避免 Schema 与手写字段校验分叉。关闭 coercion/defaults/removal。 |
| 终端字符串宽度 | string-width 8.3.0，MIT | 不自行维护 CJK/emoji 宽度表。 |
| Unicode 字素分段 | Node Intl.Segmenter | 原生标准能力，不自行实现组合字符/ZWJ 分段。 |
| 安全终端文本 | node:util.stripVTControlCharacters + 明确控制字符过滤 | 字符宽度计算不等于终端注入防护。 |
| 终端编辑、滚动、Markdown、差分渲染 | 独立 @earendil-works/pi-tui 1.5.0，MIT | 本轮需要完整交互，直接复用成熟终端模块，不引入 coding-agent/agent-core。 |
| 主题、会话命令、工具视图 | 自有小型视图/控制器 | 保留 Dark Deco 的产品交互，与自身核心事件对接。 |

所有直接运行依赖固定版本，保留 lockfile。安装禁用 lifecycle scripts。此措施不等于完整供应链安全审计。

## 实测后没有采用

测试过 wrap-ansi 10.0.2：其换行实现使用 Intl.Segmenter，但会无条件把文本 NFC 标准化。开发者工具中的代码/结果应保留原始码点，不仅是视觉等价。最终使用 string-width 与 Intl.Segmenter 做一个小型换行适配器，并通过 NFD 文本精确保留测试。没有复制 wrap-ansi 实现。

## Pi 的尺度，不机械照搬

参考 [Pi 固定提交](https://github.com/earendil-works/pi/tree/e8504dfab5fb3aa023322a7e89b43c0eb49e6120)：

- 模型传输调用官方 OpenAI、Anthropic、Google、AWS SDK；自己规范化消息与事件。
- 终端使用 get-east-asian-width、Intl.Segmenter、marked，但自行实现键盘、布局与差分渲染。
- 当前 Schema/MCP 有自研实现。pi-schema 的当前初始版本很新，不能因为 Pi 使用就认定比成熟库更适合本项目。
- AI/Agent/Coding Agent/TUI 分开，不把完整产品框架当基础 Agent 的单一依赖。

## 等有实际需求再加入

- MCP：优先官方 TypeScript SDK，保留命名空间、Schema 校验和权限边界，不自己写 OAuth。

来源：[Ajv](https://github.com/ajv-validator/ajv)、[Ajv options](https://ajv.js.org/options.html)、[string-width](https://github.com/sindresorhus/string-width)、[wrap-ansi](https://github.com/chalk/wrap-ansi)、[MCP TypeScript SDK](https://github.com/modelcontextprotocol/typescript-sdk)。
