# 项目文档

[简体中文使用说明](../README.zh.md) · [English README](../README.md) · [产品与实现设计](../DESIGN.md)

## 架构概览

- **Host 侧（`src/host/index.ts`、`src/lib/rewind-host.ts`）**：注入 `connection`、`attachments` 与 `sessionQuery`，
  通过 `ctx.connection.fetch` 暴露受鉴权只读路由 `/api/dsh-session-rewind/prepare` 与 `/api/dsh-session-rewind/file`，
  用于计算精确分叉边界、查询 `workspace/session-activity`，
  并在校验消息归属与索引后通过 `ctx.attachments.readFileStream` 流式读取普通文件附件。
- **Client 侧（`src/client/`）**：
  - `conversation.chat.user.before`（`priority: 100`）：为持久化普通用户消息在原生复制按钮左侧挂载回退图标按钮，
    复用原生操作行样式，排除 `steering`、局部发送回显、子代理会话与已归档会话。
  - `conversation.input.right`：在切换并聚焦新会话的输入框卡片后，
    将恢复的图片与普通文件 `File[]` 注入原生多文件控件（必要时回退剪贴板粘贴），复用宿主预览与上传链路。
  - `shell.overlay`：渲染带一键 **取消归档** 的原生 Toast，以及仅在存在非回合活跃工作或归档被拒时显示的原生确认框。

## 验证

- `npm test`：构建 `index.js`、`client.js`、`lib/rewind-host.js` 与工具脚本，
  并运行 `test/host.test.mts` 和 `test/client.test.mts` 全部单元测试。
- `npm run check`：校验工具脚本构建、单元测试、TypeScript 类型、本地构建产物与 DSH 类型同步。
- 工作区根目录下 `node tools/new-dsh-plugin/cli.mts --check plugins/dsh-session-rewind`：
  校验清单、本地化字典与插件骨架完整性。

## 验证记录

2026-11-24 在 DSH `0.2.2-rc.5` 一次性 Web profile 与真实 Chrome（CDP）下完成端到端验收：

- **非首轮多媒体回退与重发**：第 2 轮同时携带文本、图片与通用 `.txt` 文件；点击回退后 Toast 弹出并显示 **取消归档**，
  新会话仅保留第 1 轮，输入框恢复原文本、图片预览与就绪的 `.txt` 文件卡片；编辑后重发，
  回环模型请求完整收到第 1 轮历史、修改后文本、规范化图片与一致 sha256 字节的 `.txt` 文件句柄。
- **一键取消归档**：点击 Toast 中的取消归档按钮后，原会话立即恢复并重新打开，原有对话内容保持完整。
- **首轮纯附件回退**：仅有图片附件的第 1 轮回退后，在同一工作区打开新空白会话并恢复图片附件，原首轮会话被归档。
- **流式生成中回退**：第 2 轮处于流式输出阶段点击回退，无确认弹窗阻断，
  立即切换到保留第 1 轮的新会话并将第 2 轮正文放回输入框，原会话停止并归档；浅/深色下回退图标与复制按钮尺寸、
  圆角及对齐一致，页面全程无 console 或未捕获异常。
