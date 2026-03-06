/**
 * cursor-client.ts - Cursor API 客户端
 *
 * 职责：
 * 1. 发送请求到 https://cursor.com/api/chat（带 Chrome TLS 指纹模拟 headers）
 * 2. 流式解析 SSE 响应
 * 3. 自动重试（普通错误最多 3 次；429 使用更长指数退避）
 * 4. 代理池轮换（round-robin，降低 IP 限流）
 *
 * 注：x-is-human token 验证已被 Cursor 停用，直接发送空字符串即可。
 */

import type { CursorChatRequest, CursorSSEEvent } from './types.js';
import { getConfig } from './config.js';
import { ProxyAgent } from 'undici';

const CURSOR_CHAT_API = 'https://cursor.com/api/chat';

// 代理轮换
let proxyIndex = 0;
function getNextProxyDispatcher(): ProxyAgent | undefined {
    const proxies = getConfig().proxies;
    if (!proxies || proxies.length === 0) return undefined;
    const url = proxies[proxyIndex % proxies.length];
    proxyIndex++;
    console.log(`[Cursor] 使用代理 #${proxyIndex}: ${url.replace(/\/\/.*@/, '//***@')}`);
    return new ProxyAgent(url);
}

// Chrome 浏览器请求头模拟
function getChromeHeaders(): Record<string, string> {
    const config = getConfig();
    return {
        'Content-Type': 'application/json',
        'sec-ch-ua-platform': '"Windows"',
        'x-path': '/api/chat',
        'sec-ch-ua': '"Chromium";v="140", "Not=A?Brand";v="24", "Google Chrome";v="140"',
        'x-method': 'POST',
        'sec-ch-ua-bitness': '"64"',
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-arch': '"x86"',
        'sec-ch-ua-platform-version': '"19.0.0"',
        'origin': 'https://cursor.com',
        'sec-fetch-site': 'same-origin',
        'sec-fetch-mode': 'cors',
        'sec-fetch-dest': 'empty',
        'referer': 'https://cursor.com/en-US/docs',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'priority': 'u=1, i',
        'user-agent': config.fingerprint.userAgent,
        'x-is-human': '',  // Cursor 不再校验此字段
    };
}

// ==================== API 请求 ====================

/**
 * 发送请求到 Cursor /api/chat 并以流式方式处理响应（带重试）
 */
export async function sendCursorRequest(
    req: CursorChatRequest,
    onChunk: (event: CursorSSEEvent) => void,
): Promise<void> {
    const normalMaxAttempts = 3;
    const max429Attempts = 5;
    for (let attempt = 1; attempt <= max429Attempts; attempt++) {
        try {
            await sendCursorRequestInner(req, onChunk);
            return;
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const is429 = msg.includes('429') || msg.includes('Rate limit');
            const maxAttempts = is429 ? max429Attempts : normalMaxAttempts;
            console.error(`[Cursor] 请求失败 (${attempt}/${maxAttempts}): ${msg}`);
            if (attempt < maxAttempts) {
                if (is429) {
                    const baseDelay = 10000 * Math.pow(3, attempt - 1);
                    const delay = baseDelay * (0.5 + Math.random() * 0.5);
                    const maxRetries = maxAttempts - 1;
                    console.log(`[Cursor] 429 限流，等待 ${delay}ms 后重试 (${attempt}/${maxRetries})...`);
                    await new Promise(r => setTimeout(r, delay));
                    continue;
                }

                const delay = 2000;
                console.log(`[Cursor] ${delay / 1000}s 后重试...`);
                await new Promise(r => setTimeout(r, delay));
            } else {
                throw err;
            }
        }
    }
}

async function sendCursorRequestInner(
    req: CursorChatRequest,
    onChunk: (event: CursorSSEEvent) => void,
): Promise<void> {
    const headers = getChromeHeaders();

    console.log(`[Cursor] 发送请求: model=${req.model}, messages=${req.messages.length}`);

    // 请求级超时（使用配置值）
    const config = getConfig();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), config.timeout * 1000);

    try {
        const resp = await fetch(CURSOR_CHAT_API, {
            method: 'POST',
            headers,
            body: JSON.stringify(req),
            signal: controller.signal,
            ...(getConfig().proxies?.length ? { dispatcher: getNextProxyDispatcher() } : {}),
        } as any);

        if (!resp.ok) {
            const body = await resp.text();
            throw new Error(`Cursor API 错误: HTTP ${resp.status} - ${body}`);
        }

        if (!resp.body) {
            throw new Error('Cursor API 响应无 body');
        }

        // 流式读取 SSE 响应
        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.startsWith('data: ')) continue;
                const data = line.slice(6).trim();
                if (!data) continue;

                try {
                    const event: CursorSSEEvent = JSON.parse(data);
                    onChunk(event);
                } catch {
                    // 非 JSON 数据，忽略
                }
            }
        }

        // 处理剩余 buffer
        if (buffer.startsWith('data: ')) {
            const data = buffer.slice(6).trim();
            if (data) {
                try {
                    const event: CursorSSEEvent = JSON.parse(data);
                    onChunk(event);
                } catch { /* ignore */ }
            }
        }
    } finally {
        clearTimeout(timeout);
    }
}

/**
 * 发送非流式请求，收集完整响应
 */
export async function sendCursorRequestFull(req: CursorChatRequest): Promise<string> {
    let fullText = '';
    await sendCursorRequest(req, (event) => {
        if (event.type === 'text-delta' && event.delta) {
            fullText += event.delta;
        }
    });
    return fullText;
}
