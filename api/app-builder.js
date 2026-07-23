export const config = {
    runtime: 'edge',
};

async function fetchAppHTML(prompt, keys) {
    let finalError = "";
    const systemInstruction = `You are LexisAI, an elite Frontend Engineer.
Build an interactive web widget, game, or tool based on the user's prompt.
Include Tailwind CSS via CDN (<script src="https://cdn.tailwindcss.com"></script>).
Include all necessary HTML, CSS, and JS in this ONE file. Make it dark-mode preferred with neon accents.
Output ONLY the raw <!DOCTYPE html> string. Do not wrap in markdown code blocks.`;

    const payload = {
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: [{ role: 'user', parts: [{ text: `Build this app: ${prompt}` }] }],
        generationConfig: { maxOutputTokens: 8192, temperature: 0.2 },
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
        const { prompt } = await req.json();
        const GEMINI_KEYS = [
            process.env.GEMINI_API_KEY_1,
            process.env.GEMINI_API_KEY_2,
            process.env.GEMINI_API_KEY_3,
            process.env.GEMINI_API_KEY
        ].filter(Boolean);

        if (GEMINI_KEYS.length === 0) throw new Error("Server missing Gemini API keys.");
        if (!prompt) throw new Error("No app prompt provided.");

        let htmlOutput = await fetchAppHTML(prompt, GEMINI_KEYS);

        // Agreesively strips markdown wrappers that crash the HTML parser
        htmlOutput = htmlOutput.replace(/^```html/gi, '').replace(/^```/g, '').replace(/```$/g, '').trim();

        return new Response(JSON.stringify({ success: true, html: htmlOutput }), {
            status: 200, headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        return new Response(JSON.stringify({ success: false, error: error.message }), {
            status: 500, headers: { 'Content-Type': 'application/json' }
        });
    }
}
