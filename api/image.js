export const config = {
    runtime: 'edge',
};

// ============================================================================
// [ ENGINE ] SMART PROMPT PARSER & MODIFIER INJECTION
// Automatically enhances user prompts with professional photography terms
// ============================================================================
const STYLE_DICTIONARY = {
    'cinematic': 'cinematic lighting, 8k resolution, photorealistic, highly detailed, dramatic shadows, 35mm lens, depth of field, masterpiece',
    'anime': 'Studio Ghibli style, Makoto Shinkai, vibrant colors, anime art style, 2d illustration, masterpiece, highly detailed anime background',
    'cyberpunk': 'cyberpunk city, synthwave, neon lighting, dark atmospheric, futuristic, ray tracing, reflections, Unreal Engine 5 render',
    '3d': 'Pixar style, Disney style, 3D render, octane render, smooth lighting, highly detailed 3D model, soft shadows',
    'sketch': 'pencil sketch, architectural draft, charcoal drawing, highly detailed line art, monochrome, artistic masterpiece'
};

function parseImageCommand(rawPrompt) {
    let prompt = rawPrompt.replace(/^\/imagine\s*/i, '').trim();
    let aspectRatio = "1:1";
    let finalModifiers = [];

    // 1. Extract Aspect Ratio 
    if (prompt.includes('--ar 16:9')) { aspectRatio = "16:9"; }
    else if (prompt.includes('--ar 9:16')) { aspectRatio = "9:16"; }
    else if (prompt.includes('--ar 4:3')) { aspectRatio = "4:3"; }
    else if (prompt.includes('--ar 3:4')) { aspectRatio = "3:4"; }
    else if (prompt.includes('--ar 21:9')) { aspectRatio = "21:9"; }
    prompt = prompt.replace(/--ar\s+\d+:\d+/g, '').trim();

    // 2. Extract Style (--style cinematic)
    const styleMatch = prompt.match(/--style\s+([a-zA-Z0-9]+)/i);
    if (styleMatch && STYLE_DICTIONARY[styleMatch[1].toLowerCase()]) {
        finalModifiers.push(STYLE_DICTIONARY[styleMatch[1].toLowerCase()]);
        prompt = prompt.replace(styleMatch[0], '').trim();
    } else if (!prompt.includes('--raw')) {
        // Default enhancement if no style and no --raw flag provided
        finalModifiers.push('highly detailed, masterpiece, high quality, sharp focus');
    }

    prompt = prompt.replace(/--raw/gi, '').trim();

    const enhancedPrompt = finalModifiers.length > 0 
        ? `${prompt}, ${finalModifiers.join(', ')}` 
        : prompt;

    return { enhancedPrompt, originalPrompt: prompt, aspectRatio };
}

// ============================================================================
// [ RENDERER ] TAILWIND UI GENERATOR
// ============================================================================
function generateHTMLWidget(base64Data, originalPrompt, enhancedPrompt, aspectRatio) {
    const dataUrl = `data:image/jpeg;base64,${base64Data}`;
    const timestamp = Date.now();
    
    // Returns a self-contained, highly styled UI widget that the frontend chat will render natively
    return `
<div class="mt-4 mb-2 flex flex-col bg-gray-900/50 border border-white/10 rounded-2xl overflow-hidden shadow-2xl w-full max-w-3xl backdrop-blur-sm">
    <div class="flex items-center justify-between px-4 py-3 border-b border-white/5 bg-black/40">
        <div class="flex items-center gap-2">
            <span class="flex items-center justify-center w-6 h-6 rounded-full bg-gradient-to-tr from-blue-500 to-indigo-500 text-white text-xs">
                <i class="ph-fill ph-aperture"></i>
            </span>
            <span class="text-sm font-semibold text-gray-200">Gemini 2.5 Flash Image</span>
        </div>
        <div class="flex gap-2">
            <span class="text-xs font-medium text-gray-500 bg-black/50 px-2 py-1 rounded-md">AR: ${aspectRatio}</span>
            <a href="${dataUrl}" download="LexisAI_Gemini_Render_${timestamp}.jpg" class="text-xs font-medium text-blue-400 bg-blue-400/10 hover:bg-blue-400/20 px-3 py-1 rounded-md transition-colors flex items-center gap-1 cursor-pointer">
                <i class="ph ph-download-simple"></i> HD Export
            </a>
        </div>
    </div>
    <div class="relative group bg-[url('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAGXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAABZJREFUeNpi2rVq1X8GMIgAEGAgAEGAAAwIBAH/m+i6AAAAAElFTkSuQmCC')]">
        <img src="${dataUrl}" alt="AI Generated Image" class="w-full h-auto object-contain max-h-[70vh]" />
    </div>
    <div class="p-4 bg-black/40">
        <p class="text-sm text-gray-300 font-medium leading-relaxed">
            <span class="text-blue-400/80 mr-1">"</span>${originalPrompt}<span class="text-blue-400/80 ml-1">"</span>
        </p>
        <details class="mt-2 text-xs text-gray-600 cursor-pointer">
            <summary class="hover:text-gray-400 transition-colors">View Generation Metadata</summary>
            <div class="mt-2 p-2 bg-black/50 rounded border border-white/5 font-mono">
                <span class="text-indigo-400">System Prompt:</span> ${enhancedPrompt}<br/>
                <span class="text-indigo-400">Model Engine:</span> gemini-2.5-flash-image<br/>
                <span class="text-indigo-400">Aspect Ratio:</span> ${aspectRatio}
            </div>
        </details>
    </div>
</div>`;
}

// ============================================================================
// [ HANDLER ] MAIN EDGE ROUTE
// ============================================================================
export default async function handler(req) {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    const encoder = new TextEncoder();
    const stream = new ReadableStream({
        async start(controller) {
            const send = (msg) => controller.enqueue(encoder.encode(`data: ${JSON.stringify({ text: msg })}\n\n`));
            
            try {
                const { prompt } = await req.json();
                
                // 1. Initial State
                send("> 🟢 Initiating Image Generation...\n");

                // 2. Parse Commands
                const { enhancedPrompt, originalPrompt, aspectRatio } = parseImageCommand(prompt);
                send(`> ⚙️ Parsing parameters: AR ${aspectRatio} | Modifiers applied.\n`);
                send("> 🚀 Accessing latest LexisAI model...\n");

                // 3. Dynamic Key Loading & Validation
                const geminiKeys = [
                    process.env.GEMINI_API_KEY_1,
                    process.env.GEMINI_API_KEY_2,
                    process.env.GEMINI_API_KEY_3
                ].filter(Boolean);

                if (geminiKeys.length === 0) {
                    throw new Error("No Gemini API keys found. Please set GEMINI_API_KEY_1, 2, or 3 in Vercel.");
                }

                // Randomly select one key from the list to spread API load and stay under rate limits
                const apiKey = geminiKeys[Math.floor(Math.random() * geminiKeys.length)].replace(/[\r\n\s]/g, '');

                // 4. Fetch Image from Gemini 2.5 Flash Image via generateContent
                const geminiRes = await fetch("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent", {
                    method: "POST",
                    headers: {
                        "x-goog-api-key": apiKey,
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        contents: [{
                            role: "user",
                            parts: [{ text: `Generate an image. Aspect Ratio requested: ${aspectRatio}. Prompt: ${enhancedPrompt}` }]
                        }]
                    })
                });

                if (!geminiRes.ok) {
                    const errorText = await geminiRes.text();
                    throw new Error(`Gemini API Error: ${geminiRes.status} - ${errorText}`);
                }

                send("> 🎨 Receiving base64 pixel tensor data...\n");

                // 5. Extract & Render
                const data = await geminiRes.json();
                let base64Image = "";
                
                // New Gemini 2.5 Flash Image Schema (inlineData block inside candidates)
                if (data.candidates && data.candidates.length > 0) {
                    const parts = data.candidates[0].content?.parts || [];
                    const imagePart = parts.find(p => p.inlineData);
                    if (imagePart) {
                        base64Image = imagePart.inlineData.data;
                    }
                }

                // Fallback extractor just in case Google switches the schema to the predict format
                if (!base64Image && data.predictions && data.predictions.length > 0) {
                    const p = data.predictions[0];
                    base64Image = p.bytesBase64Encoded || (p.image && (p.image.imageBytes || p.image.data)) || p.bytes;
                }

                if (!base64Image) {
                    throw new Error("Could not extract inline image data from the Gemini response payload.");
                }
                
                send("> ✅ Render complete. Injecting UI...\n\n");
                
                // Stream the massive HTML UI widget directly into the chat
                const htmlWidget = generateHTMLWidget(base64Image, originalPrompt, enhancedPrompt, aspectRatio);
                send(htmlWidget);

            } catch (error) {
                // Fail-safe Error UI
                send(`\n\n<div class="bg-red-500/10 border border-red-500/50 text-red-400 p-3 rounded-xl text-sm">
                        <i class="ph-fill ph-warning-circle mr-2"></i> <strong>Visual Engine Error:</strong> ${error.message}
                      </div>`);
            } finally {
                controller.close();
            }
        }
    });

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive'
        }
    });
}


