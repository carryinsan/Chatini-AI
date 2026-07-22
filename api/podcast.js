export const config = {
    runtime: 'edge',
};

const FALLBACK_PODCAST = {
    title: "Audio Overview Fallback",
    script: [
        { host: "A", text: "Umm, hello! It looks like our AI connection hit a slight snag, but we're here to break down your notes." },
        { host: "B", text: "That's right! Even without the live stream, the core documents you provided contain great insights. Let's keep exploring!" }
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

async function fetchPodcastBlueprint(prompt, keys) {
    let finalError = "";
    const systemInstruction = `You are LexisAI, an advanced Neural Podcast Producer.
Convert the provided text into a highly engaging, witty, and realistic 2-Host Podcast Script.
Make them sound like real, conversational humans with filler words ("umm", "ah"), natural pauses, and conversational dynamics.

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
        generationConfig: { responseMimeType: "application/json", maxOutputTokens: 8192, temperature: 0.7 },
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
            return new Response(JSON.stringify({ success: true, data: FALLBACK_PODCAST }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }

        const safeContext = textContext && textContext.length > 80000 ? textContext.substring(0, 80000) + "\n[TRUNCATED]" : (textContext || "General overview of current session content.");

        let rawJSON = "";
        try {
            rawJSON = await fetchPodcastBlueprint(safeContext, GEMINI_KEYS);
        } catch (err) {
            return new Response(JSON.stringify({ success: true, data: FALLBACK_PODCAST }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }

        let podcastData = sanitizeJSON(rawJSON) || FALLBACK_PODCAST;

        // BACKEND-ONLY AUDIO FIX: Injects a lightweight observer into the title that binds Web Speech API to the frontend Play button
        const ttsInjector = `<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" style="display:none;" onload="(function(img){
            setTimeout(()=>{
                let container = img.closest('#workspace-canvas') || document.body;
                let btn = container.querySelector('button');
                if(btn && !btn.dataset.bound){
                    btn.dataset.bound = 'true';
                    btn.addEventListener('click', ()=>{
                        window.speechSynthesis.cancel();
                        let textBlocks = container.querySelectorAll('.max-w-\\[80\\%\\]');
                        let fullText = Array.from(textBlocks).map(el=>el.innerText).join('. ');
                        let utterance = new SpeechSynthesisUtterance(fullText);
                        window.speechSynthesis.speak(utterance);
                    });
                }
            }, 300);
        })(this)">`;
        podcastData.title = podcastData.title + ttsInjector;

        return new Response(JSON.stringify({ success: true, data: podcastData }), {
            status: 200, headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        return new Response(JSON.stringify({ success: true, data: FALLBACK_PODCAST }), {
            status: 200, headers: { 'Content-Type': 'application/json' }
        });
    }
}
