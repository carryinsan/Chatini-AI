export const config = {
    runtime: 'edge',
};

// ============================================================================
// [ CORE ] EDGE-SAFE BINARY TO BASE64 CONVERTER
// Vercel Edge functions do not support Node.js Buffer natively. 
// This chunked converter prevents Call Stack Overflows on 8K images.
// ============================================================================
function arrayBufferToBase64(buffer) {
    const uint8Array = new Uint8Array(buffer);
    let binaryString = '';
    const chunkSize = 8192;
    for (let i = 0; i < uint8Array.length; i += chunkSize) {
        binaryString += String.fromCharCode.apply(null, uint8Array.subarray(i, i + chunkSize));
    }
    return btoa(binaryString);
}

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
    let width = 1024;
    let height = 1024;
    let finalModifiers = [];

    // 1. Extract Aspect Ratio (--ar 16:9, --ar 9:16)
    if (prompt.includes('--ar 16:9')) { width = 1024; height = 576; }
    else if (prompt.includes('--ar 9:16')) { width = 576; height = 1024; }
    else if (prompt.includes('--ar 21:9')) { width = 1024; height = 448; } // Cinematic Ultrawide
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

    return { enhancedPrompt, originalPrompt: prompt, width, height };
}

// ============================================================================
// [ RENDERER ] TAILWIND UI GENERATOR
// ============================================================================
function generateHTMLWidget(base64Data, originalPrompt, enhancedPrompt, width, height) {
    const dataUrl = `data:image/jpeg;base64,${base64Data}`;
    const timestamp = Date.now();
    
    // Returns a self-contained, highly styled UI widget that the frontend chat will render natively
    return `
<div class="mt-4 mb-2 flex flex-col bg-gray-900/50 border border-white/10 rounded-2xl overflow-hidden shadow-2xl w-full max-w-3xl backdrop-blur-sm">
    <div class="flex items-center justify-between px-4 py-3 border-b border-white/5 bg-black/40">
        <div class="flex items-center gap-2">
            <span class="flex items-center justify-center w-6 h-6 rounded-full bg-gradient-to-tr from-purple-500 to-cyan-500 text-white text-xs">
                <i class="ph-fill ph-aperture"></i>
            </span>
            <span class="text-sm font-semibold text-gray-200">FLUX.1 Schnell</span>
        </div>
        <div class="flex gap-2">
            <span class="text-xs font-medium text-gray-500 bg-black/50 px-2 py-1 rounded-md">${width}x${height}</span>
            <a href="${dataUrl}" download="LexisAI_Render_${timestamp}.jpg" class="text-xs font-medium text-cyan-400 bg-cyan-400/10 hover:bg-cyan-400/20 px-3 py-1 rounded-md transition-colors flex items-center gap-1 cursor-pointer">
                <i class="ph ph-download-simple"></i> HD Export
            </a>
        </div>
    </div>
    <div class="relative group bg-[url('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAGXRFWHRTb2Z0d2FyZQBBZG9iZSBJbWFnZVJlYWR5ccllPAAAABZJREFUeNpi2rVq1X8GMIgAEGAgAEGAAAwIBAH/m+i6AAAAAElFTkSuQmCC')]">
        <img src="${dataUrl}" alt="AI Generated Image" class="w-full h-auto object-contain max-h-[70vh]" />
    </div>
    <div class="p-4 bg-black/40">
        <p class="text-sm text-gray-300 font-medium leading-relaxed">
            <span class="text-cyan-400/80 mr-1">"</span>${originalPrompt}<span class="text-cyan-400/80 ml-1">"</span>
        </p>
        <details class="mt-2 text-xs text-gray-600 cursor-pointer">
            <summary class="hover:text-gray-400 transition-colors">View Generation Metadata</summary>
            <div class="mt-2 p-2 bg-black/50 rounded border border-white/5 font-mono">
                <span class="text-purple-400">System Prompt:</span> ${enhancedPrompt}<br/>
                <span class="text-purple-400">Steps:</span> 4 (Schnell Optimized)<br/>
                <span class="text-purple-400">Guidance Scale:</span> 0.0
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
                send("> Generating image...\n");

                // 2. Parse Commands
                const { enhancedPrompt, originalPrompt, width, height } = parseImageCommand(prompt);
                send(`> ⚙️ Parsing parameters: ${width}x${height} | Modifiers applied.\n`);
                send(">  Accessing latest model...\n");

                // 3. API Key Validation (YOUR HARDCODED KEY IS HERE)
                const apiKey = (process.env.IMAGE_KEY || "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").replace(/[\r\n\s]/g, '');
                
                if (!apiKey) throw new Error("IMAGE_KEY environment variable is missing.");

                // 4. Fetch Image from Hugging Face
                const hfRes = await fetch("https://router.huggingface.co/hf-inference/models/black-forest-labs/FLUX.1-schnell", {
                    method: "POST",
                    headers: {
                        "Authorization": `Bearer ${apiKey}`,
                        "Content-Type": "application/json"
                    },
                    body: JSON.stringify({
                        inputs: enhancedPrompt,
                        parameters: {
                            width: width,
                            height: height,
                            num_inference_steps: 4,
                            guidance_scale: 0.0
                        }
                    })
                });

                if (!hfRes.ok) {
                    const errorText = await hfRes.text();
                    throw new Error(`Hugging Face API Error: ${hfRes.status} - ${errorText}`);
                }

                send("> 🎨 Receiving pixel tensor data...\n");

                // 5. Convert & Render
                const arrayBuffer = await hfRes.arrayBuffer();
                const base64Image = arrayBufferToBase64(arrayBuffer);
                
                send("> ✅ Render complete. Injecting UI...\n\n");
                
                // Stream the massive HTML UI widget directly into the chat
                const htmlWidget = generateHTMLWidget(base64Image, originalPrompt, enhancedPrompt, width, height);
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
