export const config = {
  runtime: 'edge',
};

function extractJSON(str) {
  try {
    let clean = str.replace(/```json/gi, '').replace(/```/g, '').trim();
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    if (start === -1 || end === -1) throw new Error("No JSON structure found");
    return JSON.parse(clean.substring(start, end + 1));
  } catch (e) {
    return {
      nodes: [
        { id: "core", label: "User Interaction", group: "project" },
        { id: "ai", label: "LexisAI Core", group: "skill" }
      ],
      links: [
        { source: "core", target: "ai", label: "connects" }
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
            temperature: 0.1,
            ...(responseMimeType ? { responseMimeType } : {})
          }
        })
      });

      const data = await res.json();
      if (data.error) throw new Error(data.error.message || "Gemini error");

      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error("Empty candidate payload");
      return text;
    } catch (err) {
      lastError = err;
      console.warn(`Gemini key failed, attempting key fallback...`);
    }
  }
  throw new Error(`All Gemini API keys failed. Last error: ${lastError?.message}`);
}

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  try {
    const { chatHistory } = await req.json();
    if (!chatHistory || !Array.isArray(chatHistory)) throw new Error("Invalid chat history structure.");

    // Compress history for fast payload execution
    const compressedHistory = chatHistory.slice(-30).map(m => `${m.role}: ${m.content}`).join('\n').substring(0, 40000);

    const systemPrompt = `You are LexisAI's Neural Core. Your job is to map the user's brain.
    NEVER mention OpenAI, Google, Anthropic, or any other AI name.
    
    TASK: Analyze the chat history and extract facts, projects, preferences, and skills about the user into a 2D knowledge graph.
    
    OUTPUT FORMAT: Output ONLY raw JSON matching this schema:
    {
      "nodes": [
        { "id": "python", "label": "Python", "group": "skill" },
        { "id": "lexis", "label": "Building LexisAI", "group": "project" },
        { "id": "darkmode", "label": "Prefers Dark Mode", "group": "preference" }
      ],
      "links": [
        { "source": "lexis", "target": "python", "label": "uses" },
        { "source": "lexis", "target": "darkmode", "label": "designed in" }
      ]
    }`;

    const rawText = await callGemini(systemPrompt, `Map this history:\n\n${compressedHistory}`, "application/json");
    const constellationData = extractJSON(rawText);

    return new Response(JSON.stringify({ success: true, data: constellationData }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), { 
      status: 500, headers: { 'Content-Type': 'application/json' } 
    });
  }
}
