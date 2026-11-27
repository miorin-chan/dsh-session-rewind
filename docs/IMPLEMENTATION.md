# 回退实现说明

产品行为与验收标准见[产品设计](../DESIGN.md)。
本页记录 DSH `0.2.2-rc.5` 的接口与实现边界。

## 接入宿主

插件仅使用 DSH 公开接口与插槽，不修改宿主源码。
执行遵循 `session/fork`、`session/create` 与 `workspace/archiveSession` 权限。

- Host 侧（`src/host/index.ts`、`src/lib/rewind-host.ts`）注入 `connection`、`attachments` 与 `sessionQuery`。
  Client 通过 `ctx.connection.fetch` 调用受鉴权的只读路由 `/api/dsh-session-rewind/prepare` 与
  `/api/dsh-session-rewind/file`，用于计算分叉边界、查询 `workspace/session-activity` 和读取普通附件。
- Client 侧的 `conversation.chat.user.before`（`priority: 100`）挂载按钮，`conversation.input.right` 提供附件注入入口，
  `shell.overlay` 挂载原生轻提示和活动确认弹窗。

## 会话与草稿

对于第 T 轮（T > 1），在第 T − 1 轮结束及后续独立会话事件之后、第 T 轮的入队或开始事件之前调用 `fork`，
传入 `increaseTitle: false`。
新会话保留后清除继承的待发队列。首轮没有可分叉的前置事件，改为以原 `agentPreset` 创建新会话，不调用手动重命名。
用 `whenDraftExists: 'replace'` 初始化文本草稿。
若原会话在工作区列表，先把新会话插到原会话正前方并同步置顶，再切换、归档；仅当前回合仍在运行时用 `stopActivity: true`。

## 附件

- 通过 `session.readAttachment` 读取已存储图片，保留 MIME 与原文件名。
- 普通文件路由校验所属会话、消息及附件索引后，用 `ctx.attachments.readFileStream` 读取原始字节，
  以 `application/octet-stream` 与原文件名构造文件。
- 切换并聚焦新会话后，将 `File[]` 按顺序注入输入框内隐藏的原生多文件控件，必要时回退到剪贴板粘贴链路。
