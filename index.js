/**
 * Moltbot-Dingtalk 桥接服务
 *
 * 功能：
 * 1. 接收钉钉群机器人的 WebHook 消息
 * 2. 调用 Moltbot CLI 发送消息给 agent
 * 3. 将 agent 回复发送回钉钉
 */

const express = require('express');
const { exec } = require('child_process');
const { promisify } = require('util');
const crypto = require('crypto');

const execAsync = promisify(exec);

const app = express();
app.use(express.json());

// 配置
const CONFIG = {
  // 钉钉机器人 WebHook 密钥（安全设置）
  dingtalkSignKey: process.env.DINGTALK_SIGN_KEY || '',

  // Moltbot CLI 路径（如果不在 PATH 中，需要完整路径）
  moltbotPath: process.env.MOLTBOT_PATH || 'moltbot',

  // 钉钉 WebHook URL（用于发送消息回钉钉）
  dingtalkWebhookUrl: process.env.DINGTALK_WEBHOOK_URL || '',

  // 钉钉关键字（用于验证消息）
  dingtalkKeyword: process.env.DINGTALK_KEYWORD || 'Moltbot',

  // 会话超时（毫秒）
  sessionTimeout: 5 * 60 * 1000,

  // 会话存储
  sessions: new Map()
};

// 签名验证（钉钉安全设置）
function verifySignature(timestamp, sign, body) {
  if (!CONFIG.dingtalkSignKey) return true;

  const stringToSign = `${timestamp}\n${CONFIG.dingtalkSignKey}`;
  const hmac = crypto.createHmac('sha256', CONFIG.dingtalkSignKey);
  hmac.update(stringToSign);
  const computedSign = hmac.digest('base64');

  return sign === computedSign;
}

// 解析钉钉消息
function parseDingtalkMessage(data) {
  // 文本消息
  if (data.text?.content) {
    return {
      type: 'text',
      content: data.text.content.trim(),
      userId: data.senderStaffId || data.senderId?.id,
      chatId: data.conversationId,
      isGroup: data.conversationType === 'group'
    };
  }

  return null;
}

// 发送消息到钉钉
async function sendToDingtalk(webhookUrl, message) {
  if (!webhookUrl) {
    console.error('未配置钉钉 WebHook URL');
    return false;
  }

  const payload = {
    msgtype: 'text',
    text: {
      content: message
    }
  };

  try {
    const axios = require('axios');
    await axios.post(webhookUrl, payload);
    return true;
  } catch (error) {
    console.error('发送钉钉消息失败:', error.message);
    return false;
  }
}

// 调用 Moltbot 发送消息
async function sendToMoltbot(message, chatId) {
  try {
    // 使用 moltbot agent 命令发送消息
    const { stdout, stderr } = await execAsync(
      `${CONFIG.moltbotPath} agent --message "${message.replace(/"/g, '\\"')}" --timeout 120`,
      { timeout: 130000 }
    );

    // 解析输出
    const response = stdout.trim();

    // 如果输出为空，尝试从 stderr 获取
    if (!response && stderr) {
      return stderr.trim();
    }

    return response || '消息已发送，但未收到回复';
  } catch (error) {
    console.error('调用 Moltbot 失败:', error.message);

    // 超时等情况
    if (error.killed) {
      return '处理超时，请稍后再试';
    }

    return `处理失败: ${error.message}`;
  }
}

// 获取会话 ID
function getSessionId(chatId, userId) {
  return `${chatId}:${userId}`;
}

// 清理过期会话
function cleanupSessions() {
  const now = Date.now();
  for (const [id, session] of CONFIG.sessions.entries()) {
    if (now - session.lastActivity > CONFIG.sessionTimeout) {
      CONFIG.sessions.delete(id);
    }
  }
}

// 定时清理会话
setInterval(cleanupSessions, CONFIG.sessionTimeout);

// WebHook 端点
app.post('/webhook/dingtalk', async (req, res) => {
  try {
    const { header, body } = req.body;

    // 验证签名（如果配置了）
    const timestamp = req.headers['x-dingtalk-signature-timestamp'];
    const sign = req.headers['x-dingtalk-signature'];

    if (timestamp && sign && !verifySignature(timestamp, sign, body)) {
      console.error('签名验证失败');
      return res.status(401).json({ error: '签名验证失败' });
    }

    // 解析消息
    const message = parseDingtalkMessage(body);
    if (!message) {
      console.log('忽略非文本消息:', JSON.stringify(body));
      return res.json({ status: 'ignored' });
    }

    // 检查关键字（如果配置了）
    if (CONFIG.dingtalkKeyword && !message.content.includes(CONFIG.dingtalkKeyword)) {
      console.log('消息不包含关键字，跳过');
      return res.json({ status: 'keyword_mismatch' });
    }

    console.log(`收到消息 [${message.isGroup ? '群' : '私'}聊] ${message.userId}: ${message.content}`);

    // 发送确认（钉钉要求快速响应）
    res.json({ status: 'ok' });

    // 处理消息（异步）
    (async () => {
      // 获取会话 ID
      const sessionId = getSessionId(message.chatId, message.userId);

      // 检查是否正在处理
      if (CONFIG.sessions.has(sessionId)) {
        const session = CONFIG.sessions.get(sessionId);
        await sendToDingtalk(CONFIG.dingtalkWebhookUrl, '请稍候，我正在思考...');
        return;
      }

      // 创建会话
      CONFIG.sessions.set(sessionId, {
        lastActivity: Date.now(),
        processing: true
      });

      try {
        // 调用 Moltbot
        const response = await sendToMoltbot(message.content, message.chatId);

        // 发送回复
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

// 健康检查端点
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// 状态端点
app.get('/status', (req, res) => {
  res.json({
    status: 'ok',
    sessions: CONFIG.sessions.size,
    config: {
      hasDingtalkWebhookUrl: !!CONFIG.dingtalkWebhookUrl,
      hasSignKey: !!CONFIG.dingtalkSignKey
    }
  });
});

// 启动服务
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Moltbot-Dingtalk Bridge started on port ${PORT}`);
  console.log(`   WebHook 端点: http://localhost:${PORT}/webhook/dingtalk`);
  console.log(`   健康检查: http://localhost:${PORT}/health`);
});
