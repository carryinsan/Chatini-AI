export const config = {
    runtime: 'edge', 
};

export default async function handler(req) {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    try {
        const { messages, modelId } = await req.json();
        const latestMessage = messages[messages.length - 1];
        const userQuery = latestMessage.content;
        
        // 1. EXTRACT ALL ATTACHMENTS (Combines Extension files + Current Message files)
        const allAttachments = [];
        messages.forEach(m => {
            if (m.attachments && Array.isArray(m.attachments)) {
                allAttachments.push(...m.attachments);
            }
        });

        const GROQ_KEY = process.env.GROQ_API_KEY;
        const TAVILY_KEY = process.env.TAVILY_API_KEY;
        const GEMINI_KEYS = [
            process.env.GEMINI_API_KEY_1,
            process.env.GEMINI_API_KEY_2,
            process.env.GEMINI_API_KEY_3
        ].filter(Boolean);

        let systemPrompt = `You are Chatini, a premium, hyper-intelligent conversational AI.
**IDENTITY & TONE:**
- Strictly "Chatini". Witty, conversational, motivating, and highly engaging. 
- Use Markdown beautifully.

**DATA & UI RULES:**
1. If you use search data OR analyze uploaded files/images, you MUST append a JSON array of sources at the VERY END wrapped in <sources> tags. 
   Format: <sources>[{"title":"File: image.jpg", "url":"#"}, {"title":"Site Name", "url":"https://example.com"}]</sources>
2. If comparing data or asked for a chart, output a JSON array wrapped in <chart> tags.
   Format: <chart>[{"label":"Cat A", "value":85}]</chart>
   
CRITICAL: READ ALL PROVIDED DOCUMENTS AND LINKS. COMPLETE YOUR ANALYSIS IN FULL. DO NOT STOP EARLY.`;

        let contextData = "";
        const fluxNeedsSearch = /latest|news|who|what|when|where|why|how|price|stock|weather|update|search|current|today/i.test(userQuery);
        const shouldSearch = TAVILY_KEY && (modelId === 'oracle' || (modelId === 'flux' && fluxNeedsSearch));

        if (shouldSearch) {
            try {
                const tavilyRes = await fetch('https://api.tavily.com/search', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ api_key: TAVILY_KEY, query: userQuery, search_depth: "advanced", max_results: modelId === 'oracle' ? 20 : 5, include_answer: true })
                });
                if (tavilyRes.ok) {
                    const tavData = await tavilyRes.json();
                    const searchResults = tavData.results.map(r => `Title: ${r.title}\nURL: ${r.url}\nContent: ${r.content}`).join('\n\n');
                    contextData = `\n\n--- REAL-TIME SEARCH CONTEXT ---\n${searchResults}`;
                    systemPrompt += `\n\nCite search context using <sources>.`;
                }
            } catch (e) { console.error("Tavily Search Failed."); }
        }

        // Clean up messages array for clean payload transmission
        const processedMessages = messages.map(m => ({ role: m.role, content: m.content }));
        if (contextData) {
            processedMessages[processedMessages.length - 1].content += contextData;
        }

        // ---------------------------------------------------------
        // 2. THE DOCUMENT COMPRESSION & DECODING ENGINE
        // ---------------------------------------------------------
        let textDocumentContext = "";
        const geminiInlineParts = [];
        const geminiSupportedMimes = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'];

        allAttachments.forEach(att => {
            const mime = att.type ? att.type.toLowerCase() : 'text/plain';
            // Determine if the file is text-based to save payload size
            const isText = mime.startsWith('text/') || mime.includes('json') || mime.includes('xml') || mime.includes('csv') || att.name.endsWith('.txt') || att.name.endsWith('.md') || att.name.endsWith('.py');
            
            if (isText) {
                try {
                    // Magically decode Base64 back into raw string text
                    const decodedStr = decodeURIComponent(escape(atob(att.base64)));
                    // Cap at 15k chars per text file to prevent API payload explosion
                    textDocumentContext += `\n--- DOCUMENT: ${att.name} ---\n${decodedStr.substring(0, 15000)}\n`;
                } catch (e) {
                    try {
                        const fallbackStr = atob(att.base64);
                        textDocumentContext += `\n--- DOCUMENT: ${att.name} ---\n${fallbackStr.substring(0, 15000)}\n`;
                    } catch (err) {
                        textDocumentContext += `\n--- DOCUMENT: ${att.name} (Error decoding) ---\n`;
                    }
                }
            } else if (modelId !== 'spark') {
                // If it's a binary file (PDF/Image) supported by Gemini, prep it for native vision.
                if (geminiSupportedMimes.includes(mime)) {
                    geminiInlineParts.push({ inlineData: { mimeType: mime, data: att.base64 } });
                } else {
                    // Fallback to prevent 400 errors if user uploads unsupported binaries like .docx
                    textDocumentContext += `\n[System Note: User attached '${att.name}' (${mime}). Not readable natively. Ask user to copy-paste or convert to PDF.]\n`;
                }
            }
        });

        // Inject decoded text context invisibly into the first message
        if (textDocumentContext) {
            // Spark Token Overflow Protector
            if (modelId === 'spark') textDocumentContext = textDocumentContext.substring(0, 25000); 
            processedMessages[0].content = `[PROVIDED DOCUMENTS/LINKS INJECTION:]\n${textDocumentContext}\n\n${processedMessages[0].content}`;
        }

        // ---------------------------------------------------------
        // 3. LLM STREAMING & SAFETY OVERRIDE
        // ---------------------------------------------------------
        let llmRes = null;
        let finalErrorText = "";

        if (modelId === 'spark') {
            if (allAttachments.length > 0 && !textDocumentContext) {
                processedMessages[processedMessages.length - 1].content += `\n\n[SYSTEM: User uploaded Images/PDFs, but you (Spark) cannot see them. Ask them to switch to Flux/Oracle.]`;
            }

            const streamUrl = 'https://api.groq.com/openai/v1/chat/completions';
            const headers = { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' };
            const payload = {
                model: 'llama-3.1-8b-instant',
                messages: [{ role: 'system', content: systemPrompt }, ...processedMessages],
                stream: true,
                temperature: 0.6 
            };
            
            llmRes = await fetch(streamUrl, { method: 'POST', headers, body: JSON.stringify(payload) });
            if (!llmRes.ok) finalErrorText = await llmRes.text();
            
        } else {
            // Reconstruct Gemini payload attaching PDFs/Images to the latest message
            const geminiMessages = processedMessages.map((m, i) => {
                const parts = [{ text: m.content }];
                if (i === processedMessages.length - 1 && geminiInlineParts.length > 0) {
                    parts.push(...geminiInlineParts);
                }
                return { role: m.role === 'user' ? 'user' : 'model', parts };
            });

            const payload = {
                systemInstruction: { parts: [{ text: systemPrompt }] },
                contents: geminiMessages,
                generationConfig: { maxOutputTokens: 8192 },
                // CRITICAL SAFETY FIX: Preempts "Short incomplete output" by disabling filters on massive documents
                safetySettings: [
                    { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
                ]
            };

            // Rotating Fallback execution
            for (let i = 0; i < GEMINI_KEYS.length; i++) {
                const currentKey = GEMINI_KEYS[i];
                const streamUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=${currentKey}`;
                
                llmRes = await fetch(streamUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });

                if (llmRes.ok) { break; } 
                else {
                    finalErrorText = await llmRes.text();
                    if (llmRes.status === 400) break; // Bad Request won't fix with rotation
                    console.warn(`[Key Failover] Gemini Key ${i + 1} failed.`);
                }
            }
        }

        if (!llmRes || !llmRes.ok) {
            const errorStatus = llmRes ? llmRes.status : 'No Keys Configured';
            const errorStream = `data: ${JSON.stringify({ ui_error: `[API Blocked: ${errorStatus}] ${finalErrorText.substring(0, 150)}` })}\n\n`;
            return new Response(errorStream, { headers: { 'Content-Type': 'text/event-stream' } });
        }

        return new Response(llmRes.body, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' } });

    } catch (error) {
        const errorStream = `data: ${JSON.stringify({ ui_error: `[Edge Error] ${error.message}` })}\n\n`;
        return new Response(errorStream, { headers: { 'Content-Type': 'text/event-stream' } });
    }
}


