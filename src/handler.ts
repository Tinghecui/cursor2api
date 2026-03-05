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

// ==================== Messages API ====================

export async function handleMessages(req: Request, res: Response): Promise<void> {
    const body = req.body as AnthropicRequest;

    const resolvedModel = resolveModel(body.model);
    console.log(`[Handler] 收到请求: model=${body.model} → ${resolvedModel}, messages=${body.messages?.length}, stream=${body.stream}, tools=${body.tools?.length ?? 0}`);

    try {
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

    // 发送 message_start
    writeSSE(res, 'message_start', {
        type: 'message_start',
        message: {
            id, type: 'message', role: 'assistant', content: [],
            model, stop_reason: null, stop_sequence: null,
            usage: { input_tokens: 100, output_tokens: 0 },
        },
    });

    let fullResponse = '';
    let blockIndex = 0;
    let textBlockStarted = false;

    try {
        await sendCursorRequest(cursorReq, (event: CursorSSEEvent) => {
            if (event.type !== 'text-delta' || !event.delta) return;

            fullResponse += event.delta;

            // 如果有工具定义，我们需要缓冲响应来正确检测工具调用
            // 但仍然先实时流式传输文本部分
            if (hasTools && hasToolCalls(fullResponse)) {
                // 检测到工具调用标签开始，停止实时流式传输
                // 等待完整的工具调用块
                return;
            }

            // 实时流式传输文本增量
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
        });

        // 流完成后，处理完整响应
        let stopReason = 'end_turn';

        if (hasTools && hasToolCalls(fullResponse)) {
            const { toolCalls, cleanText } = parseToolCalls(fullResponse);

            if (toolCalls.length > 0) {
                stopReason = 'tool_use';

                // 如果有工具调用前的文本，确保文本块已关闭
                if (textBlockStarted) {
                    // 需要重新计算：流式发送的文本可能包含了工具调用标签之前的部分
                    // 这里我们结束当前文本块
                    writeSSE(res, 'content_block_stop', {
                        type: 'content_block_stop', index: blockIndex,
                    });
                    blockIndex++;
                    textBlockStarted = false;
                }

                // 如果解析后有干净的文本（工具调用之外的文本），发送文本块
                if (cleanText && !textBlockStarted) {
                    // 文本可能已经通过流式增量发送了，这里的 cleanText 是去除工具调用后的剩余
                    // 不需要重复发送
                }

                // 发送工具调用块
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
            usage: { output_tokens: Math.ceil(fullResponse.length / 4) },
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
        const { toolCalls, cleanText } = parseToolCalls(fullText);

        if (toolCalls.length > 0) {
            stopReason = 'tool_use';

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
            contentBlocks.push({ type: 'text', text: fullText });
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
        usage: {
            input_tokens: 100,
            output_tokens: Math.ceil(fullText.length / 4),
        },
    };

    res.json(response);
}

// ==================== SSE 工具函数 ====================

function writeSSE(res: Response, event: string, data: unknown): void {
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    // @ts-expect-error flush exists on ServerResponse when compression is used
    if (typeof res.flush === 'function') res.flush();
}
