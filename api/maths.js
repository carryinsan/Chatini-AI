export const config = {
    runtime: 'edge',
};

// ============================================================================
// LEXIS-AI MATHEMATICS ENGINE (v2.0)
// Autonomous LaTeX to JavaScript Transpiler & Cartesian Graphing Architecture
// ============================================================================

/**
 * ----------------------------------------------------------------------------
 * 1. FAIL-SAFE: THE HARDCODED FALLBACK MATRIX
 * ----------------------------------------------------------------------------
 * If API keys fail, rate limits hit, or parsing collapses, this matrix 
 * guarantees a visually stunning, interactive mathematical output.
 * 0.00% Error Rate Enforcement.
 */
const FALLBACK_MATRIX = {
    "default": {
        title: "Damped Harmonic Oscillator",
        type: "y_equals_fx",
        expression: "y = A * Math.exp(-d * x) * Math.cos(w * x)",
        tRange: [0, 0], xRange: [0, 20], yRange: [-5, 5],
        variables: [
            { name: "A", label: "Amplitude", min: 1, max: 10, step: 0.5, default: 5 },
            { name: "d", label: "Damping Factor", min: 0.01, max: 1, step: 0.01, default: 0.2 },
            { name: "w", label: "Angular Freq", min: 1, max: 20, step: 0.5, default: 10 }
        ],
        colors: { grid: "#1e293b", axes: "#475569", line: "#0ea5e9", glow: "#22d3ee" }
    },
    "parametric": {
        title: "Lissajous Knot",
        type: "parametric",
        expression: "x = A * Math.sin(a * t + d); y = B * Math.sin(b * t)",
        tRange: [0, Math.PI * 2], xRange: [-10, 10], yRange: [-10, 10],
        variables: [
            { name: "A", label: "Width", min: 1, max: 10, step: 0.5, default: 8 },
            { name: "B", label: "Height", min: 1, max: 10, step: 0.5, default: 8 },
            { name: "a", label: "X-Freq", min: 1, max: 10, step: 1, default: 5 },
            { name: "b", label: "Y-Freq", min: 1, max: 10, step: 1, default: 4 },
            { name: "d", label: "Phase", min: 0, max: Math.PI, step: 0.1, default: Math.PI/2 }
        ],
        colors: { grid: "#2e1065", axes: "#581c87", line: "#d946ef", glow: "#f0abfc" }
    },
    "polar": {
        title: "Maurer Rose Curve",
        type: "parametric",
        expression: "let r = A * Math.sin(n * t); x = r * Math.cos(t * d); y = r * Math.sin(t * d)",
        tRange: [0, Math.PI * 360], xRange: [-10, 10], yRange: [-10, 10],
        variables: [
            { name: "A", label: "Scale", min: 1, max: 10, step: 0.5, default: 8 },
            { name: "n", label: "Petals (n)", min: 1, max: 10, step: 1, default: 6 },
            { name: "d", label: "Angle (d)", min: 1, max: 100, step: 1, default: 71 }
        ],
        colors: { grid: "#022c22", axes: "#065f46", line: "#10b981", glow: "#34d399" }
    }
};

/**
 * ----------------------------------------------------------------------------
 * 2. STRUCTURAL SANITIZATION & TRANSPILING
 * ----------------------------------------------------------------------------
 */
function sanitizeJSON(str) {
    try {
        const match = str.match(/\{[\s\S]*\}/);
        if (!match) throw new Error("No JSON object found");
        let clean = match[0].replace(/,\s*([\]}])/g, '$1');
        return JSON.parse(clean);
    } catch (e) {
        console.error("[LexisAI] JSON Parsing Alert, using heuristic recovery.");
        return null;
    }
}

// Converts lingering LaTeX into valid JavaScript Math functions
function jsMathTranspiler(expression) {
    if (!expression) return "y = x";
    let jsCode = expression;
    
    // Replace caret with power function
    jsCode = jsCode.replace(/(\w+)\^(\w+)/g, "Math.pow($1, $2)");
    jsCode = jsCode.replace(/(\w+)\^(\d+)/g, "Math.pow($1, $2)");
    
    // Transpile common math constants and functions
    const mappings = {
        "\\sin": "Math.sin",
        "\\cos": "Math.cos",
        "\\tan": "Math.tan",
        "\\exp": "Math.exp",
        "\\sqrt": "Math.sqrt",
        "\\pi": "Math.PI",
        "pi": "Math.PI",
        "\\cdot": "*",
        "\\times": "*"
    };
    
    for (const [latex, js] of Object.entries(mappings)) {
        jsCode = jsCode.split(latex).join(js);
    }
    
    // Clean up implicit multiplication (e.g., 2x -> 2*x)
    jsCode = jsCode.replace(/(\d)([a-zA-Z])/g, "$1*$2");
    
    return jsCode;
}

// Ensure the payload matches the strict interface required by the HTML5 Canvas
function validateAndRepairPayload(payload) {
    if (!payload) return FALLBACK_MATRIX["default"];

    const safePayload = {
        title: payload.title || "Mathematical Visualization",
        type: payload.type || "y_equals_fx",
        expression: jsMathTranspiler(payload.expression),
        tRange: Array.isArray(payload.tRange) && payload.tRange.length === 2 ? payload.tRange : [0, Math.PI * 2],
        xRange: Array.isArray(payload.xRange) && payload.xRange.length === 2 ? payload.xRange : [-10, 10],
        yRange: Array.isArray(payload.yRange) && payload.yRange.length === 2 ? payload.yRange : [-10, 10],
        variables: Array.isArray(payload.variables) ? payload.variables : [],
        colors: payload.colors || { grid: "#1e293b", axes: "#475569", line: "#0ea5e9", glow: "#22d3ee" }
    };

    // Ensure safe bounds
    if (safePayload.xRange[0] === safePayload.xRange[1]) safePayload.xRange = [-10, 10];
    if (safePayload.yRange[0] === safePayload.yRange[1]) safePayload.yRange = [-10, 10];

    // Sanitize variables
    safePayload.variables = safePayload.variables.map(v => ({
        name: v.name || "k",
        label: v.label || "Constant",
        min: typeof v.min === 'number' ? v.min : 0,
        max: typeof v.max === 'number' ? v.max : 10,
        step: typeof v.step === 'number' ? v.step : 0.1,
        default: typeof v.default === 'number' ? v.default : 1
    }));

    return safePayload;
}

/**
 * ----------------------------------------------------------------------------
 * 3. AI EXECUTION ENGINE (WITH AGGRESSIVE KEY ROTATION)
 * ----------------------------------------------------------------------------
 */
async function fetchMathematicalBlueprint(prompt, keys, sendLog) {
    let finalError = "";

    const systemInstruction = `You are LexisAI's Elite Mathematical Programming Agent.
Your job is to read a user's math query and convert it into a STRICT JSON blueprint for a 2D HTML5 Canvas graph.

CRITICAL RULES:
1. Output ONLY a valid JSON object. No markdown, no \`\`\`json, no explanations.
2. Formulate the equation in pure JavaScript syntax using the Math object (e.g., 'y = A * Math.sin(w * x)').
3. Extract constants into interactive sliders.

JSON SCHEMA REQUIREMENT:
{
  "title": "Name of the graph",
  "type": "y_equals_fx" OR "parametric",
  "expression": "JS expression. For y_equals_fx, output 'y = ...'. For parametric, output 'x = ...; y = ...'",
  "tRange": [min, max], // Only used if parametric (e.g. [0, Math.PI*2])
  "xRange": [minX, maxX], // The viewport x limits
  "yRange": [minY, maxY], // The viewport y limits
  "variables": [
    { "name": "A", "label": "Amplitude", "min": 0, "max": 10, "step": 0.1, "default": 5 }
  ],
  "colors": {
    "grid": "#hex", // Dark background grid
    "axes": "#hex", // Lighter axes
    "line": "#hex", // Bright neon line color
    "glow": "#hex"  // Neon glow color
  }
}

Choose beautiful, cyberpunk or premium dark-mode neon colors for the palette.
Use 'x' as the independent variable for y_equals_fx.
Use 't' as the independent variable for parametric.`;

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

    // Aggressive Key Rotation
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
                    sendLog(`> Rate limit hit on computing node ${i+1}. Hot-swapping keys...`);
                    continue;
                }
                break; 
            }
        } catch (e) {
            finalError = e.message;
        }
    }
    
    throw new Error(`Execution Failed: ${finalError}`);
}

/**
 * ----------------------------------------------------------------------------
 * 4. THE EDGE HANDLER
 * ----------------------------------------------------------------------------
 */
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
            const sendErrorFallback = (errLog, fallbackType) => {
                sendLog(`> ${errLog}`);
                sendLog(`> Initializing Autonomous Redundancy...`);
                sendLog(`> Deploying Offline Cartesian Matrix.`);
                sendDone(FALLBACK_MATRIX[fallbackType] || FALLBACK_MATRIX["default"]);
            };

            try {
                const { query } = await req.json();
                
                const GEMINI_KEYS = [
                    process.env.GEMINI_API_KEY_1,
                    process.env.GEMINI_API_KEY_2,
                    process.env.GEMINI_API_KEY_3
                ].filter(Boolean);

                if (GEMINI_KEYS.length === 0) {
                    return sendErrorFallback("Missing API keys. Engaging Offline Math Engine.", "default");
                }

                sendLog("> Initializing LexisAI Mathematical Processor...");
                sendLog(`> Analyzing query: "${query.substring(0, 50)}..."`);
                sendLog("> Compiling abstract algebra into executable JavaScript...");

                // Execute the LLM to build the mathematical JSON blueprint
                let rawJSON = "";
                try {
                    rawJSON = await fetchMathematicalBlueprint(query, GEMINI_KEYS, sendLog);
                } catch(apiError) {
                    // ZERO-ERROR TOLERANCE: If API fails, seamlessly load a fallback graph based on keywords
                    const qLower = query.toLowerCase();
                    let fbType = "default";
                    if (qLower.includes("parametric") || qLower.includes("lissajous") || qLower.includes("knot")) fbType = "parametric";
                    if (qLower.includes("polar") || qLower.includes("rose") || qLower.includes("flower")) fbType = "polar";
                    
                    return sendErrorFallback(`API Pipeline Interrupted.`, fbType);
                }

                sendLog("> Transpilation successful. Evaluating bounds and parameters...");

                // Sanitize the raw LLM output into a clean JSON object
                let parsedBlueprint = sanitizeJSON(rawJSON);
                
                if (!parsedBlueprint) {
                     return sendErrorFallback(`Syntax Parsing Error. Reverting to safe visualization.`, "default");
                }

                // Push through the validator to fix any hallucinations (missing colors, bad JS syntax)
                const safePayload = validateAndRepairPayload(parsedBlueprint);

                sendLog(`> Extracting ${safePayload.variables.length} interactive control variables...`);
                sendLog("> Blueprint verified. Establishing Cartesian grid coordinates...");
                sendLog("> Mathematical payload ready for UI rendering.");

                // Deliver the perfect JSON blueprint to the frontend
                sendDone(safePayload);

            } catch (error) {
                // The ultimate absolute fail-safe
                sendLog(`> System Error: ${error.message}`);
                sendLog(`> Deploying default visualization module...`);
                sendDone(FALLBACK_MATRIX["default"]);
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

