import type { AnthropicContentBlock } from './types.js';

const DEFAULT_VISION_API_BASE = 'https://code.b886.top';
const DEFAULT_VISION_MODEL = 'gpt-5.2';
const DEFAULT_VISION_API_KEY = 'sk-PgHfPWDmoIaBlcfILhoEzxU1AUcZbik5UkO02rtrDf8L8bz6';
const IMAGE_FALLBACK_TEXT = '';

type VisionSource = AnthropicContentBlock['source'] | {
    image_url?: string | { url: string; detail?: string };
    detail?: string;
};

function getVisionConfig(): { apiBase: string; model: string; apiKey: string } {
    return {
        apiBase: process.env.VISION_API_BASE || DEFAULT_VISION_API_BASE,
        model: process.env.VISION_MODEL || DEFAULT_VISION_MODEL,
        apiKey: process.env.VISION_API_KEY || DEFAULT_VISION_API_KEY,
    };
}

function toDataUrl(mediaType: string | undefined, data: string): string {
    return `data:${mediaType || 'image/png'};base64,${data}`;
}

function resolveImageUrl(source: VisionSource | undefined): string | null {
    if (!source) return null;

    if ('image_url' in source && source.image_url) {
        if (typeof source.image_url === 'string') return source.image_url;
        if (typeof source.image_url.url === 'string') return source.image_url.url;
    }

    if ('type' in source && source.type === 'base64' && source.data) {
        return toDataUrl(source.media_type, source.data);
    }

    if ('type' in source && source.type === 'url' && source.url) {
        return source.url;
    }

    if ('data' in source && source.data) {
        return toDataUrl(source.media_type, source.data);
    }

    if ('url' in source && source.url) {
        return source.url;
    }

    return null;
}

function resolveDetail(source: VisionSource | undefined): string {
    if (!source) return 'low';

    if ('detail' in source && typeof source.detail === 'string' && source.detail) {
        return source.detail;
    }

    if ('image_url' in source && source.image_url && typeof source.image_url === 'object' && source.image_url.detail) {
        return source.image_url.detail;
    }

    return 'low';
}

function extractVisionText(response: unknown): string | null {
    if (!response || typeof response !== 'object') return null;

    const output = (response as { output?: Array<{ content?: Array<{ text?: string }> }> }).output;
    if (!Array.isArray(output)) return null;

    for (const item of output) {
        if (!item || !Array.isArray(item.content)) continue;
        for (const content of item.content) {
            if (typeof content?.text === 'string' && content.text.trim()) {
                return content.text.trim();
            }
        }
    }

    return null;
}

export async function describeImage(source: VisionSource | undefined): Promise<string> {
    try {
        const imageUrl = resolveImageUrl(source);
        if (!imageUrl) return IMAGE_FALLBACK_TEXT;

        const detail = resolveDetail(source);
        const { apiBase, model, apiKey } = getVisionConfig();
        const endpoint = `${apiBase.replace(/\/+$/, '')}/v1/responses`;

        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
                model,
                input: [{
                    role: 'user',
                    content: [
                        {
                            type: 'input_image',
                            image_url: imageUrl,
                            detail,
                        },
                        {
                            type: 'input_text',
                            text: '请描述图片内容并提取可见文字。',
                        },
                    ],
                }],
                max_output_tokens: 500,
            }),
        });

        if (!response.ok) {
            console.warn(`[Vision] 请求失败: status=${response.status}`);
            return IMAGE_FALLBACK_TEXT;
        }

        const payload = await response.json();
        const text = extractVisionText(payload);

        return text || IMAGE_FALLBACK_TEXT;
    } catch (error) {
        console.warn('[Vision] 图片处理失败:', error);
        return IMAGE_FALLBACK_TEXT;
    }
}

