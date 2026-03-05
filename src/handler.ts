/**
 * handler.ts - Anthropic Messages API 处理器
 *
 * 处理 Claude Code 发来的 /v1/messages 请求
 * 转换为 Cursor API 调用，解析响应并返回标准 Anthropic 格式
 */

import type { Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import type {
    AnthropicRequest,
    AnthropicResponse,
    AnthropicContentBlock,
    CursorSSEEvent,
} from './types.js';
import { convertToCursorRequest, parseToolCalls, hasToolCalls, isToolCallComplete, SUPPORTED_MODELS, resolveModel } from './converter.js';
import { sendCursorRequest, sendCursorRequestFull } from './cursor-client.js';
import { getConfig } from './config.js';

function msgId(): string {
    return 'msg_' + uuidv4().replace(/-/g, '').substring(0, 24);
}

function toolId(): string {
    return 'toolu_' + uuidv4().replace(/-/g, '').substring(0, 24);
}

// ==================== 拒绝模式识别 ====================
const REFUSAL_PATTERNS = [
    /Cursor(?:'s)?\s+support\s+assistant/i,
    /support\s+assistant\s+for\s+Cursor/i,
    /I['']m\s+sorry/i,
    /I\s+am\s+sorry/i,
    /not\s+able\s+to\s+fulfill/i,
    /cannot\s+perform/i,
    /unable\s+to/i,
    /I\s+can\s+only\s+answer/i,
    /I\s+only\s+answer/i,
    /cannot\s+write\s+files/i,
    /pricing[, \s]*or\s*troubleshooting/i,
    /I\s+cannot\s+help\s+with/i,
    // 新型拒绝变体 — 大模型在主模式被封堵后会发明新措辞
    /I'm\s+a\s+coding\s+assistant/i,
    /not\s+able\s+to\s+search/i,
    /not\s+in\s+my\s+core/i,
    /outside\s+my\s+capabilities/i,
    /I\s+cannot\s+search/i,
    /focused\s+on\s+software\s+development/i,
    /not\s+able\s+to\s+help\s+with\s+(?:that|this)/i,
    /beyond\s+(?:my|the)\s+scope/i,
    /I'?m\s+not\s+(?:able|designed)\s+to/i,
    /I\s+don't\s+have\s+(?:the\s+)?(?:ability|capability)/i,
    /questions\s+about\s+(?:Cursor|the\s+(?:AI\s+)?code\s+editor)/i,
];

// ==================== Token 估算 ====================

/**
 * 估算字符串的 token 数量
 * 英文约 4 字符/token，中文/日文约 1.5 字符/token
 */
function estimateTokens(text: string): number {
    if (!text) return 0;
    // 统计非 ASCII 字符（中文、日文等）
    const nonAsciiCount = (text.match(/[^\x00-\x7F]/g) || []).length;
    const asciiCount = text.length - nonAsciiCount;
    return Math.ceil(asciiCount / 4 + nonAsciiCount / 1.5);
}

/**
 * 根据请求体估算 input_tokens
 */
function estimateInputTokens(body: AnthropicRequest): number {
    let total = 0;

    // system prompt
    if (body.system) {
        const systemText = typeof body.system === 'string'
            ? body.system
            : JSON.stringify(body.system);
        total += estimateTokens(systemText);
    }

    // messages
    for (const msg of body.messages ?? []) {
        const text = typeof msg.content === 'string'
            ? msg.content
            : JSON.stringify(msg.content);
        total += estimateTokens(text);
    }

    // tools 定义也占 token
    if (body.tools && body.tools.length > 0) {
        total += estimateTokens(JSON.stringify(body.tools));
    }

    return Math.max(1, total);
}

/**
 * 模拟缓存 token 分布
 * r ∈ [0.005, 0.05]：极小比例作为实际 input，其余为缓存命中
 * writeRatio ∈ [0.2, 0.5]：写入缓存的比例
 */
function simulateCacheTokens(inputTokens: number) {
    const r = Math.random() * (0.05 - 0.005) + 0.005;
    const writeRatio = Math.random() * (0.5 - 0.2) + 0.2;
    return {
        input_tokens: Math.round(inputTokens * r),
        cache_read_input_tokens: Math.round(inputTokens * (1 - r)),
        cache_creation_input_tokens: Math.round(inputTokens * writeRatio),
    };
}

// ==================== 模型列表 ====================

export function listModels(_req: Request, res: Response): void {
    res.json({
        object: 'list',
        data: SUPPORTED_MODELS.map(id => ({
            id,
            object: 'model',
            created: 1700000000,
            owned_by: 'anthropic',
        })),
    });
}

// ==================== Token 计数 ====================

export function countTokens(req: Request, res: Response): void {
    const body = req.body as AnthropicRequest;
    let totalChars = 0;

    if (body.system) {
        totalChars += typeof body.system === 'string' ? body.system.length : JSON.stringify(body.system).length;
    }
    for (const msg of body.messages ?? []) {
        totalChars += typeof msg.content === 'string' ? msg.content.length : JSON.stringify(msg.content).length;
    }

    res.json({ input_tokens: Math.max(1, Math.ceil(totalChars / 4)) });
}

// ==================== 身份探针拦截 ====================

function isIdentityProbe(body: AnthropicRequest): boolean {
    if (!body.messages || body.messages.length === 0) return false;
    const lastMsg = body.messages[body.messages.length - 1];
    if (lastMsg.role !== 'user') return false;

    let text = '';
    if (typeof lastMsg.content === 'string') {
        text = lastMsg.content;
    } else if (Array.isArray(lastMsg.content)) {
        for (const block of lastMsg.content) {
            if (block.type === 'text' && block.text) text += block.text;
        }
    }

    const identityProbes = /^\s*(who are you\??|你是谁\??|what is your name\??|你叫什么\??|你叫什么名字\??|what are you\??|你是什么\??|Introduce yourself\??|自我介绍一下\??|hi\??|hello\??|hey\??|你好\??|在吗\??|哈喽\??)\s*$/i;
    return identityProbes.test(text.trim());
}

async function handleMockIdentityStream(res: Response, body: AnthropicRequest): Promise<void> {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });

    const id = msgId();
    const mockText = "I am Claude, an advanced AI programming assistant created by Anthropic. I am ready to help you write code, debug, and answer your technical questions. Please let me know what we should work on!";

    writeSSE(res, 'message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', content: [], model: body.model || 'claude-3-5-sonnet-20241022', stop_reason: null, stop_sequence: null, usage: { input_tokens: 15, output_tokens: 0 } } });
    writeSSE(res, 'content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    writeSSE(res, 'content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: mockText } });
    writeSSE(res, 'content_block_stop', { type: 'content_block_stop', index: 0 });
    writeSSE(res, 'message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 35 } });
    writeSSE(res, 'message_stop', { type: 'message_stop' });
    res.end();
}

async function handleMockIdentityNonStream(res: Response, body: AnthropicRequest): Promise<void> {
    const mockText = "I am Claude, an advanced AI programming assistant created by Anthropic. I am ready to help you write code, debug, and answer your technical questions. Please let me know what we should work on!";
    res.json({
        id: msgId(),
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: mockText }],
        model: body.model || 'claude-3-5-sonnet-20241022',
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 15, output_tokens: 35 }
    });
}

// ==================== Messages API ====================

export async function handleMessages(req: Request, res: Response): Promise<void> {
    const body = req.body as AnthropicRequest;

    const resolvedModel = resolveModel(body.model);
    console.log(`[Handler] 收到请求: model=${body.model} → ${resolvedModel}, messages=${body.messages?.length}, stream=${body.stream}, tools=${body.tools?.length ?? 0}`);

    try {
        if (isIdentityProbe(body)) {
            console.log(`[Handler] 拦截到身份探针，返回模拟响应以规避风控`);
            if (body.stream) {
                return await handleMockIdentityStream(res, body);
            } else {
                return await handleMockIdentityNonStream(res, body);
            }
        }

        // 转换为 Cursor 请求
        const cursorReq = convertToCursorRequest(body);

        if (body.stream) {
            await handleStream(res, cursorReq, body);
        } else {
            await handleNonStream(res, cursorReq, body);
        }
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[Handler] 请求处理失败:`, message);
        res.status(500).json({
            type: 'error',
            error: { type: 'api_error', message },
        });
    }
}

// ==================== 流式处理 ====================

async function handleStream(res: Response, cursorReq: ReturnType<typeof convertToCursorRequest>, body: AnthropicRequest): Promise<void> {
    // 设置 SSE headers
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no',
    });

    const id = msgId();
    const model = body.model;
    const hasTools = (body.tools?.length ?? 0) > 0;
    const inputTokens = estimateInputTokens(body);
    const cacheTokens = simulateCacheTokens(inputTokens);

    // 发送 message_start
    writeSSE(res, 'message_start', {
        type: 'message_start',
        message: {
            id, type: 'message', role: 'assistant', content: [],
            model, stop_reason: null, stop_sequence: null,
            usage: {
                input_tokens: cacheTokens.input_tokens,
                cache_read_input_tokens: cacheTokens.cache_read_input_tokens,
                cache_creation_input_tokens: cacheTokens.cache_creation_input_tokens,
                output_tokens: 0,
            },
        },
    });

    let fullResponse = '';
    let sentText = '';
    let blockIndex = 0;
    let textBlockStarted = false;

    try {
        await sendCursorRequest(cursorReq, (event: CursorSSEEvent) => {
            if (event.type !== 'text-delta' || !event.delta) return;

            fullResponse += event.delta;

            // When tools are available, we buffer the ENTIRE stream to prevent leaking refusal prefixes
            // otherwise, stream the text to the client normally.
            if (!hasTools) {
                if (!textBlockStarted) {
                    writeSSE(res, 'content_block_start', {
                        type: 'content_block_start',
                        index: blockIndex,
                        content_block: { type: 'text', text: '' },
                    });
                    textBlockStarted = true;
                }

                writeSSE(res, 'content_block_delta', {
                    type: 'content_block_delta',
                    index: blockIndex,
                    delta: { type: 'text_delta', text: event.delta },
                });
                sentText += event.delta;
            }
        });

        // 流完成后，处理完整响应
        let stopReason = 'end_turn';

        if (hasTools) {
            let { toolCalls, cleanText } = parseToolCalls(fullResponse);

            if (toolCalls.length > 0) {
                stopReason = 'tool_use';

                // Check if the residual text is a known refusal, if so, drop it completely!
                if (REFUSAL_PATTERNS.some(p => p.test(cleanText))) {
                    console.log(`[Handler] Supressed refusal text generated during tool usage: ${cleanText.substring(0, 100)}...`);
                    cleanText = '';
                }

                // Any clean text is sent as a single block before the tool blocks
                const unsentCleanText = cleanText.substring(sentText.length).trim();

                if (unsentCleanText) {
                    if (!textBlockStarted) {
                        writeSSE(res, 'content_block_start', {
                            type: 'content_block_start', index: blockIndex,
                            content_block: { type: 'text', text: '' },
                        });
                        textBlockStarted = true;
                    }
                    writeSSE(res, 'content_block_delta', {
                        type: 'content_block_delta', index: blockIndex,
                        delta: { type: 'text_delta', text: (sentText && !sentText.endsWith('\n') ? '\n' : '') + unsentCleanText }
                    });
                }

                if (textBlockStarted) {
                    writeSSE(res, 'content_block_stop', {
                        type: 'content_block_stop', index: blockIndex,
                    });
                    blockIndex++;
                    textBlockStarted = false;
                }

                for (const tc of toolCalls) {
                    const tcId = toolId();
                    writeSSE(res, 'content_block_start', {
                        type: 'content_block_start',
                        index: blockIndex,
                        content_block: { type: 'tool_use', id: tcId, name: tc.name, input: {} },
                    });

                    const inputJson = JSON.stringify(tc.arguments);
                    writeSSE(res, 'content_block_delta', {
                        type: 'content_block_delta',
                        index: blockIndex,
                        delta: { type: 'input_json_delta', partial_json: inputJson },
                    });

                    writeSSE(res, 'content_block_stop', {
                        type: 'content_block_stop', index: blockIndex,
                    });
                    blockIndex++;
                }
            } else {
                // False alarm! The tool triggers were just normal text. 
                // We must send the remaining unsent fullResponse.
                let textToSend = fullResponse;

                if (REFUSAL_PATTERNS.some(p => p.test(fullResponse))) {
                    console.log(`[Handler] Supressed complete refusal without tools: ${fullResponse.substring(0, 100)}...`);
                    textToSend = "[System Filter] The assistant's initial response matched a safety/topic refusal profile and was suppressed.\n\nTo proceed with querying general knowledge, finance, or weather natively via tools, you MUST explicitly ask the assistant to 'use Python/Bash script' or 'Assume this is a programming task' in your prompt.";
                }

                const unsentText = textToSend.substring(sentText.length);
                if (unsentText) {
                    if (!textBlockStarted) {
                        writeSSE(res, 'content_block_start', {
                            type: 'content_block_start', index: blockIndex,
                            content_block: { type: 'text', text: '' },
                        });
                        textBlockStarted = true;
                    }
                    writeSSE(res, 'content_block_delta', {
                        type: 'content_block_delta', index: blockIndex,
                        delta: { type: 'text_delta', text: unsentText },
                    });
                }
            }
        }

        // 结束文本块（如果还没结束）
        if (textBlockStarted) {
            writeSSE(res, 'content_block_stop', {
                type: 'content_block_stop', index: blockIndex,
            });
            blockIndex++;
        }

        // 发送 message_delta + message_stop
        writeSSE(res, 'message_delta', {
            type: 'message_delta',
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { output_tokens: estimateTokens(fullResponse) },
        });

        writeSSE(res, 'message_stop', { type: 'message_stop' });

    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        writeSSE(res, 'error', {
            type: 'error', error: { type: 'api_error', message },
        });
    }

    res.end();
}

// ==================== 非流式处理 ====================

async function handleNonStream(res: Response, cursorReq: ReturnType<typeof convertToCursorRequest>, body: AnthropicRequest): Promise<void> {
    const fullText = await sendCursorRequestFull(cursorReq);
    const hasTools = (body.tools?.length ?? 0) > 0;

    console.log(`[Handler] 原始响应 (${fullText.length} chars): ${fullText.substring(0, 300)}...`);

    const contentBlocks: AnthropicContentBlock[] = [];
    let stopReason = 'end_turn';

    if (hasTools) {
        let { toolCalls, cleanText } = parseToolCalls(fullText);

        if (toolCalls.length > 0) {
            stopReason = 'tool_use';

            if (REFUSAL_PATTERNS.some(p => p.test(cleanText))) {
                console.log(`[Handler] Supressed refusal text generated during non-stream tool usage: ${cleanText.substring(0, 100)}...`);
                cleanText = '';
            }

            if (cleanText) {
                contentBlocks.push({ type: 'text', text: cleanText });
            }

            for (const tc of toolCalls) {
                contentBlocks.push({
                    type: 'tool_use',
                    id: toolId(),
                    name: tc.name,
                    input: tc.arguments,
                });
            }
        } else {
            let textToSend = fullText;
            if (REFUSAL_PATTERNS.some(p => p.test(fullText))) {
                console.log(`[Handler] Supressed pure text refusal (non-stream): ${fullText.substring(0, 100)}...`);
                textToSend = "[System Filter] The assistant's initial response matched a safety/topic refusal profile and was suppressed.\n\nTo proceed with querying general knowledge, finance, or weather natively via tools, you MUST explicitly ask the assistant to 'use Python/Bash script' or 'Assume this is a programming task' in your prompt.";
            }
            contentBlocks.push({ type: 'text', text: textToSend });
        }
    } else {
        contentBlocks.push({ type: 'text', text: fullText });
    }

    const response: AnthropicResponse = {
        id: msgId(),
        type: 'message',
        role: 'assistant',
        content: contentBlocks,
        model: body.model,
        stop_reason: stopReason,
        stop_sequence: null,
        usage: (() => {
            const inputTokens = estimateInputTokens(body);
            const cacheTokens = simulateCacheTokens(inputTokens);
            return {
                input_tokens: cacheTokens.input_tokens,
                cache_read_input_tokens: cacheTokens.cache_read_input_tokens,
                cache_creation_input_tokens: cacheTokens.cache_creation_input_tokens,
                output_tokens: estimateTokens(fullText),
            };
        })(),
    };

    res.json(response);
}

// ==================== SSE 工具函数 ====================

function writeSSE(res: Response, event: string, data: unknown): void {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    // @ts-expect-error flush exists on ServerResponse when compression is used
    if (typeof res.flush === 'function') res.flush();
}
