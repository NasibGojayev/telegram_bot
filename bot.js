require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { GoogleGenAI } = require('@google/genai');
const { OpenAI } = require('openai');
const fs = require('fs');

// Initialize bot with your token
const token = process.env.TELEGRAM_TOKEN;
const bot = new TelegramBot(token, { polling: true });

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

const GROQ_API_KEY = process.env.GROQ_API_KEY;
let groqClient;
if (GROQ_API_KEY) {
  groqClient = new OpenAI({
    apiKey: GROQ_API_KEY,
    baseURL: 'https://api.groq.com/openai/v1',
  });
} else {
  console.warn('Warning: GROQ_API_KEY is not set. Groq fallback will be disabled.');
}

let botUsername = process.env.BOT_USERNAME ? process.env.BOT_USERNAME.toLowerCase() : null;
const PRIMARY_USERNAMES = process.env.PRIMARY_USERNAMES
  ? process.env.PRIMARY_USERNAMES.split(',').map((s) => s.trim().replace(/^@/, '').toLowerCase())
  : [];

// fetch bot username if not provided in env
bot.getMe && bot.getMe().then((me) => {
  try {
    botUsername = botUsername || (me.username && me.username.toLowerCase());
  } catch (e) {
    /* ignore */
  }
});

console.log('🤖 Funny Telegram Bot started!');

// persistent registered username -> profileKey mapping
const PROFILES_FILE = './profiles.json';
let registeredProfiles = {};
try {
  if (fs.existsSync(PROFILES_FILE)) {
    registeredProfiles = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8') || '{}');
  }
} catch (e) {
  registeredProfiles = {};
}

function saveRegisteredProfiles() {
  try {
    fs.writeFileSync(PROFILES_FILE, JSON.stringify(registeredProfiles, null, 2));
  } catch (e) {
    console.error('Failed to save profiles', e);
  }
}

// roles persistence
const ROLES_FILE = './roles.json';
let rolesMapping = {};
try {
  if (fs.existsSync(ROLES_FILE)) {
    rolesMapping = JSON.parse(fs.readFileSync(ROLES_FILE, 'utf8') || '{}');
  }
} catch (e) {
  rolesMapping = {};
}

function saveRoles() {
  try {
    fs.writeFileSync(ROLES_FILE, JSON.stringify(rolesMapping, null, 2));
  } catch (e) {
    console.error('Failed to save roles', e);
  }
}

function getRoleForUsername(username) {
  if (!username) return null;
  return rolesMapping[username.replace(/^@/, '').toLowerCase()] || null;
}

// per-chat chatty settings persistence
const CHAT_SETTINGS_FILE = './chatty.json';
let chattySettings = {};
try {
  if (fs.existsSync(CHAT_SETTINGS_FILE)) {
    chattySettings = JSON.parse(fs.readFileSync(CHAT_SETTINGS_FILE, 'utf8') || '{}');
  }
} catch (e) {
  chattySettings = {};
}

function saveChattySettings() {
  try {
    fs.writeFileSync(CHAT_SETTINGS_FILE, JSON.stringify(chattySettings, null, 2));
  } catch (e) {
    console.error('Failed to save chatty settings', e);
  }
}

// Helper function to call Groq fallback API
async function callGroq(prompt) {
  if (!GROQ_API_KEY) {
    console.error('Groq fallback requested but GROQ_API_KEY is not configured.');
    return '❌ Oops! The fallback service is not configured. Please set GROQ_API_KEY.';
  }

  try {
    const response = await groqClient.responses.create({
      model: 'openai/gpt-oss-20b',
      input: prompt,
    });

    return (
      response.output_text ||
      (Array.isArray(response.output)
        ? response.output
            .map((output) =>
              Array.isArray(output.content)
                ? output.content.map((item) => item?.text || '').join('')
                : ''
            )
            .join(' ')
        : '') ||
      '❌ Oops! Groq is taking a nap. Try again later!'
    );
  } catch (error) {
    console.error('Groq API Error:', error.response?.data || error.message);
    return '❌ Oops! Groq is taking a nap. Try again later!';
  }
}

// Helper function to call Gemini API
async function callGemini(prompt) {
  try {
    const response = await ai.models.generateContent({
      model: 'gemini-3.5-flash',
      contents: prompt,
    });

    const text = response.text || response.output?.[0]?.content?.[0]?.text || '';
    if (text && text.trim()) {
      return text;
    }

    console.warn('Gemini returned no usable text, falling back to Groq.');
    return await callGroq(prompt);
  } catch (error) {
    console.error('Gemini API Error:', error.response?.data || error.message);
    return await callGroq(prompt);
  }
}

const groupProfiles = [
  {
    patterns: [/\bPavi\b/i],
    nickname: 'owner',
    note: 'Pavi is Tamil and lives in Malaysia.',
    hint: 'Always call him owner when referring to him.',
  },
  {
    patterns: [/\bYU\b/i, /\bAbangYU\b/i, /\babangYU\b/i],
    nickname: 'abangYU',
    fallback: 'uncle',
    note: 'YU should be addressed as abangYU or uncle.',
    hint: 'Use abangYU when you can, otherwise uncle is fine.',
  },
  {
    patterns: [/\bCeli\b/i, /\bCEC?EL\b/i, /\bamoy\b/i],
    nickname: 'the pretty girl',
    note: 'Celi is CECEL and her admin tag is amoy pretty.',
    hint: 'Mention that she is the pretty girl in the group.',
  },
  {
    patterns: [/\bAddy\b/i],
    nickname: 'uncle',
    note: 'Addy is from Brunei, about 30 years old, and will get married soon.',
    hint: 'Call him uncle and keep the tone gentle.',
  },
];

function findMentionedProfiles(text) {
  return groupProfiles.filter((profile) =>
    profile.patterns.some((pattern) => pattern.test(text))
  );
}

function findProfilesByUsername(username) {
  if (!username) return [];
  const key = username.replace(/^@/, '').toLowerCase();
  const profileKey = registeredProfiles[key];
  if (!profileKey) return [];
  return groupProfiles.filter((p) => p.nickname && p.nickname.toLowerCase().includes(profileKey.toLowerCase()));
}

function getProfilesFromMessage(msg) {
  const text = msg.text || '';
  const profiles = [];

  // name-based patterns in text
  profiles.push(...findMentionedProfiles(text));

  // entity mentions like @username
  if (msg.entities && Array.isArray(msg.entities)) {
    for (const e of msg.entities) {
      if (e.type === 'mention') {
        const mention = text.substr(e.offset, e.length).replace('@', '').toLowerCase();
        profiles.push(...findProfilesByUsername(mention));
      }
    }
  }

  // author-based mapping
  if (msg.from && msg.from.username) {
    profiles.push(...findProfilesByUsername(msg.from.username));
  }

  // dedupe by nickname
  const uniq = [];
  for (const p of profiles) {
    if (!uniq.find((u) => u.nickname === p.nickname)) uniq.push(p);
  }
  return uniq;
}

function shouldReplyToMessage(msg) {
  if (!msg.text || msg.from?.is_bot) return false;
  const text = msg.text.trim();
  const chatId = msg.chat && msg.chat.id;
  if (!text) return false;
  if (text.startsWith('/')) return false;

  if (msg.chat.type === 'private') {
    return true;
  }

  if (!['group', 'supergroup'].includes(msg.chat.type)) return false;

  // if chatty is explicitly enabled for this chat, reply to everyone (non-bot, non-commands)
  if (chatId && chattySettings[chatId]) return true;

  const lower = text.toLowerCase();
  const funnyKeywords = /(lol|lmao|haha|hehe|🤣|😂|funny|joke|roast|silly|wtf|bruh|hilarious|cute)/i;
  const mentionProfiles = getProfilesFromMessage(msg);

  // always reply if message mentions a known profile
  if (mentionProfiles.length > 0) return true;

  // reply if message explicitly mentions the bot (by @username) or replies to the bot
  if (messageMentionsBot(msg)) return true;

  // reply if the message is sent by a configured primary username
  if (msg.from?.username && PRIMARY_USERNAMES.includes(msg.from.username.toLowerCase())) return true;

  if (funnyKeywords.test(lower)) return true;
  if (text.length > 40 && Math.random() < 0.20) return true;

  return false;
}

function messageMentionsBot(msg) {
  if (!msg || !msg.text) return false;
  const text = msg.text;
  if (msg.entities && Array.isArray(msg.entities)) {
    for (const e of msg.entities) {
      if (e.type === 'mention') {
        const mention = text.substr(e.offset, e.length).replace('@', '').toLowerCase();
        if (botUsername && mention === botUsername) return true;
      }
    }
  }

  if (botUsername && text.toLowerCase().includes(`@${botUsername}`)) return true;

  if (msg.reply_to_message && msg.reply_to_message.from && msg.reply_to_message.from.username) {
    if (botUsername && msg.reply_to_message.from.username.toLowerCase() === botUsername) return true;
  }

  return false;
}

function buildReplyPrompt(msg, text) {
  if (msg.chat.type === 'private') {
    return `You are a friendly conversational assistant. Reply directly to the user in a warm, chatty, and humorous way. Keep your answer short, quick, and funny — do not overthink it. Avoid repeating the same joke or phrase the user has already heard. User: "${text}"`;
  }

  const mentionedProfiles = getProfilesFromMessage(msg);
  if (!mentionedProfiles.length) {
    // include role hints if any mentioned by username or author
    const roleHints = [];
    if (msg.from && msg.from.username) {
      const role = getRoleForUsername(msg.from.username);
      if (role) roleHints.push(`${msg.from.username}: ${role}`);
    }
    if (msg.entities && Array.isArray(msg.entities)) {
      for (const e of msg.entities) {
        if (e.type === 'mention') {
          const mention = msg.text.substr(e.offset, e.length).replace('@', '').toLowerCase();
          const role = getRoleForUsername(mention);
          if (role) roleHints.push(`@${mention}: ${role}`);
        }
      }
    }

    return `You are a friendly Telegram group assistant. ${roleHints.join(' ')} Reply to the message below with a brief, lighthearted, and careful comment. Do not be mean or harsh. Keep it quick and funny when appropriate. Message: "${text}"`;
  }

  const profileLines = mentionedProfiles.map((profile) => {
    const nickname = profile.nickname || profile.fallback || 'friend';
    return `${nickname}: ${profile.note}`;
  });

  // also include any explicit role info for mentioned usernames/author
  const roleLines = [];
  if (msg.from && msg.from.username) {
    const r = getRoleForUsername(msg.from.username);
    if (r) roleLines.push(`${msg.from.username}: ${r}`);
  }
  if (msg.entities && Array.isArray(msg.entities)) {
    for (const e of msg.entities) {
      if (e.type === 'mention') {
        const mention = msg.text.substr(e.offset, e.length).replace('@', '').toLowerCase();
        const r = getRoleForUsername(mention);
        if (r) roleLines.push(`@${mention}: ${r}`);
      }
    }
  }

  return `You are a friendly Telegram group assistant. The message mentions ${mentionedProfiles.map((p) => p.nickname).join(', ')}. ${profileLines.join(' ')} ${roleLines.join(' ')} Reply to the message below with a brief, lighthearted, and careful comment. Do not be mean or harsh. Keep it quick and funny. Message: "${text}"`;
}

bot.on('message', async (msg) => {
  if (!shouldReplyToMessage(msg)) return;

  const chatId = msg.chat.id;
  const text = msg.text.trim();
  const prompt = buildReplyPrompt(msg, text);

  const reply = await callGemini(prompt);
  if (reply) {
    bot.sendMessage(chatId, reply, { reply_to_message_id: msg.message_id });
  }
});

// /start command
bot.onText(/\/start/, (msg) => {
  const chatId = msg.chat.id;
  const welcomeMessage = `
🤖 Welcome to the Funny Bot!

Available commands:
/joke - Get a random funny joke
/fact - Get a random funny fact
/mock @username - Mock someone in a funny way
/help - Show this menu

Have fun! 🎉
  `;
  bot.sendMessage(chatId, welcomeMessage);
});

// /help command
bot.onText(/\/help/, (msg) => {
  const chatId = msg.chat.id;
  const helpMessage = `
📋 Command Guide:

/joke - Get a hilarious joke
/fact - Learn a weird funny fact
/mock @username - Roast someone playfully
/start - Show welcome message
/help - Show this help menu
  `;
  bot.sendMessage(chatId, helpMessage);
});

// Register a Telegram username to a known profile key (pavi, yu, celi, addy)
bot.onText(/\/register (.+)/, (msg, match) => {
  const chatId = msg.chat.id;
  const parts = match[1].trim().split(/\s+/);
  if (parts.length < 2) {
    bot.sendMessage(chatId, 'Usage: /register @username profileKey (e.g. /register @pavi pavi)');
    return;
  }
  const username = parts[0].replace(/^@/, '').toLowerCase();
  const key = parts[1].toLowerCase();
  registeredProfiles[username] = key;
  saveRegisteredProfiles();
  bot.sendMessage(chatId, `Saved profile mapping: @${username} -> ${key}`);
});

// List registered profiles
bot.onText(/\/profiles/, (msg) => {
  const chatId = msg.chat.id;
  const entries = Object.entries(registeredProfiles).map(([u, k]) => `@${u} -> ${k}`);
  if (!entries.length) return bot.sendMessage(chatId, 'No registered profiles.');
  bot.sendMessage(chatId, `Registered profiles:\n${entries.join('\n')}`);
});

// Set role for a username (admin-only)
bot.onText(/\/setrole (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!['group', 'supergroup'].includes(msg.chat.type)) {
    return bot.sendMessage(chatId, 'This command only works in groups.');
  }

  const isAdmin = await isUserAdmin(chatId, msg.from.id);
  if (!isAdmin) return bot.sendMessage(chatId, 'Only group admins can set roles.');

  const parts = match[1].trim().split(/\s+/);
  if (parts.length < 2) {
    return bot.sendMessage(chatId, 'Usage: /setrole @username role');
  }

  const username = parts[0].replace(/^@/, '').toLowerCase();
  const role = parts.slice(1).join(' ').trim();

  // validate role: non-sensitive, simple format
  const banned = ['race', 'religion', 'ethnicity', 'nationality', 'sexual', 'gender', 'age', 'medical', 'political'];
  const roleKey = role.toLowerCase();
  if (!/^[A-Za-z0-9 _-]{1,30}$/.test(role)) {
    return bot.sendMessage(chatId, 'Invalid role. Use letters, numbers, spaces, hyphens or underscores (max 30 chars).');
  }
  for (const b of banned) {
    if (roleKey.includes(b)) return bot.sendMessage(chatId, 'Role contains sensitive content; choose a non-sensitive role.');
  }

  rolesMapping[username] = role;
  saveRoles();
  bot.sendMessage(chatId, `Saved role: @${username} -> ${role}`);
});

// List roles
bot.onText(/\/roles/, (msg) => {
  const chatId = msg.chat.id;
  const entries = Object.entries(rolesMapping).map(([u, r]) => `@${u} -> ${r}`);
  if (!entries.length) return bot.sendMessage(chatId, 'No roles set.');
  bot.sendMessage(chatId, `Roles:\n${entries.join('\n')}`);
});

// Helper: check if user is admin in a chat
async function isUserAdmin(chatId, userId) {
  try {
    const member = await bot.getChatMember(chatId, userId);
    return member && (member.status === 'creator' || member.status === 'administrator');
  } catch (e) {
    return false;
  }
}

// /chatty on|off - toggle auto-reply for this group (admin-only)
bot.onText(/\/chatty(?:\s+(on|off))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  const arg = (match && match[1]) ? match[1].toLowerCase() : null;

  if (!['group', 'supergroup'].includes(msg.chat.type)) {
    return bot.sendMessage(chatId, 'This command only works in groups.');
  }

  const isAdmin = await isUserAdmin(chatId, msg.from.id);
  if (!isAdmin) return bot.sendMessage(chatId, 'Only group admins can change chatty settings.');

  if (!arg) {
    const status = chattySettings[chatId] ? 'ON' : 'OFF';
    return bot.sendMessage(chatId, `Chatty is currently ${status} for this group.`);
  }

  if (arg === 'on') {
    chattySettings[chatId] = true;
    saveChattySettings();
    return bot.sendMessage(chatId, '✅ Chatty is now ON — I will respond to messages in this group.');
  }

  if (arg === 'off') {
    delete chattySettings[chatId];
    saveChattySettings();
    return bot.sendMessage(chatId, '⛔ Chatty is now OFF — I will be quiet in this group.');
  }

  return bot.sendMessage(chatId, 'Usage: /chatty on | /chatty off');
});

// /joke command
bot.onText(/\/joke/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, '🤣 Fetching a funny joke...');

  const prompt = 'Tell me ONE very funny and short joke. Just the joke, no explanation.';
  const joke = await callGemini(prompt);
  bot.sendMessage(chatId, `😂 ${joke}`);
});

// /fact command
bot.onText(/\/fact/, async (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId, '📚 Finding a funny fact...');

  const prompt = 'Tell me ONE weird, funny, and interesting fact that most people don\'t know. Make it really funny! Just the fact, no explanation. Keep it under 2 sentences.';
  const fact = await callGemini(prompt);
  bot.sendMessage(chatId, `🤓 ${fact}`);
});

// /mock command
bot.onText(/\/mock/, async (msg) => {
  const chatId = msg.chat.id;
  const input = msg.text.replace('/mock', '').trim();

  if (!input) {
    bot.sendMessage(chatId, '⚠️ Usage: /mock @username or /mock username');
    return;
  }

  bot.sendMessage(chatId, `🎭 Crafting a roast for ${input}...`);

  const prompt = `Create a short, funny, and playful roast/mock for "${input}". Keep it lighthearted and hilarious, nothing mean-spirited. Just 1-2 sentences.`;
  const roast = await callGemini(prompt);
  bot.sendMessage(chatId, `💬 ${roast}`);
});

// Error handler
bot.on('polling_error', (error) => {
  console.error('Polling Error:', error);
});

console.log('✅ Bot is running and listening for commands...');
