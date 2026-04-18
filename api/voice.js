const twilio = require('twilio');
const VoiceResponse = twilio.twiml.VoiceResponse;

module.exports = async (req, res) => {
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  const twiml = new VoiceResponse();
  const gather = twiml.gather({
    input: 'speech',
    action: '/api/voice/respond',
    speechTimeout: 'auto',
    language: 'en-US',
    speechModel: 'experimental_conversations',
  });

  gather.say(
    { voice: 'Polly.Joanna', language: 'en-US' },
    "Hey Dan, Paperclip here. What's on your mind?"
  );

  twiml.say({ voice: 'Polly.Joanna' }, "I didn't catch that. Try again.");
  twiml.redirect('/api/voice');

  res.setHeader('Content-Type', 'text/xml');
  res.send(twiml.toString());
};
