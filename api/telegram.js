// Telegram voice-in/voice-out webhook
//
// Setup: register this URL with Telegram once after deploy:
//   curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook?url=https://<your-domain>/api/telegram"
//
// Required env vars: TELEGRAM_BOT_TOKEN, OPENAI_API_KEY, GEMINI_API_KEY
//                    PAPERCLIP_VOICE_API_KEY, PAPERCLIP_API_URL, PAPERCLIP_COMPANY_ID
// Flow: voice msg → Whisper STT → Gemini (with Paperclip tools) → OpenAI TTS → voice reply

const { GoogleGenerativeAI } = require('@google/generative-ai');
const { TOOL_DECLARATIONS, runWithTools } = require('./lib/paperclip');

const SYSTEM_PROMPT = `You are Paperclip, Dan's AI assistant for managing work and tasks.
Be concise — responses should be 1-3 sentences max since they'll be spoken aloud.
Be direct, helpful, and conversational. No bullet points or markdown.
You have tools to manage Dan's tasks in Paperclip. When asked about agenda, tasks, or work — use them.
When creating or updating tasks, confirm what you did in one brief sentence.`;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const conversations = new Map();
const MAX_HISTORY = 10;
const MAX_CONVERSATIONS = 100;

async function telegramApi(method, body) {
  const res = await fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
  return res.json();
}

async function downloadTelegramFile(fileId) {
  const info = await fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`
  );
  const { result } = await info.json();
  const fileRes = await fetch(
    `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${result.file_path}`
  );
  return { buffer: await fileRes.arrayBuffer(), filePath: result.file_path };
}

async function transcribeAudio(buffer, filePath) {
  const ext = filePath.split('.').pop() || 'oga';
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: 'audio/ogg' }), `voice.${ext}`);
  form.append('model', 'whisper-1');
  const res = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });
  const data = await res.json();
  return (data.text || '').trim();
}

async function generateResponse(chatId, userMessage) {
  if (!conversations.has(chatId)) {
    if (conversations.size >= MAX_CONVERSATIONS) {
      conversations.delete(conversations.keys().next().value);
    }
    conversations.set(chatId, []);
  }
  const history = conversations.get(chatId);

  const model = genAI.getGenerativeModel({
    model: 'gemini-2.5-flash',
    systemInstruction: SYSTEM_PROMPT,
    tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
  });

  const chat = model.startChat({
    history: history.slice(-(MAX_HISTORY * 2)).map((turn) => ({
      role: turn.role,
      parts: [{ text: turn.text }],
    })),
  });

  const responseText = await runWithTools(chat, userMessage);

  history.push({ role: 'user', text: userMessage });
  history.push({ role: 'model', text: responseText });
  return responseText;
}

async function textToSpeech(text) {
  const res = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'tts-1',
      input: text,
      voice: 'nova',
      response_format: 'opus',
    }),
  });
  return res.arrayBuffer();
}

async function sendVoice(chatId, audioBuffer) {
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('voice', new Blob([audioBuffer], { type: 'audio/ogg' }), 'response.oga');
  const res = await fetch(
    `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendVoice`,
    { method: 'POST', body: form }
  );
  return res.json();
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(200).json({ ok: true });
  }

  const update = req.body;
  const message = update.message || update.edited_message;

  if (!message) {
    return res.status(200).json({ ok: true });
  }

  const chatId = message.chat.id;

  if (message.text === '/start') {
    await telegramApi('sendMessage', {
      chat_id: chatId,
      text: "Hey! I'm Paperclip. Send me a voice message and I'll respond in kind. I can check your tasks, create new ones, or update existing ones.",
    });
    return res.status(200).json({ ok: true });
  }

  try {
    let userText;

    if (message.voice) {
      const { buffer, filePath } = await downloadTelegramFile(message.voice.file_id);
      userText = await transcribeAudio(buffer, filePath);
      if (!userText) {
        await telegramApi('sendMessage', {
          chat_id: chatId,
          text: "Sorry, I couldn't understand that. Try again?",
        });
        return res.status(200).json({ ok: true });
      }
    } else if (message.text) {
      userText = message.text;
    } else {
      return res.status(200).json({ ok: true });
    }

    const responseText = await generateResponse(chatId, userText);
    const audioBuffer = await textToSpeech(responseText);
    await sendVoice(chatId, audioBuffer);
  } catch (err) {
    console.error('Telegram handler error:', err);
    try {
      await telegramApi('sendMessage', {
        chat_id: chatId,
        text: 'Something went wrong. Please try again.',
      });
    } catch {}
  }

  return res.status(200).json({ ok: true });
};
