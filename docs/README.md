# 项目文档

[简体中文使用说明](../README.zh.md)介绍撤销入口与安装步骤。

## 实现

插件替换 `conversation.input.dock` 的 `queue` 条目，按原生 Inbox 投影渲染排队和等待插话的消息。
待发区使用宿主的 `conversation.chat.user.content` Factory 展示正文和附件。
撤销、编辑与插话调用会话的 `updateQueue`。
宿主在操作时按消息 ID 再查队列，撤销成功后客户端按投影更新。
宿主尚未提供队列 ID 时，排队回显显示「发送中」。

当前版本的聊天区待发气泡没有动作插槽。等待插话的消息也会在输入框上方显示一条可操作的预览。
插件停用后，`queue` 恢复内置条目。

## 验证

- `npm test` 构建运行入口并测试注册清理、队列去重、附件和错误输入。
- `npm run check` 检查测试、类型、构建产物以及运行版本。
- 从工作区根运行 `node tools/new-dsh-plugin/cli.mts --check plugins/dsh-undo-send` 校验插件骨架。
- 一次性 DSH profile 的 Chrome 对照验证覆盖排队编辑、单条撤销、等待插话、文件卡和模型请求。
- 1440 px 与 390 px 的页面均核对了按钮位置、点击和键盘焦点，390 px 使用触控模拟。
