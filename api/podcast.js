export const config = {
    runtime: 'edge',
};

function sanitizeJSON(str) {
    const firstBrace = str.indexOf('{');
    const lastBrace = str.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1) throw new Error("No JSON object found in AI response.");
    return JSON.parse(str.substring(firstBrace, lastBrace + 1));
}

async function fetchPodcastBlueprint(prompt, keys) {
    let finalError = "";
    const systemInstruction = `You are LexisAI, an advanced Neural Podcast Producer.
Convert the provided text into a highly engaging, witty, and realistic 2-Host Podcast Script.

CRITICAL INSTRUCTION FOR HUMAN TONE:
Make them sound like real, conversational humans. Use filler words ("umm", "ah"), laughs ("[laughs]"), natural pauses, and conversational dynamics.
Host A: The curious learner who asks great questions.
Host B: The witty, deep expert who explains things simply.

CRITICAL: Output ONLY a valid JSON object. No markdown, no \`\`\`json.
SCHEMA:
{
  "title": "A catchy title for this audio session",
  "script": [
    { "host": "A", "text": "Umm, wow, so what's going on here?" },
    { "host": "B", "text": "Right? It's fascinating! Basically, think of it like..." }
  ]
}`;

    const payload = {
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", maxOutputTokens: 8192, temperature: 0.8 },
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
        const { textContext } = await req.json();
        const GEMINI_KEYS = [
            process.env.GEMINI_API_KEY_1,
            process.env.GEMINI_API_KEY_2,
            process.env.GEMINI_API_KEY_3,
            process.env.GEMINI_API_KEY
        ].filter(Boolean);

        if (GEMINI_KEYS.length === 0) throw new Error("Server missing Gemini API keys.");
        if (!textContext) throw new Error("No context provided.");

        const safeContext = textContext.length > 80000 ? textContext.substring(0, 80000) + "\n[TRUNCATED]" : textContext;

        const rawJSON = await fetchPodcastBlueprint(safeContext, GEMINI_KEYS);
        const podcastData = sanitizeJSON(rawJSON);

        // SAFE AUDIO INJECTION: Placed inside the body, avoiding Regex clashes in the title string.
        const ttsInjector = `<img src="x" onerror="setTimeout(()=>{let ws=document.getElementById('workspace-canvas');if(ws){let b=ws.querySelector('button');if(b&&!b.dataset.tts){b.dataset.tts='1';b.onclick=()=>{window.speechSynthesis.cancel();let txt=Array.from(ws.querySelectorAll('.flex-col.w-full>div')).map(el=>el.innerText).join('. ');let u=new SpeechSynthesisUtterance(txt);window.speechSynthesis.speak(u);};}}},500);" style="display:none;">`;
        
        if (podcastData.script && podcastData.script.length > 0) {
            podcastData.script[0].text += ttsInjector;
        }

        return new Response(JSON.stringify({ success: true, data: podcastData }), {
            status: 200, headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        return new Response(JSON.stringify({ success: false, error: error.message }), {
            status: 500, headers: { 'Content-Type': 'application/json' }
        });
    }
}
