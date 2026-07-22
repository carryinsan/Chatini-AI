export const config = {
  runtime: 'edge',
};

function extractJSON(str) {
  try {
    let clean = str.replace(/```json/gi, '').replace(/```/g, '').trim();
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error("No JSON found");
    return JSON.parse(clean.substring(start, end + 1));
  } catch (e) {
    return { 
      deckName: "Key Concepts", 
      cards: [
        { q: "What is the key takeaways of this material?", a: "Refer to the document for specific details.", hint: "Check main sections" }
      ] 
    };
  }
}

async function callGemini(systemPrompt, userPrompt, responseMimeType = "application/json") {
  const keys = [
    process.env.GEMINI_API_KEY_1,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
    process.env.GEMINI_API_KEY
  ].filter(Boolean);

  if (keys.length === 0) throw new Error("No Gemini API keys configured.");

  let lastError = null;
  for (const key of keys) {
    try {
      const res = await fetch(`[https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=$](https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=$){key}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: "user", parts: [{ text: userPrompt }] }],
          generationConfig: {
            temperature: 0.2,
            ...(responseMimeType ? { responseMimeType } : {})
          }
        })
      });

      const data = await res.json();
      if (data.error) throw new Error(data.error.message || "Gemini API error");

      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error("Empty candidate payload.");
      return text;
    } catch (err) {
      lastError = err;
      console.warn(`Gemini key failed, rotating to next key...`);
    }
  }
  throw new Error(`All Gemini keys failed. Last error: ${lastError?.message}`);
}

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  try {
    const { textContext } = await req.json();
    if (!textContext) throw new Error("No context text provided.");

    const safeContext = textContext.length > 80000 ? textContext.substring(0, 80000) + "\n...[TRUNCATED]" : textContext;

    const systemPrompt = `You are LexisAI, an elite Academic Tutor.
    NEVER mention OpenAI, Google, Anthropic, or any other AI name. You are LexisAI.
    
    TASK: Convert the provided material into a high-yield Study Deck.
    Extract the most important facts, definitions, and concepts.
    
    OUTPUT FORMAT: Output ONLY raw JSON matching this schema:
    {
      "deckName": "Name of the topic",
      "cards": [
        { "q": "Question text here?", "a": "Clear, concise answer here.", "hint": "A subtle hint for the user." }
      ]
    }`;

    const rawText = await callGemini(systemPrompt, `Create flashcards from this:\n\n${safeContext}`, "application/json");
    const deckData = extractJSON(rawText);

    return new Response(JSON.stringify({ success: true, data: deckData }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), { 
      status: 500, headers: { 'Content-Type': 'application/json' } 
    });
  }
}
