# Claude Custom Router

中文 | [English](README.en.md)

一个轻量级、零依赖的代理服务器，根据场景检测将 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 的 API 请求路由到不同的 LLM 提供商。

## 为什么需要它？

Claude Code 默认将所有请求发送到 Anthropic 的 API。如果你想要：

- 不同模型家族（Haiku/Sonnet/Opus）路由到**不同提供商**
- 图片请求路由到**视觉模型**
- **负载均衡**多个提供商，避免被限流
- 使用**默认提供商**作为兜底

这个代理帮你自动完成。通过自定义场景检测器，还可以按工具类型、关键词、时间段等规则扩展路由。

## 工作原理

```
┌──────────────┐     ┌──────────────────────────┐     ┌─────────────────┐
│ Claude Code   │────▶│  Custom Model Proxy       │────▶│  Anthropic API  │
│               │     │                          │     ├─────────────────┤
│               │     │  内置检测器：              │     │  GLM / DeepSeek │
│               │     │  • Explicit override (0)  │     │  Qwen / Others  │
│               │     │  • Image detection  (5)   │     │  ...            │
│               │     │  • Model ID mapping (8)   │     └─────────────────┘
│               │     │    (haiku/sonnet/opus)    │
│               │     │                          │◀── 自定义场景检测器
│               │     │  直查 → providers 匹配     │    (可扩展)
│               │     │  兜底 → routes.default    │
│               │     └──────────────────────────┘
└──────────────┘
```

每个请求按优先级依次经过所有检测器，第一个匹配成功的决定目标路由。所有内置检测器未命中时，还会尝试直接查找 `providers`，最后回退到 `routes.default`。

## 快速开始

### 安装

```bash
git clone https://github.com/your-username/claude-custom-router.git
cd claude-custom-router
```

### 配置

```bash
# 复制示例配置
cp config/custom-models.example.json ~/.claude-custom-router.json

# 编辑配置（填入你的 API Key 和模型端点）
vim ~/.claude-custom-router.json
```

### 启动

```bash
# 启动代理
node src/custom-model-proxy.mjs

# 配置 Claude Code 使用代理
export ANTHROPIC_BASE_URL="http://127.0.0.1:8082"
export ANTHROPIC_API_KEY="your-key-here"
```

### 验证

```bash
curl http://127.0.0.1:8082/health
```

## 配置详解

配置文件：`~/.claude-custom-router.json`（或 `$ROUTER_CONFIG_PATH`）

```json
{
  "port": 8082,
  "debug": false,
  "upstreamTimeoutMs": 360000,
  "providers": {
    "default-provider": {
      "model": "实际模型名称",
      "baseURL": "https://api.provider.com/v1",
      "apiKey": "${环境变量名}",
      "maxTokens": 8192
    },
    "glm": {
      "model": "glm-4",
      "baseURL": "https://open.bigmodel.cn/api/anthropic",
      "apiKey": "${GLM_API_KEY}"
    },
    "qwen-sonnet": {
      "model": "qwen-plus",
      "baseURL": "https://dashscope.aliyuncs.com/apps/anthropic",
      "apiKey": "${QWEN_API_KEY}"
    }
  },
  "pools": {
    "sonnet-primary": {
      "strategy": "priority-fallback",
      "providers": [
        { "provider": "glm", "maxConns": 5 },
        { "provider": "qwen-sonnet", "maxConns": 3 }
      ]
    }
  },
  "routes": {
    "default": { "provider": "default-provider" },
    "image": { "provider": "default-provider" },
    "haiku": { "provider": "default-provider" },
    "sonnet": { "pool": "sonnet-primary" },
    "opus": { "provider": "default-provider" }
  },
  "loadBalancer": {
    "showProvider": true
  }
}
```

### 环境变量引用

在 `apiKey` 和 `baseURL` 中使用 `${ENV_VAR}` 或 `$ENV_VAR` 引用环境变量：

```json
{
  "apiKey": "${MY_API_KEY}",
  "baseURL": "$PROVIDER_BASE_URL"
}
```

### 配置分层

- `routes`：业务入口，比如 `default`、`haiku`、`sonnet`、`opus`、`image`
- `pools`：可复用的负载均衡池
- `providers`：具体的上游 endpoint、账号和实际发给上游的模型名

每个 route 必须二选一：

- `{ "provider": "provider-id" }`
- `{ "pool": "pool-id" }`

## 负载均衡

当启动 Claude Code agent team 时，多个 agent 并发调用 LLM API，可能导致单一提供商被限流（429）。负载均衡通过**活跃连接数**在多个提供商之间分配请求。

### Priority Fallback 策略

默认策略按配置顺序检查提供商，选择第一个有可用容量的（`activeConns < maxConns`）。适合有主力提供商 + 1-2 个 backup 的场景——主力处理大部分流量，backup 仅在主力饱和时启用。

### 容量统计单位

负载均衡的容量统计单位是 `providerId`，也就是 `pools.<pool>.providers[*].provider` 使用的那个 ID。

- 如果多个 pool 复用同一个 provider ID，就会共享同一份连接池。例如 `haiku-primary` 和 `sonnet-primary` 都引用 `glm` 时，会共享同一个 `activeConns` 预算。
- 如果使用不同的 provider ID，就会分开统计容量。即使两个 provider 最终都指向同一个上游模型名，也不会自动合并。例如 `glm` 和 `zai_glm` 即使都配置成 `"model": "glm-4"`，仍然分别计数。
- 容量统计既不是按 route 名称，也不会按 `providers[*].model` 自动合并。

### 配置

```json
{
  "providers": {
    "glm": { "model": "glm-4", "baseURL": "...", "apiKey": "..." },
    "haiku-provider": { "model": "haiku-model", "baseURL": "...", "apiKey": "..." },
    "deepseek-sonnet": { "model": "deepseek-chat", "baseURL": "...", "apiKey": "..." },
    "qwen-sonnet": { "model": "qwen-plus", "baseURL": "...", "apiKey": "..." }
  },
  "pools": {
    "haiku-primary": {
      "strategy": "priority-fallback",
      "providers": [
        { "provider": "glm", "maxConns": 3 },
        { "provider": "haiku-provider", "maxConns": 5 }
      ]
    },
    "sonnet-primary": {
      "strategy": "priority-fallback",
      "providers": [
        { "provider": "glm", "maxConns": 3 },
        { "provider": "deepseek-sonnet", "maxConns": 5 },
        { "provider": "qwen-sonnet", "maxConns": 3 }
      ]
    }
  },
  "routes": {
    "haiku": { "pool": "haiku-primary" },
    "sonnet": { "pool": "sonnet-primary" }
  },
  "loadBalancer": {
    "showProvider": true
  }
}
```

如果你希望同一类上游模型使用彼此独立的容量池，就给它们不同的 provider ID：

```json
{
  "providers": {
    "glm": { "model": "glm-4", "baseURL": "...", "apiKey": "..." },
    "zai_glm": { "model": "glm-4", "baseURL": "...", "apiKey": "..." }
  }
}
```

### 工作原理

1. detector 先解析出 route key，例如 `haiku` 或 `sonnet`
2. 路由器读取 `routes.<key>`，决定走单 provider 还是命名 pool
3. 如果 route 指向 pool，就按顺序检查该 pool 的 providers
4. 选择第一个 `activeConnections < maxConns` 的 provider
5. pool 里所有 provider 满载时，**fail-open** 使用第一个 provider（不丢弃请求）
6. `activeConns` 按 provider ID 统计，因此多个 pool 复用同一个 provider ID 时会共享同一个实时计数
7. 连接清理使用 **once-guard** 防止双重递减

### 可观测性

`loadBalancer.showProvider` 为 `true` 时：
- **响应头**：`X-Router-Provider: deepseek-sonnet`
- **SSE 注释**：`: router_provider: deepseek-sonnet`（仅流式响应）
- **请求日志**：`[a3k9f2][abc123] claude-sonnet-4-5 -> deepseek-chat [route=sonnet pool=sonnet-primary provider=deepseek-sonnet 2/5 active]`
- **健康检查**：`/health` 返回 `routes` 和 `loadBalancer.pools`。如果多个 pool 复用了同一个 provider ID，同一个共享 `activeConns` 值可能会在多个 pool 视图里出现。

### 配置校验

代理在启动和热重载时校验 LB 配置：
- Route 必须引用存在的 provider 或 pool
- Pool 内的 provider 必须引用已定义的 provider config
- 同一个 pool 内 Provider ID 不能重复
- 不同 pool 之间允许复用同一个 Provider ID，以共享同一份容量池
- `maxConns` 必须为正整数
- Strategy 必须已知（`priority-fallback`）
- Provider ID 不能与 route 或 pool key 同名
- Pool ID 不能与 route key 同名

### 支持的提供商

只要提供商兼容 Anthropic API 格式，就可以直接使用。常见配置：

| 提供商 | baseURL 示例 |
|--------|-------------|
| Anthropic | `https://api.anthropic.com/v1` |
| 智谱 GLM | `https://open.bigmodel.cn/api/anthropic` |
| DeepSeek | `https://api.deepseek.com/anthropic` |
| 阿里 Qwen | `https://dashscope.aliyuncs.com/apps/anthropic` |

### Provider 配置字段

| 字段 | 必填 | 说明 |
|------|------|------|
| `model` | 否 | 实际发送给上游的模型名，默认等于 provider ID |
| `baseURL` | 是 | 上游 API 基础地址 |
| `apiKey` | 是 | API Key，支持 `${ENV_VAR}` / `$ENV_VAR` |
| `maxTokens` | 否 | 请求中 `max_tokens` 的上限 |

### TLS 配置

配置文件中可通过 `tls` 字段控制上游 HTTPS 请求的证书信任行为：

```json
{
  "tls": {
    "trustSystemCerts": true,
    "ca": ["/etc/ssl/certs/my-company-ca.pem"],
    "rejectUnauthorized": true
  }
}
```

| 字段 | 类型 | 默认值 | 说明 |
|------|------|--------|------|
| `trustSystemCerts` | boolean | `false` | 自动加载操作系统证书存储（macOS Keychain / Linux `/etc/ssl/certs`） |
| `ca` | string[] | `[]` | 自定义 CA 证书文件路径（仅限 `/etc/ssl/certs` 等系统证书目录） |
| `rejectUnauthorized` | boolean | `true` | 设为 `false` 可跳过证书校验（不安全，会记录警告） |

**常见场景**：

- **企业网络中使用代理**（如 Surge、Zscaler）：设置 `"trustSystemCerts": true`，自动信任系统 Keychain 中的企业 CA
- **自定义 CA 证书**：通过 `ca` 指定 PEM 格式的证书文件路径
- **开发环境跳过校验**：设置 `"rejectUnauthorized": false`（不建议在生产环境使用）

> Node.js 默认使用内置的 Mozilla CA 证书列表，不读取操作系统证书存储。`trustSystemCerts` 解决了在企业网络中因中间人代理导致的证书验证失败问题。

### Route Key

| 规则 | Key | 说明 |
|------|-----|------|
| Default | `default` | 所有 detector 都未命中时的兜底 |
| Image | `image` | 检测到图片内容时走的 route |
| Haiku | `haiku` | 请求模型名包含 `haiku` |
| Sonnet | `sonnet` | 请求模型名包含 `sonnet` |
| Opus | `opus` | 请求模型名包含 `opus` |

## 场景检测器

| 优先级 | 检测器 | 触发条件 |
|--------|--------|---------|
| 0 | **explicit** | 请求中包含逗号分隔的模型 ID |
| 5 | **image** | 消息中包含图片内容 |
| 8 | **modelFamily** | 模型 ID 包含 haiku / sonnet / opus 关键字 |

所有 detector 检查完后，代理还会尝试：

1. 直接把 `body.model` 当成 `providers` 里的 key 查找
2. 如果仍未命中，则使用 `routes.default`

## 自定义场景

创建 `~/.claude-custom-scenarios.mjs`（或设置 `$ROUTER_SCENARIOS_PATH`）添加自定义检测器：

```javascript
export const detectors = [
  {
    name: 'coding',        // 检测器名称
    priority: 15,           // 优先级（越小越先检查）
    detect(body, ctx) {
      // body: API 请求体
      // ctx: { tokenCount, config }
      if (!ctx.config.routes.coding) return null;
      const hasCodeTools = (body.tools || []).some(t =>
        t.name === 'Read' || t.name === 'Edit'
      );
      // 返回 route KEY，而不是 provider ID
      return hasCodeTools ? 'coding' : null;
    },
  },
];
```

然后在配置中添加路由规则：

```json
{
  "routes": {
    "coding": { "provider": "coding-provider-id" }
  }
}
```

> **注意**：自定义检测器应返回 **route key**（如 `'coding'`），而非 provider ID。代理会把 route 解析为单 provider 或命名 pool。直接返回 provider ID 仍然可以通过 direct lookup 生效，但推荐返回 route key。

完整示例见 [`examples/custom-scenarios.mjs`](examples/custom-scenarios.mjs)。

## CLI 命令

```bash
node src/custom-model-proxy.mjs          # 启动代理
node src/custom-model-proxy.mjs --stop   # 停止代理
node src/custom-model-proxy.mjs --status # 查看状态
```

## 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `ROUTER_CONFIG_PATH` | `~/.claude-custom-router.json` | 配置文件路径 |
| `ROUTER_SCENARIOS_PATH` | `~/.claude-custom-scenarios.mjs` | 自定义场景模块路径 |
| `ROUTER_PORT` | 配置文件中的端口（8082） | 覆盖代理端口 |
| `ROUTER_LOG_DIR` | `~/.claude-custom-router.d/logs` | 日志目录 |

## API 端点

| 端点 | 方法 | 说明 |
|------|------|------|
| `/health` | GET | 健康检查（返回 providers、routes、pool 状态、debug 状态） |
| `/v1/models` | GET | 以 Anthropic 模型列表格式返回已配置的 providers |
| `/v1/messages` | POST | 代理端点（路由到对应的模型） |
| 其他路径 | Any | 转发到默认模型的 base URL |

## 热重载

代理会监听配置文件变更并自动重载，无需重启。

## 调试模式

在配置中设置 `"debug": true` 启用请求/响应转储：

```
~/.claude-custom-router.d/logs/debug/
  └── <session-id>/
      ├── <timestamp>_<reqid>_<model>_req.json        # 原始请求
      ├── <timestamp>_<reqid>_<model>_processed.json  # 路由后请求
      └── <timestamp>_<reqid>_<model>_res.txt         # 响应内容
```

- 请求日志前缀会带上生成的 `reqid`，以及 `session_id` 存在时的前 6 位：`[reqid][session6]`。
- Debug 转储按 `session_id` 分目录；如果请求里没有 session，则回退到当天日期（`YYYYMMDD`）。
- 上游返回非 2xx 时，代理会把解码后的响应体写入日志；超长内容会被截断。

## 与 Claude Code 集成

在 shell 配置文件（`.zshrc` / `.bashrc`）中添加：

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:8082"
```

或者单次会话使用：

```bash
ANTHROPIC_BASE_URL="http://127.0.0.1:8082" claude
```

## 运行测试

```bash
npm test
```

使用 Node.js 内置测试运行器，零依赖。

## 系统要求

- Node.js >= 18.0.0
- 无需 npm 依赖

## 许可证

MIT
