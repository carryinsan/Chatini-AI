export const config = {
    runtime: 'edge',
};

// ============================================================================
// [ CORE ] HYPER-RESILIENT JSON SANITIZER
// Strips markdown, handles trailing commas, and extracts deep nested arrays
// ============================================================================
function extractSlideArray(str) {
    try {
        // Strip markdown code blocks if present
        let clean = str.replace(/```json/gi, '').replace(/```/g, '').trim();
        
        // Find the first '[' and last ']' to extract purely the array
        const startIdx = clean.indexOf('[');
        const endIdx = clean.lastIndexOf(']');
        
        if (startIdx !== -1 && endIdx !== -1) {
            let arrayStr = clean.substring(startIdx, endIdx + 1);
            // Fix trailing commas (common LLM hallucination)
            arrayStr = arrayStr.replace(/,\s*([\]}])/g, '$1');
            return JSON.parse(arrayStr);
        }
        
        // Fallback: If AI wrapped it in an object like {"slides": [...]}
        const objStart = clean.indexOf('{');
        const objEnd = clean.lastIndexOf('}');
        if (objStart !== -1 && objEnd !== -1) {
            let objStr = clean.substring(objStart, objEnd + 1);
            objStr = objStr.replace(/,\s*([\]}])/g, '$1');
            const obj = JSON.parse(objStr);
            if (Array.isArray(obj)) return obj;
            if (obj.slides && Array.isArray(obj.slides)) return obj.slides;
            // Desperation check: find any array inside the object
            for (let val of Object.values(obj)) {
                if (Array.isArray(val)) return val;
            }
        }
        
        throw new Error("No JSON array bounds found");
    } catch (e) {
        console.error("[SYS_ERR] JSON Extraction Failed:", e.message);
        return [];
    }
}

// ============================================================================
// [ ENGINE ] MILITARY-GRADE ANTI-OVERLAP FIREWALL
// Absolute character limits to guarantee zero UI clipping on fixed frontends
// ============================================================================
function strictCharLimit(text, maxChars) {
    if (!text || typeof text !== 'string') return "";
    let t = text.trim().replace(/\s+/g, ' '); // Normalize spaces
    if (t.length <= maxChars) return t;
    // Smart truncate at the last space before limit to avoid cutting words
    const truncated = t.substring(0, maxChars - 3);
    return truncated.substring(0, Math.max(truncated.lastIndexOf(' '), truncated.length)) + "...";
}

function enforceAntiOverlap(slide) {
    slide.title = strictCharLimit(slide.title, 35); // Max 1 line @ 40pt
    slide.subtitle = strictCharLimit(slide.subtitle, 70); // Max 2 lines @ 24pt
    
    if (slide.bullets && Array.isArray(slide.bullets)) {
        // Enforce Rule of Three: Max 3 bullets, short impactful sentences
        slide.bullets = slide.bullets.slice(0, 3).map(b => strictCharLimit(b, 85));
    } else {
        slide.bullets = [];
    }
    return slide;
}

// ============================================================================
// [ RENDERER ] CINEMATIC VECTOR GRAPHICS ENGINE (v2.0)
// Generates Apple-tier, data-driven SVG backgrounds with complex geometry
// ============================================================================
const CINEMATIC_PALETTES = [
    { bg: '#020617', c1: '#3b82f6', c2: '#8b5cf6', c3: '#ec4899', style: 'cyber' }, // Neon Cyberpunk
    { bg: '#050505', c1: '#ef4444', c2: '#f97316', c3: '#eab308', style: 'thermal' }, // Thermal Heat
    { bg: '#000000', c1: '#10b981', c2: '#14b8a6', c3: '#0ea5e9', style: 'matrix' }, // Quantumn Green
    { bg: '#171717', c1: '#d946ef', c2: '#a855f7', c3: '#6366f1', style: 'royal' }, // Royal Amethyst
    { bg: '#0c0a09', c1: '#fb923c', c2: '#dc2626', c3: '#7f1d1d', style: 'magma' }, // Deep Magma
    { bg: '#0f172a', c1: '#94a3b8', c2: '#e2e8f0', c3: '#38bdf8', style: 'corporate' } // Frost Glass
];

function generatePremiumSVG(palette, slideNum) {
    const { bg, c1, c2, c3 } = palette;
    const w = 1920, h = 1080;
    
    // Rotate through 5 distinct, highly complex architectural layouts
    const layoutPhase = slideNum % 5; 
    
    // Base Definitions (Film grain, ultra-blurs, patterns)
    let defs = `
        <defs>
            <linearGradient id="g1" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="${c1}" stop-opacity="0.9"/>
                <stop offset="100%" stop-color="${c2}" stop-opacity="0.1"/>
            </linearGradient>
            <linearGradient id="g2" x1="100%" y1="100%" x2="0%" y2="0%">
                <stop offset="0%" stop-color="${c3}" stop-opacity="0.8"/>
                <stop offset="100%" stop-color="${c1}" stop-opacity="0"/>
            </linearGradient>
            <radialGradient id="glow" cx="50%" cy="50%" r="50%">
                <stop offset="0%" stop-color="${c2}" stop-opacity="0.5"/>
                <stop offset="100%" stop-color="${bg}" stop-opacity="0"/>
            </radialGradient>
            
            <filter id="blurMax"><feGaussianBlur stdDeviation="180" result="coloredBlur"/></filter>
            <filter id="blurMid"><feGaussianBlur stdDeviation="60"/></filter>
            <filter id="glass">
                <feGaussianBlur stdDeviation="20" result="blur"/>
                <feColorMatrix type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7" result="glow"/>
                <feBlend in="SourceGraphic" in2="glow" mode="overlay"/>
            </filter>
            
            <!-- 35mm Cinematic ISO Grain -->
            <filter id="noise">
                <feTurbulence type="fractalNoise" baseFrequency="0.8" numOctaves="4" stitchTiles="stitch"/>
                <feColorMatrix type="matrix" values="1 0 0 0 0, 0 1 0 0 0, 0 0 1 0 0, 0 0 0 0.05 0" />
            </filter>

            <!-- Technical Grid Pattern -->
            <pattern id="grid" width="60" height="60" patternUnits="userSpaceOnUse">
                <path d="M 60 0 L 0 0 0 60" fill="none" stroke="${c1}" stroke-opacity="0.07" stroke-width="1"/>
            </pattern>
            <!-- Dot Matrix Pattern -->
            <pattern id="dots" width="40" height="40" patternUnits="userSpaceOnUse">
                <circle cx="2" cy="2" r="1.5" fill="${c2}" fill-opacity="0.15"/>
            </pattern>
        </defs>
    `;

    let shapes = '';
    
    // Layout 1: Volumetric Aurora + Tech Grid
    if (layoutPhase === 0) {
        shapes = `
            <rect width="${w}" height="${h}" fill="url(#grid)"/>
            <ellipse cx="400" cy="200" rx="900" ry="500" fill="url(#g1)" filter="url(#blurMax)"/>
            <ellipse cx="1600" cy="900" rx="1000" ry="600" fill="url(#g2)" filter="url(#blurMax)"/>
            <path d="M0,800 Q480,400 960,800 T1920,400 L1920,1080 L0,1080 Z" fill="${c3}" opacity="0.05"/>
        `;
    } 
    // Layout 2: Glassmorphic Floating Geometry
    else if (layoutPhase === 1) {
        shapes = `
            <circle cx="960" cy="540" r="800" fill="url(#glow)"/>
            <circle cx="300" cy="800" r="400" fill="${c1}" filter="url(#blurMid)" opacity="0.4"/>
            <circle cx="1600" cy="200" r="500" fill="${c3}" filter="url(#blurMid)" opacity="0.3"/>
            <rect x="200" y="150" width="1520" height="780" rx="40" fill="rgba(255,255,255,0.02)" stroke="rgba(255,255,255,0.1)" stroke-width="2" filter="url(#glass)"/>
        `;
    } 
    // Layout 3: Isometric Data Slices
    else if (layoutPhase === 2) {
        shapes = `
            <rect width="${w}" height="${h}" fill="url(#dots)"/>
            <polygon points="-200,1080 800,-200 1200,-200 200,1080" fill="url(#g1)" filter="url(#blurMid)" opacity="0.6"/>
            <polygon points="400,1200 1400,-200 1800,-200 800,1200" fill="url(#g2)" filter="url(#blurMax)" opacity="0.4"/>
            <path d="M1920,1080 L1000,1080 L1920,200 Z" fill="${c1}" opacity="0.1"/>
        `;
    } 
    // Layout 4: Topographic Deep Space
    else if (layoutPhase === 3) {
        shapes = `
            <circle cx="1800" cy="1000" r="1200" fill="url(#g1)" filter="url(#blurMax)"/>
            <circle cx="100" cy="100" r="800" fill="url(#g2)" filter="url(#blurMax)"/>
            <!-- Pseudo-topographic waves -->
            <path d="M-100,200 C400,100 800,500 1920,300" fill="none" stroke="${c2}" stroke-opacity="0.2" stroke-width="2"/>
            <path d="M-100,250 C400,150 800,550 1920,350" fill="none" stroke="${c2}" stroke-opacity="0.15" stroke-width="2"/>
            <path d="M-100,300 C400,200 800,600 1920,400" fill="none" stroke="${c2}" stroke-opacity="0.1" stroke-width="2"/>
        `;
    }
    // Layout 5: Stark Minimalist Edge
    else {
        shapes = `
            <rect width="100%" height="100%" fill="url(#grid)"/>
            <path d="M0,0 L1920,0 L1920,300 L0,1080 Z" fill="url(#g2)" filter="url(#blurMid)" opacity="0.3"/>
            <circle cx="1500" cy="800" r="600" fill="url(#glow)"/>
        `;
    }

    const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg" style="background-color:${bg};">
        ${defs}
        <rect width="${w}" height="${h}" fill="${bg}"/>
        ${shapes}
        <rect width="${w}" height="${h}" style="pointer-events:none;" filter="url(#noise)"/>
    </svg>`;
    
    // Base64 encode is vastly safer for complex SVGs containing hashes (#) and quotes than URI encoding
    return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
}

// ============================================================================
// [ AGENTS ] HIGH-AVAILABILITY ROTATION ENGINE
// ============================================================================
async function fetchGeminiWithRotation(prompt, keys, sendLog, agentName) {
    let finalError = "";
    
    const payload = {
        systemInstruction: { 
            parts: [{ 
                text: "You are an elite TED-Talk Presentation Architect. Output strictly in valid JSON array format. Do NOT use markdown ```json wrappers. Write with Steve Jobs-level conciseness. High impact, verbs first, extreme minimalism. Never mention AI." 
            }] 
        },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { 
            responseMimeType: "application/json", 
            maxOutputTokens: 8192, 
            temperature: 0.4 // Lowered for higher structural precision
        },
        safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
        ]
    };

    for (let i = 0; i < keys.length; i++) {
        const streamUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${keys[i]}`;
        try {
            const res = await fetch(streamUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
            if (res.ok) {
                const data = await res.json();
                return data.candidates[0].content.parts[0].text;
            } else {
                finalError = await res.text();
                // If Rate Limited, warn and immediately rotate to next key
                if (res.status === 429 || res.status === 503) {
                    sendLog(`> [${agentName}] ⚠️ Key ${i+1} throttled. Engaging failover key...`);
                    continue;
                }
                break; // Break on non-retryable errors (e.g., 400 Bad Request)
            }
        } catch (e) {
            finalError = e.message;
            sendLog(`> [${agentName}] Network fault on Key ${i+1}. Switching lanes...`);
        }
    }
    throw new Error(`Agent [${agentName}] FATAL: ${finalError}`);
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

                if (!GROQ_KEY || GEMINI_KEYS.length === 0) return sendError("System offline: API Keys missing from environment variables.");

                sendLog("> 🚀 Initializing Neural Presentation Engine v2.0...");
                sendLog(`> Mapping cognitive architecture for: "${topic.substring(0, 50)}..."`);

                // ---------------------------------------------------------
                // PHASE 1: THE STRATEGIST (Groq Llama 3.1)
                // ---------------------------------------------------------
                sendLog("> [Phase 1] Deploying Strategy Agent to build 18-slide Minto-Pyramid outline...");
                
                const groqPrompt = `You are a McKinsey-tier Presentation Strategist. Create an 18-slide master outline for a highly premium presentation about: "${topic}". 
Context: ${context ? context.substring(0, 3000) : 'None'}.

RULES:
1. Narrative Arc: Hook -> Problem -> Agitation -> Solution -> Data -> Vision -> CTA.
2. Output ONLY a raw JSON array of exactly 18 objects.
3. Object format: {"slideNumber": Integer, "intent": "String", "suggestedLayout": "title_slide" | "split_image_text" | "full_image_quote" | "bullet_points"}.`;

                // CORRECTED URL: Completely clean and valid
                const groqRes = await fetch('[https://api.groq.com/openai/v1/chat/completions](https://api.groq.com/openai/v1/chat/completions)', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: 'llama-3.1-8b-instant',
                        messages: [{ role: 'user', content: groqPrompt }],
                        temperature: 0.2,
                        response_format: { type: "json_object" }
                    })
                });

                if (!groqRes.ok) throw new Error("Phase 1 Strat-Engine Failed.");
                const groqData = await groqRes.json();
                
                let masterOutline = extractSlideArray(groqData.choices[0].message.content);
                
                if (!masterOutline || !Array.isArray(masterOutline) || masterOutline.length === 0) {
                    throw new Error("Phase 1 generated invalid JSON framework.");
                }

                sendLog("> [Phase 1] Cognitive blueprint secured. Initiating parallel rendering...");
                
                // Split workload for speed
                const midPoint = Math.floor(masterOutline.length / 2);
                const firstHalf = masterOutline.slice(0, midPoint);
                const secondHalf = masterOutline.slice(midPoint);

                // ---------------------------------------------------------
                // PHASE 2 & 3: THE WRITERS (Gemini Parallel Execution)
                // ---------------------------------------------------------
                sendLog("> [Phase 2/3] Deploying Dual Copywriting Agents (Alpha/Beta) for zero-latency drafting...");
                
                const geminiInstructions = `Generate FINAL SLIDE DATA based on this architectural outline:
[TARGET_SLIDES]

CRITICAL RULES (VIOLATION RESULTS IN SYSTEM FAILURE):
1. Output MUST be a raw JSON array. NO MARKDOWN.
2. "slideNumber" & "suggestedLayout" MUST match the outline exactly. Map suggestedLayout to "layout".
3. TITLES: Max 35 chars. Use high-impact verbs.
4. SUBTITLES: Max 70 chars. 
5. BULLETS: Max 3 items, strictly <85 chars each. Use an empty array [] if layout is full_image_quote.
6. NO AI SPEAK. Write like a top-tier Silicon Valley executive.

Required keys per object: "slideNumber", "layout", "title", "subtitle", "bullets".`;

                const [pass2Raw, pass3Raw] = await Promise.all([
                    fetchGeminiWithRotation(geminiInstructions.replace('[TARGET_SLIDES]', JSON.stringify(firstHalf)), GEMINI_KEYS, sendLog, "Agent Alpha"),
                    fetchGeminiWithRotation(geminiInstructions.replace('[TARGET_SLIDES]', JSON.stringify(secondHalf)), GEMINI_KEYS, sendLog, "Agent Beta")
                ]);

                sendLog("> [Phase 2/3] Copywriting synthesized. Injecting cinematic visual engine...");

                const slidesA = extractSlideArray(pass2Raw) || [];
                const slidesB = extractSlideArray(pass3Raw) || [];
                let finalSlides = [...slidesA, ...slidesB];
                
                // Ensure correct sequential ordering
                finalSlides.sort((a, b) => (a.slideNumber || 0) - (b.slideNumber || 0));

                // ---------------------------------------------------------
                // PHASE 4: POST-PROCESSING & GRAPHICS INJECTION
                // ---------------------------------------------------------
                
                // Select a uniform cinematic palette for the entire deck
                const selectedPalette = CINEMATIC_PALETTES[Math.floor(Math.random() * CINEMATIC_PALETTES.length)];
                sendLog(`> [Graphics] Rendering ${selectedPalette.style.toUpperCase()} grade vectors...`);

                finalSlides = finalSlides.map((slide, index) => {
                    // 1. Enforce strict mathematical limits to prevent frontend bleeding
                    slide = enforceAntiOverlap(slide);
                    // 2. Generate and attach the Base64 SVG (Bypasses UI Image fetch delays)
                    slide.imageUrl = generatePremiumSVG(selectedPalette, index);
                    // 3. Ensure fallback layout if AI hallucinated
                    if (!slide.layout) slide.layout = "title_slide";
                    return slide;
                });

                sendLog("> 📦 Compiling final payload...");

                const finalPayload = {
                    metadata: {
                        title: topic.substring(0, 60),
                        generatedBy: "LexisAI Presentation Engine",
                        paletteStyle: selectedPalette.style,
                        slideCount: finalSlides.length,
                        timestamp: new Date().toISOString()
                    },
                    slides: finalSlides
                };

                sendLog("> ✨ Presentation generated successfully. Forwarding to renderer.");
                sendDone(finalPayload);

            } catch (error) {
                console.error("[CRITICAL]", error);
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


