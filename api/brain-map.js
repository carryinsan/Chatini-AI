export const config = {
    runtime: 'edge',
};

function sanitizeJSON(str) {
    const firstBrace = str.indexOf('{');
    const lastBrace = str.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1) throw new Error("No JSON object found in AI response.");
    return JSON.parse(str.substring(firstBrace, lastBrace + 1));
}

async function fetchBrainMapBlueprint(prompt, keys) {
    let finalError = "";
    const systemInstruction = `You are LexisAI's Neural Core.
Analyze the chat history and extract facts, projects, preferences, and skills into a 2D knowledge graph structure.

CRITICAL: Output ONLY a valid JSON object. No markdown, no \`\`\`json.
SCHEMA:
{
  "nodes": [
    { "id": "python", "label": "Python", "group": "skill" },
    { "id": "lexis", "label": "Building LexisAI", "group": "project" },
    { "id": "darkmode", "label": "Prefers Dark Mode", "group": "preference" }
  ],
  "links": [
    { "source": "lexis", "target": "python", "label": "uses" }
  ]
}`;

    const payload = {
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", maxOutputTokens: 8192, temperature: 0.1 },
        safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
        ]
    };

    for (let i = 0; i < keys.length; i++) {
        const currentKey = keys[i].replace(/[\r\n\s]/g, '');
        const streamUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${currentKey}`;
        
        try {
            const res = await fetch(streamUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            if (res.ok) {
                const data = await res.json();
                return data.candidates[0].content.parts[0].text;
            } else {
                finalError = await res.text();
                if (res.status === 429 || res.status === 503) continue;
                break; 
            }
        } catch (e) {
            finalError = e.message;
        }
    }
    throw new Error(`Gemini Pipeline Failed: ${finalError}`);
}

export default async function handler(req) {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    try {
        const { chatHistory } = await req.json();
        const GEMINI_KEYS = [
            process.env.GEMINI_API_KEY_1,
            process.env.GEMINI_API_KEY_2,
            process.env.GEMINI_API_KEY_3,
            process.env.GEMINI_API_KEY
        ].filter(Boolean);

        if (GEMINI_KEYS.length === 0) throw new Error("Server missing Gemini API keys.");
        if (!chatHistory || !Array.isArray(chatHistory) || chatHistory.length === 0) throw new Error("Insufficient history to map.");

        const compressedHistory = chatHistory.slice(-30).map(m => `${m.role}: ${m.content}`).join('\n').substring(0, 40000);

        const rawJSON = await fetchBrainMapBlueprint(compressedHistory, GEMINI_KEYS);
        const constellationData = sanitizeJSON(rawJSON);

        return new Response(JSON.stringify({ success: true, data: constellationData }), {
            status: 200, headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        return new Response(JSON.stringify({ success: false, error: error.message }), {
            status: 500, headers: { 'Content-Type': 'application/json' }
        });
    }
}
