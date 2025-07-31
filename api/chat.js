const axios = require('axios');

// 延迟函数
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// 心跳包发送函数
function sendHeartbeat(res) {
  try {
    // 发送空的 SSE 注释行作为心跳包
    res.write(': heartbeat\n\n');
  } catch (error) {
    console.error('Failed to send heartbeat:', error);
  }
}

// 启动心跳定timer
function startHeartbeat(res, interval = 3000) {
  const heartbeatTimer = setInterval(() => {
    sendHeartbeat(res);
  }, interval);
  
  return heartbeatTimer;
}

// 停止心跳
function stopHeartbeat(timer) {
  if (timer) {
    clearInterval(timer);
  }
}

// 将文本分解为合理的块
function chunkText(text, chunkSize = 10) {
  const words = text.split(' ');
  const chunks = [];
  
  for (let i = 0; i < words.length; i += chunkSize) {
    chunks.push(words.slice(i, i + chunkSize).join(' '));
  }
  
  return chunks;
}

// 生成 SSE 格式的数据
function formatSSEData(data) {
  if (typeof data === 'string') {
    return `data: ${data}\n\n`;
  }
  return `data: ${JSON.stringify(data)}\n\n`;
}

module.exports = async (req, res) => {
  // 设置 CORS 头
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // 只允许 POST 请求
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { 
    model = 'gpt-3.5-turbo',
    messages,
    temperature = 0.7,
    max_tokens,
    stream = false, // 从请求中获取 stream 参数
    ...otherParams 
  } = req.body;

  // 验证必需参数
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ 
      error: { 
        message: 'messages is required and must be an array',
        type: 'invalid_request_error'
      }
    });
  }

  // 获取环境变量
  const apiKey = process.env.OPENAI_API_KEY;
  const sourceApiUrl = process.env.SOURCE_API_URL || 'https://api.openai.com';

  if (!apiKey) {
    return res.status(500).json({ 
      error: { 
        message: 'OPENAI_API_KEY environment variable is not set',
        type: 'server_error'
      }
    });
  }

  // 从请求头获取 API 密钥（如果提供）
  const authHeader = req.headers.authorization;
  let requestApiKey = apiKey;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    requestApiKey = authHeader.substring(7);
  }

  // 准备发送到源 API 的请求体
  // 强制设置 stream: false，以实现“假流式”
  const requestBody = {
    model,
    messages,
    temperature,
    stream: false, // 核心修改：始终以非流式请求源 API
    ...otherParams,
  };

  // 如果 max_tokens 存在，则添加到请求体中
  if (max_tokens !== undefined) {
    requestBody.max_tokens = max_tokens;
  }

  try {
    // 向源 API 发起非流式请求
    const response = await axios.post(`${sourceApiUrl}/v1/chat/completions`, requestBody, {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${requestApiKey}`,
      },
    });

    // 根据客户端请求的 stream 参数决定如何响应
    if (stream) {
      // 客户端需要流式响应，我们来模拟它
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');

      const heartbeatTimer = startHeartbeat(res);

      try {
        const fullContent = response.data.choices[0].message.content;
        const chunks = chunkText(fullContent, 10); // 将文本按10个单词分块

        // 模拟逐块发送
        for (const chunk of chunks) {
          const sseChunk = {
            id: `chatcmpl-${Date.now()}`,
            object: 'chat.completion.chunk',
            created: Math.floor(Date.now() / 1000),
            model: response.data.model || model,
            choices: [{
              index: 0,
              delta: { content: chunk + ' ' }, // 加上空格以获得更好的分词效果
              finish_reason: null,
            }],
          };
          res.write(formatSSEData(sseChunk));
          await delay(100); // 模拟打字延迟
        }

        // 发送最后一个空块，包含 finish_reason
        const finalChunk = {
          id: `chatcmpl-${Date.now()}`,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: response.data.model || model,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: response.data.choices[0].finish_reason || 'stop',
          }],
        };
        res.write(formatSSEData(finalChunk));

        // 发送结束标志
        res.write(formatSSEData('[DONE]'));

      } catch (error) {
        console.error('Error during fake stream generation:', error);
        const errorPayload = {
          error: {
            message: 'Error processing response from source API.',
            type: 'server_error'
          }
        };
        res.write(formatSSEData(errorPayload));
      } finally {
        stopHeartbeat(heartbeatTimer);
        res.end();
      }

    } else {
      // 客户端需要非流式响应，直接返回结果
      res.status(200).json(response.data);
    }

  } catch (error) {
    // 处理请求源 API 时发生的错误
    console.error('Error calling source API:', error.response ? error.response.data : error.message);
    const statusCode = error.response ? error.response.status : 500;
    const errorResponse = error.response ? error.response.data : { 
      error: { 
        message: 'An unexpected error occurred.',
        type: 'server_error'
      } 
    };
    res.status(statusCode).json(errorResponse);
  }
};