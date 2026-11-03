// st-opencode-go-bridge（TT / ST 前端扩展）
// 两件事：
// 1) 「经酒馆后端转发」的自定义 API 请求，补上 OpenCode Go 要求的 x-opencode-session 头。
// 2) 插件自己直连 opencode.ai 的 chat/completions 或 models，改道到酒馆后端（浏览器直连会被 CORS 挡）。

const SESSION_KEY = 'st-opencode-bridge-session';
const OPENCODE_HOSTS = ['opencode.ai', 'www.opencode.ai'];
const TAVERN_PATHS = ['/api/backends/chat-completions/generate', '/api/backends/chat-completions/status'];
const CHAT_PATH = '/api/backends/chat-completions/generate';
const STATUS_PATH = '/api/backends/chat-completions/status';
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

function headersToObject(headers) {
    const out = {};
    if (!headers) return out;
    if (typeof headers.forEach === 'function' && typeof headers.get === 'function') {
        headers.forEach((value, key) => { out[key] = value; });
        return out;
    }
    if (Array.isArray(headers)) {
        for (const [key, value] of headers) out[key] = value;
        return out;
    }
    if (typeof headers === 'object') {
        for (const [key, value] of Object.entries(headers)) out[key] = value;
    }
    return out;
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

// 酒馆同一个 POST 路由要 CSRF（ST 浏览器版）；TT 没有，但带上也无害。
function tavernHeaders() {
    try {
        const headers = globalThis.SillyTavern?.getContext?.()?.getRequestHeaders?.();
        return headers && typeof headers === 'object' ? headers : {};
    } catch {
        return {};
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

const DTO_KEYS = new Set([
    'model', 'messages', 'stream', 'temperature', 'max_tokens', 'max_completion_tokens',
    'top_p', 'top_k', 'stop', 'presence_penalty', 'frequency_penalty', 'logit_bias',
    'seed', 'n', 'user', 'response_format',
]);

function openCodeBase(url) {
    return url.origin + url.pathname.replace(/\/chat\/completions\/?$/i, '').replace(/\/models\/?$/i, '');
}

// 直连 opencode 的请求改道到酒馆后端。返回 {input, init} 或 null。
export function rewriteDirectRequest(input, init, sessionId) {
    if (typeof input !== 'string') return null;

    let url;
    try {
        url = new URL(input, 'http://localhost');
    } catch {
        return null;
    }
    if (!OPENCODE_HOSTS.includes(url.hostname.toLowerCase())) return null;

    const method = String(init?.method || 'GET').toUpperCase();
    const headers = headersToObject(init?.headers);
    const authorization = Object.entries(headers).find(([key]) => key.toLowerCase() === 'authorization')?.[1];
    const base = openCodeBase(url);
    const includeHeaders = { ...(authorization ? { Authorization: authorization } : {}), 'x-opencode-session': sessionId };

    if (method === 'POST' && /\/chat\/completions\/?$/i.test(url.pathname)) {
        let body;
        try {
            body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
        } catch {
            return null;
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) return null;

        const dto = {
            chat_completion_source: 'custom',
            custom_url: base,
            custom_include_headers: JSON.stringify(includeHeaders),
        };
        const extras = {};
        for (const [key, value] of Object.entries(body)) {
            if (DTO_KEYS.has(key)) dto[key] = value;
            else extras[key] = value;
        }
        if (Object.keys(extras).length) dto.custom_include_body = JSON.stringify(extras);

        log('rerouted direct chat request to tavern backend');
        return {
            input: CHAT_PATH,
            init: {
                ...init,
                method: 'POST',
                headers: { ...tavernHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify(dto),
            },
        };
    }

    if (method === 'GET' && /\/models\/?$/i.test(url.pathname)) {
        log('rerouted direct models request to tavern backend');
        return {
            input: STATUS_PATH,
            init: {
                ...init,
                method: 'POST',
                headers: { ...tavernHeaders(), 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_completion_source: 'custom',
                    custom_url: base,
                    custom_include_headers: JSON.stringify(includeHeaders),
                }),
            },
        };
    }

    return null;
}

// 酒馆后端请求：只补 session 头。
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
            const direct = rewriteDirectRequest(input, init, sessionId);
            if (direct) return originalFetch(direct.input, direct.init);
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
