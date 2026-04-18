const twilio = require('twilio');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const VoiceResponse = twilio.twiml.VoiceResponse;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

const SYSTEM_PROMPT = `You are Paperclip, an AI assistant helping Dan while he drives.
Be concise — responses should be 1-3 sentences max since they'll be spoken aloud.
Be direct, helpful, and conversational. No bullet points or markdown.
Focus on actionable answers. If asked about tasks or work, be specific and brief.`;

// Simple in-memory conversation history (per-call via CallSid)
const conversations = new Map();

const MAX_HISTORY = 10; // keep last N turns

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
    // Maintain conversation history per call
    if (!conversations.has(callSid)) {
      conversations.set(callSid, []);
    }
    const history = conversations.get(callSid);

    const model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      systemInstruction: SYSTEM_PROMPT,
    });

    const chat = model.startChat({
      history: history.slice(-MAX_HISTORY).map((turn) => ({
        role: turn.role,
        parts: [{ text: turn.text }],
      })),
    });

    const result = await chat.sendMessage(speech);
    const aiResponse = result.response.text().trim();

    // Store turn in history
    history.push({ role: 'user', text: speech });
    history.push({ role: 'model', text: aiResponse });

    // Clean up old calls after 30 min (rough estimate by size limit)
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

    // Fallback if silence after response
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
