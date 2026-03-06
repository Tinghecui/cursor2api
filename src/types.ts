// ==================== Anthropic API Types ====================

export interface AnthropicRequest {
    model: string;
    messages: AnthropicMessage[];
    max_tokens: number;
    stream?: boolean;
    system?: string | AnthropicContentBlock[];
    tools?: AnthropicTool[];
    temperature?: number;
    top_p?: number;
    stop_sequences?: string[];
}

export interface AnthropicMessage {
    role: 'user' | 'assistant';
    content: string | AnthropicContentBlock[];
}

export interface AnthropicContentBlock {
    type: 'text' | 'tool_use' | 'tool_result' | 'image';
    text?: string;
    source?: {
        type: 'base64' | 'url';
        media_type?: string;
        data?: string;
        url?: string;
    };
    // tool_use fields
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
    // tool_result fields
    tool_use_id?: string;
    content?: string | AnthropicContentBlock[];
    is_error?: boolean;
}

export interface AnthropicTool {
    name: string;
    description?: string;
    input_schema: Record<string, unknown>;
}

export interface AnthropicResponse {
    id: string;
    type: 'message';
    role: 'assistant';
    content: AnthropicContentBlock[];
    model: string;
    stop_reason: string;
    stop_sequence: string | null;
    usage: {
        input_tokens: number;
        output_tokens: number;
        cache_read_input_tokens?: number;
        cache_creation_input_tokens?: number;
    };
}

// ==================== Cursor API Types ====================

export interface CursorChatRequest {
    context?: CursorContext[];
    model: string;
    id: string;
    messages: CursorMessage[];
    trigger: string;
}

export interface CursorContext {
    type: string;
    content: string;
    filePath: string;
}

export interface CursorMessage {
    parts: CursorPart[];
    id: string;
    role: string;
}

export interface CursorPart {
    type: string;
    text: string;
}

export interface CursorSSEEvent {
    type: 'text-delta' | 'tool-input-start' | 'tool-input-delta' | 'tool-input-available' | 'tool-output-error' | (string & {});
    delta?: string;
    partial_json?: string;
    inputDelta?: string;
    text?: string;
    toolCallId?: string;
    callId?: string;
    id?: string;
    toolName?: string;
    name?: string;
    [key: string]: unknown;
}

export interface CursorNativeToolCall {
    id: string;
    name: string;
    jsonBuffer: string;
    finalized: boolean;
}

export interface CursorCollectedResponse {
    text: string;
    nativeToolCalls: CursorNativeToolCall[];
}

// ==================== Internal Types ====================

export interface ParsedToolCall {
    name: string;
    arguments: Record<string, unknown>;
}

export interface AppConfig {
    port: number;
    timeout: number;
    proxy?: string;
    proxies?: string[];  // 代理池，格式 http://user:pass@ip:port
    cursorModel: string;
    fingerprint: {
        userAgent: string;
    };
}
