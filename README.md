# Vercel 假流式代理

这是一个部署在 Vercel 上的假流式代理，可以将非流式的 OpenAI API 响应转换为流式格式。

## 📋 功能特性

- 🚀 将非流式 API 转换为流式响应  
- 📡 支持 Server-Sent Events (SSE)
- 🔄 兼容 OpenAI API 格式
- ⚡ 部署在 Vercel 上，响应快速
- 🔧 支持自定义源 API 地址
- 💓 心跳包机制，防止长请求超时
- 🛡️ 完善的错误处理和 CORS 支持

## 🎯 工作原理

1. 接收客户端的流式请求
2. 向源 API 发送非流式请求（同时发送心跳包保持连接）
3. 将完整响应分解为多个 chunk
4. 通过 SSE 逐个发送 chunk 给客户端
5. 模拟真实的流式响应体验

## 🚀 部署到 Vercel

### 方法一：通过 Vercel 网站部署（推荐）

#### 1. 准备工作
- 注册 [Vercel 账号](https://vercel.com)
- 获取 [OpenAI API 密钥](https://platform.openai.com/api-keys)

#### 2. 部署步骤

**步骤 1：导入项目**
1. 访问 [vercel.com](https://vercel.com)
2. 点击 "New Project"
3. 选择 "Import Git Repository" 或直接拖拽项目文件夹
4. 如果使用 GitHub，先将代码推送到 GitHub 仓库

**步骤 2：配置项目**
1. 项目名称：输入如 `my-fake-stream-proxy`
2. Framework Preset：选择 "Other"
3. Root Directory：保持默认

**步骤 3：设置环境变量**
在部署前，点击 "Environment Variables" 添加：
```
OPENAI_API_KEY = sk-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
SOURCE_API_URL = https://api.openai.com (可选)
```

**步骤 4：部署**
1. 点击 "Deploy"
2. 等待 2-3 分钟完成部署
3. 获得类似 `https://your-project-name.vercel.app` 的 URL

### 方法二：使用 Vercel CLI

#### 1. 安装 CLI
```bash
npm install -g vercel
```

#### 2. 登录并部署
```bash
# 登录 Vercel
vercel login

# 在项目根目录运行部署
vercel

# 按提示回答问题：
# - Set up and deploy? Y
# - Which scope? 选择你的账号  
# - Link to existing project? N
# - Project name? my-fake-stream-proxy
# - Directory? ./
```

#### 3. 设置环境变量
```bash
# 添加 OpenAI API 密钥
vercel env add OPENAI_API_KEY
# 输入你的密钥：sk-xxxxxxxxxxxxxxxx

# 添加源 API URL（可选）
vercel env add SOURCE_API_URL  
# 输入：https://api.openai.com
```

#### 4. 重新部署
```bash
vercel --prod
```

## 🧪 本地测试

在部署前，你可以在本地测试：

### 1. 安装依赖
```bash
npm install
```

### 2. 配置环境变量
复制 `.env.example` 为 `.env.local`：
```bash
cp .env.example .env.local
```

编辑 `.env.local`：
```
OPENAI_API_KEY=your_openai_api_key_here
SOURCE_API_URL=https://api.openai.com
```

### 3. 启动本地服务器
```bash
npm run local
```

### 4. 访问测试页面
打开浏览器访问：`http://localhost:3000`

## 📖 使用方法

### 1. 基本用法

部署完成后，你会得到一个 Vercel URL，例如：`https://your-project.vercel.app`

#### 流式请求
```bash
curl -X POST https://your-project.vercel.app/api/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "model": "gpt-3.5-turbo",
    "messages": [{"role": "user", "content": "你好！"}],
    "stream": true
  }'
```

#### 非流式请求
```bash
curl -X POST https://your-project.vercel.app/api/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "model": "gpt-3.5-turbo", 
    "messages": [{"role": "user", "content": "你好！"}],
    "stream": false
  }'
```

### 2. 在客户端代码中使用

#### Python 示例
```python
import openai

# 配置使用你的代理
openai.api_base = "https://your-project.vercel.app/v1"
openai.api_key = "your-api-key"

# 流式请求
response = openai.ChatCompletion.create(
    model="gpt-3.5-turbo",
    messages=[{"role": "user", "content": "你好！"}],
    stream=True
)

for chunk in response:
    content = chunk.choices[0].delta.get('content', '')
    if content:
        print(content, end='', flush=True)
```

#### JavaScript 示例
```javascript
import OpenAI from 'openai';

const openai = new OpenAI({
  apiKey: 'your-api-key',
  baseURL: 'https://your-project.vercel.app/v1',
});

const stream = await openai.chat.completions.create({
  model: 'gpt-3.5-turbo',
  messages: [{ role: 'user', content: '你好！' }],
  stream: true,
});

for await (const chunk of stream) {
  const content = chunk.choices[0]?.delta?.content || '';
  if (content) {
    process.stdout.write(content);
  }
}
```

#### 前端 JavaScript (fetch API)
```javascript
const response = await fetch('https://your-project.vercel.app/api/chat', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'Authorization': 'Bearer your-api-key',
  },
  body: JSON.stringify({
    model: 'gpt-3.5-turbo',
    messages: [{ role: 'user', content: '你好！' }],
    stream: true,
  }),
});

const reader = response.body.getReader();
const decoder = new TextDecoder();

while (true) {
  const { done, value } = await reader.read();
  if (done) break;

  const chunk = decoder.decode(value);
  const lines = chunk.split('\n');

  for (const line of lines) {
    if (line.startsWith('data: ')) {
      const data = line.slice(6);
      if (data === '[DONE]') break;
      
      try {
        const parsed = JSON.parse(data);
        const content = parsed.choices?.[0]?.delta?.content || '';
        if (content) {
          console.log(content);
        }
      } catch (e) {
        // 忽略解析错误
      }
    }
  }
}
```

### 3. 测试页面

部署后访问你的 Vercel URL 根路径（如：`https://your-project.vercel.app`），会看到一个内置的测试页面，可以：

- 输入 API 密钥
- 选择模型
- 测试流式和非流式响应
- 查看实时响应效果

### 4. 状态检查

访问 `/api/status` 端点检查服务状态：
```bash
curl https://your-project.vercel.app/api/status
```

返回示例：
```json
{
  "status": "ok",
  "message": "假流式代理服务正常运行",
  "timestamp": "2025-07-31T10:30:00.000Z",
  "version": "1.0.0",
  "features": {
    "streaming": true,
    "non_streaming": true,
    "cors": true
  },
  "environment": {
    "has_api_key": true,
    "source_api_url": "https://api.openai.com"
  }
}
```

## ⚙️ 环境变量配置

| 变量名 | 描述 | 必需 | 默认值 |
|--------|------|------|--------|
| `OPENAI_API_KEY` | OpenAI API 密钥 | ✅ | - |
| `SOURCE_API_URL` | 源 API 基础 URL | ❌ | `https://api.openai.com` |

### 在 Vercel 中管理环境变量

1. 登录 Vercel 控制台
2. 进入你的项目
3. 点击 "Settings" > "Environment Variables"
4. 添加或修改环境变量
5. 重新部署以应用更改

## 🔧 高级配置

### 自定义域名

1. 在 Vercel 控制台中，进入项目设置
2. 点击 "Domains" 
3. 添加你的自定义域名
4. 根据提示配置 DNS 记录

### 使用不同的源 API

你可以将代理指向任何兼容 OpenAI 格式的 API：

```bash
# 通过环境变量配置
vercel env add SOURCE_API_URL
# 输入其他 API 地址，如：
# https://api.anthropic.com
# https://api.cohere.ai
# https://your-custom-api.com
```

## 🔍 故障排除

### 常见问题

#### Q1: 部署后出现 500 错误
**A:** 检查环境变量是否正确设置，特别是 `OPENAI_API_KEY`

#### Q2: API 密钥无效错误
**A:** 确保 OpenAI API 密钥正确，并且账户有足够余额

#### Q3: 流式响应不工作
**A:** 确保客户端正确处理 Server-Sent Events (SSE) 格式

#### Q4: 连接超时
**A:** 代理已内置心跳包机制，如仍有问题请检查网络配置

#### Q5: CORS 错误
**A:** 代理已设置 CORS 头，如有问题请检查请求头格式

### 查看日志

1. 登录 Vercel 控制台
2. 进入你的项目
3. 点击 "Functions" 标签页
4. 查看实时日志和错误信息

## 📊 监控和维护

### 使用量监控

在 Vercel 控制台中查看：
- 函数调用次数
- 带宽使用量
- 错误率统计

### 更新代码

1. **通过 Git**：推送到 GitHub 会自动触发重新部署
2. **通过 CLI**：运行 `vercel --prod` 手动部署

### 成本控制

- 监控 OpenAI API 使用量
- 设置 Vercel 使用量告警
- 考虑添加请求频率限制

## 🧪 测试和开发

### 本地测试脚本

```bash
# 基本功能测试
npm test

# 心跳包功能测试
npm run test:heartbeat
```

### 性能测试

```bash
# 测试并发请求
curl -X POST https://your-project.vercel.app/api/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{
    "model": "gpt-3.5-turbo",
    "messages": [{"role": "user", "content": "测试消息"}],
    "stream": true
  }' &
```

## 📝 技术细节

### 心跳包机制

为防止长请求超时，代理实现了心跳包机制：
- 每3秒发送心跳包保持连接
- 自动在响应完成后停止心跳
- 监听客户端断开事件

### 错误处理

- API 密钥验证
- 请求参数验证  
- 源 API 错误转发
- 网络异常处理
- 资源清理保证

### 安全考虑

- 使用环境变量存储敏感信息
- 支持自定义 API 密钥
- CORS 头正确配置
- 输入参数验证

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

### 开发设置

```bash
# 克隆项目
git clone https://github.com/your-username/vercel-fake-stream-proxy.git

# 安装依赖
npm install

# 创建环境变量文件
cp .env.example .env.local

# 启动开发服务器
npm run local
```

## 📄 许可证

MIT License

## 🔗 相关链接

- [Vercel 文档](https://vercel.com/docs)
- [OpenAI API 文档](https://platform.openai.com/docs)
- [Server-Sent Events 规范](https://developer.mozilla.org/en-US/docs/Web/API/Server-sent_events)

---

## ⚠️ 重要提醒

- 🔐 **API 密钥安全**：永远不要在代码中硬编码 API 密钥
- 💰 **成本控制**：监控 OpenAI API 使用量，避免意外费用
- 🔄 **限制频率**：考虑为生产环境添加请求频率限制
- 📋 **日志记录**：保留必要的请求日志用于调试和监控

**这是一个"假"流式实现**，实际上是先获取完整响应再分块发送。适用于源 API 不支持流式但你需要流式体验的场景。
