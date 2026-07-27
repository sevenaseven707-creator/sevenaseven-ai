/**
 * SevenaSeven AI Bot - Enterprise Grade 10/10 Architecture
 * Cloudflare Worker, Gemini 2.5 Flash, KV Memory, Vision API, Admin Panel, Rate Limiter.
 */

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_API_ENDPOINT = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;
const TELEGRAM_MAX_LENGTH = 4000;
const FETCH_TIMEOUT_MS = 15000; // 15s timeout
const RATE_LIMIT_MAX_MSG = 10; // Max messages per minute
const SYSTEM_PROMPT = "تۆ SevenaSeven AI، بۆتەکێ هوشمەندیا دەستکردی کۆ بەرسڤا بەکارهێنەران ددەی ب کوردی (بادینی و سورانی)، عەرەبی و ئینگلیزی. بەرسڤێن تە دەم ب دەم هاوکار، ڕێزدار و خاوەن ڕێکخستن بن.";

export default {
  /**
   * Main Worker Fetch Handler
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. Health, Version & Info Endpoint
    if (request.method === "GET") {
      if (url.pathname === "/" || url.pathname === "/health" || url.pathname === "/info" || url.pathname === "/version") {
        return new Response(JSON.stringify({
          status: "healthy",
          name: "SevenaSeven AI Bot",
          version: "2.0.0-enterprise",
          engine: GEMINI_MODEL,
          server: "Cloudflare Workers Edge"
        }), {
          status: 200,
          headers: { "Content-Type": "application/json; charset=utf-8" }
        });
      }
      return new Response("Not Found", { status: 404 });
    }

    // 2. Strict Webhook Route Isolation
    if (request.method === "POST" && url.pathname !== "/webhook") {
      return new Response("Not Found", { status: 404 });
    }

    if (request.method !== "POST") {
      return new Response("Method Not Allowed", { status: 405 });
    }

    // 3. Environment Secrets & KV Validation
    if (!env.BOT_TOKEN || !env.GEMINI_API_KEY) {
      console.error("[CRITICAL_ENV] BOT_TOKEN or GEMINI_API_KEY is missing.");
      return new Response("OK", { status: 200 });
    }

    // 4. Webhook Secret Token Verification
    if (env.WEBHOOK_SECRET) {
      const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (secretHeader !== env.WEBHOOK_SECRET) {
        console.warn("[SECURITY] Unauthorized webhook request blocked.");
        return new Response("Unauthorized", { status: 401 });
      }
    }

    // 5. Safe Payload Processing
    let update = null;
    try {
      update = await request.json();
    } catch (err) {
      console.error("[PAYLOAD_ERROR] Failed to parse JSON body:", err);
      return new Response("OK", { status: 200 });
    }

    // Execute background update asynchronously
    if (ctx && typeof ctx.waitUntil === "function") {
      ctx.waitUntil(processUpdate(update, env));
    } else {
      await processUpdate(update, env);
    }

    return new Response("OK", { status: 200 });
  }
};

/**
 * Core Telegram Processing Pipeline
 */
async function processUpdate(update, env) {
  if (!update || (!update.message && !update.channel_post)) {
    return;
  }

  const message = update.message || update.channel_post;
  const chatId = message.chat.id;
  const userId = message.from ? message.from.id : chatId;
  const isGroup = message.chat.type === "group" || message.chat.type === "supergroup";

  // Check if User is Banned in KV
  if (env.BOT_KV) {
    const isBanned = await env.BOT_KV.get(`ban:${userId}`);
    if (isBanned === "true") {
      console.warn(`[BLOCKED_USER] Ignored message from banned user: ${userId}`);
      return;
    }

    // Rate Limiting Logic (10 requests/min)
    const rateKey = `rate:${userId}:${Math.floor(Date.now() / 60000)}`;
    const currentRequests = parseInt((await env.BOT_KV.get(rateKey)) || "0");
    if (currentRequests >= RATE_LIMIT_MAX_MSG) {
      await sendTelegramMessage(chatId, "⚠️ تە زۆر نامە هنارتینە! هیڤیە خولەکەکێ ڕاوەستە.", env.BOT_TOKEN);
      return;
    }
    await env.BOT_KV.put(rateKey, (currentRequests + 1).toString(), { expirationTtl: 120 });
  }

  // Extract Input Text or Captions
  let userPrompt = message.text || message.caption || "";
  userPrompt = userPrompt.trim();

  // Admin Panel Commands
  const ADMIN_ID = env.ADMIN_ID || "";
  if (userId.toString() === ADMIN_ID.toString() && userPrompt.startsWith("/")) {
    if (await handleAdminCommands(chatId, userPrompt, env)) return;
  }

  // Standard Bot Commands
  if (userPrompt === "/start") {
    await sendTelegramMessage(chatId, "👋 **بەخێرهاتی بۆ SevenaSeven AI Enterprise!**\n\nئەز بۆتەکێ ژیرێ هوشمەندیا دەستکردم. تۆ دکاری پەیام، دەنگ، یان وێنان بۆ من هنێری دا ئەز دگەل تە ب ئاخڤم.\n\n/help - ڕێنمایی\n/about - دەربارەی بۆتی", env.BOT_TOKEN);
    return;
  }

  if (userPrompt === "/help") {
    await sendTelegramMessage(chatId, "🛠 **فەرمانێن هاریکاریێ:**\n\n- هەر نامەیەکی، وێنەیەکی، یان دەنگەکی فرێکە دا بەرسڤا تە ب دم.\n- /reset - پاکژکرنا مێژوویا گفتوگۆیێ", env.BOT_TOKEN);
    return;
  }

  if (userPrompt === "/reset" && env.BOT_KV) {
    await env.BOT_KV.delete(`chat_history:${chatId}`);
    await sendTelegramMessage(chatId, "🧹 مێژوویا گفتوگۆیا تە هاتە پاکژکرن!", env.BOT_TOKEN);
    return;
  }

  if (!userPrompt && !message.photo && !message.voice && !message.audio) {
    return; // Ignore non-supported attachments without caption
  }

  await sendChatAction(chatId, "typing", env.BOT_TOKEN);

  try {
    // Media & Vision Extract
    let imageBase64 = null;
    let mimeType = null;

    if (message.photo && message.photo.length > 0) {
      const largestPhoto = message.photo[message.photo.length - 1];
      const fileData = await fetchTelegramFile(largestPhoto.file_id, env.BOT_TOKEN);
      if (fileData) {
        imageBase64 = fileData.base64;
        mimeType = fileData.mimeType;
      }
    }

    // Load History from KV
    let history = [];
    if (env.BOT_KV) {
      const savedHistory = await env.BOT_KV.get(`chat_history:${chatId}`);
      if (savedHistory) {
        history = JSON.parse(savedHistory);
      }
    }

    // Build Payload & Call Gemini
    const aiResponse = await callGeminiWithVisionAndHistory(userPrompt, imageBase64, mimeType, history, env.GEMINI_API_KEY);

    // Update History in KV (Keep last 10 messages)
    if (env.BOT_KV) {
      history.push({ role: "user", parts: [{ text: userPrompt || "[Media Message]" }] });
      history.push({ role: "model", parts: [{ text: aiResponse }] });
      if (history.length > 10) history = history.slice(history.length - 10);
      await env.BOT_KV.put(`chat_history:${chatId}`, JSON.stringify(history), { expirationTtl: 86400 });
    }

    // Deliver Response
    await sendSmartChunkedMessage(chatId, aiResponse, env.BOT_TOKEN);
  } catch (err) {
    console.error(`[EXEC_ERROR] Chat ${chatId}:`, err.stack || err);
    await sendTelegramMessage(chatId, "⚠️ ببورە، ئاریشەیەک چێبوو د بەرسڤدانا نامەیا تە دا. هیڤیە دووبارە بگەڕێنەوە.", env.BOT_TOKEN);
  }
}

/**
 * Handle Admin Management Commands
 */
async function handleAdminCommands(chatId, prompt, env) {
  const parts = prompt.split(" ");
  const cmd = parts[0];
  const arg = parts[1];

  if (cmd === "/ban" && arg && env.BOT_KV) {
    await env.BOT_KV.put(`ban:${arg}`, "true");
    await sendTelegramMessage(chatId, `🚫 User ${arg} has been banned.`, env.BOT_TOKEN);
    return true;
  }

  if (cmd === "/unban" && arg && env.BOT_KV) {
    await env.BOT_KV.delete(`ban:${arg}`);
    await sendTelegramMessage(chatId, `✅ User ${arg} has been unbanned.`, env.BOT_TOKEN);
    return true;
  }

  if (cmd === "/stats") {
    await sendTelegramMessage(chatId, `📊 **System Status**: Enterprise Engine Active.\nGemini Model: ${GEMINI_MODEL}`, env.BOT_TOKEN);
    return true;
  }

  return false;
}

/**
 * Query Gemini 2.5 API with Memory, Vision, & System Instructions
 */
async function callGeminiWithVisionAndHistory(prompt, imageBase64, mimeType, history, apiKey) {
  const url = `${GEMINI_API_ENDPOINT}?key=${encodeURIComponent(apiKey)}`;

  const contents = [...history];
  const userPart = [];

  if (prompt) userPart.push({ text: prompt });
  if (imageBase64 && mimeType) {
    userPart.push({
      inline_data: { mime_type: mimeType, data: imageBase64 }
    });
  }

  contents.push({ role: "user", parts: userPart });

  const payload = {
    system_instruction: {
      parts: [{ text: SYSTEM_PROMPT }]
    },
    contents: contents,
    generationConfig: {
      temperature: 0.7,
      topP: 0.95,
      maxOutputTokens: 2048
    }
  };

  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  }, FETCH_TIMEOUT_MS);

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Gemini API Error status ${response.status}: ${errText}`);
  }

  const data = await response.json();
  if (data.candidates && data.candidates[0]?.content?.parts[0]?.text) {
    return data.candidates[0].content.parts[0].text;
  }

  return "⚠️ چ بەرسڤ ژ AI نەهاتە وەرگرتن.";
}

/**
 * Fetch File from Telegram Servers & Convert to Base64
 */
async function fetchTelegramFile(fileId, botToken) {
  try {
    const fileRes = await fetchWithTimeout(`https://api.telegram.org/bot${botToken}/getFile?file_id=${fileId}`, {}, 5000);
    const fileJson = await fileRes.json();
    if (!fileJson.ok) return null;

    const filePath = fileJson.result.file_path;
    const downloadRes = await fetchWithTimeout(`https://api.telegram.org/file/bot${botToken}/${filePath}`, {}, 10000);
    const arrayBuffer = await downloadRes.arrayBuffer();

    const bytes = new Uint8Array(arrayBuffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    const base64 = btoa(binary);
    const ext = filePath.split(".").pop().toLowerCase();
    const mimeType = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png";

    return { base64, mimeType };
  } catch (err) {
    console.error("[FILE_FETCH_ERROR]", err);
    return null;
  }
}

/**
 * Safe Message Chunking preserving Unicode & Emojis
 */
async function sendSmartChunkedMessage(chatId, text, botToken) {
  if (text.length <= TELEGRAM_MAX_LENGTH) {
    await sendTelegramMessage(chatId, text, botToken);
    return;
  }

  const chunks = splitUnicodeSafe(text, TELEGRAM_MAX_LENGTH);
  for (const chunk of chunks) {
    await sendTelegramMessage(chatId, chunk, botToken);
  }
}

function splitUnicodeSafe(str, limit) {
  const codePoints = Array.from(str);
  const chunks = [];
  let current = "";

  for (const char of codePoints) {
    if ((current + char).length > limit) {
      chunks.push(current);
      current = char;
    } else {
      current += char;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/**
 * Sends Telegram Message with Auto-Fallback from Markdown to Plain
 */
async function sendTelegramMessage(chatId, text, botToken) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  let response = await fetchWithTimeout(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: "Markdown" })
  }, 8000);

  if (!response.ok) {
    response = await fetchWithTimeout(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: text })
    }, 8000);
  }
}

async function sendChatAction(chatId, action, botToken) {
  try {
    await fetchWithTimeout(`https://api.telegram.org/bot${botToken}/sendChatAction`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, action: action })
    }, 5000);
  } catch (e) {}
}

/**
 * AbortController Timeout Fetch Wrapper
 */
async function fetchWithTimeout(resource, options = {}, timeout = 10000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(resource, { ...options, signal: controller.signal });
    clearTimeout(id);
    return response;
  } catch (error) {
    clearTimeout(id);
    throw error;
  }
}
