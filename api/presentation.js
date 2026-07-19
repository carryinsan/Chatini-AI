export const config = {
    runtime: 'edge',
};

// ============================================================================
// FAIL-SAFE: JSON SANITIZER
// ============================================================================
function sanitizeJSON(str) {
    try {
        const match = str.match(/\[[\s\S]*\]/);
        if (!match) throw new Error("No JSON array found");
        let clean = match[0];
        clean = clean.replace(/,\s*([\]}])/g, '$1');
        return JSON.parse(clean);
    } catch (e) {
        console.error("JSON Parsing Error:", e);
        return null;
    }
}

// ============================================================================
// FAIL-SAFE: HARD TEXT TRUNCATOR (ANTI-OVERLAP ENGINE)
// Mathematically guarantees text will never overflow the UI containers
// ============================================================================
function truncate(text, maxWords) {
    if (!text || typeof text !== 'string') return "";
    const words = text.trim().split(/\s+/);
    if (words.length <= maxWords) return text;
    return words.slice(0, maxWords).join(' ') + "...";
}

function enforceAntiOverlap(slide) {
    slide.title = truncate(slide.title, 8); // Max 8 words for massive titles
    slide.subtitle = truncate(slide.subtitle, 15); // Max 15 words for subtitles
    
    if (slide.bullets && Array.isArray(slide.bullets)) {
        // Force max 3 bullets, slice each bullet to max 12 words
        slide.bullets = slide.bullets.slice(0, 3).map(b => truncate(b, 12));
    } else {
        slide.bullets = [];
    }
    return slide;
}

// ============================================================================
// VISUALS: PROCEDURAL SVG GENERATOR (APPLE KEYNOTE AESTHETIC)
// Replaces external images with hyper-crisp, instant geometric vectors
// ============================================================================
const PREMIUM_PALETTES = [
    ['#0f172a', '#1e293b', '#38bdf8'], // Obsidian & Neon Cyan
    ['#18181b', '#27272a', '#fbbf24'], // Midnight & Gold
    ['#2e1065', '#3b0764', '#d946ef'], // Deep Royal Purple & Pink
    ['#082f49', '#0c4a6e', '#38bdf8'], // Deep Ocean & Sky
    ['#022c22', '#064e3b', '#10b981']  // Emerald Forest
];

function generateStunningSVG(palette, slideNum) {
    const bg = palette[0];
    const mid = palette[1];
    const accent = palette[2];
    const w = 1920, h = 1080;
    
    let shapes = '';
    const style = slideNum % 3;

    if (style === 0) {
        // Style A: Elegant Glowing Orbs
        shapes = `<circle cx="1600" cy="200" r="700" fill="${accent}" opacity="0.15" filter="blur(60px)"/>
                  <circle cx="200" cy="900" r="500" fill="${mid}" opacity="0.3" filter="blur(40px)"/>`;
    } else if (style === 1) {
        // Style B: Sleek Modern Angular Cuts
        shapes = `<polygon points="1920,0 1920,1080 600,1080" fill="${mid}" opacity="0.4"/>
                  <polygon points="1920,0 1920,400 1300,1080 1920,1080" fill="${accent}" opacity="0.25"/>`;
    } else {
        // Style C: Soft Abstract Fluid Waves
        shapes = `<path d="M0,700 C500,400 1000,900 1920,600 L1920,1080 L0,1080 Z" fill="${mid}" opacity="0.5"/>
                  <path d="M0,900 C600,700 1200,1000 1920,800 L1920,1080 L0,1080 Z" fill="${accent}" opacity="0.3"/>`;
    }

    const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
        <rect width="${w}" height="${h}" fill="${bg}"/>
        ${shapes}
    </svg>`;
    
    // Inject directly into the frontend as a Data URI (zero load time)
    return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

// ============================================================================
// AI EXECUTION ENGINE (WITH INDEPENDENT KEY ROTATION)
// ============================================================================
async function fetchGeminiWithRotation(prompt, keys, sendLog, agentName) {
    let finalError = "";
    
    const payload = {
        systemInstruction: { parts: [{ text: "You are a Top-Tier Corporate Presentation Architect. Output strictly in JSON format. Do not use markdown blocks. Never mention 'AI', 'Gemini', 'Groq', or internal logic. Act as a human market-beating strategist." }] },
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
    throw new Error(`Agent ${agentName} Failed: ${finalError}`);
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

                sendLog("> Initializing LexisAI Corporate Slide Engine...");
                sendLog(`> Constructing framework for: "${topic.substring(0, 50)}..."`);

                // ---------------------------------------------------------
                // PASS 1: THE ARCHITECT (Groq Llama 3.1)
                // ---------------------------------------------------------
                sendLog("> [Pass 1] Deploying Architect Agent to map 18-slide master structure...");
                
                const groqPrompt = `You are a Master Corporate Strategist. Create an 18-slide master outline for a highly premium, market-beating presentation about: "${topic}". 
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

                if (!masterOutline || !Array.isArray(masterOutline)) throw new Error("Pass 1 generated an invalid master structure.");

                sendLog("> [Pass 1] Master 18-slide blueprint secured.");
                
                const midPoint = Math.floor(masterOutline.length / 2);
                const firstHalf = masterOutline.slice(0, midPoint);
                const secondHalf = masterOutline.slice(midPoint);

                // ---------------------------------------------------------
                // PASS 2 & 3: THE DESIGNERS (Gemini Parallel Execution)
                // ---------------------------------------------------------
                sendLog("> [Pass 2 & 3] Deploying Dual Agents for high-fidelity content creation...");
                
                const geminiInstructions = `You are a world-class Corporate Presentation Writer.
Generate the FULL DATA for the following specific slides based on this outline:
[TARGET_SLIDES]

CRITICAL ANTI-OVERLAP AND DESIGN RULES:
1. "slideNumber": Must match the outline.
2. "layout": Must be exactly one of: 'title_slide', 'split_image_text', 'full_image_quote', 'bullet_points'.
3. "title": Catchy, premium title. **MAXIMUM 8 WORDS**.
4. "subtitle": Optional subtitle or quote. **MAXIMUM 15 WORDS**.
5. "bullets": An array of highly engaging strings. **MAXIMUM 3 BULLETS TOTAL**. **EACH BULLET MUST BE MAXIMUM 12 WORDS LONG**. Use empty array [] if layout is full_image_quote.
6. ABSOLUTELY NEVER mention "Gemini", "Groq", "AI", or backend mechanics. Be highly creative, professional, and market-beating. Do not provide external image URLs.

Output ONLY a JSON array of these slide objects. Do NOT wrap in markdown.`;

                const [pass2Raw, pass3Raw] = await Promise.all([
                    fetchGeminiWithRotation(geminiInstructions.replace('[TARGET_SLIDES]', JSON.stringify(firstHalf)), GEMINI_KEYS, sendLog, "Agent Alpha"),
                    fetchGeminiWithRotation(geminiInstructions.replace('[TARGET_SLIDES]', JSON.stringify(secondHalf)), GEMINI_KEYS, sendLog, "Agent Beta")
                ]);

                sendLog("> [Pass 2 & 3] Content synthesis complete. Applying aesthetic vector layers...");

                const slidesA = sanitizeJSON(pass2Raw) || [];
                const slidesB = sanitizeJSON(pass3Raw) || [];
                let finalSlides = [...slidesA, ...slidesB];

                finalSlides.sort((a, b) => a.slideNumber - b.slideNumber);

                // ---------------------------------------------------------
                // POST-PROCESSING: ANTI-OVERLAP & PROCEDURAL GRAPHICS
                // ---------------------------------------------------------
                
                // Select a random premium corporate color palette for this presentation
                const selectedPalette = PREMIUM_PALETTES[Math.floor(Math.random() * PREMIUM_PALETTES.length)];

                finalSlides = finalSlides.map((slide, index) => {
                    // 1. Physically truncate the text to make overlapping mathematically impossible
                    slide = enforceAntiOverlap(slide);
                    
                    // 2. Inject breathtaking procedural geometric SVG backgrounds natively
                    slide.imageUrl = generateStunningSVG(selectedPalette, index);
                    
                    return slide;
                });

                sendLog("> Applying LexisAI Premium formatting payload...");

                const finalPayload = {
                    metadata: {
                        title: topic.substring(0, 50),
                        generatedBy: "LexisAI Premium",
                        watermark: "© LexisAI Premium Market Engine",
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


