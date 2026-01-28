# Moltbot-Dingtalk Bridge

通过钉钉群机器人与 Moltbot AI 助手对接的桥接服务。

## 功能特点

- 接收钉钉群机器人的 WebHook 消息
- 调用 Moltbot CLI 与 AI 对话
- 将 AI 回复发送回钉钉群
- 支持签名验证和关键词验证
- Docker 部署支持

## 快速开始

### 1. 克隆项目

\`\`\`bash
git clone https://github.com/你的用户名/moltbot-dingtalk.git
cd moltbot-dingtalk
\`\`\`

### 2. 配置环境变量

\`\`\`bash
cp .env.example .env
\`\`\`

编辑 .env 文件，配置钉钉 WebHook 和 Moltbot Token。

### 3. 运行服务

\`\`\`bash
# 本地运行
npm install
npm start

# 或使用 Docker
docker compose up -d
\`\`\`

## 钉钉配置

1. 在钉钉群中添加自定义机器人
2. 选择安全设置（关键词或签名验证）
3. 复制 WebHook URL
4. 在 .env 中配置相关参数

## 详细文档

请查看 [README.md](./README.md)

## License

MIT

