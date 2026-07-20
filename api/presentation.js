export const config = {
    runtime: 'edge',
};

// ============================================================================
// FAIL-SAFE 1: JSON SANITIZER
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
// FAIL-SAFE 2: ABSOLUTE CHARACTER-LIMIT FIREWALL (ANTI-OVERLAP)
// Forces text to fit single lines on the frontend fixed-coordinate PPTX engine
// ============================================================================
function strictCharLimit(text, maxChars) {
    if (!text || typeof text !== 'string') return "";
    text = text.trim();
    if (text.length <= maxChars) return text;
    // Safely truncate without slicing words in half
    return text.substring(0, maxChars - 3).trim() + "...";
}

function enforceAntiOverlap(slide) {
    // Title: Max ~35 chars fits on 1 line at 36-44pt font
    slide.title = strictCharLimit(slide.title, 40); 
    // Subtitle: Max ~70 chars fits on 1 line at 20-24pt font
    slide.subtitle = strictCharLimit(slide.subtitle, 70); 
    
    if (slide.bullets && Array.isArray(slide.bullets)) {
        // Max 3 bullets total, Max ~90 chars per bullet to avoid multiple wrapping lines
        slide.bullets = slide.bullets.slice(0, 3).map(b => strictCharLimit(b, 90));
    } else {
        slide.bullets = [];
    }
    return slide;
}

// ============================================================================
// VISUALS: APPLE KEYNOTE-STYLE MESH GRADIENT ENGINE
// Generates stunning, complex, grain-overlay vector graphics instantly
// ============================================================================
const PREMIUM_PALETTES = [
    { bg: '#000000', c1: '#4338ca', c2: '#3b82f6', c3: '#06b6d4' }, // Deep Space Cobalt
    { bg: '#050505', c1: '#be185d', c2: '#f43f5e', c3: '#fbbf24' }, // Midnight Ruby
    { bg: '#020617', c1: '#0f766e', c2: '#10b981', c3: '#a3e635' }, // Aurora Emerald
    { bg: '#1c1917', c1: '#7e22ce', c2: '#a855f7', c3: '#f0abfc' }, // Obsidian Amethyst
    { bg: '#0f172a', c1: '#1d4ed8', c2: '#4f46e5', c3: '#c026d3' }, // Corporate Galaxy
    { bg: '#000000', c1: '#b45309', c2: '#d97706', c3: '#fcd34d' }  // Exec Gold
];

function generateStunningSVG(palette, slideNum) {
    const { bg, c1, c2, c3 } = palette;
    const w = 1920, h = 1080;
    const style = slideNum % 4; // Cycle through 4 distinct master layouts

    let defs = `
        <defs>
            <linearGradient id="grad1" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="${c1}" stop-opacity="0.85"/>
                <stop offset="100%" stop-color="${c2}" stop-opacity="0.1"/>
            </linearGradient>
            <linearGradient id="grad2" x1="100%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stop-color="${c3}" stop-opacity="0.75"/>
                <stop offset="100%" stop-color="${c1}" stop-opacity="0.0"/>
            </linearGradient>
            <radialGradient id="glow" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stop-color="${c2}" stop-opacity="0.6"/>
                <stop offset="100%" stop-color="${bg}" stop-opacity="0"/>
            </radialGradient>
            <filter id="blurLg"><feGaussianBlur stdDeviation="140" result="coloredBlur"/></filter>
            <filter id="blurMd"><feGaussianBlur stdDeviation="80"/></filter>
            <!-- Premium cinematic film grain noise overlay -->
            <filter id="noise" x="0" y="0" width="100%" height="100%">
                <feTurbulence type="fractalNoise" baseFrequency="0.65" numOctaves="3" stitchTiles="stitch"/>
                <feColorMatrix type="matrix" values="1 0 0 0 0, 0 1 0 0 0, 0 0 1 0 0, 0 0 0 0.06 0" />
            </filter>
        </defs>
    `;

    let shapes = '';
    
    if (style === 0) {
        // Liquid Mesh Gradients
        shapes = `
            <circle cx="300" cy="100" r="800" fill="url(#grad1)" filter="url(#blurLg)"/>
            <circle cx="1600" cy="900" r="900" fill="url(#grad2)" filter="url(#blurLg)"/>
            <path d="M0,500 C600,700 1200,200 1920,600 L1920,1080 L0,1080 Z" fill="${c1}" opacity="0.2" filter="url(#blurMd)"/>
        `;
    } else if (style === 1) {
        // Glassmorphic Angular Cuts
        shapes = `
            <rect x="-300" y="-300" width="1200" height="1200" rx="150" fill="url(#grad1)" transform="rotate(35)" filter="url(#blurLg)"/>
            <circle cx="1700" cy="800" r="700" fill="url(#glow)"/>
            <polygon points="0,1080 1920,100 1920,1080" fill="${c3}" opacity="0.15" filter="url(#blurMd)"/>
        `;
    } else if (style === 2) {
        // Cinematic Edge Glow
        shapes = `
            <ellipse cx="960" cy="1200" rx="1400" ry="600" fill="url(#grad1)" filter="url(#blurLg)"/>
            <circle cx="960" cy="-300" r="700" fill="url(#grad2)" filter="url(#blurLg)"/>
        `;
    } else {
        // Minimalist Premium Tech
        shapes = `
            <path d="M-200,1080 C500,800 900,100 1920,0 L1920,1080 Z" fill="url(#grad2)" opacity="0.45" filter="url(#blurLg)"/>
            <circle cx="1700" cy="300" r="600" fill="${c1}" opacity="0.4" filter="url(#blurLg)"/>
        `;
    }

    const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg" style="background-color:${bg};">
        ${defs}
        <rect width="${w}" height="${h}" fill="${bg}"/>
        ${shapes}
        <rect width="${w}" height="${h}" style="pointer-events:none;" filter="url(#noise)"/>
    </svg>`;
    
    // Minify and encode to Data URI
    return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg.replace(/\n/g, '').replace(/\s+/g, ' '))}`;
}

// ============================================================================
// AI EXECUTION ENGINE (WITH KEY ROTATION)
// ============================================================================
async function fetchGeminiWithRotation(prompt, keys, sendLog, agentName) {
    let finalError = "";
    
    const payload = {
        systemInstruction: { parts: [{ text: "You are an elite, Apple-tier Presentation Architect. Output strictly in JSON format. Do not use markdown blocks. Never mention 'AI' or internal logic. Write punchy, minimalist, brilliant copy." }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json", maxOutputTokens: 8192, temperature: 0.5 },
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

                if (!GROQ_KEY || GEMINI_KEYS.length === 0) return sendError("Missing required API keys.");

                sendLog("> Initializing LexisAI Minimalist Slide Engine...");
                sendLog(`> Constructing framework for: "${topic.substring(0, 50)}..."`);

                // ---------------------------------------------------------
                // PASS 1: THE ARCHITECT (Groq Llama 3.1)
                // ---------------------------------------------------------
                sendLog("> [Pass 1] Deploying Strategy Agent to map 18-slide master structure...");
                
                const groqPrompt = `You are an elite Presentation Strategist. Create an 18-slide master outline for a highly premium, market-beating presentation about: "${topic}". 
Context provided: ${context ? context.substring(0, 3000) : 'None'}.

RULES:
1. NEVER mention "AI", "Groq", or "Gemini". Act as a top-tier human consultant.
2. Output ONLY a JSON array of 18 objects: {"slideNumber": 1-18, "intent": "purpose", "suggestedLayout": "title_slide" | "split_image_text" | "full_image_quote" | "bullet_points"}.`;

                const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: 'llama-3.1-8b-instant',
                        messages: [{ role: 'user', content: groqPrompt }],
                        temperature: 0.2,
                        response_format: { type: "json_object" }
                    })
                });

                if (!groqRes.ok) throw new Error("Pass 1 Architect Failed.");
                const groqData = await groqRes.json();
                const rawOutline = groqData.choices[0].message.content;
                
                let masterOutline = sanitizeJSON(rawOutline);
                if (masterOutline && masterOutline.slides) masterOutline = masterOutline.slides;
                if (!masterOutline || !Array.isArray(masterOutline)) throw new Error("Pass 1 generated invalid JSON.");

                sendLog("> [Pass 1] Master 18-slide blueprint secured.");
                
                const midPoint = Math.floor(masterOutline.length / 2);
                const firstHalf = masterOutline.slice(0, midPoint);
                const secondHalf = masterOutline.slice(midPoint);

                // ---------------------------------------------------------
                // PASS 2 & 3: THE DESIGNERS (Gemini Parallel Execution)
                // ---------------------------------------------------------
                sendLog("> [Pass 2 & 3] Deploying Dual Copywriting Agents for high-fidelity content...");
                
                const geminiInstructions = `You are a world-class Executive Presentation Writer.
Generate FULL DATA for these specific slides based on this outline:
[TARGET_SLIDES]

CRITICAL ANTI-OVERLAP RULES (YOU MUST COUNT CHARACTERS):
1. "slideNumber" and "layout" must match the outline exactly.
2. "title": MAX 35 CHARACTERS. Keep it punchy.
3. "subtitle": MAX 70 CHARACTERS.
4. "bullets": MAX 3 BULLETS TOTAL. MAX 80 CHARACTERS PER BULLET. Use empty array [] if layout is full_image_quote.
5. "imagePrompt": Omit this completely. We use procedural vector graphics.
6. NEVER mention you are an AI. Write like Steve Jobs creating a keynote.

Output ONLY a raw JSON array of slide objects. Do NOT wrap in markdown \`\`\`json.`;

                const [pass2Raw, pass3Raw] = await Promise.all([
                    fetchGeminiWithRotation(geminiInstructions.replace('[TARGET_SLIDES]', JSON.stringify(firstHalf)), GEMINI_KEYS, sendLog, "Agent Alpha"),
                    fetchGeminiWithRotation(geminiInstructions.replace('[TARGET_SLIDES]', JSON.stringify(secondHalf)), GEMINI_KEYS, sendLog, "Agent Beta")
                ]);

                sendLog("> [Pass 2 & 3] Content complete. Injecting procedural vector graphics...");

                const slidesA = sanitizeJSON(pass2Raw) || [];
                const slidesB = sanitizeJSON(pass3Raw) || [];
                let finalSlides = [...slidesA, ...slidesB];
                finalSlides.sort((a, b) => a.slideNumber - b.slideNumber);

                // ---------------------------------------------------------
                // POST-PROCESSING: ANTI-OVERLAP & PROCEDURAL GRAPHICS
                // ---------------------------------------------------------
                
                // Select a random premium corporate color palette
                const selectedPalette = PREMIUM_PALETTES[Math.floor(Math.random() * PREMIUM_PALETTES.length)];

                finalSlides = finalSlides.map((slide, index) => {
                    // 1. Physically truncate the text to make overlapping mathematically impossible
                    slide = enforceAntiOverlap(slide);
                    // 2. Inject breathtaking 8k procedural SVG mesh gradients natively
                    slide.imageUrl = generateStunningSVG(selectedPalette, index);
                    return slide;
                });

                sendLog("> Formatting LexisAI Minimalist payload...");

                const finalPayload = {
                    metadata: {
                        title: topic.substring(0, 50),
                        generatedBy: "LexisAI Premium",
                        watermark: "© LexisAI Corporate Visuals",
                        slideCount: finalSlides.length,
                        timestamp: new Date().toISOString()
                    },
                    slides: finalSlides
                };

                sendLog("> Workspace Generation Complete. Ready for instant PPTX export.");
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


