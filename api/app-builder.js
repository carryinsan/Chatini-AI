export const config = {
    runtime: 'edge',
};

// Key Sanitizer
const sanitizeKey = (key) => key ? key.replace(/[\r\n\s]/g, '') : '';

// Helper to Clean HTML wrappers
function sanitizeHTML(rawHtml) {
    if (!rawHtml) return '';
    return rawHtml
        .replace(/^```html\s*/gi, '')
        .replace(/^```\s*/gm, '')
        .replace(/```$/g, '')
        .trim();
}

/**
 * Execute Gemini Stream Request with Failover and Keep-Alive
 */
async function streamGeminiPass({ systemInstruction, contents, keys, controller, encoder, passName = "Generation" }) {
    let lastError = "";

    const payload = {
        systemInstruction: { parts: [{ text: systemInstruction }] },
        contents: contents,
        generationConfig: { 
            maxOutputTokens: 8192, 
            temperature: 0.2 
        },
        safetySettings: [
            { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
            { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
        ]
    };

    for (let i = 0; i < keys.length; i++) {
        const currentKey = sanitizeKey(keys[i]);
        if (!currentKey) continue;

        const streamUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=${currentKey}`;

        try {
            const res = await fetch(streamUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!res.ok) {
                lastError = await res.text();
                if (res.status === 429 || res.status === 503) continue; // Try next key on rate-limit/overload
                break;
            }

            const reader = res.body.getReader();
            const decoder = new TextDecoder();
            let passBuffer = "";
            let passText = "";
            let finishReason = null;

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                passBuffer += decoder.decode(value, { stream: true });
                const lines = passBuffer.split("\n");
                passBuffer = lines.pop() || ""; // Keep incomplete line in buffer

                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || !trimmed.startsWith('data:')) continue;

                    const jsonStr = trimmed.replace(/^data:\s*/, '').trim();
                    if (jsonStr === '[DONE]') continue;

                    try {
                        const parsed = JSON.parse(jsonStr);
                        const candidate = parsed.candidates?.[0];
                        const textChunk = candidate?.content?.parts?.[0]?.text;

                        if (candidate?.finishReason) {
                            finishReason = candidate.finishReason;
                        }

                        if (textChunk) {
                            passText += textChunk;
                            // Emit token stream chunk to keep Vercel connection active
                            const chunkEvent = JSON.stringify({
                                type: 'chunk',
                                pass: passName,
                                text: textChunk
                            });
                            controller.enqueue(encoder.encode(`data: ${chunkEvent}\n\n`));
                        }
                    } catch (e) {
                        // Suppress JSON partial line parse errors
                    }
                }
            }

            return { text: passText, finishReason };

        } catch (e) {
            lastError = e.message;
        }
    }

    throw new Error(`Gemini Pipeline (${passName}) Failed: ${lastError}`);
}

export default async function handler(req) {
    if (req.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 });
    }

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
        async start(controller) {
            // Sends real-time progress events to prevent browser & Vercel idle timeouts
            const sendStatus = (statusMsg, progressPercentage = 0) => {
                const eventData = JSON.stringify({
                    type: 'status',
                    status: statusMsg,
                    progress: progressPercentage
                });
                controller.enqueue(encoder.encode(`data: ${eventData}\n\n`));
            };

            const sendError = (errMsg) => {
                const eventData = JSON.stringify({ type: 'error', error: errMsg });
                controller.enqueue(encoder.encode(`data: ${eventData}\n\n`));
            };

            // Set up a periodic heartbeat timer (Every 3 seconds) to keep HTTP connection alive
            const heartbeat = setInterval(() => {
                controller.enqueue(encoder.encode(`: keep-alive heartbeat\n\n`));
            }, 3000);

            try {
                const { prompt } = await req.json();

                const GEMINI_KEYS = [
                    process.env.GEMINI_API_KEY_1,
                    process.env.GEMINI_API_KEY_2,
                    process.env.GEMINI_API_KEY_3,
                    process.env.GEMINI_API_KEY
                ].filter(Boolean);

                if (GEMINI_KEYS.length === 0) throw new Error("Server missing Gemini API keys.");
                if (!prompt) throw new Error("No application prompt provided.");

                // ----------------------------------------------------------------
                // PASS 1: SYSTEM ARCHITECTURE & INITIAL GENERATION
                // ----------------------------------------------------------------
                sendStatus("Analyzing architecture & compiling high-performance widget...", 10);

                const pass1SystemPrompt = `You are LexisAI, a master Principal Frontend Architect.
Your task is to build a modern, fully functional, production-ready web application or widget based on the user's prompt.

TECHNICAL CONSTRAINTS:
1. Include Tailwind CSS via CDN (<script src="[https://cdn.tailwindcss.com](https://cdn.tailwindcss.com)"></script>).
2. Preferred Dark Mode aesthetic with sleek modern UI, rounded containers, vibrant accents, and high responsiveness.
3. Include all necessary HTML, CSS (Tailwind + custom <style>), and JavaScript in this SINGLE document.
4. Output ONLY valid <!DOCTYPE html> string. DO NOT wrap output in markdown code blocks like \`\`\`html.
5. Provide full, uncompressed, fully functional JS code. Do NOT use placeholders, TODOs, or truncated logic.`;

                const pass1Contents = [
                    { role: 'user', parts: [{ text: `Build a highly detailed, interactive, complete web app for: ${prompt}` }] }
                ];

                sendStatus("Generating core application architecture...", 25);

                const pass1Result = await streamGeminiPass({
                    systemInstruction: pass1SystemPrompt,
                    contents: pass1Contents,
                    keys: GEMINI_KEYS,
                    controller,
                    encoder,
                    passName: "Pass 1"
                });

                let fullCode = pass1Result.text;

                // ----------------------------------------------------------------
                // DYNAMIC PASS 2: CONTINUATION IF TRUNCATED OR MASSIVE APP DETECTED
                // ----------------------------------------------------------------
                const isTruncated = pass1Result.finishReason === 'MAX_TOKENS' || 
                                    (!fullCode.trim().endsWith('</html>') && !fullCode.trim().endsWith('</body>'));

                if (isTruncated) {
                    sendStatus("App complexity demands second pass. Extending logic matrix...", 65);

                    const pass2SystemPrompt = `You are LexisAI continuation engine. 
The code previously generated was cut off due to extreme complexity and high feature density.
Resume output EXACTLY where the code stopped.
OUTPUT ONLY THE REMAINING RAW CODE.
DO NOT repeat previously written code.
DO NOT wrap output in markdown code blocks.
Ensure the output correctly finishes all open tags, scripts, and closes with </html>.`;

                    const pass2Contents = [
                        { role: 'user', parts: [{ text: `Original App Request: ${prompt}` }] },
                        { role: 'model', parts: [{ text: fullCode }] },
                        { role: 'user', parts: [{ text: `Continue generating the code from the exact character where you stopped. Complete all remaining JavaScript logic, styles, and HTML tags.` }] }
                    ];

                    const pass2Result = await streamGeminiPass({
                        systemInstruction: pass2SystemPrompt,
                        contents: pass2Contents,
                        keys: GEMINI_KEYS,
                        controller,
                        encoder,
                        passName: "Pass 2"
                    });

                    fullCode += pass2Result.text;
                }

                // ----------------------------------------------------------------
                // FAIL-SAFE POST-PROCESSING & CLEANUP
                // ----------------------------------------------------------------
                sendStatus("Executing fail-safe code validation & cleaning...", 90);

                let cleanHTML = sanitizeHTML(fullCode);

                // Auto-close missing tags if severe truncation occurred
                if (!cleanHTML.includes('</html>')) {
                    if (!cleanHTML.includes('</body>')) {
                        cleanHTML += '\n</body>';
                    }
                    cleanHTML += '\n</html>';
                }

                // Emit final complete payload event
                const finalEvent = JSON.stringify({
                    type: 'complete',
                    success: true,
                    html: cleanHTML
                });
                controller.enqueue(encoder.encode(`data: ${finalEvent}\n\n`));

            } catch (err) {
                sendError(err.message || "An unexpected error occurred during application construction.");
            } finally {
                clearInterval(heartbeat);
                controller.close();
            }
        }
    });

    return new Response(stream, {
        status: 200,
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache, no-transform',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        }
    });
                }
