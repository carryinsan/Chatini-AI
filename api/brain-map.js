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
      nodes: [{ id: "user", label: "User Interaction", group: "project" }, { id: "ai", label: "LexisAI", group: "skill" }],
      links: [{ source: "user", target: "ai", label: "communicates with" }]
    };
  }
}

async function callGemini(systemPrompt, userPrompt) {
  const rawKeys = [
    process.env.GEMINI_API_KEY_1, process.env.GEMINI_API_KEY_2, 
    process.env.GEMINI_API_KEY_3, process.env.GEMINI_API_KEY
  ];
  const keys = rawKeys.map(k => k ? k.replace(/[\r\n\s]/g, '') : null).filter(Boolean);
  if (keys.length === 0) throw new Error("No Gemini keys found.");

  let lastError = null;
  for (const key of keys) {
    try {
      const res = await fetch(`[https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=$](https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=$){key}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: "user", parts: [{ text: userPrompt }] }],
          generationConfig: { temperature: 0.1, responseMimeType: "application/json" }
        })
      });

      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error("Empty payload.");
      return text;
    } catch (err) { lastError = err; }
  }
  throw new Error(`All keys failed. Last error: ${lastError?.message}`);
}

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  try {
    const { chatHistory } = await req.json();
    if (!chatHistory || !Array.isArray(chatHistory)) throw new Error("Invalid chat history structure.");

    const compressedHistory = chatHistory.slice(-30).map(m => `${m.role}: ${m.content}`).join('\n').substring(0, 40000);

    const systemPrompt = `You are LexisAI's Neural Core.
    TASK: Analyze the chat history and extract facts, projects, preferences, and skills about the user.
    
    OUTPUT FORMAT: Output ONLY raw JSON matching this schema:
    {
      "nodes": [
        { "id": "python", "label": "Python", "group": "skill" },
        { "id": "darkmode", "label": "Prefers Dark Mode", "group": "preference" }
      ],
      "links": [
        { "source": "lexis", "target": "python", "label": "uses" }
      ]
    }`;

    const rawText = await callGemini(systemPrompt, `Map this history:\n\n${compressedHistory}`);
    const constellationData = extractJSON(rawText);

    return new Response(JSON.stringify({ success: true, data: constellationData }), { status: 200 });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500 });
  }
}
