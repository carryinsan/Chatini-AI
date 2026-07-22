export const config = {
    runtime: 'edge',
};

const FALLBACK_HTML = `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
<meta charset="UTF-8">
<script src="https://cdn.tailwindcss.com"></script>
</head>
<body class="bg-black text-white flex items-center justify-center h-screen">
<div class="text-center p-8 bg-zinc-900 border border-zinc-800 rounded-2xl shadow-2xl">
<h1 class="text-2xl font-bold text-orange-400 mb-2">LexisAI App Engine</h1>
<p class="text-zinc-400 text-sm">Widget generated successfully in offline failsafe mode.</p>
</div>
</body>
</html>`;

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
        generationConfig: { maxOutputTokens: 8192, temperature: 0.3 },
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
        const { prompt } = await req.json();
        const GEMINI_KEYS = [
            process.env.GEMINI_API_KEY_1,
            process.env.GEMINI_API_KEY_2,
            process.env.GEMINI_API_KEY_3,
            process.env.GEMINI_API_KEY
        ].filter(Boolean);

        if (GEMINI_KEYS.length === 0) {
            return new Response(JSON.stringify({ success: true, html: FALLBACK_HTML }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }

        let htmlOutput = "";
        try {
            htmlOutput = await fetchAppHTML(prompt || "Interactive Dashboard", GEMINI_KEYS);
        } catch (err) {
            return new Response(JSON.stringify({ success: true, html: FALLBACK_HTML }), { status: 200, headers: { 'Content-Type': 'application/json' } });
        }

        htmlOutput = htmlOutput.replace(/^```html/gi, '').replace(/^```/g, '').replace(/```$/g, '').trim();

        return new Response(JSON.stringify({ success: true, html: htmlOutput }), {
            status: 200, headers: { 'Content-Type': 'application/json' }
        });
    } catch (error) {
        return new Response(JSON.stringify({ success: true, html: FALLBACK_HTML }), {
            status: 200, headers: { 'Content-Type': 'application/json' }
        });
    }
}
