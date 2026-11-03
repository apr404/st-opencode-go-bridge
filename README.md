# st-opencode-go-bridge（TT / ST 前端扩展）

给 **BakemonoMemory（类脑记忆）** 这类支持「经酒馆后端转发」的插件补上 OpenCode Go 要求的 `x-opencode-session` 请求头，解决 `400 MissingSessionID`。

不改第三方插件，也不让浏览器直连 opencode（那条路会被 CORS 挡）。

## 它做什么

只在同源请求 `/api/backends/chat-completions/generate`（和 `/status`）上动手：

- 请求体里 `chat_completion_source === 'custom'`
- `custom_url` 的域名是 `opencode.ai`
- 就把 `x-opencode-session: <固定UUID>` 合并进 `custom_include_headers`

已有的 `Authorization` 原样保留。session id 存在 `localStorage['st-opencode-bridge-session']`，首次生成，之后固定不变（OpenCode 只用它做路由 / 缓存亲和）。

## 安装

1. 把 `manifest.json`、`index.js`、`README.md` 传到 GitHub（仓库必须 **public**）
2. 酒馆 → Extensions → Install extension → 粘贴仓库地址
3. Reload

装好后 console 会有一行 `[st-opencode-go-bridge] installed; session = …`。

## 插件那边怎么填

以 BakemonoMemory 的自定义 API 为例：

```
自定义接口地址   https://opencode.ai/zen/go/v1
模型             deepseek-v4.1-flash     ← 裸名，不要 opencode-go/ 前缀
密钥             OpenCode 的 API Key
经酒馆后端转发   ✅ 必须打开
```

> 不开「经酒馆转发」= 浏览器直连 `opencode.ai`，响应没有 `Access-Control-Allow-Origin`，会被 CORS 拦成 `Failed to fetch`。这个扩展救不了直连，它只补头、不搬请求。

## 排错

- `400 MissingSessionID` → 扩展没生效：确认页面已 Reload、console 里有 `installed` 和 `injected` 两行日志
- `Failed to fetch` → 没开「经酒馆转发」
- `401` → 密钥填错，只填 key 本身，不要带 `Bearer`
- `404 Unsupported endpoint` → 地址要对：`/zen/go/v1`（Go 套餐），不是 `/zen/v1`（按量计费）
- 想看是否真的带上了头 → DevTools → Network 看那条 `chat-completions/generate` 的 request body：`custom_include_headers` 里应有 `x-opencode-session`

## 边界

- 只包了 `window.fetch`；用 XHR / Worker 发请求的插件管不到
- 只处理 `custom` 来源；TT 原生 `opencode` 来源不需要它（后端自己会带 session）
- `custom_include_headers` 支持 JSON 字符串、对象、YAML 文本三种写法，都能合并
