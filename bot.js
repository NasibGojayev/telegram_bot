require('dotenv').config();
const express = require('express');
const TelegramBot = require('node-telegram-bot-api');
const { GoogleGenAI } = require('@google/genai');
const { OpenAI } = require('openai');
const fs = require('fs');

// ========================
// CONFIGURATION (tune these)
// ========================
const GROUP_COOLDOWN_MS = 60 * 1000;      // 60 seconds - no AI response per group
const USER_COOLDOWN_MS = 3 * 60 * 1000;   // 3 minutes per user
const RESPONSE_PROBABILITY = 0.10;        // 10% chance to reply even when conditions match
const BATCH_WINDOW_MS = 30 * 1000;        // 30 seconds batch window
const CACHE_TTL_MS = 5 * 60 * 1000;       // 5 minutes cache TTL
const QUOTA_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24 hours for exhausted keys
const JOKES_FILE = './jokes.json';
const FACTS_FILE = './facts.json';

// ========================
// HEALTH SERVER (unchanged)
// ========================
const app = express();
app.get('/', (req, res) => res.send('Telegram bot is running'));
app.get('/heartbeat', (req, res) => res.status(200).send('OK'));
const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Health server listening on port ${PORT}`));

// ========================
// BOT INITIALIZATION
// ========================
const token = process.env.TELEGRAM_TOKEN;
const bot = new TelegramBot(token, { polling: true });

// ========================
// API KEY MANAGEMENT (quota-aware)
// ========================
class QuotaAwareKeyManager {
  constructor(keys, providerName) {
    this.keys = keys.map((key, idx) => ({
      key,
      availableUntil: 0, // timestamp when key becomes available again (0 = now)
      index: idx
    }));
    this.providerName = providerName;
  }

  getAvailableKey() {
    const now = Date.now();
    const available = this.keys.filter(k => k.availableUntil <= now);
    if (available.length === 0) return null;
    // simple round-robin: return first available (or implement rotation)
    return available[0];
  }

  markUnavailable(key) {
    const keyObj = this.keys.find(k => k.key === key);
    if (keyObj) {
      keyObj.availableUntil = Date.now() + QUOTA_COOLDOWN_MS;
      console.log(`[${this.providerName}] Key marked unavailable for 24h due to quota exhaustion`);
    }
  }
}

const geminiKeys = [process.env.GEMINI_API_KEY1, process.env.GEMINI_API_KEY2, process.env.GEMINI_API_KEY3].filter(Boolean);
const groqKeys = [process.env.GROQ_API_KEY1, process.env.GROQ_API_KEY2, process.env.GROQ_API_KEY3].filter(Boolean);

const geminiManager = new QuotaAwareKeyManager(geminiKeys, 'Gemini');
const groqManager = new QuotaAwareKeyManager(groqKeys, 'Groq');

// ========================
// LOCAL JOKES & FACTS (no API calls)
// ========================
let localJokes = [];
let localFacts = [];

function loadLocalJokes() {
  try {
    if (fs.existsSync(JOKES_FILE)) {
      localJokes = JSON.parse(fs.readFileSync(JOKES_FILE, 'utf8'));
    } else {
      // Default jokes if file missing
      localJokes = [
        "Why don't scientists trust atoms? Because they make up everything!",
        "What do you call a fake noodle? An impasta!",
        "Why did the scarecrow win an award? He was outstanding in his field!",
        "I told my wife she was drawing her eyebrows too high. She looked surprised.",
        "What do you call a bear with no teeth? A gummy bear!"
      ];
      fs.writeFileSync(JOKES_FILE, JSON.stringify(localJokes, null, 2));
    }
  } catch(e) { localJokes = ["Why did the chicken cross the road? To get to the other side!"]; }
}

function loadLocalFacts() {
  try {
    if (fs.existsSync(FACTS_FILE)) {
      localFacts = JSON.parse(fs.readFileSync(FACTS_FILE, 'utf8'));
    } else {
      localFacts = [
        "Octopuses have three hearts.",
        "Bananas are berries, but strawberries aren't.",
        "A day on Venus is longer than a year on Venus.",
        "Honey never spoils. Archaeologists found 3000-year-old honey in Egyptian tombs.",
        "Cows have best friends and get stressed when separated."
      ];
      fs.writeFileSync(FACTS_FILE, JSON.stringify(localFacts, null, 2));
    }
  } catch(e) { localFacts = ["The Eiffel Tower can be 15 cm taller during summer."]; }
}

loadLocalJokes();
loadLocalFacts();

// ========================
// CACHE & COOLDOWN & BATCHING STRUCTURES
// ========================
const responseCache = new Map(); // key: normalized message text -> { response, expires }
const groupLastResponse = new Map(); // groupId -> timestamp
const userLastResponse = new Map();   // userId -> timestamp
const groupBatchBuffers = new Map();   // groupId -> { messages: [], timer: null, lastBatchTime: 0 }

// Statistics counters
let apiCallsTotal = 0;
let cacheHits = 0;
let cooldownIgnores = 0;
let batchResponsesGenerated = 0;

function logStats() {
  console.log(`[STATS] API calls: ${apiCallsTotal} | Cache hits: ${cacheHits} (${((cacheHits/(apiCallsTotal+cacheHits||1))*100).toFixed(1)}%) | Cooldown ignores: ${cooldownIgnores} | Batch responses: ${batchResponsesGenerated}`);
}
// Log stats every hour
setInterval(logStats, 60 * 60 * 1000);

// Helper: get cached response
function getCachedResponse(text) {
  const key = text.toLowerCase().trim();
  const entry = responseCache.get(key);
  if (entry && entry.expires > Date.now()) {
    cacheHits++;
    return entry.response;
  }
  responseCache.delete(key);
  return null;
}

function setCachedResponse(text, response) {
  const key = text.toLowerCase().trim();
  responseCache.set(key, { response, expires: Date.now() + CACHE_TTL_MS });
}

// ========================
// API CALL FUNCTIONS (with fallback hierarchy & quota management)
// ========================
async callGroq(prompt) {
  const availableKey = groqManager.getAvailableKey();
  if (!availableKey) {
    console.warn('No Groq keys available (all quota exhausted), falling back to Gemini');
    return await callGemini(prompt);
  }
  const client = new OpenAI({ apiKey: availableKey.key, baseURL: 'https://api.groq.com/openai/v1' });
  try {
    const response = await client.responses.create({ model: 'openai/gpt-oss-20b', input: prompt });
    const text = response.output_text || (Array.isArray(response.output) ? response.output.map(o => o.content?.[0]?.text || '').join(' ') : '');
    if (text && text.trim()) {
      apiCallsTotal++;
      return text;
    }
    throw new Error('Empty response');
  } catch (error) {
    if (error.status === 429 || (error.response?.data?.error?.code === 429)) {
      groqManager.markUnavailable(availableKey.key);
    }
    console.error(`Groq key failed:`, error.message);
    // Try next available Groq key (recursive, but avoid deep recursion)
    return await callGroq(prompt);
  }
}

async callGemini(prompt) {
  const availableKey = geminiManager.getAvailableKey();
  if (!availableKey) {
    console.warn('No Gemini keys available, falling back to Groq');
    return await callGroq(prompt);
  }
  const client = new GoogleGenAI({ apiKey: availableKey.key });
  try {
    const response = await client.models.generateContent({ model: 'gemini-2.0-flash', contents: prompt }); // or gemini-1.5-flash
    const text = response.text || response.output?.[0]?.content?.[0]?.text || '';
    if (text && text.trim()) {
      apiCallsTotal++;
      return text;
    }
    throw new Error('Empty response');
  } catch (error) {
    if (error.status === 429 || (error.response?.data?.error?.code === 429)) {
      geminiManager.markUnavailable(availableKey.key);
    }
    console.error(`Gemini key failed:`, error.message);
    return await callGemini(prompt);
  }
}

// Primary API caller: Groq first, then Gemini as per user request
async callAI(prompt) {
  if (groqKeys.length > 0) {
    return await callGroq(prompt);
  }
  return await callGemini(prompt);
}

// ========================
// PROFILES, ROLES, REGISTRATION (preserved exactly)
// ========================
let botUsername = process.env.BOT_USERNAME ? process.env.BOT_USERNAME.toLowerCase() : null;
const PRIMARY_USERNAMES = process.env.PRIMARY_USERNAMES ? process.env.PRIMARY_USERNAMES.split(',').map(s => s.trim().replace(/^@/, '').toLowerCase()) : [];
bot.getMe().then(me => { if(me?.username) botUsername = botUsername || me.username.toLowerCase(); });

const PROFILES_FILE = './profiles.json';
let registeredProfiles = {};
try { if(fs.existsSync(PROFILES_FILE)) registeredProfiles = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8')||'{}'); } catch(e) {}
function saveRegisteredProfiles() { fs.writeFileSync(PROFILES_FILE, JSON.stringify(registeredProfiles, null, 2)); }

const ROLES_FILE = './roles.json';
let rolesMapping = {};
try { if(fs.existsSync(ROLES_FILE)) rolesMapping = JSON.parse(fs.readFileSync(ROLES_FILE, 'utf8')||'{}'); } catch(e) {}
function saveRoles() { fs.writeFileSync(ROLES_FILE, JSON.stringify(rolesMapping, null, 2)); }
function getRoleForUsername(username) { return rolesMapping[username?.replace(/^@/, '').toLowerCase()] || null; }

const CHAT_SETTINGS_FILE = './chatty.json';
let chattySettings = {};
try { if(fs.existsSync(CHAT_SETTINGS_FILE)) chattySettings = JSON.parse(fs.readFileSync(CHAT_SETTINGS_FILE, 'utf8')||'{}'); } catch(e) {}
function saveChattySettings() { fs.writeFileSync(CHAT_SETTINGS_FILE, JSON.stringify(chattySettings, null, 2)); }

const groupProfiles = [
  { patterns: [/\bPavi\b/i], nickname: 'owner', note: 'Pavi is Tamil and lives in Malaysia.', hint: 'Always call him owner when referring to him.' },
  { patterns: [/\bYU\b/i, /\bAbangYU\b/i, /\babangYU\b/i], nickname: 'abangYU', fallback: 'uncle', note: 'YU should be addressed as abangYU or uncle.', hint: 'Use abangYU when you can, otherwise uncle is fine.' },
  { patterns: [/\bCeli\b/i, /\bCEC?EL\b/i, /\bamoy\b/i], nickname: 'the pretty girl', note: 'Celi is CECEL and her admin tag is amoy pretty.', hint: 'Mention that she is the pretty girl in the group.' },
  { patterns: [/\bAddy\b/i], nickname: 'uncle', note: 'Addy is from Brunei, about 30 years old, and will get married soon.', hint: 'Call him uncle and keep the tone gentle.' },
];
function findMentionedProfiles(text) { return groupProfiles.filter(p => p.patterns.some(pat => pat.test(text))); }
function findProfilesByUsername(username) { const key = username?.replace(/^@/, '').toLowerCase(); return registeredProfiles[key] ? groupProfiles.filter(p => p.nickname && p.nickname.toLowerCase().includes(registeredProfiles[key].toLowerCase())) : []; }
function getProfilesFromMessage(msg) {
  const text = msg.text || '';
  let profiles = findMentionedProfiles(text);
  if(msg.entities) for(const e of msg.entities) if(e.type==='mention') profiles.push(...findProfilesByUsername(text.substr(e.offset, e.length).replace('@','')));
  if(msg.from?.username) profiles.push(...findProfilesByUsername(msg.from.username));
  return profiles.filter((p,i,a)=>a.findIndex(u=>u.nickname===p.nickname)===i);
}

// ========================
// REPLY DECISION LOGIC (with additional cooldown & probability)
// ========================
function shouldReplyToMessage(msg) {
  if (!msg.text || msg.from?.is_bot) return false;
  const text = msg.text.trim();
  if (!text || text.startsWith('/')) return false;
  if (msg.chat.type === 'private') return true;
  if (!['group','supergroup'].includes(msg.chat.type)) return false;
  if (chattySettings[msg.chat.id]) return true;
  const lower = text.toLowerCase();
  const funnyKeywords = /(lol|lmao|haha|hehe|🤣|😂|funny|joke|roast|silly|wtf|bruh|hilarious|cute)/i;
  if (getProfilesFromMessage(msg).length > 0) return true;
  if (messageMentionsBot(msg)) return true;
  if (msg.from?.username && PRIMARY_USERNAMES.includes(msg.from.username.toLowerCase())) return true;
  if (funnyKeywords.test(lower)) return true;
  if (text.length > 40 && Math.random() < 0.20) return true;
  return false;
}

function messageMentionsBot(msg) {
  const text = msg.text || '';
  if(msg.entities) for(const e of msg.entities) if(e.type==='mention' && botUsername && text.substr(e.offset,e.length).replace('@','').toLowerCase()===botUsername) return true;
  if(botUsername && text.toLowerCase().includes(`@${botUsername}`)) return true;
  if(msg.reply_to_message?.from?.username && botUsername && msg.reply_to_message.from.username.toLowerCase()===botUsername) return true;
  return false;
}

function buildReplyPrompt(msg, text) {
  const mentionedProfiles = getProfilesFromMessage(msg);
  const roleHints = [];
  if(msg.from?.username) { const r = getRoleForUsername(msg.from.username); if(r) roleHints.push(`${msg.from.username}: ${r}`); }
  if(msg.entities) for(const e of msg.entities) if(e.type==='mention') { const mention = msg.text.substr(e.offset,e.length).replace('@','').toLowerCase(); const r = getRoleForUsername(mention); if(r) roleHints.push(`@${mention}: ${r}`); }
  if(mentionedProfiles.length) {
    const profileLines = mentionedProfiles.map(p => `${p.nickname}: ${p.note}`);
    return `You are a friendly Telegram group assistant. The message mentions ${mentionedProfiles.map(p=>p.nickname).join(', ')}. ${profileLines.join(' ')} ${roleHints.join(' ')} Reply briefly, lighthearted, and careful. Message: "${text}"`;
  }
  return `You are a friendly Telegram group assistant. ${roleHints.join(' ')} Reply briefly and humorously when appropriate. Message: "${text}"`;
}

// ========================
// BATCH PROCESSING
// ========================
async function processBatch(chatId) {
  const buffer = groupBatchBuffers.get(chatId);
  if (!buffer || buffer.messages.length === 0) return;
  clearTimeout(buffer.timer);
  groupBatchBuffers.delete(chatId);
  
  // Build combined prompt from all buffered messages
  const combinedText = buffer.messages.map(m => `[${m.from?.first_name || m.from?.username || 'User'}]: ${m.text}`).join('\n');
  const prompt = `The following messages were sent in a Telegram group. Generate ONE short, funny comment that responds to the overall conversation. Keep it light and entertaining. Messages:\n${combinedText}`;
  
  const reply = await callAI(prompt);
  if (reply) {
    batchResponsesGenerated++;
    bot.sendMessage(chatId, reply);
  }
  // Update group cooldown after batch reply
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

// ========================
// MAIN MESSAGE HANDLER (with cooldowns, probability, batching)
// ========================
bot.on('message', async (msg) => {
  // Always process commands (they are handled by onText separately)
  if (msg.text && msg.text.startsWith('/')) return;

  // Step 1: Should we consider this message at all?
  if (!shouldReplyToMessage(msg)) return;

  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const now = Date.now();

  // Step 2: Group cooldown
  const lastGroup = groupLastResponse.get(chatId) || 0;
  if (now - lastGroup < GROUP_COOLDOWN_MS) {
    cooldownIgnores++;
    return;
  }

  // Step 3: User cooldown (for immediate responses, but we also apply to batch addition)
  const lastUser = userLastResponse.get(userId) || 0;
  if (now - lastUser < USER_COOLDOWN_MS) {
    cooldownIgnores++;
    return;
  }

  // Step 4: Random participation (10% chance to actually respond)
  if (Math.random() > RESPONSE_PROBABILITY) {
    cooldownIgnores++;
    return;
  }

  // Step 5: Decide immediate vs batched response
  const isDirectMention = messageMentionsBot(msg) || (msg.reply_to_message && msg.reply_to_message.from?.username === botUsername);
  
  if (isDirectMention || msg.chat.type === 'private') {
    // Immediate response (with cache)
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
    // Batched response for groups (non-direct)
    addToBatch(msg);
    // Mark user as "has contributed to batch" - they cannot trigger another immediate or be added to another batch until cooldown
    userLastResponse.set(userId, now);
  }
});

// ========================
// ALL COMMANDS (preserved, plus /stats)
// ========================
bot.onText(/\/start/, (msg) => {
  bot.sendMessage(msg.chat.id, `🤖 Welcome to the Funny Bot!\n\n/joke - Get a random funny joke\n/fact - Get a random funny fact\n/mock @username - Mock someone playfully\n/help - Show menu\n/stats - Bot usage stats (admin)`);
});
bot.onText(/\/help/, (msg) => {
  bot.sendMessage(msg.chat.id, `📋 Commands:\n/joke\n/fact\n/mock @user\n/start\n/help\n/register @user profileKey\n/profiles\n/setrole @user role (admin)\n/roles\n/chatty on|off (admin)\n/stats (admin)`);
});
bot.onText(/\/register (.+)/, (msg, match) => {
  const parts = match[1].trim().split(/\s+/);
  if(parts.length<2) return bot.sendMessage(msg.chat.id, 'Usage: /register @username profileKey');
  const username = parts[0].replace(/^@/,'').toLowerCase();
  const key = parts[1].toLowerCase();
  registeredProfiles[username]=key;
  saveRegisteredProfiles();
  bot.sendMessage(msg.chat.id, `Saved: @${username} -> ${key}`);
});
bot.onText(/\/profiles/, (msg) => {
  const entries = Object.entries(registeredProfiles).map(([u,k])=>`@${u} -> ${k}`);
  bot.sendMessage(msg.chat.id, entries.length ? `Registered profiles:\n${entries.join('\n')}` : 'No profiles.');
});
bot.onText(/\/setrole (.+)/, async (msg, match) => {
  const chatId = msg.chat.id;
  if(!['group','supergroup'].includes(msg.chat.type)) return bot.sendMessage(chatId, 'Groups only.');
  const isAdmin = await bot.getChatMember(chatId, msg.from.id).then(m=>['creator','administrator'].includes(m.status)).catch(()=>false);
  if(!isAdmin) return bot.sendMessage(chatId, 'Admin only.');
  const parts = match[1].trim().split(/\s+/);
  if(parts.length<2) return bot.sendMessage(chatId, 'Usage: /setrole @username role');
  const username = parts[0].replace(/^@/,'').toLowerCase();
  const role = parts.slice(1).join(' ').trim();
  if(!/^[A-Za-z0-9 _-]{1,30}$/.test(role)) return bot.sendMessage(chatId, 'Invalid role format.');
  rolesMapping[username]=role;
  saveRoles();
  bot.sendMessage(chatId, `Role set: @${username} -> ${role}`);
});
bot.onText(/\/roles/, (msg) => {
  const entries = Object.entries(rolesMapping).map(([u,r])=>`@${u} -> ${r}`);
  bot.sendMessage(msg.chat.id, entries.length ? `Roles:\n${entries.join('\n')}` : 'No roles.');
});
bot.onText(/\/chatty(?:\s+(on|off))?/, async (msg, match) => {
  const chatId = msg.chat.id;
  if(!['group','supergroup'].includes(msg.chat.type)) return bot.sendMessage(chatId, 'Groups only.');
  const isAdmin = await bot.getChatMember(chatId, msg.from.id).then(m=>['creator','administrator'].includes(m.status)).catch(()=>false);
  if(!isAdmin) return bot.sendMessage(chatId, 'Admin only.');
  const arg = match?.[1]?.toLowerCase();
  if(!arg) return bot.sendMessage(chatId, `Chatty is ${chattySettings[chatId] ? 'ON' : 'OFF'}`);
  if(arg==='on') { chattySettings[chatId]=true; saveChattySettings(); bot.sendMessage(chatId, '✅ Chatty ON'); }
  else { delete chattySettings[chatId]; saveChattySettings(); bot.sendMessage(chatId, '⛔ Chatty OFF'); }
});
bot.onText(/\/joke/, (msg) => {
  const randomJoke = localJokes[Math.floor(Math.random() * localJokes.length)];
  bot.sendMessage(msg.chat.id, `😂 ${randomJoke}`);
});
bot.onText(/\/fact/, (msg) => {
  const randomFact = localFacts[Math.floor(Math.random() * localFacts.length)];
  bot.sendMessage(msg.chat.id, `🤓 ${randomFact}`);
});
bot.onText(/\/mock/, async (msg) => {
  const input = msg.text.replace('/mock', '').trim();
  if(!input) return bot.sendMessage(msg.chat.id, 'Usage: /mock @username');
  bot.sendMessage(msg.chat.id, `🎭 Roasting ${input}...`);
  const roast = await callAI(`Create a short, funny, playful roast for "${input}". Keep it lighthearted. 1-2 sentences.`);
  bot.sendMessage(msg.chat.id, `💬 ${roast}`);
});
bot.onText(/\/stats/, async (msg) => {
  const chatId = msg.chat.id;
  const isAdmin = msg.chat.type === 'private' ? true : await bot.getChatMember(chatId, msg.from.id).then(m=>['creator','administrator'].includes(m.status)).catch(()=>false);
  if(!isAdmin && msg.chat.type !== 'private') return bot.sendMessage(chatId, 'Admin only.');
  const statsMsg = `📊 Bot Stats (since last restart)\nAPI calls: ${apiCallsTotal}\nCache hits: ${cacheHits}\nCooldown ignores: ${cooldownIgnores}\nBatch responses: ${batchResponsesGenerated}\nCache hit rate: ${((cacheHits/(apiCallsTotal+cacheHits||1))*100).toFixed(1)}%`;
  bot.sendMessage(chatId, statsMsg);
});

// Error handler for polling conflicts
bot.on('polling_error', (error) => {
  console.error('Polling Error:', error);
  if(error?.code==='ETELEGRAM' && error?.response?.body?.description?.includes('terminated by other getUpdates')) process.exit(1);
});
console.log('✅ Optimized bot running with aggressive API reduction.');