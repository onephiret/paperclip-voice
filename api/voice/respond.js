const twilio = require('twilio');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { TOOL_DECLARATIONS, runWithTools } = require('../lib/paperclip');
const VoiceResponse = twilio.twiml.VoiceResponse;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const SYSTEM_PROMPT = `You are Paperclip, an AI assistant helping Dan while he drives.
Be concise — responses should be 1-3 sentences max since they'll be spoken aloud.
Be direct, helpful, and conversational. No bullet points or markdown.
You have tools to manage Dan's tasks in Paperclip. When asked about agenda, tasks, or work — use them.
When creating or updating tasks, confirm what you did in one brief sentence.`;

const conversations = new Map();
const MAX_HISTORY = 10;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  const twiml = new VoiceResponse();
  const speech = req.body?.SpeechResult || '';
  const callSid = req.body?.CallSid || 'unknown';

  if (!speech.trim()) {
    const gather = twiml.gather({
      input: 'speech',
      action: '/api/voice/respond',
      speechTimeout: 'auto',
      language: 'en-US',
      speechModel: 'experimental_conversations',
    });
    gather.say({ voice: 'Polly.Joanna' }, "Sorry, I didn't catch that. Go ahead.");
    twiml.redirect('/api/voice');
    res.setHeader('Content-Type', 'text/xml');
    return res.send(twiml.toString());
  }

  try {
    if (!conversations.has(callSid)) {
      conversations.set(callSid, []);
    }
    const history = conversations.get(callSid);

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.5-flash',
      systemInstruction: SYSTEM_PROMPT,
      tools: [{ functionDeclarations: TOOL_DECLARATIONS }],
    });

    const chat = model.startChat({
      history: history.slice(-MAX_HISTORY).map((turn) => ({
        role: turn.role,
        parts: [{ text: turn.text }],
      })),
    });

    const aiResponse = await runWithTools(chat, speech);

    history.push({ role: 'user', text: speech });
    history.push({ role: 'model', text: aiResponse });

    if (conversations.size > 100) {
      const firstKey = conversations.keys().next().value;
      conversations.delete(firstKey);
    }

    const gather = twiml.gather({
      input: 'speech',
      action: '/api/voice/respond',
      speechTimeout: 'auto',
      language: 'en-US',
      speechModel: 'experimental_conversations',
    });
    gather.say({ voice: 'Polly.Joanna', language: 'en-US' }, aiResponse);

    twiml.say({ voice: 'Polly.Joanna' }, 'Anything else?');
    twiml.redirect('/api/voice/respond');
  } catch (err) {
    console.error('AI error:', err);
    const gather = twiml.gather({
      input: 'speech',
      action: '/api/voice/respond',
      speechTimeout: 'auto',
    });
    gather.say({ voice: 'Polly.Joanna' }, "I hit a snag. What else can I help with?");
  }

  res.setHeader('Content-Type', 'text/xml');
  res.send(twiml.toString());
};
