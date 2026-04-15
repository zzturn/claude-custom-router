# Claude Custom Router

[English](README.md) | 中文

一个轻量级、零依赖的代理服务器，根据场景检测将 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 的 API 请求路由到不同的 LLM 提供商。

## 为什么需要它？

Claude Code 默认将所有请求发送到 Anthropic 的 API。如果你想要：

- 后台任务使用**便宜的模型**，复杂任务保留 Claude
- 图片请求路由到**视觉模型**
- 长上下文使用**大窗口模型**
- 扩展思考使用**推理专用模型**

这个代理帮你自动完成。

## 工作原理

```
Claude Code ──▶ 场景检测链 ──▶ 匹配模型 ──▶ 转发到对应提供商
                 │
                 ├── explicit   (优先级 0)  显式模型覆盖
                 ├── image      (优先级 5)  图片检测
                 ├── longContext (优先级 10) 长上下文
                 ├── subagent   (优先级 20) 子代理标签
                 ├── background (优先级 30) 后台任务
                 ├── webSearch  (优先级 40) 网页搜索
                 ├── think      (优先级 50) 扩展思考
                 └── [自定义场景...]       可扩展
```

请求按优先级依次经过所有检测器，第一个匹配成功的决定目标模型。

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
  "Router": {
    "default": "默认模型ID",
    "longContext": "长上下文模型ID",
    "longContextThreshold": 60000,
    "image": "视觉模型ID",
    "background": "轻量模型ID",
    "think": "推理模型ID",
    "webSearch": "搜索模型ID"
  },
  "models": {
    "模型ID": {
      "name": "实际模型名称",
      "baseURL": "https://api.provider.com/v1",
      "apiKey": "${环境变量名}",
      "maxTokens": 8192
    }
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

### 支持的提供商

只要提供商兼容 Anthropic API 格式，就可以直接使用。常见配置：

| 提供商 | baseURL 示例 |
|--------|-------------|
| Anthropic | `https://api.anthropic.com/v1` |
| 智谱 GLM | `https://open.bigmodel.cn/api/anthropic` |
| DeepSeek | `https://api.deepseek.com/anthropic` |
| 阿里 Qwen | `https://dashscope.aliyuncs.com/apps/anthropic` |

## 场景检测器

| 优先级 | 检测器 | 触发条件 |
|--------|--------|---------|
| 0 | **explicit** | 请求中包含逗号分隔的模型 ID |
| 5 | **image** | 消息中包含图片内容 |
| 10 | **longContext** | 估算 token 数超过阈值（默认 60k） |
| 20 | **subagent** | system prompt 中包含 `<CCR-SUBAGENT-MODEL>` 标签 |
| 30 | **background** | 检测到 Haiku 模型请求 |
| 40 | **webSearch** | 请求包含 `web_search` 类型工具 |
| 50 | **think** | 请求包含 `thinking` 参数 |

### 子代理模型指定

在子代理的 system prompt 中嵌入模型标签即可指定使用的模型：

```
<CCR-SUBAGENT-MODEL>my-model</CCR-SUBAGENT-MODEL>你是一个有用的助手...
```

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
      if (!ctx.config.Router.coding) return null;
      const hasCodeTools = (body.tools || []).some(t =>
        t.name === 'Read' || t.name === 'Edit'
      );
      return hasCodeTools ? ctx.config.Router.coding : null;
    },
  },
];
```

然后在配置中添加路由规则：

```json
{
  "Router": {
    "coding": "coding-model-id"
  }
}
```

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

## 热重载

代理会监听配置文件变更并自动重载，无需重启。

## 调试模式

在配置中设置 `"debug": true` 启用请求/响应转储：

```
~/.claude-custom-router.d/logs/debug/
  └── <session-id>/
      ├── <timestamp>_<random>_<model>_req.json       # 原始请求
      ├── <timestamp>_<random>_<model>_processed.json  # 路由后请求
      └── <timestamp>_<random>_<model>_res.txt         # 响应内容
```

## 与 Claude Code 集成

在 shell 配置文件（`.zshrc` / `.bashrc`）中添加：

```bash
export ANTHROPIC_BASE_URL="http://127.0.0.1:8082"
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
