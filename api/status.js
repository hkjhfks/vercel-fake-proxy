module.exports = async (req, res) => {
  // 设置 CORS 头
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // 只允许 GET 请求
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const status = {
    status: 'ok',
    message: '假流式代理服务正常运行',
    timestamp: new Date().toISOString(),
    version: '1.0.0',
    features: {
      streaming: true,
      non_streaming: true,
      cors: true
    },
    endpoints: {
      chat: '/api/chat',
      status: '/api/status',
      test_page: '/'
    },
    environment: {
      has_api_key: !!process.env.OPENAI_API_KEY,
      source_api_url: process.env.SOURCE_API_URL || 'https://api.openai.com'
    }
  };

  res.json(status);
};