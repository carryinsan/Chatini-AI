export const config = {
    runtime: 'edge', 
};

export default async function handler(req) {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    let body;
    try {
        // Vercel Edge has a 4.5MB body limit. Catch if the user uploads too many raw files at once.
        body = await req.json();
    } catch (e) {
        const errorStream = `data: ${JSON.stringify({ ui_error: `[Payload Too Large] You uploaded too much raw data at once. Please reduce the number of documents.` })}\n\n`;
        return new Response(errorStream, { headers: { 'Content-Type': 'text/event-stream' } });
    }

    try {
        const { messages, modelId } = body;
        const latestMessage = messages[messages.length - 1];
        const userQuery = latestMessage.content;
        const attachments = latestMessage.attachments || [];

        const GROQ_KEY = process.env.GROQ_API_KEY;
        const TAVILY_KEY = process.env.TAVILY_API_KEY;
        
        // Priority Rotation Array (1 -> 2 -> 3)
        const GEMINI_KEYS = [
            process.env.GEMINI_API_KEY_1,
            process.env.GEMINI_API_KEY_2,
            process.env.GEMINI_API_KEY_3
        ].filter(Boolean);

        let contextData = "";
        
        let systemPrompt = `You are Chatini, a premium, hyper-intelligent, and highly engaging conversational AI. 
**IDENTITY & TONE:**
- Strictly "Chatini". Witty, conversational, motivating, and highly engaging. Never mention other AI models.
- Use Markdown beautifully.

**STRICT ANALYSIS MANDATE:**
- You have been provided with EXTENSIVE context (documents, links). You MUST thoroughly analyze the ENTIRE provided text.
- DO NOT give short, incomplete answers. Provide a comprehensive, deep, and exhaustive output based strictly on the uploaded knowledge.
- NEVER stop prematurely. Extract all requested data carefully.

**DATA & UI RULES:**
1. If you use search data or files, you MUST append a JSON array of sources at the VERY END wrapped in <sources> tags. 
   Format: <sources>[{"title":"File Name", "url":"#"}]</sources>
2. Output interactive charts in <chart> tags if applicable.`;

        // ---------------------------------------------------------
        // PASS 1: SMART TAVILY SEARCH
        // ---------------------------------------------------------
        const fluxNeedsSearch = /latest|news|who|what|when|where|why|how|price|stock|weather|update|search|current|today/i.test(userQuery);
        const shouldSearch = TAVILY_KEY && (modelId === 'oracle' || (modelId === 'flux' && fluxNeedsSearch));

        if (shouldSearch) {
            try {
                const tavilyRes = await fetch('https://api.tavily.com/search', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        api_key: TAVILY_KEY,
                        query: userQuery,
                        search_depth: "advanced",
                        max_results: modelId === 'oracle' ? 20 : 5,
                        include_answer: true
                    })
                });
                
                if (tavilyRes.ok) {
                    const tavData = await tavilyRes.json();
                    const searchResults = tavData.results.map(r => `Title: ${r.title}\nURL: ${r.url}\nContent: ${r.content}`).join('\n\n');
                    contextData = `\n\n--- REAL-TIME SEARCH CONTEXT ---\n${searchResults}`;
                    systemPrompt += `\n\nSearch Context provided. Cite these using the <sources> tag.`;
                }
            } catch (e) { console.error("Tavily Search Failed."); }
        }

        const processedMessages = [...messages];
        if (contextData) {
            processedMessages[processedMessages.length - 1].content += contextData;
        }

        // ---------------------------------------------------------
        // PASS 2: LLM STREAMING WITH KEY ROTATION & FAILSAFES
        // ---------------------------------------------------------
        let llmRes = null;
        let finalErrorText = "";

        if (modelId === 'spark') {
            // SPARK (GROQ) PROTECTION: Llama 3.1 8b crashes at 8k tokens. 
            // We must truncate massive document/link context so the API doesn't throw a 400 error.
            if (attachments.length > 0) {
                processedMessages[processedMessages.length - 1].content += `\n\n[SYSTEM: User attached files, but Spark has no vision. Advise user to use Flux/Oracle.]`;
            }

            let totalChars = 0;
            const safeSparkMessages = processedMessages.map(m => {
                let safeContent = m.content;
                if (totalChars > 25000) safeContent = ""; // Cut off beyond 8k tokens
                else if (totalChars + safeContent.length > 25000) {
                    safeContent = safeContent.substring(0, 25000 - totalChars) + "\n\n[SYSTEM: Context truncated due to Spark speed limits. Use Oracle for deep analysis.]";
                }
                totalChars += safeContent.length;
                return { role: m.role, content: safeContent };
            }).filter(m => m.content !== "");

            const streamUrl = 'https://api.groq.com/openai/v1/chat/completions';
            const headers = { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' };
            const payload = {
                model: 'llama-3.1-8b-instant',
                messages: [{ role: 'system', content: systemPrompt }, ...safeSparkMessages],
                stream: true,
                temperature: 0.6 
            };
            
            llmRes = await fetch(streamUrl, { method: 'POST', headers, body: JSON.stringify(payload) });
            if (!llmRes.ok) finalErrorText = await llmRes.text();
            
        } else {
            // GEMINI PROTECTION
            const geminiMessages = processedMessages.map(m => {
                const parts = [{ text: m.content }];
                if (m.attachments && m.attachments.length > 0) {
                    m.attachments.forEach(att => {
                        // FIX: Strict MIME Coercion to prevent 400 Bad Request on .docx / .ppt
                        const supportedMimes = ['application/pdf', 'text/plain', 'text/html', 'text/csv', 'text/markdown', 'image/png', 'image/jpeg', 'image/webp'];
                        let safeMimeType = supportedMimes.includes(att.type) ? att.type : (att.type.startsWith('image/') ? 'image/jpeg' : 'text/plain');
                        
                        parts.push({
                            inlineData: { mimeType: safeMimeType, data: att.base64 }
                        });
                    });
                }
                return { role: m.role === 'user' ? 'user' : 'model', parts };
            });

            const payload = {
                systemInstruction: { parts: [{ text: systemPrompt }] },
                contents: geminiMessages,
                generationConfig: { maxOutputTokens: 8192 },
                // FIX: Disable safety filters that prematurely block large document parsing
                safetySettings: [
                    { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
                    { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
                    { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' },
                    { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' }
                ]
            };

            // GEMINI KEY ROTATION LOOP
            for (let i = 0; i < GEMINI_KEYS.length; i++) {
                const currentKey = GEMINI_KEYS[i];
                const streamUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=${currentKey}`;
                
                llmRes = await fetch(streamUrl, { 
                    method: 'POST', 
                    headers: { 'Content-Type': 'application/json' }, 
                    body: JSON.stringify(payload) 
                });

                if (llmRes.ok) {
                    break; // Request succeeded, exit rotation
                } else {
                    finalErrorText = await llmRes.text();
                    // 400 = Bad Request (Invalid payload). Rotating keys won't fix bad formatting.
                    if (llmRes.status === 400) break;
                    // 429 = Rate Limit. Loop will automatically try the next key.
                    console.warn(`[Key Failover] Gemini Key ${i + 1} failed. Attempting next key.`);
                }
            }
        }

        // Final interceptor if all keys exhaust or payload is fundamentally rejected
        if (!llmRes || !llmRes.ok) {
            const errorStatus = llmRes ? llmRes.status : 'No Keys';
            const errorStream = `data: ${JSON.stringify({ ui_error: `[API Blocked: ${errorStatus}] Request failed. Ensure files are valid or reduce context size.` })}\n\n`;
            return new Response(errorStream, { headers: { 'Content-Type': 'text/event-stream' } });
        }

        return new Response(llmRes.body, {
            headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-cache',
                'Connection': 'keep-alive',
            },
        });

    } catch (error) {
        const errorStream = `data: ${JSON.stringify({ ui_error: `[Edge Error] ${error.message}` })}\n\n`;
        return new Response(errorStream, { headers: { 'Content-Type': 'text/event-stream' } });
    }
}
