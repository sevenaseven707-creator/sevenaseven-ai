export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return new Response("SevenaSeven AI Bot is running!", {
        status: 200,
      });
    }

    try {
      const update = await request.json();

      if (!update.message || !update.message.text) {
        return new Response("OK", { status: 200 });
      }

      const chatId = update.message.chat.id;
      const text = update.message.text;

      if (text === "/start") {
        await sendTelegramMessage(
          env.BOT_TOKEN,
          chatId,
          "👋 Welcome to SevenaSeven AI Bot!\n\nThe bot is online and ready."
        );

        return new Response("OK", { status: 200 });
      }

      const aiReply = await askGemini(env.GEMINI_API_KEY, text);

      await sendTelegramMessage(
        env.BOT_TOKEN,
        chatId,
        aiReply
      );

      return new Response("OK", { status: 200 });

    } catch (error) {
      return new Response(error.toString(), {
        status: 500,
      });
    }
  },
};
async function sendTelegramMessage(botToken, chatId, text) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;

  await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      chat_id: chatId,
      text: text,
      parse_mode: "HTML",
    }),
  });
}

async function askGemini(apiKey, prompt) {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      contents: [
        {
          parts: [
            {
              text: prompt,
            },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    return "❌ Gemini API Error.";
  }

  const data = await response.json();

  try {
    return data.candidates[0].content.parts[0].text;
  } catch (e) {
    return "⚠️ No response received from Gemini.";
  }
}
function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function logError(error) {
  console.error("SevenaSeven AI Error:", error);
}

addEventListener("unhandledrejection", (event) => {
  console.error("Unhandled Promise Rejection:", event.reason);
});

addEventListener("error", (event) => {
  console.error("Worker Error:", event.error);
});
