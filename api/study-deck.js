export const config = {
    runtime: 'edge',
};

const FALLBACK_DECK = {
    deckName: "Core Concepts Overview",
    cards: [
        { q: "What are the primary insights?", a: "Review the provided text stream for core structural guidelines.", hint: "Check summary details" },
        { q: "How can this be applied?", a: "Integrate findings directly into your active workspace session.", hint: "Practical execution" }
    ]
};

function sanitizeJSON(str) {
    try {
        const match = str.match(/\{[\s\S]*\}/);
        if (!match) throw new Error("No JSON object found");
        let clean = match[0].replace(/,\s*([\]}])/g, '$1');
        return JSON.parse(clean);
    } catch (e) {
        return null;
    }
}

async function fetchStudyBlueprint(prompt, keys) {
    let finalError = "";
    const systemInstruction = `You are LexisAI, an elite Academic Tutor.
Convert the provided material into a high-yield Study Deck containing key facts and definitions.

CRITICAL: Output ONLY a valid JSON object. No markdown, no \`\`\`json.
SCHEMA:
{
  "deckName": "Name of the topic",
  "cards": [
    { "q": "Question text here?", "a": "Clear, concise answer here.", "hint": "A subtle hint for the user." }
  ]
}`;

    const payload = {
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", maxOutputTokens: 8192, temperature: 0.2 },
        safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
        ]
    };

    for (let i = 0; i < keys.length; i++) {
        const currentKey = keys[i].replace(/[\r\n\s]/g, '');
        const streamUrl = `[https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=$](https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=$){currentKey}`;
        
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
    throw new Error(`Execution Failed: ${finalError}`);
}

export default async function handler(req) {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    try {
        const { textContext } = await req.json();
        const GEMINI_KEYS = [
            process.env.GEMINI_API_KEY_1,
            process.env.GEMINI_API_KEY_2,
            process.env.GEMINI_API_KEY_3,
            process.env.GEMINI_API_KEY
        ].filter(Boolean);

        if (GEMINI_KEYS.length === 0) {
            return new Response(JSON.stringify({ success: true, data: FALLBACK_DECK }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }

        const safeContext = textContext && textContext.length > 80000 ? textContext.substring(0, 80000) + "\n[TRUNCATED]" : (textContext || "General study overview.");

        let rawJSON = "";
        try {
            rawJSON = await fetchStudyBlueprint(safeContext, GEMINI_KEYS);
        } catch (err) {
            return new Response(JSON.stringify({ success: true, data: FALLBACK_DECK }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }

        const deckData = sanitizeJSON(rawJSON) || FALLBACK_DECK;

        return new Response(JSON.stringify({ success: true, data: deckData }), {
            status: 200, headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        return new Response(JSON.stringify({ success: true, data: FALLBACK_DECK }), {
            status: 200, headers: { 'Content-Type': 'application/json' }
        });
    }
}
