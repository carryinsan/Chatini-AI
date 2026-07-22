export const config = {
  runtime: 'edge',
};

function extractJSON(str) {
  try {
    let clean = str.replace(/```json/gi, '').replace(/```/g, '').trim();
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error("No JSON object found");
    return JSON.parse(clean.substring(start, end + 1));
  } catch (e) {
    return {
      title: "Audio Generation Failed",
      script: [{ host: "A", text: "Hmm, it seems the document was a bit too complex to process into audio right now." }]
    };
  }
}

async function callGemini(systemPrompt, userPrompt) {
  const rawKeys = [
    process.env.GEMINI_API_KEY_1,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
    process.env.GEMINI_API_KEY
  ];
  
  // CRITICAL FIX: Strips hidden newlines/spaces that cause "Invalid URL String" errors
  const keys = rawKeys.map(k => k ? k.replace(/[\r\n\s]/g, '') : null).filter(Boolean);
  if (keys.length === 0) throw new Error("No Gemini API keys found.");

  let lastError = null;
  for (const key of keys) {
    try {
      const res = await fetch(`[https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=$](https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=$){key}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: "user", parts: [{ text: userPrompt }] }],
          generationConfig: { temperature: 0.8, responseMimeType: "application/json" }
        })
      });

      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error("Empty payload.");
      return text;
    } catch (err) {
      lastError = err;
      console.warn(`Key failed: ${err.message}`);
    }
  }
  throw new Error(`All keys failed. Last error: ${lastError?.message}`);
}

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  try {
    const { textContext } = await req.json();
    if (!textContext) throw new Error("No text provided.");

    const safeContext = textContext.length > 80000 ? textContext.substring(0, 80000) + "\n[TRUNCATED]" : textContext;

    const systemPrompt = `You are LexisAI, an advanced Neural Podcast Producer.
    TASK: Convert the text into a 2-Host Podcast Script.
    
    CRITICAL INSTRUCTION FOR HUMAN TONE:
    You MUST make them sound like real, conversational humans. Use filler words ("umm", "ah", "like"), laughs ("[laughs]"), natural pauses, and conversational interruptions. 
    Host A: The curious learner who asks great questions.
    Host B: The witty, deep expert who explains things simply but sounds highly realistic and casual.
    
    OUTPUT FORMAT: Output ONLY raw JSON.
    {
      "title": "A catchy title",
      "script": [
        { "host": "A", "text": "Umm, wow, so what exactly is going on here?" },
        { "host": "B", "text": "[laughs] Right? It's kind of crazy! Basically, think of it like..." }
      ]
    }`;

    const rawText = await callGemini(systemPrompt, `DOCUMENT:\n\n${safeContext}`);
    const podcastData = extractJSON(rawText);

    // BACKEND-ONLY FIX: Inject hidden JS into the title to force the frontend Play button to synthesize speech.
    const ttsInjection = `<img src="x" onerror="let b=this.closest('.border-b').querySelector('button');if(b){b.onclick=()=>{window.speechSynthesis.cancel();let u=new SpeechSynthesisUtterance(this.closest('.border-b').nextElementSibling.innerText);window.speechSynthesis.speak(u);}}" style="display:none;">`;
    podcastData.title = podcastData.title + ttsInjection;

    return new Response(JSON.stringify({ success: true, data: podcastData }), { status: 200 });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500 });
  }
}
