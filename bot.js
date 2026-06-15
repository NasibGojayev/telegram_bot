require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { GoogleGenAI } = require('@google/genai');
const Groq = require('groq-sdk');
const fs = require('fs');

// ========================
// CONFIGURATION (tune these)
// ========================
const GROUP_COOLDOWN_MS = 15 * 1000;          // 15 seconds per group
const USER_COOLDOWN_MS = 20 * 1000;           // 20 seconds per user
const RESPONSE_PROBABILITY = 0.80;            // 80% chance to reply when eligible
const BATCH_WINDOW_MS = 15 * 1000;            // 15 seconds batch window in groups
const CACHE_TTL_MS = 5 * 60 * 1000;           // 5 minutes cache TTL
const QUOTA_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours for exhausted keys
const JOKES_FILE = './jokes.json';
const FACTS_FILE = './facts.json';

// ========================
// HEALTH SERVER (unchanged)
// ========================
const app = express();
app.use(express.json());
app.get('/', (req, res) => res.send('Telegram bot is running'));
app.get('/heartbeat', (req, res) => res.status(200).send('OK'));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Health server listening on port ${PORT}`));

// ========================
// BOT INITIALIZATION
// ========================
const token = process.env.TELEGRAM_TOKEN;
const rawWebhookPath = process.env.WEBHOOK_PATH;
const rawWebhookUrl = process.env.WEBHOOK_URL;
const WEBHOOK_HOST = process.env.WEBHOOK_HOST;

let WEBHOOK_ROUTE = rawWebhookPath || `/webhook/${token}`;
let WEBHOOK_URL = rawWebhookUrl || null;

try {
  if (WEBHOOK_ROUTE && WEBHOOK_ROUTE.match(/^https?:\/\//i)) {
    const url = new URL(WEBHOOK_ROUTE);
    WEBHOOK_URL = WEBHOOK_URL || WEBHOOK_ROUTE;
    WEBHOOK_ROUTE = url.pathname + (url.search || '');
  }
} catch (err) {
  console.warn('Invalid WEBHOOK_PATH URL format; using as route:', WEBHOOK_ROUTE);
}

if (!WEBHOOK_URL && WEBHOOK_HOST) {
  const host = WEBHOOK_HOST.replace(/\/+$/, '');
  WEBHOOK_ROUTE = WEBHOOK_ROUTE.startsWith('/') ? WEBHOOK_ROUTE : `/${WEBHOOK_ROUTE}`;
  WEBHOOK_URL = `${host}${WEBHOOK_ROUTE}`;
}

const bot = new TelegramBot(token);

const maskToken = (value) => {
  if (!value) return value;
  return value.replace(/([A-Za-z0-9_-]{10})[A-Za-z0-9_-]+([A-Za-z0-9_-]{10})$/, '$1...$2');
};

if (WEBHOOK_URL) {
  const webhookRoute = WEBHOOK_ROUTE.startsWith('/') ? WEBHOOK_ROUTE : `/${WEBHOOK_ROUTE}`;
  app.post(webhookRoute, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });

  bot
    .setWebHook(WEBHOOK_URL)
    .then(() => {
      console.log(`✅ Telegram webhook is set.`);
      console.log(`✅ /setwebhook resolved route: ${maskToken(webhookRoute)}`);
      console.log(`✅ /setwebhook resolved URL: ${maskToken(WEBHOOK_URL)}`);
    })
    .catch((err) => console.error('Failed to set Telegram webhook:', err));
} else {
  console.warn('Warning: WEBHOOK_URL, WEBHOOK_HOST, or WEBHOOK_PATH is not configured. Telegram webhook is disabled.');
}

// ========================
// API KEY MANAGEMENT
// ========================
class QuotaAwareKeyManager {
  constructor(keys, providerName) {
    this.providerName = providerName;
    this.keys = keys.map((key, index) => ({ key, availableUntil: 0, index }));
  }

  getAvailableKeys() {
    const now = Date.now();
    return this.keys.filter((entry) => entry.availableUntil <= now);
  }

  getAvailableKey() {
    return this.getAvailableKeys()[0] || null;
  }

  markUnavailable(key) {
    const entry = this.keys.find((item) => item.key === key);
    if (entry) {
      entry.availableUntil = Date.now() + QUOTA_COOLDOWN_MS;
      console.warn(`[${this.providerName}] Key marked unavailable until ${new Date(entry.availableUntil).toISOString()}`);
    }
  }
}

const GEMINI_API_KEYS = [process.env.GEMINI_API_KEY1, process.env.GEMINI_API_KEY2, process.env.GEMINI_API_KEY3].filter(Boolean);
const GROQ_API_KEYS = [process.env.GROQ_API_KEY1, process.env.GROQ_API_KEY2, process.env.GROQ_API_KEY3, process.env.GROQ_API_KEY4].filter(Boolean);
const geminiManager = new QuotaAwareKeyManager(GEMINI_API_KEYS, 'Gemini');
const groqManager = new QuotaAwareKeyManager(GROQ_API_KEYS, 'Groq');

if (!GEMINI_API_KEYS.length) console.warn('Warning: No GEMINI_API_KEYs configured. Gemini fallback will be unavailable.');
if (!GROQ_API_KEYS.length) console.warn('Warning: No GROQ_API_KEYs configured. Groq primary will be unavailable.');

function createGeminiClient(key) {
  return new GoogleGenAI({ apiKey: key });
}

function createGroqClient(key) {
  return new Groq({ apiKey: key });
}

// ========================
// LOCAL JOKES & FACTS (no LLM usage)
// ========================
let localJokes = [];
let localFacts = [];

function normalizeText(text) {
  return (text || '').toLowerCase().trim().replace(/\s+/g, ' ');
}

function loadLocalData(path, defaults) {
  try {
    if (fs.existsSync(path)) {
      const value = JSON.parse(fs.readFileSync(path, 'utf8') || '[]');
      if (Array.isArray(value) && value.length) return value;
    }
    fs.writeFileSync(path, JSON.stringify(defaults, null, 2));
    return defaults;
  } catch (error) {
    console.error(`Failed to load ${path}:`, error.message);
    return defaults;
  }
}

localJokes = loadLocalData(JOKES_FILE, [
  "Why don't scientists trust atoms? Because they make up everything!",
  "What do you call a fake noodle? An impasta!",
  "Why did the scarecrow win an award? He was outstanding in his field!",
  "I told my wife she was drawing her eyebrows too high. She looked surprised.",
  "What do you call a bear with no teeth? A gummy bear!"
]);

localFacts = loadLocalData(FACTS_FILE, [
  "Octopuses have three hearts.",
  "The national animal of Canada is beaver",
  "Bananas are berries, but strawberries aren't.",
  "A day on Venus is longer than a year on Venus.",
  "Honey never spoils; archaeologists found 3,000-year-old honey in Egyptian tombs.",
  "Cows have best friends and get stressed when separated."
]);

// ========================
// CACHE, COOLDOWNS, BATCHING, STATS
// ========================
const responseCache = new Map();
const groupLastResponse = new Map();
const userLastResponse = new Map();
const groupBatchBuffers = new Map();

let apiCallsTotal = 0;
let apiCallsToday = 0;
let apiCallsTodayDate = new Date().toISOString().slice(0, 10);
let cacheHits = 0;
let cooldownIgnores = 0;
let batchResponsesGenerated = 0;

function resetDailyCountsIfNeeded() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== apiCallsTodayDate) {
    apiCallsTodayDate = today;
    apiCallsToday = 0;
  }
}

function incrementApiCalls() {
  resetDailyCountsIfNeeded();
  apiCallsTotal += 1;
  apiCallsToday += 1;
}

function logStats() {
  resetDailyCountsIfNeeded();
  const totalRequests = apiCallsTotal + cacheHits || 1;
  console.log(
    `[STATS] API calls total: ${apiCallsTotal} | API calls today: ${apiCallsToday} | cache hits: ${cacheHits} (${((cacheHits / totalRequests) * 100).toFixed(1)}%) | cooldown ignores: ${cooldownIgnores} | batch responses: ${batchResponsesGenerated}`
  );
}
setInterval(logStats, 60 * 60 * 1000);

function getCachedResponse(text) {
  const key = normalizeText(text);
  const entry = responseCache.get(key);
  if (entry && entry.expires > Date.now()) {
    cacheHits += 1;
    return entry.response;
  }
  responseCache.delete(key);
  return null;
}

function setCachedResponse(text, response) {
  const key = normalizeText(text);
  responseCache.set(key, { response, expires: Date.now() + CACHE_TTL_MS });
}

// ========================
// AI CALLS WITH FALLBACKS
// ========================
function isQuotaError(error) {
  const status = error?.status || error?.response?.status;
  const code = error?.response?.data?.error?.code || error?.response?.data?.error?.status;
  const message = (error?.response?.data?.error?.message || error?.message || '').toString().toLowerCase();
  return status === 429 || code === 429 || message.includes('quota') || message.includes('rate limit');
}

async function callGroq(prompt) {
  const availableKeys = groqManager.getAvailableKeys();
  if (!availableKeys.length) {
    console.warn('No available Groq keys; falling back to Gemini.');
    return await callGemini(prompt);
  }

  for (const keyEntry of availableKeys) {
    const client = createGroqClient(keyEntry.key);
    try {
      const response = await client.chat.completions.create({ 
        model: 'openai/gpt-oss-120b', 
        messages: [{ role: 'user', content: prompt }]
      });
      const text = response.choices?.[0]?.message?.content || '';
      if (text && text.trim()) {
        incrementApiCalls();
        return text.trim();
      }
      console.warn(`[Groq] Key #${keyEntry.index + 1} returned empty text.`);
    } catch (error) {
      const status = error?.status || error?.response?.status;
      const errorData = error?.error || error?.response?.data?.error;
      const message = error?.message || error?.response?.data?.error?.message || 'Unknown error';
      console.error(`[Groq] Key #${keyEntry.index + 1} error [${status}]:`, message);
      if (errorData) console.error(`[Groq] Error details:`, JSON.stringify(errorData));
      
      if (isQuotaError(error)) {
        groqManager.markUnavailable(keyEntry.key);
      }
    }
  }

  console.warn('All Groq keys failed, falling back to Gemini.');
  return await callGemini(prompt);
}

async function callGemini(prompt) {
  const availableKeys = geminiManager.getAvailableKeys();
  if (!availableKeys.length) {
    console.warn('No available Gemini keys; unable to fulfill AI request.');
    return '❌ Sorry, no AI keys are currently available. Please try again later.';
  }

  for (const keyEntry of availableKeys) {
    const client = createGeminiClient(keyEntry.key);
    try {
      const response = await client.models.generateContent({ model: 'gemini-3.5-flash', contents: prompt });
      const text = response.text || response.output?.[0]?.content?.[0]?.text || '';
      if (text && text.trim()) {
        incrementApiCalls();
        return text.trim();
      }
      console.warn(`[Gemini] Key #${keyEntry.index + 1} returned empty text.`);
    } catch (error) {
      console.error(`[Gemini] Key #${keyEntry.index + 1} error:`, error?.message || error);
      if (isQuotaError(error)) {
        geminiManager.markUnavailable(keyEntry.key);
      }
    }
  }

  return '❌ Sorry, no Gemini keys are currently available. Please try again later.';
}

async function callAI(prompt) {
  if (GEMINI_API_KEYS.length > 0) {
    return await callGemini(prompt);
  }
  return await callGroq(prompt);
}

// ========================
// PROFILES, ROLES, REGISTRATION
// ========================
let botUsername = process.env.BOT_USERNAME ? process.env.BOT_USERNAME.toLowerCase() : null;
const PRIMARY_USERNAMES = process.env.PRIMARY_USERNAMES
  ? process.env.PRIMARY_USERNAMES.split(',').map((s) => s.trim().replace(/^@/, '').toLowerCase())
  : [];

bot.getMe && bot.getMe().then((me) => {
  try {
    botUsername = botUsername || (me.username && me.username.toLowerCase());
  } catch (e) {
    /* ignore */
  }
});

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
  return groupProfiles.filter((profile) => profile.patterns.some((pattern) => pattern.test(text)));
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

  profiles.push(...findMentionedProfiles(text));
  if (msg.entities && Array.isArray(msg.entities)) {
    for (const e of msg.entities) {
      if (e.type === 'mention') {
        const mention = text.substr(e.offset, e.length).replace('@', '').toLowerCase();
        profiles.push(...findProfilesByUsername(mention));
      }
    }
  }
  if (msg.from && msg.from.username) {
    profiles.push(...findProfilesByUsername(msg.from.username));
  }

  return profiles.filter((profile, index, array) => array.findIndex((p) => p.nickname === profile.nickname) === index);
}

function shouldReplyToMessage(msg) {
  if (!msg.text || msg.from?.is_bot) return false;
  const text = msg.text.trim();
  if (!text || text.startsWith('/')) return false;

  if (msg.chat.type === 'private') return true;
  if (!['group', 'supergroup'].includes(msg.chat.type)) return false;
  if (chattySettings[msg.chat.id]) return true;

  const lower = text.toLowerCase();
  const activeKeywords = /(lol|lmao|haha|hehe|🤣|😂|funny|joke|roast|silly|wtf|bruh|hilarious|cute|wow|nice|omg|cool|fire|what|help|tell me|say something|seriously|please|interesting|\?)/i;
  const mentionProfiles = getProfilesFromMessage(msg);

  if (mentionProfiles.length > 0) return true;
  if (messageMentionsBot(msg)) return true;
  if (msg.from?.username && PRIMARY_USERNAMES.includes(msg.from.username.toLowerCase())) return true;
  if (activeKeywords.test(lower)) return true;
  if (text.length > 20 && Math.random() < RESPONSE_PROBABILITY) return true;
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
  if (msg.reply_to_message?.from?.username && botUsername && msg.reply_to_message.from.username.toLowerCase() === botUsername) return true;
  return false;
}

function buildReplyPrompt(msg, text) {
  if (msg.chat.type === 'private') {
    return `You are a friendly conversational assistant. Reply directly to the user in a warm, chatty, and humorous way. Keep your answer short, quick, and funny — do not overthink it. Avoid repeating the same joke or phrase the user has already heard. User: "${text}"`;
  }

  const mentionedProfiles = getProfilesFromMessage(msg);
  const roleHints = [];
  if (msg.from?.username) {
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

  if (mentionedProfiles.length > 0) {
    const profileLines = mentionedProfiles.map((profile) => `${profile.nickname}: ${profile.note}`);
    return `You are a friendly Telegram group assistant. The message mentions ${mentionedProfiles.map((p) => p.nickname).join(', ')}. ${profileLines.join(' ')} ${roleHints.join(' ')} Reply to the message below with a brief, lighthearted, and careful comment. Do not be mean or harsh. Keep it quick and funny. Message: "${text}"`;
  }

  return `You are a friendly Telegram group assistant. ${roleHints.join(' ')} Reply to the message below with a brief, lighthearted comment. Do not be mean or harsh. Keep it quick and funny when appropriate. Message: "${text}"`;
}

async function processBatch(chatId) {
  const buffer = groupBatchBuffers.get(chatId);
  if (!buffer || !buffer.messages.length) return;
  clearTimeout(buffer.timer);
  groupBatchBuffers.delete(chatId);

  const combinedText = buffer.messages
    .map((m) => `[${m.from?.first_name || m.from?.username || 'User'}]: ${m.text}`)
    .join('\n');
  const prompt = `The following messages were sent in a Telegram group. Generate ONE short, funny comment that responds to the overall conversation. Keep it light and entertaining. Messages:\n${combinedText}`;

  const reply = await callAI(prompt);
  if (reply) {
    batchResponsesGenerated += 1;
    bot.sendMessage(chatId, reply);
  }
  groupLastResponse.set(chatId, Date.now());
}

function addToBatch(msg) {
  const chatId = msg.chat.id;
  let buffer = groupBatchBuffers.get(chatId);
  if (!buffer) {
    buffer = { messages: [], timer: null };
    groupBatchBuffers.set(chatId, buffer);
  }
  buffer.messages.push(msg);
  if (buffer.timer) clearTimeout(buffer.timer);
  buffer.timer = setTimeout(() => processBatch(chatId), BATCH_WINDOW_MS);
}

bot.on('message', async (msg) => {
  if (msg.text && msg.text.startsWith('/')) return;
  if (!shouldReplyToMessage(msg)) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const now = Date.now();

  const lastGroup = groupLastResponse.get(chatId) || 0;
  if (now - lastGroup < GROUP_COOLDOWN_MS) {
    cooldownIgnores += 1;
    return;
  }

  const lastUser = userLastResponse.get(userId) || 0;
  if (now - lastUser < USER_COOLDOWN_MS) {
    cooldownIgnores += 1;
    return;
  }

  if (Math.random() > RESPONSE_PROBABILITY) {
    cooldownIgnores += 1;
    return;
  }

  const isDirectMention = messageMentionsBot(msg) || (msg.reply_to_message?.from?.username === botUsername);
  if (isDirectMention || msg.chat.type === 'private') {
    const cached = getCachedResponse(msg.text);
    if (cached) {
      bot.sendMessage(chatId, cached, { reply_to_message_id: msg.message_id });
      groupLastResponse.set(chatId, now);
      userLastResponse.set(userId, now);
      return;
    }
    const prompt = buildReplyPrompt(msg, msg.text);
    const reply = await callAI(prompt);
    if (reply) {
      setCachedResponse(msg.text, reply);
      bot.sendMessage(chatId, reply, { reply_to_message_id: msg.message_id });
      groupLastResponse.set(chatId, now);
      userLastResponse.set(userId, now);
    }
  } else {
    addToBatch(msg);
    userLastResponse.set(userId, now);
  }
});

bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, `🤖 Welcome to the Funny Bot!\n\n/joke - Get a random funny joke\n/fact - Get a random funny fact\n/mock @username - Mock someone playfully\n/help - Show menu\n/stats - Bot usage stats`);
});

bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id, `📋 Commands:\n/joke\n/fact\n/mock @user\n/start\n/help\n/register @user profileKey\n/profiles\n/setrole @user role (admin)\n/roles\n/chatty on|off (admin)\n/stats (admin)`);
});

bot.onText(/\/register (.+)/, (msg, match) => {
  const parts = match[1].trim().split(/\s+/);
  if (parts.length < 2) return bot.sendMessage(msg.chat.id, 'Usage: /register @username profileKey');
  const username = parts[0].replace(/^@/, '').toLowerCase();
  const key = parts[1].toLowerCase();
  registeredProfiles[username] = key;
  saveRegisteredProfiles();
  bot.sendMessage(msg.chat.id, `Saved profile mapping: @${username} -> ${key}`);
});

bot.onText(/\/profiles/, (msg) => {
  const entries = Object.entries(registeredProfiles).map(([u, k]) => `@${u} -> ${k}`);
  bot.sendMessage(msg.chat.id, entries.length ? `Registered profiles:\n${entries.join('\n')}` : 'No registered profiles.');
});

async function isUserAdmin(chatId, userId) {
  try {
    const member = await bot.getChatMember(chatId, userId);
    return member && ['creator', 'administrator'].includes(member.status);
  } catch (e) {
    return false;
  }
}

bot.onText(/\/setrole (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!['group', 'supergroup'].includes(msg.chat.type)) return bot.sendMessage(chatId, 'This command only works in groups.');
  const isAdmin = await isUserAdmin(chatId, msg.from.id);
  if (!isAdmin) return bot.sendMessage(chatId, 'Only group admins can set roles.');

  const parts = match[1].trim().split(/\s+/);
  if (parts.length < 2) return bot.sendMessage(chatId, 'Usage: /setrole @username role');
  const username = parts[0].replace(/^@/, '').toLowerCase();
  const role = parts.slice(1).join(' ').trim();
  if (!/^[A-Za-z0-9 _-]{1,30}$/.test(role)) return bot.sendMessage(chatId, 'Invalid role. Use letters, numbers, spaces, hyphens or underscores (max 30 chars).');

  rolesMapping[username] = role;
  saveRoles();
  bot.sendMessage(chatId, `Saved role: @${username} -> ${role}`);
});

bot.onText(/\/roles/, (msg) => {
  const entries = Object.entries(rolesMapping).map(([u, r]) => `@${u} -> ${r}`);
  bot.sendMessage(msg.chat.id, entries.length ? `Roles:\n${entries.join('\n')}` : 'No roles set.');
});

bot.onText(/\/chatty(?:\s+(on|off))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  if (!['group', 'supergroup'].includes(msg.chat.type)) return bot.sendMessage(chatId, 'This command only works in groups.');
  const isAdmin = await isUserAdmin(chatId, msg.from.id);
  if (!isAdmin) return bot.sendMessage(chatId, 'Only group admins can change chatty settings.');

  const arg = match?.[1]?.toLowerCase();
  if (!arg) return bot.sendMessage(chatId, `Chatty is currently ${chattySettings[chatId] ? 'ON' : 'OFF'}`);
  if (arg === 'on') {
    chattySettings[chatId] = true;
    saveChattySettings();
    return bot.sendMessage(chatId, '✅ Chatty is now ON — I will respond to messages in this group.');
  }
  delete chattySettings[chatId];
  saveChattySettings();
  bot.sendMessage(chatId, '⛔ Chatty is now OFF — I will be quiet in this group.');
});

bot.onText(/\/joke/, (msg) => {
  const joke = localJokes[Math.floor(Math.random() * localJokes.length)];
  bot.sendMessage(msg.chat.id, `😂 ${joke}`);
});

bot.onText(/\/fact/, (msg) => {
  const fact = localFacts[Math.floor(Math.random() * localFacts.length)];
  bot.sendMessage(msg.chat.id, `🤓 ${fact}`);
});

bot.onText(/\/mock/, async (msg) => {
  const input = msg.text.replace('/mock', '').trim();
  if (!input) return bot.sendMessage(msg.chat.id, '⚠️ Usage: /mock @username or /mock username');
  bot.sendMessage(msg.chat.id, `🎭 Crafting a roast for ${input}...`);
  const roast = await callAI(`Create a short, funny, and playful roast/mock for "${input}". Keep it lighthearted, no mean-spirited insults. One or two sentences only.`);
  bot.sendMessage(msg.chat.id, `💬 ${roast}`);
});

bot.onText(/\/stats/, async (msg) => {
  const chatId = msg.chat.id;
  const isPrivate = msg.chat.type === 'private';
  const isAdmin = isPrivate || await isUserAdmin(chatId, msg.from.id);
  if (!isAdmin) return bot.sendMessage(chatId, 'Admin only.');
  resetDailyCountsIfNeeded();
  const totalRequests = apiCallsTotal + cacheHits || 1;
  const hitRate = ((cacheHits / totalRequests) * 100).toFixed(1);
  bot.sendMessage(chatId, `📊 Bot Stats\nAPI calls total: ${apiCallsTotal}\nAPI calls today: ${apiCallsToday}\nCache hits: ${cacheHits}\nCache hit rate: ${hitRate}%\nCooldown ignores: ${cooldownIgnores}\nBatch responses: ${batchResponsesGenerated}`);
});

bot.on('polling_error', (error) => {
  console.error('Polling Error:', error);
  try {
    const description = error?.response?.body?.description || '';
    if (error && error.code === 'ETELEGRAM' && description.includes('terminated by other getUpdates')) {
      console.error('Detected Telegram 409 conflict (another getUpdates instance). Exiting.');
      process.exit(1);
    }
  } catch (e) {
    // ignore
  }
});

console.log('✅ Optimized bot running with aggressive API reduction.');
