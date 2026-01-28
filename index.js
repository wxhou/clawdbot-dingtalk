const express = require('express');
const { spawn } = require('child_process');
const crypto = require('crypto');
const axios = require('axios');
const url = require('url');

const app = express();
app.use(express.json());

const CONFIG = {
  dingtalkSecret: process.env.DINGTALK_SECRET || '',
  moltbotPath: process.env.MOLTBOT_PATH || 'moltbot',
  dingtalkWebhookUrl: process.env.DINGTALK_WEBHOOK_URL || '',
  dingtalkKeyword: process.env.DINGTALK_KEYWORD || '',
  sessionTimeout: 5 * 60 * 1000,
  rateLimitWindow: 1000,
  sessions: new Map(),
  requestLog: new Map()
};

function generateDingtalkSign(timestamp, secret) {
  const sign = crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}\n${secret}`)
    .digest('base64');
  return encodeURIComponent(sign);
}

async function sendToDingtalk(webhookUrl, message) {
  if (!webhookUrl) {
    console.error('未配置钉钉 WebHook URL');
    return false;
  }

  try {
    let finalUrl = webhookUrl;

    if (CONFIG.dingtalkSecret) {
      const timestamp = Date.now().toString();
      const parsedUrl = new url.URL(webhookUrl);
      parsedUrl.searchParams.set('timestamp', timestamp);
      parsedUrl.searchParams.set('sign', generateDingtalkSign(timestamp, CONFIG.dingtalkSecret));
      finalUrl = parsedUrl.toString();
    }

    await axios.post(finalUrl, { msgtype: 'text', text: { content: message } }, {
      headers: { 'Content-Type': 'application/json' }
    });
    return true;
  } catch (error) {
    console.error('发送钉钉消息失败:', error.response?.data || error.message);
    return false;
  }
}

function verifyDingtalkSignature(body, timestamp, sign) {
  if (!CONFIG.dingtalkSecret || !timestamp || !sign) {
    return true;
  }

  const computedSign = crypto
    .createHmac('sha256', CONFIG.dingtalkSecret)
    .update(`${timestamp}\n${CONFIG.dingtalkSecret}`)
    .digest('base64');

  return computedSign === decodeURIComponent(sign);
}

function parseDingtalkMessage(data) {
  if (data.msgtype === 'text' && data.text?.content) {
    return {
      type: 'text',
      content: data.text.content.trim(),
      userId: data.senderStaffId || data.senderId?.id || data.sender?.id,
      chatId: data.conversationId,
      isGroup: data.conversationType === 'group'
    };
  }
  return null;
}

async function sendToMoltbot(message, chatId) {
  return new Promise((resolve) => {
    try {
      const child = spawn(CONFIG.moltbotPath, ['agent', '--message', message, '--timeout', '120'], {
        timeout: 130000,
        killSignal: 'SIGTERM'
      });

      let stdout = '';
      let stderr = '';

      child.stdout.on('data', (data) => stdout += data.toString());
      child.stderr.on('data', (data) => stderr += data.toString());

      child.on('close', () => {
        resolve(stdout.trim() || stderr.trim() || '消息已发送，但未收到回复');
      });

      child.on('error', (error) => {
        console.error('执行 Moltbot 失败:', error.message);
        resolve(`处理失败: ${error.message}`);
      });

    } catch (error) {
      console.error('调用 Moltbot 失败:', error.message);
      resolve(`处理失败: ${error.message}`);
    }
  });
}

function getSessionId(chatId, userId) {
  return `${chatId}:${userId}`;
}

function cleanupSessions() {
  const now = Date.now();
  for (const [id, session] of CONFIG.sessions.entries()) {
    if (now - session.lastActivity > CONFIG.sessionTimeout) {
      CONFIG.sessions.delete(id);
    }
  }
}

function checkRateLimit(ip) {
  const now = Date.now();
  const lastRequest = CONFIG.requestLog.get(ip);

  if (lastRequest && now - lastRequest < CONFIG.rateLimitWindow) {
    return false;
  }

  CONFIG.requestLog.set(ip, now);

  for (const [key, time] of CONFIG.requestLog.entries()) {
    if (now - time > CONFIG.rateLimitWindow) {
      CONFIG.requestLog.delete(key);
    }
  }

  return true;
}

setInterval(cleanupSessions, CONFIG.sessionTimeout);

app.post('/webhook/dingtalk', async (req, res) => {
  try {
    const clientIp = req.ip || req.connection.remoteAddress;
    if (!checkRateLimit(clientIp)) {
      console.log('请求过于频繁:', clientIp);
      return res.status(429).json({ error: '请求过于频繁' });
    }

    const body = req.body;
    const timestamp = req.query.timestamp || req.headers['x-dingtalk-signature-timestamp'];
    const sign = req.query.sign || req.headers['x-dingtalk-signature'];

    if (timestamp && sign && !verifyDingtalkSignature(body, timestamp, sign)) {
      console.error('签名验证失败');
      return res.status(401).json({ error: '签名验证失败' });
    }

    const message = parseDingtalkMessage(body);
    if (!message) {
      console.log('忽略非消息类型:', JSON.stringify(body).substring(0, 200));
      return res.json({ status: 'ignored' });
    }

    if (CONFIG.dingtalkKeyword && !message.content.includes(CONFIG.dingtalkKeyword)) {
      console.log('消息不包含关键字，跳过');
      return res.json({ status: 'keyword_mismatch' });
    }

    console.log(`收到消息 [${message.isGroup ? '群' : '私'}聊] ${message.userId}: ${message.content}`);

    res.json({ status: 'ok' });

    (async () => {
      const sessionId = getSessionId(message.chatId, message.userId);

      if (CONFIG.sessions.has(sessionId)) {
        await sendToDingtalk(CONFIG.dingtalkWebhookUrl, '请稍候，我正在处理上一个请求...');
        return;
      }

      CONFIG.sessions.set(sessionId, { lastActivity: Date.now(), processing: true });

      try {
        const response = await sendToMoltbot(message.content, message.chatId);
        await sendToDingtalk(CONFIG.dingtalkWebhookUrl, response);
      } catch (error) {
        console.error('处理消息失败:', error);
        await sendToDingtalk(CONFIG.dingtalkWebhookUrl, '抱歉，处理消息时出错');
      } finally {
        CONFIG.sessions.delete(sessionId);
      }
    })();

  } catch (error) {
    console.error('处理 WebHook 失败:', error);
    res.status(500).json({ error: '内部错误' });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

app.get('/status', (req, res) => {
  res.json({
    status: 'ok',
    sessions: CONFIG.sessions.size,
    config: {
      hasDingtalkWebhookUrl: !!CONFIG.dingtalkWebhookUrl,
      hasSecret: !!CONFIG.dingtalkSecret,
      hasKeyword: !!CONFIG.dingtalkKeyword
    }
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Moltbot-Dingtalk Bridge started on port ${PORT}`);
  console.log(`WebHook: http://localhost:${PORT}/webhook/dingtalk`);
  console.log(`Health: http://localhost:${PORT}/health`);
});
