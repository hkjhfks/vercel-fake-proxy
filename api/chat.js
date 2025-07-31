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
  return `data: ${JSON.stringify(data)}\n\n`;
}

export default async function handler(req, res) {
  // 只允许 POST 请求
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // 设置 CORS 头
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  try {
    const { 
      model = 'gpt-3.5-turbo',
      messages,
      temperature = 0.7,
      max_tokens,
      stream = false,
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

    // 如果不是流式请求，直接转发
    if (!stream) {
      try {
        const response = await axios.post(
          `${sourceApiUrl}/v1/chat/completions`,
          {
            model,
            messages,
            temperature,
            max_tokens,
            stream: false,
            ...otherParams
          },
          {
            headers: {
              'Authorization': `Bearer ${requestApiKey}`,
              'Content-Type': 'application/json'
            }
          }
        );

        return res.json(response.data);
      } catch (error) {
        console.error('API Error:', error.response?.data || error.message);
        return res.status(error.response?.status || 500).json(
          error.response?.data || { 
            error: { 
              message: 'Internal server error',
              type: 'server_error'
            }
          }
        );
      }
    }

    // 流式请求处理
    console.log('Processing streaming request...');

    // 设置 SSE 头
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    // 启动心跳定时器，每3秒发送一次心跳包
    const heartbeatTimer = startHeartbeat(res, 3000);

    // 监听客户端断开连接
    req.on('close', () => {
      console.log('Client disconnected, stopping heartbeat...');
      stopHeartbeat(heartbeatTimer);
    });

    req.on('error', (err) => {
      console.error('Request error:', err);
      stopHeartbeat(heartbeatTimer);
    });

    try {
      // 向源 API 发送非流式请求
      console.log('Sending request to source API...');
      
      const response = await axios.post(
        `${sourceApiUrl}/v1/chat/completions`,
        {
          model,
          messages,
          temperature,
          max_tokens,
          stream: false,
          ...otherParams
        },
        {
          headers: {
            'Authorization': `Bearer ${requestApiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: 300000 // 5分钟超时
        }
      );

      // 停止心跳定时器，因为我们已经收到响应
      stopHeartbeat(heartbeatTimer);
      
      console.log('Received response from source API, starting fake streaming...');

      const fullResponse = response.data;
      const content = fullResponse.choices[0]?.message?.content || '';

      // 将内容分解为块
      const chunks = chunkText(content, 8);
      const totalChunks = chunks.length;

      // 生成唯一 ID
      const chatId = `chatcmpl-${Date.now()}${Math.random().toString(36).substr(2, 9)}`;

      // 发送开始的流式响应
      const startChunk = {
        id: chatId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: fullResponse.model,
        choices: [{
          index: 0,
          delta: {
            role: 'assistant',
            content: ''
          },
          finish_reason: null
        }]
      };

      res.write(formatSSEData(startChunk));
      await delay(100);

      // 逐个发送内容块
      for (let i = 0; i < totalChunks; i++) {
        const chunk = {
          id: chatId,
          object: 'chat.completion.chunk',
          created: Math.floor(Date.now() / 1000),
          model: fullResponse.model,
          choices: [{
            index: 0,
            delta: {
              content: chunks[i] + (i < totalChunks - 1 ? ' ' : '')
            },
            finish_reason: null
          }]
        };

        res.write(formatSSEData(chunk));
        
        // 模拟流式延迟
        await delay(50 + Math.random() * 100);
      }

      // 发送结束块
      const endChunk = {
        id: chatId,
        object: 'chat.completion.chunk',
        created: Math.floor(Date.now() / 1000),
        model: fullResponse.model,
        choices: [{
          index: 0,
          delta: {},
          finish_reason: 'stop'
        }]
      };

      res.write(formatSSEData(endChunk));

      // 发送完成信号
      res.write('data: [DONE]\n\n');
      res.end();

    } catch (error) {
      // 确保停止心跳定时器
      stopHeartbeat(heartbeatTimer);
      
      console.error('Streaming Error:', error.response?.data || error.message);
      
      // 发送错误信息
      const errorData = {
        error: {
          message: error.response?.data?.error?.message || 'Internal server error',
          type: error.response?.data?.error?.type || 'server_error',
          code: error.response?.data?.error?.code || null
        }
      };

      res.write(formatSSEData(errorData));
      res.end();
    }

  } catch (error) {
    console.error('Handler Error:', error);
    
    if (!res.headersSent) {
      return res.status(500).json({ 
        error: { 
          message: 'Internal server error',
          type: 'server_error'
        }
      });
    }
  }
}

// CommonJS 兼容性导出
module.exports = handler;
