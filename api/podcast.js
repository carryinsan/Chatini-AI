export const config = {
  runtime: 'edge',
};

// ============================================================================
// [ HYPER-RESILIENT JSON SANITIZER & FALLBACK ]
// ============================================================================
function extractJSON(str) {
  try {
    let clean = str.replace(/```json/gi, '').replace(/```/g, '').trim();
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error("No JSON object found");
    return JSON.parse(clean.substring(start, end + 1));
  } catch (e) {
    return {
      title: "Audio Overview",
      script: [
        { host: "A", text: "Welcome back! Today we are taking a look into the core details of your document." },
        { host: "B", text: "That's right! Let me break down the main takeaways for you simply." }
      ]
    };
  }
}

// ============================================================================
// [ MULTI-KEY GEMINI API CALLER WITH AUTOMATIC ROTATION ]
// ============================================================================
async function callGemini(systemPrompt, userPrompt, responseMimeType = "application/json") {
  const keys = [
    process.env.GEMINI_API_KEY_1,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
    process.env.GEMINI_API_KEY
  ].filter(Boolean);

  if (keys.length === 0) throw new Error("No Gemini API keys found in environment variables.");

  let lastError = null;
  for (const key of keys) {
    try {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: "user", parts: [{ text: userPrompt }] }],
          generationConfig: {
            temperature: 0.7,
            ...(responseMimeType ? { responseMimeType } : {})
          }
        })
      });

      const data = await res.json();
      if (data.error) throw new Error(data.error.message || "Gemini API Error");

      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error("Empty candidate payload received from Gemini.");
      return text;
    } catch (err) {
      lastError = err;
      console.warn(`Gemini key failed, attempting next key. Error: ${err.message}`);
    }
  }
  throw new Error(`All configured Gemini API keys failed. Last error: ${lastError?.message}`);
}

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  try {
    const { textContext } = await req.json();
    if (!textContext) throw new Error("No text provided for podcast generation.");

    // Truncate payload to prevent edge timeouts
    const safeContext = textContext.length > 80000 ? textContext.substring(0, 80000) + "\n...[TRUNCATED]" : textContext;

    const systemPrompt = `You are LexisAI, an advanced Neural Podcast Producer.
    NEVER mention OpenAI, Google, Anthropic, or any other AI company name. You are LexisAI.
    
    TASK: Convert the provided text into a highly engaging, witty, and easy-to-understand 2-Host Podcast Script.
    Host A: The curious, energetic learner who asks concise questions.
    Host B: The witty, deep expert who explains things simply.
    
    OUTPUT FORMAT: Output ONLY raw JSON matching this structure:
    {
      "title": "A catchy title for this audio session",
      "script": [
        { "host": "A", "text": "Question or conversational hook here" },
        { "host": "B", "text": "Clear and witty explanation here" }
      ]
    }`;

    const rawText = await callGemini(systemPrompt, `DOCUMENT CONTENT:\n\n${safeContext}`, "application/json");
    const podcastData = extractJSON(rawText);

    return new Response(JSON.stringify({ success: true, data: podcastData }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), { 
      status: 500, headers: { 'Content-Type': 'application/json' } 
    });
  }
}
