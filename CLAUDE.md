# cursor2api 项目规范

## 必须永久保留的功能

### 1. Token 估算与缓存模拟（handler.ts）

合并上游代码时，**不得删除**以下函数，必须始终保留：

- `estimateTokens(text)` — ASCII 字符 /4，非 ASCII /1.5
- `estimateInputTokens(body)` — 基于 system + messages + tools 估算
- `simulateCacheTokens(inputTokens)` — r:[0.005,0.05] 作为 input，其余为 cache_read，writeRatio:[0.2,0.5] 作为 cache_creation

usage 字段必须返回 `input_tokens`、`cache_read_input_tokens`、`cache_creation_input_tokens`、`output_tokens`。

> 上游在 v2.2.0 把这些删掉改回硬编码 `input_tokens: 100`，**每次合并上游都必须还原**。

### 2. 多模型 ID 支持（converter.ts + handler.ts）

- `SUPPORTED_MODELS` 数组 + `resolveModel()` 函数必须保留在 converter.ts
- `listModels()` 必须返回完整模型列表（而非配置中的单一模型）
- handler.ts 必须 import 并使用这两者

> 上游在 v2.2.0 删掉了这些，**每次合并上游都必须还原**。

### 3. API 密钥鉴权（index.ts）

- 通过 `API_KEY` 环境变量配置
- 支持 `x-api-key` 头（Anthropic 风格）和 `Authorization: Bearer` 头（OpenAI 风格）
- 未配置时跳过鉴权
- 所有 API 端点（/v1/messages, /v1/chat/completions, count_tokens）都需要鉴权

### 4. Cursor 原生 Tool Events 支持（cursor-client.ts）

- `sendCursorRequestStructured(req)` 函数必须保留，它是主要工具调用路径
- 收集 Cursor SSE 原生事件：`tool-input-start` → `tool-input-delta`（含 `inputTextDelta` 字段）→ `tool-input-available`
- `extractToolInputDelta` 必须包含 `inputTextDelta` 在字段列表中（Cursor API 实际使用此字段名）
- `CursorNativeToolCall` 和 `CursorCollectedResponse` 类型必须保留在 types.ts
- handler.ts 优先使用 `nativeToolCalls`，无原生事件时降级到 `parseToolCalls` 文本解析

> 这是解决 Cursor ~20KB 响应截断问题的核心方案，原生 tool events 不受截断影响。

### 5. 截断续写逻辑（handler.ts）

- `buildContinuationRequest` 函数必须保留
- 截断检测：`extractJsonActionBlocks` 返回 `truncated: true` + `truncatedBlockStart`
- `parseToolCalls` 使用 `truncatedBlockStart` 裁剪 `cleanText`，移除不完整块
- handler.ts 中截断时最多续写 3 次（`MAX_CONTINUATIONS = 3`）
- 续写是原生 tool events 路径的降级兜底

### 6. 响应大小限制提示词（converter.ts）

- `buildToolInstructions` 的 rule 6 必须包含 ⚠️ HARD OUTPUT LIMIT 警告
- 告知模型 15KB 限制、150 行拆分策略、Bash heredoc 追加方法
- `sharedRule6` 常量在两个分支间共用，不得单独修改其中一个

## 合并上游代码的注意事项

1. 上游的新功能（拒绝模式扩展、sanitizeResponse、tolerantParse、重试逻辑等）正常合并
2. 上述所有功能每次都要手动还原，不跟随上游删除
3. types.ts 中 AnthropicResponse.usage 必须保留 cache_read_input_tokens 和 cache_creation_input_tokens 可选字段
4. handler.ts 必须使用 `sendCursorRequestStructured` 而非 `sendCursorRequestFull`（后者现为薄包装层）
5. converter.ts 中 `extractJsonActionBlocks` 返回 `truncatedBlockStart`，`parseToolCalls` 必须使用它裁剪 cleanText
