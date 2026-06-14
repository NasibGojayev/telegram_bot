# 🤖 Telegram Funny Bot

A Node.js Telegram bot that generates funny jokes, random facts, and playful roasts using the Gemini AI API.

## ✨ Features

- **🎭 /joke** - Get hilarious jokes
- **📚 /fact** - Learn weird funny facts
- **💬 /mock @username** - Create playful roasts
- **📖 /help** - Show all commands

## 🚀 Quick Start

### 1. Prerequisites
- Node.js (v14 or higher)
- npm or yarn
- A Telegram account
- Telegram bot token (from BotFather)
- Gemini API key

### 2. Get Your Telegram Bot Token

1. Open Telegram and search for **@BotFather**
2. Send `/start` and then `/newbot`
3. Follow the prompts to name your bot
4. Copy the **API token** provided
5. Optional: Send `/setcommands` to BotFather and add:
   ```
   joke - Get a funny joke
   fact - Get a random fact
   mock - Roast someone
   help - Show all commands
   ```

### 3. Setup Environment Variables

```bash
# Copy the example file
cp .env.example .env

# Edit .env and add your credentials
# TELEGRAM_TOKEN=your_bot_token_here
# GEMINI_API_KEY=your_gemini_key_here
```

### 4. Install Dependencies

```bash
npm install
```

### 5. Run the Bot Locally

```bash
# Start the bot
npm start

# Or for development with auto-reload
npm run dev
```

You should see:
```
✅ Bot is running and listening for commands...
```

## 🧪 Testing

1. Open Telegram and find your bot (search by the bot username you created)
2. Send `/start` or `/help` to see commands
3. Try `/joke`, `/fact`, or `/mock @username`

## 🌐 Deployment Options

### Option A: Heroku (Free tier deprecated, use Railway instead)

#### Deploy to Railway:
1. Push your code to GitHub
2. Go to [Railway.app](https://railway.app)
3. Create new project → "Deploy from GitHub"
4. Select your repository
5. Add environment variables in Railway dashboard:
   - `TELEGRAM_TOKEN`
   - `GEMINI_API_KEY`
6. Railway will auto-deploy when you push to main

### Option B: Google Cloud Run (Good Free Tier)

```bash
# 1. Create a Dockerfile
cat > Dockerfile << 'EOF'
FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --only=production
COPY . .
CMD ["npm", "start"]
EOF

# 2. Deploy to Cloud Run
gcloud run deploy telegram-funny-bot \
  --source . \
  --platform managed \
  --region us-central1 \
  --set-env-vars TELEGRAM_TOKEN=xxx,GEMINI_API_KEY=xxx
```

### Option C: Keep Running Locally (VPS/Server)

Using PM2 for process management:

```bash
# Install PM2 globally
npm install -g pm2

# Start bot with PM2
pm2 start bot.js --name "telegram-bot"

# Make it run on restart
pm2 startup
pm2 save

# Check status
pm2 status
```

### Option D: Docker Compose

```bash
# Build and run with Docker
docker build -t telegram-funny-bot .
docker run -e TELEGRAM_TOKEN=xxx -e GEMINI_API_KEY=xxx telegram-funny-bot
```

## 📝 Environment Variables

| Variable | Description |
|----------|-------------|
| `TELEGRAM_TOKEN` | Your Telegram bot token from BotFather |
| `GEMINI_API_KEY` | Your Google Gemini API key |

## 🐛 Troubleshooting

**Bot not responding?**
- Check `TELEGRAM_TOKEN` is correct
- Verify bot is running: `npm start`
- Check logs for errors

**Gemini API errors?**
- Verify `GEMINI_API_KEY` is correct
- Check API quota at [Google Cloud Console](https://console.cloud.google.com)
- Ensure API is enabled in your project

**Polling errors?**
- Normal if bot restarts. It will reconnect automatically.
- Check internet connection

## 📚 Project Structure

```
telegram-funny-bot/
├── bot.js              # Main bot logic
├── package.json        # Dependencies
├── .env.example        # Environment template
├── .env                # Your credentials (don't commit!)
├── .gitignore          # Git ignore rules
└── README.md           # This file
```

## 🔐 Security Notes

⚠️ **IMPORTANT:**
- **NEVER** commit `.env` file (contains API keys!)
- Add `.env` to `.gitignore` (already recommended)
- Rotate keys if accidentally exposed
- Use environment variables, never hardcode secrets

## 💡 Customization

### Add More Commands

Edit `bot.js` and add:

```javascript
bot.onText(/\/yourcommand/, async (msg) => {
  const chatId = msg.chat.id;
  const prompt = 'Your Gemini prompt here';
  const result = await callGemini(prompt);
  bot.sendMessage(chatId, result);
});
```

### Modify Prompts

Edit the `prompt` strings in each command handler to customize behavior.

## 📞 Support

For issues:
- Check [node-telegram-bot-api docs](https://github.com/yagop/node-telegram-bot-api)
- Review [Gemini API docs](https://ai.google.dev)

## 📄 License

MIT
