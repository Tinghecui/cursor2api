import { readFileSync, existsSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import type { AppConfig } from './types.js';

let config: AppConfig;

/**
 * 解析代理字符串：支持 ip:port:user:pass (Webshare) 和 http://... 格式
 */
function parseProxyString(raw: string): string | null {
    if (!raw) return null;
    if (raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('socks')) return raw;
    const parts = raw.split(':');
    if (parts.length === 4) {
        const [ip, port, user, pass] = parts;
        return `http://${user}:${pass}@${ip}:${port}`;
    }
    if (parts.length === 2) {
        return `http://${parts[0]}:${parts[1]}`;
    }
    return null;
}

export function getConfig(): AppConfig {
    if (config) return config;

    // 默认配置
    config = {
        port: 3010,
        timeout: 120,
        cursorModel: 'anthropic/claude-sonnet-4.6',
        fingerprint: {
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
        },
    };

    // 从 config.yaml 加载
    if (existsSync('config.yaml')) {
        try {
            const raw = readFileSync('config.yaml', 'utf-8');
            const yaml = parseYaml(raw);
            if (yaml.port) config.port = yaml.port;
            if (yaml.timeout) config.timeout = yaml.timeout;
            if (yaml.proxy) config.proxy = yaml.proxy;
            if (yaml.proxies && Array.isArray(yaml.proxies)) {
                config.proxies = yaml.proxies.map((p: string) => parseProxyString(p)).filter(Boolean) as string[];
            }
            if (yaml.cursor_model) config.cursorModel = yaml.cursor_model;
            if (yaml.fingerprint) {
                if (yaml.fingerprint.user_agent) config.fingerprint.userAgent = yaml.fingerprint.user_agent;
            }
        } catch (e) {
            console.warn('[Config] 读取 config.yaml 失败:', e);
        }
    }

    // 环境变量覆盖
    if (process.env.PORT) config.port = parseInt(process.env.PORT);
    if (process.env.TIMEOUT) config.timeout = parseInt(process.env.TIMEOUT);
    if (process.env.PROXY) config.proxy = process.env.PROXY;
    if (process.env.CURSOR_MODEL) config.cursorModel = process.env.CURSOR_MODEL;

    // 代理池：PROXIES 环境变量（逗号分隔，支持 ip:port:user:pass 格式）
    if (process.env.PROXIES) {
        config.proxies = process.env.PROXIES.split(',').map(p => parseProxyString(p.trim())).filter(Boolean) as string[];
    } else if (config.proxy) {
        // 单 proxy 也加入池
        config.proxies = [config.proxy.includes('@') ? config.proxy : parseProxyString(config.proxy)].filter(Boolean) as string[];
    }

    // 从 base64 FP 环境变量解析指纹
    if (process.env.FP) {
        try {
            const fp = JSON.parse(Buffer.from(process.env.FP, 'base64').toString());
            if (fp.userAgent) config.fingerprint.userAgent = fp.userAgent;
        } catch (e) {
            console.warn('[Config] 解析 FP 环境变量失败:', e);
        }
    }

    return config;
}
