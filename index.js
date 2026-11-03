// st-opencode-go-bridge（TT / ST 前端扩展）
// 作用：给「经酒馆后端转发」的自定义 API 请求补上 OpenCode Go 要求的 x-opencode-session 头。
// 不直连、不改第三方插件；只在同源 /api/backends/chat-completions/{generate,status} 上动手。

const SESSION_KEY = 'st-opencode-bridge-session';
const OPENCODE_HOSTS = ['opencode.ai', 'www.opencode.ai'];
const TAVERN_PATHS = ['/api/backends/chat-completions/generate', '/api/backends/chat-completions/status'];
const LOG = '[st-opencode-go-bridge]';

function log(...args) {
    try { console.info(LOG, ...args); } catch { /* ignore */ }
}

function isOpenCodeUrl(value) {
    if (!value) return false;
    try {
        const url = new URL(String(value));
        return OPENCODE_HOSTS.includes(url.hostname.toLowerCase());
    } catch {
        return false;
    }
}

function isTavernEndpoint(url) {
    try {
        return TAVERN_PATHS.includes(new URL(url, 'http://localhost').pathname);
    } catch {
        return false;
    }
}

function hasHeader(obj, name) {
    const lower = name.toLowerCase();
    return Object.keys(obj).some(key => key.toLowerCase() === lower);
}

function getSessionId() {
    try {
        let id = localStorage.getItem(SESSION_KEY);
        if (!id) {
            id = crypto.randomUUID ? crypto.randomUUID() : `tt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
            localStorage.setItem(SESSION_KEY, id);
        }
        return id;
    } catch {
        return 'st-opencode-go-bridge';
    }
}

// 把 session 头并进 custom_include_headers；兼容 JSON 字符串、对象和 YAML 文本三种写法。
export function withSessionHeader(existing, sessionId) {
    if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
        const obj = { ...existing };
        if (!hasHeader(obj, 'x-opencode-session')) obj['x-opencode-session'] = sessionId;
        return JSON.stringify(obj);
    }

    if (typeof existing === 'string' && existing.trim()) {
        try {
            const parsed = JSON.parse(existing);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                if (!hasHeader(parsed, 'x-opencode-session')) parsed['x-opencode-session'] = sessionId;
                return JSON.stringify(parsed);
            }
        } catch {
            // Not JSON: treat as YAML-ish lines and append.
            if (/(^|\n)\s*x-opencode-session\s*:/i.test(existing)) return existing;
            return `${existing.replace(/\s+$/, '')}\nx-opencode-session: ${sessionId}`;
        }
    }

    return `x-opencode-session: ${sessionId}`;
}

// 返回改写后的 body 字符串；不需要改写时返回 null。
export function rewriteRequestBody(rawBody, sessionId, options = {}) {
    if (typeof rawBody !== 'string' || !rawBody.trim()) return null;

    let body;
    try {
        body = JSON.parse(rawBody);
    } catch {
        return null;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    if (body.chat_completion_source !== 'custom') return null;
    if (!isOpenCodeUrl(body.custom_url)) return null;

    const nextHeaders = withSessionHeader(body.custom_include_headers, sessionId);
    if (nextHeaders === body.custom_include_headers) return null;

    body.custom_include_headers = nextHeaders;
    if (options.dryRun) return body;
    return JSON.stringify(body);
}

export function rewriteRequest(input, init, sessionId) {
    if (!init || String(init.method || 'GET').toUpperCase() !== 'POST') return null;
    if (!isTavernEndpoint(input)) return null;

    const body = rewriteRequestBody(init.body, sessionId);
    if (!body || typeof body !== 'string') return null;

    log('injected x-opencode-session into', String(input));
    return { input, init: { ...init, body } };
}

function install() {
    if (typeof window === 'undefined' || !window.fetch) return;
    if (window.__OPENCODE_GO_BRIDGE__) return;
    window.__OPENCODE_GO_BRIDGE__ = true;

    const originalFetch = window.fetch.bind(window);
    const sessionId = getSessionId();

    window.fetch = function bridgedFetch(input, init) {
        try {
            const rewritten = rewriteRequest(input, init, sessionId);
            if (rewritten) return originalFetch(rewritten.input, rewritten.init);
        } catch (error) {
            log('rewrite failed, passing through:', error);
        }
        return originalFetch(input, init);
    };

    log('installed; session =', sessionId);
}

if (typeof window !== 'undefined') {
    install();
}
