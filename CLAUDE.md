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

## 合并上游代码的注意事项

1. 上游的新功能（拒绝模式扩展、sanitizeResponse、tolerantParse、重试逻辑等）正常合并
2. 上述三项功能每次都要手动还原，不跟随上游删除
3. types.ts 中 AnthropicResponse.usage 必须保留 cache_read_input_tokens 和 cache_creation_input_tokens 可选字段
