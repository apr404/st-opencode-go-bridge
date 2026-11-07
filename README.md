# st-opencode-go-bridge（TT / ST 前端扩展）

给酒馆插件解决 OpenCode Go 的两类问题：

- 走「经酒馆后端转发」时缺 `x-opencode-session` → `400 MissingSessionID`
- 插件自己直连 `opencode.ai` → 被 CORS 挡成 `Failed to fetch`

不改第三方插件，也不让浏览器直连 opencode（那条路会被 CORS 挡）。

## 它做什么

**A. 已经走酒馆转发的请求**（同源 `/api/backends/chat-completions/generate`、`/status`）

- 请求体里 `chat_completion_source === 'custom'` 且 `custom_url` 域名是 `opencode.ai`
- 把 `x-opencode-session: <固定UUID>` 合并进 `custom_include_headers`，原有 `Authorization` 不动

**B. 插件自己直连 opencode 的请求**

- `POST https://opencode.ai/.../chat/completions` → 改写成酒馆后端的 custom 请求
- `GET https://opencode.ai/.../models` → 改写成酒馆后端 `/status`
- 原有 `Authorization` 搬进 `custom_include_headers`，再加上 session 头

两条路请求最终都由酒馆后端发出，绕开 CORS。

## 每个插件独立的 session

- 从调用栈认出是哪个第三方扩展发的请求（`/extensions/third-party/<名字>/`），按插件各生成一个固定 UUID
- 存在 `localStorage['st-opencode-bridge-sessions']`，卸载重装也不变
- console 会打印 `new session for plugin <名字> = <uuid>`，发请求时也会带 `from <名字>`
- 查看当前映射：在 console 里执行 `__ST_OPENCODE_BRIDGE_SESSIONS__()`
- 认不出插件时（Worker / 内联脚本）用全局的默认 UUID

## 安装

酒馆 → Extensions → Install extension → 粘贴仓库地址：

```
https://github.com/ffybe/st-opencode-go-bridge
```

然后 Reload。

装好后 console 会有一行 `[st-opencode-go-bridge] installed; session = …`。

## 自定义 API 怎么填

- 接口地址：`https://opencode.ai/zen/go/v1`
- 模型：`deepseek-v4.1-flash`（裸名，不要 `opencode-go/` 前缀）
- 密钥：OpenCode 的 API Key
- 经酒馆后端转发：有就打开；没有也行，v0.2 会把直连请求改道到酒馆后端

> 直连 `opencode.ai` 本身会被 CORS 挡（真实响应没有 `Access-Control-Allow-Origin`）；扩展负责把它改写成同源的酒馆请求，所以插件不用自己处理跨域。

## 排错

- `400 MissingSessionID` → 扩展没生效：确认页面已 Reload、console 里有 `installed` 和 `injected` 两行日志
- `Failed to fetch` → 直连没被改道：确认装的是 v0.2、并且已经 Reload
- `401` → 密钥填错，只填 key 本身，不要带 `Bearer`
- `404 Unsupported endpoint` → 地址要对：`/zen/go/v1`（Go 套餐），不是 `/zen/v1`（按量计费）
- 想看是否真的带上了头 → DevTools → Network 看那条 `chat-completions/generate` 的 request body：`custom_include_headers` 里应有 `x-opencode-session`

## 边界

- 只包了 `window.fetch`；用 XHR / Worker 发请求的插件管不到
- 直连改道只处理 `chat/completions` 和 `models`；`embeddings`、`audio` 等其它路径不碰
- 只处理 `custom` 来源；TT 原生 `opencode` 来源不需要它（后端自己会带 session）
- `custom_include_headers` 支持 JSON 字符串、对象、YAML 文本三种写法，都能合并
