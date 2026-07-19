export const config = {
    runtime: 'edge',
};

// ============================================================================
// FAIL-SAFE JSON SANITIZER
// Strips markdown, backticks, and trailing commas to guarantee JSON parsing
// ============================================================================
function sanitizeJSON(str) {
    try {
        const match = str.match(/\[[\s\S]*\]/);
        if (!match) throw new Error("No JSON array found");
        let clean = match[0];
        clean = clean.replace(/,\s*([\]}])/g, '$1');
        return JSON.parse(clean);
    } catch (e) {
        console.error("JSON Parsing Error:", e, "\nRaw String:", str);
        return null;
    }
}

// ============================================================================
// GEMINI EXECUTION ENGINE (WITH INDEPENDENT KEY ROTATION)
// ============================================================================
async function fetchGeminiWithRotation(prompt, keys, sendLog, agentName) {
    let finalError = "";
    
    const payload = {
        systemInstruction: { parts: [{ text: "You are LexisAI's Premium Presentation Designer. Output strictly in JSON format. Do not use markdown code blocks. Just output the raw JSON array. Never break character. Never mention you are an AI." }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", maxOutputTokens: 8192, temperature: 0.7 }, // Temp raised slightly for higher creativity
        safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
        ]
    };

    for (let i = 0; i < keys.length; i++) {
        const currentKey = keys[i];
        const streamUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${currentKey}`;
        
        try {
            const res = await fetch(streamUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            if (res.ok) {
                const data = await res.json();
                return data.candidates[0].content.parts[0].text;
            } else {
                finalError = await res.text();
                if (res.status === 429 || res.status === 503) {
                    sendLog(`> [${agentName}] Rate limit on Key ${i+1}. Rotating to backup...`);
                    continue;
                }
                break; 
            }
        } catch (e) {
            finalError = e.message;
        }
    }
    throw new Error(`Gemini ${agentName} Failed: ${finalError}`);
}

export default async function handler(req) {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    const encoder = new TextEncoder();
    
    const stream = new ReadableStream({
        async start(controller) {
            const sendLog = (msg) => controller.enqueue(encoder.encode(`data: ${JSON.stringify({ log: msg })}\n\n`));
            const sendDone = (data) => {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true, payload: data })}\n\n`));
                controller.close();
            };
            const sendError = (err) => {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: err })}\n\n`));
                controller.close();
            };

            try {
                const { topic, context } = await req.json();
                
                const GROQ_KEY = process.env.GROQ_API_KEY;
                const GEMINI_KEYS = [
                    process.env.GEMINI_API_KEY_1,
                    process.env.GEMINI_API_KEY_2,
                    process.env.GEMINI_API_KEY_3
                ].filter(Boolean);

                if (!GROQ_KEY || GEMINI_KEYS.length === 0) {
                    return sendError("Missing required API keys for Presentation Generation.");
                }

                sendLog("> Initializing LexisAI Premium Slide Engine...");
                sendLog(`> Target Context: "${topic.substring(0, 50)}..."`);

                // ---------------------------------------------------------
                // PASS 1: THE ARCHITECT (Groq Llama 3.1)
                // ---------------------------------------------------------
                sendLog("> [Pass 1] Deploying Architect Agent to map 18-slide master structure...");
                
                // ANTI-PERSONA BLEED PROMPT
                const groqPrompt = `You are a Master Presentation Strategist for LexisAI. Create an 18-slide master outline for a highly premium, market-beating presentation about: "${topic}". 
Context provided: ${context ? context.substring(0, 3000) : 'None'}.

CRITICAL RULES:
1. ABSOLUTELY NEVER mention "Groq", "Gemini", "AI", or "Language Model". 
2. Act as a top-tier human business consultant.
3. Output ONLY a JSON array of 18 objects. Each object must have: "slideNumber" (1 to 18), "intent" (what the slide covers), and "suggestedLayout" (choose one: 'title_slide', 'split_image_text', 'full_image_quote', 'bullet_points').`;

                const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: 'llama-3.1-8b-instant',
                        messages: [{ role: 'user', content: groqPrompt }],
                        temperature: 0.3,
                        response_format: { type: "json_object" }
                    })
                });

                if (!groqRes.ok) throw new Error("Pass 1 Architect Failed to construct outline.");
                const groqData = await groqRes.json();
                const rawOutline = groqData.choices[0].message.content;
                
                let masterOutline = [];
                try {
                    masterOutline = JSON.parse(rawOutline);
                    if (masterOutline.slides) masterOutline = masterOutline.slides;
                } catch(e) {
                    masterOutline = sanitizeJSON(rawOutline);
                }

                if (!masterOutline || !Array.isArray(masterOutline)) {
                    throw new Error("Pass 1 generated an invalid master structure.");
                }

                sendLog("> [Pass 1] Master 18-slide blueprint secured.");
                
                const midPoint = Math.floor(masterOutline.length / 2);
                const firstHalf = masterOutline.slice(0, midPoint);
                const secondHalf = masterOutline.slice(midPoint);

                // ---------------------------------------------------------
                // PASS 2 & 3: THE DESIGNERS (Gemini Parallel Execution)
                // ---------------------------------------------------------
                sendLog("> [Pass 2 & 3] Deploying Dual LexisAI Agents for high-fidelity creation...");
                
                // ANTI-OVERLAP & CREATIVITY PROMPT
                const geminiInstructions = `You are a world-class Corporate Presentation Designer for LexisAI.
Generate the FULL DATA for the following specific slides based on this outline:
[TARGET_SLIDES]

CRITICAL ANTI-OVERLAP AND DESIGN RULES:
1. "slideNumber": Must match the outline.
2. "layout": Must be exactly one of: 'title_slide', 'split_image_text', 'full_image_quote', 'bullet_points'.
3. "title": Catchy, premium title. **MAXIMUM 6 WORDS**.
4. "subtitle": Optional subtitle or quote. **MAXIMUM 12 WORDS**.
5. "bullets": An array of 3 to 4 highly engaging strings. **EACH BULLET MUST BE MAXIMUM 10 WORDS LONG**. (If you make them longer, the text will overlap on the slide. Keep them punchy and short!). Use empty array [] if layout is full_image_quote.
6. "imagePrompt": A highly detailed, Midjourney-style prompt for an AI image generator (e.g., "Cinematic 8k rendering of a futuristic cityscape, photorealistic, neon lighting, no text"). MUST be provided if layout is title_slide, split_image_text, or full_image_quote.
7. ABSOLUTELY NEVER mention "Gemini", "Groq", "AI", or backend mechanics. Be highly creative, professional, and market-beating.

Output ONLY a JSON array of these slide objects. Do NOT wrap in markdown.`;

                const [pass2Raw, pass3Raw] = await Promise.all([
                    fetchGeminiWithRotation(geminiInstructions.replace('[TARGET_SLIDES]', JSON.stringify(firstHalf)), GEMINI_KEYS, sendLog, "Agent Alpha"),
                    fetchGeminiWithRotation(geminiInstructions.replace('[TARGET_SLIDES]', JSON.stringify(secondHalf)), GEMINI_KEYS, sendLog, "Agent Beta")
                ]);

                sendLog("> [Pass 2 & 3] Content synthesis complete. Applying aesthetic layers...");

                const slidesA = sanitizeJSON(pass2Raw) || [];
                const slidesB = sanitizeJSON(pass3Raw) || [];
                let finalSlides = [...slidesA, ...slidesB];

                finalSlides.sort((a, b) => a.slideNumber - b.slideNumber);

                // ---------------------------------------------------------
                // POST-PROCESSING: AI IMAGE GENERATION CACHE FIX
                // ---------------------------------------------------------
                sendLog("> Compiling visual assets and dynamic media...");
                
                finalSlides = finalSlides.map(slide => {
                    if (slide.imagePrompt) {
                        // Added a random seed to the URL to prevent aggressive browser caching from breaking the images
                        const seed = Math.floor(Math.random() * 100000);
                        const encodedPrompt = encodeURIComponent(slide.imagePrompt + ", highly detailed, masterpiece, 8k resolution, photorealistic, cinematic lighting, no text, no watermarks");
                        slide.imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=1920&height=1080&nologo=true&seed=${seed}`;
                    }
                    return slide;
                });

                sendLog("> Applying LexisAI Premium formatting payload...");

                const finalPayload = {
                    metadata: {
                        title: topic.substring(0, 50),
                        generatedBy: "LexisAI Premium",
                        watermark: "© LexisAI Autonomous Presentation Engine",
                        slideCount: finalSlides.length,
                        timestamp: new Date().toISOString()
                    },
                    slides: finalSlides
                };

                sendLog("> Workspace Generation Complete. Ready for PPTX export.");
                sendDone(finalPayload);

            } catch (error) {
                sendError(error.message);
            }
        }
    });

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        }
    });
}


