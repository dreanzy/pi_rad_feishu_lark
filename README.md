# pi-feishu-extension

Feishu/Lark bridge for the new Pi as a Pi extension package.

## Features / 功能

- Pi extension, not a standalone bot / 作为 Pi 扩展运行，不是独立机器人程序
- `/feishu setup` bilingual setup wizard / 中英双语引导配置
- QR-code app creation via Lark SDK `registerApp()` / 扫码自动创建飞书助手
- `/feishu start|stop|status`
- Private chat, group chat, group topic/thread routing / 支持私聊、群聊、群话题
- Default group policy: `open` — no @ required / 默认群策略 `open`，无需 @ 自动回复
- Message de-duplication / 消息去重
- Per-conversation persistent Pi sessions / 每个会话独立持久化 Pi session
- Feishu-side `/new` and `/model` commands / 飞书内支持 `/new` 新会话与 `/model` 按钮切换模型

## Install / 安装

From this directory:

```bash
npm install
pi install /Users/ax/pi-feishu-extension
```

Or test temporarily:

```bash
pi -e /Users/ax/pi-feishu-extension
```

## Usage / 使用

Inside Pi:

```text
/feishu setup
/feishu start
/feishu status
/feishu stop
```

Inside Feishu/Lark:

```text
/new
/model
```

`/new` starts a fresh Pi session for the current Feishu private chat, group, or topic. Existing session history is kept.

`/model` replies with an interactive card showing the current model and clickable model buttons. Clicking a button switches the model for that Feishu conversation only.

Config is saved to:

```text
~/.pi/agent/feishu/config.json
```

Conversation session mapping is saved to:

```text
~/.pi/agent/feishu/state.json
```

Conversation session files are saved in Pi's native session directory:

```text
~/.pi/agent/sessions/
```

`/feishu reset` clears Feishu config and conversation mappings, but keeps session history.

## MVP limitations / 第一版限制

- Replies are plain text for stability / 第一版先用纯文本回复保证稳定
- Markdown cards and streaming patch updates are planned for v2 / Markdown 卡片与流式更新放到 v2
- No allow-list protection by default / 默认不做白名单限制
