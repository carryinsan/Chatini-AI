export const config = {
    runtime: 'edge',
};

// Enforce Maximum Execution Time on Vercel Edge (5 Minutes)
export const maxDuration = 300;

// Helper to Clean HTML wrappers & Markdown artifacts
function sanitizeHTML(rawHtml) {
    if (!rawHtml) return '';
    let cleaned = rawHtml
        .replace(/^```html\s*/gi, '')
        .replace(/^```xml\s*/gi, '')
        .replace(/^```\s*/gm, '')
        .replace(/```$/g, '')
        .trim();

    // Auto-repair missing closing tags if output cut off
    if (!cleaned.includes('</html>')) {
        if (cleaned.includes('<script') && !cleaned.includes('</script>')) {
            cleaned += '\n</script>';
        }
        if (!cleaned.includes('</body>')) {
            cleaned += '\n</body>';
        }
        cleaned += '\n</html>';
    }

    return cleaned;
}

export default async function handler(req) {
    if (req.method !== 'POST') {
        return new Response('Method not allowed', { status: 405 });
    }

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
        async start(controller) {
            // Helper to immediately push SSE messages
            const emitSSE = (dataObject) => {
                try {
                    controller.enqueue(encoder.encode(`data: ${JSON.stringify(dataObject)}\n\n`));
                } catch (e) {
                    // Controller closed by client
                }
            };

            // 1. CRITICAL FAILSAFE: Send instant response headers within <50ms 
            // This permanently prevents Vercel's 25-second TTFB Gateway Timeout.
            emitSSE({ type: 'init', message: 'LexisEngine connected. Initializing workspace...' });

            // 2. Active Heartbeat Ping every 1.5s to keep the HTTP socket alive
            const heartbeat = setInterval(() => {
                try {
                    controller.enqueue(encoder.encode(`: ping\n\n`));
                } catch (e) {}
            }, 1500);

            try {
                const { prompt } = await req.json();

                const GEMINI_KEYS = [
                    process.env.GEMINI_API_KEY_1,
                    process.env.GEMINI_API_KEY_2,
                    process.env.GEMINI_API_KEY_3,
                    process.env.GEMINI_API_KEY
                ].filter(Boolean).map(k => k.replace(/[\r\n\s]/g, ''));

                if (GEMINI_KEYS.length === 0) throw new Error("Server missing Gemini API keys.");
                if (!prompt) throw new Error("No application prompt provided.");

                emitSSE({ type: 'status', status: 'Architecting high-density standalone widget...', progress: 15 });

                const systemInstruction = `You are LexisAI, a World-Class Principal Frontend Architect.
Build an extraordinarily detailed, complete, interactive web application or widget based on the user's prompt.

MANDATORY RULES:
1. Include Tailwind CSS via CDN (<script src="https://cdn.tailwindcss.com"></script>).
2. Preferred Dark Mode design with smooth glassmorphic UI, rounded modern cards, vibrant neon accents, and responsive layout.
3. Include ALL necessary HTML, CSS (Tailwind + custom <style>), and JavaScript logic in this SINGLE document.
4. Write EXHAUSTIVE, complete, fully working JS code. Never summarize code, omit logic, or write "// logic goes here".
5. Output ONLY the raw <!DOCTYPE html> string. DO NOT wrap output in markdown code blocks (\`\`\`html).`;

                const payload = {
                    systemInstruction: { parts: [{ text: systemInstruction }] },
                    contents: [{ role: 'user', parts: [{ text: `Build a complete, standalone, production-grade web application for: ${prompt}` }] }],
                    generationConfig: { 
                        maxOutputTokens: 16384, // Maximize single-pass token limit
                        temperature: 0.2 
                    },
                    safetySettings: [
                        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
                    ]
                };

                let streamSuccess = false;
                let fullText = "";
                let lastError = "";

                // Key Rotation with Failover Failsafe
                for (let i = 0; i < GEMINI_KEYS.length; i++) {
                    const currentKey = GEMINI_KEYS[i];
                    const streamUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=${currentKey}`;

                    try {
                        const res = await fetch(streamUrl, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify(payload)
                        });

                        if (!res.ok) {
                            lastError = await res.text();
                            if (res.status === 429 || res.status === 503) continue; // Try next key if rate limited or server busy
                            break;
                        }

                        const reader = res.body.getReader();
                        const decoder = new TextDecoder();
                        let buffer = "";

                        emitSSE({ type: 'status', status: 'Compiling code logic stream...', progress: 40 });

                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) break;

                            buffer += decoder.decode(value, { stream: true });
                            const lines = buffer.split("\n");
                            buffer = lines.pop() || "";

                            for (const line of lines) {
                                const trimmed = line.trim();
                                if (!trimmed || !trimmed.startsWith('data:')) continue;

                                const jsonStr = trimmed.replace(/^data:\s*/, '').trim();
                                if (jsonStr === '[DONE]') continue;

                                try {
                                    const parsed = JSON.parse(jsonStr);
                                    const textChunk = parsed.candidates?.[0]?.content?.parts?.[0]?.text;

                                    if (textChunk) {
                                        fullText += textChunk;
                                        // Stream tokens back live to the user interface
                                        emitSSE({ type: 'chunk', text: textChunk });
                                    }
                                } catch (e) {}
                            }
                        }

                        if (fullText.trim().length > 0) {
                            streamSuccess = true;
                            break; // Successfully finished streaming
                        }

                    } catch (e) {
                        lastError = e.message;
                    }
                }

                if (!streamSuccess) {
                    throw new Error(`Gemini Stream Generation Failed: ${lastError}`);
                }

                emitSSE({ type: 'status', status: 'Validating HTML structure & applying repairs...', progress: 95 });

                const finalHTML = sanitizeHTML(fullText);

                // Send Complete Success Event
                emitSSE({
                    type: 'complete',
                    success: true,
                    html: finalHTML
                });

            } catch (err) {
                emitSSE({
                    type: 'error',
                    error: err.message || "An unexpected error occurred during build execution."
                });
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
