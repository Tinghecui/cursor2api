# AI 文档接口调研

本文档记录通过 Chrome DevTools 抓包探索第三方文档站 AI 接口的方法和发现，用于评估 cursor2api 场景的扩展可能性。

## 探索方法论

### 操作步骤

1. **打开目标文档站**，观察页面是否有 AI 聊天入口（Ask AI、Chatbot、Assistant 等按钮）
2. **打开 DevTools Network 面板**，触发一条测试消息
3. **筛选非静态资源的 POST 请求**，排除 `.js`/`.css`/埋点
4. **分析关键请求**，提取：接口 URL、鉴权方式、请求体格式、响应头、tool call ID 格式

### 识别 Claude 模型的关键线索

| 线索 | 说明 |
|------|------|
| tool call ID 前缀 `tooluse_` | Anthropic Claude 专用格式，100% 确认使用 Claude |
| 响应头 `x-vercel-ai-ui-message-stream: v1` | Vercel AI SDK，常与 Claude 搭配 |
| 请求体含 `parts` / `trigger` 字段 | 与 Cursor `/api/chat` 格式一致，同源框架 |
| 模型名含 `claude-` | 明确指定 Claude 模型 |
| Bearer token 格式 + SSE 流 | 可能是直接调用 Anthropic API |

---

## 已调研站点（2026-03）

### 1. ✅ Vercel Docs — 确认 Claude

**AI 入口**: 顶部 "Ask AI" 按钮 + 文章页右下角 "Ask AI about this page"

**接口**:
```
POST https://vercel.com/api/ai-chat
POST https://vercel.com/api/ai-chat/title
```

**鉴权**: Cookie（`_v-anonymous-id` 等，匿名访客可用，无需登录）

**请求体**:
```json
{
  "currentRoute": "/docs",
  "id": "3GosFjfE0KOOPavN",
  "messages": [{"parts": [{"type": "text", "text": "What is Vercel?"}], "id": "...", "role": "user"}],
  "trigger": "submit-message"
}
```

**确认 Claude 的证据**:
- tool call ID: `tooluse_lCI6zNpGkC4Lbp2EIdX9DM` — `tooluse_` 前缀是 Anthropic 专有
- 响应头: `x-vercel-ai-ui-message-stream: v1`
- 工具名: `askKnowledgeBase`（RAG 检索）

**与 Cursor 对比**:

| 字段 | Cursor `/api/chat` | Vercel `/api/ai-chat` |
|------|--------------------|-----------------------|
| messages 格式 | `[{parts, id, role}]` | `[{parts, id, role}]` ✅ |
| trigger 字段 | `"submit-message"` | `"submit-message"` ✅ |
| 顶层 id | 短随机 ID | 短随机 ID ✅ |
| 鉴权 | access_token | Cookie ✅ 更简单 |
| 模型字段 | 明确传 model | 服务端决定 |

**结论**: 格式几乎完全一致，两者均基于 Vercel AI SDK。cursor2api 理论上只需少量修改即可支持。

---

### 2. ⚠️ Anthropic Docs — Inkeep 第三方

**AI 入口**: 右下角 "Ask Docs" 按钮

**后端服务**: [Inkeep](https://inkeep.com)（专门做文档 AI 的第三方 SaaS）

**接口**:
```
GET  https://api.inkeep.com/v1/challenge          # PoW 挑战（SHA-256, maxnumber=50000）
POST https://api.io.inkeep.com/conversations      # 创建对话
POST https://api.inkeep.com/v1/chat/completions  # AI 对话（OpenAI 兼容格式）
```

**鉴权**: `Authorization: Bearer 338b6cdd7488066de9b9dc40e996d96b11488d29ef05b56d`（硬编码在前端 JS）

**PoW 机制**:
```json
// GET /v1/challenge 响应
{"algorithm":"SHA-256","challenge":"edd544...","maxnumber":50000,"salt":"...","signature":"..."}
// 需要在客户端暴力遍历 0~50000，找到使 SHA256(salt+number) 匹配 challenge 的数字
```

**模型**: `inkeep-qa-expert`（Inkeep 内部路由，背后模型不透明，可能非 Claude）

**结论**: 技术可代理，但 token 是 Anthropic 官方付费的公共资源，滥用会影响所有文档用户；模型为文档专用，非通用 Claude。

---

### 3. ⚠️ Stripe Docs — 未能触发

**AI 入口**: 顶部 "Stripe Assistant" 按钮

**状态**: 点击后未产生 AI 相关网络请求，可能需要登录或特定操作才能激活

**结论**: 待进一步探索

---

### 4. 🔵 GitHub Docs — Copilot（非 Claude）

**AI 入口**: "Search or ask Copilot" 搜索框

**接口**:
```
POST https://docs.github.com/api/ai-search/v1
```

**鉴权**: Cookie（匿名可用）

**请求体**:
```json
{"query":"How do I connect to GitHub with SSH?","version":"free-pro-team@latest","client_name":"docs.github.com-client"}
```

**响应格式**: 自定义 ndjson
```json
{"chunkType": "SOURCES", "sources": [...]}
{"chunkType": "MESSAGE_CHUNK", "text": "To"}
{"chunkType": "MESSAGE_CHUNK", "text": " connect"}
```

**模型**: GitHub Copilot 后端（GPT-4o 系列），非 Claude

**结论**: 接口简单、无需登录，但后端是 OpenAI 不是 Claude

---

### 5. ❌ Linear Docs — 无 AI chatbot

**状态**: 文档站使用 Algolia 搜索，无独立 AI 对话功能

**注**: Linear 产品内部有 AI 功能（已知集成 Claude），但文档站不暴露 AI 接口

---

### 6. ❌ Supabase Docs — 无 AI chatbot

**状态**: 仅有搜索按钮，无 AI 对话功能

---

## 综合结论

### 可代理性评估

| 排名 | 站点 | 接口 | 鉴权 | Claude | 实用性 |
|------|------|------|------|--------|--------|
| 1 | Vercel Docs | 自建同源 | Cookie 匿名 | ✅ | ⭐⭐⭐⭐ |
| 2 | GitHub Docs | 自建同源 | Cookie 匿名 | ❌ GPT | ⭐⭐ |
| 3 | Anthropic Docs | Inkeep 第三方 | 公共 Bearer | ❓ | ⭐ |
| — | Linear/Supabase | 无 AI | — | — | ❌ |

### 为什么都不如 Cursor

1. **模型受限**: 文档站 AI 专为 RAG 问答优化，不支持通用工具调用
2. **额度有限**: 面向访客的免费功能，高频使用会被限速
3. **稳定性差**: 随时可能加固鉴权或修改接口
4. **Cursor 的不可替代性**: 订阅制 + 大额度 + 通用 Claude 模型 + 完整 Anthropic tool_use 协议支持

### 待探索站点

- `developers.raycast.com` — 已知产品用 Claude，文档站待确认
- `mintlify.com/docs` — 文档平台，可能为多个客户提供统一 AI 接口
- `docs.cursor.com` — Cursor 自己的文档站
