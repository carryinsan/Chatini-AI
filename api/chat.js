export const config = {
    runtime: 'edge', 
};

export default async function handler(req) {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    try {
        const { messages, modelId, researchContext } = await req.json();
        const latestMessage = messages[messages.length - 1];
        const userQuery = latestMessage.content;
        
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
1. <sources>: If you use search data OR analyze uploaded files, append a JSON array of sources at the VERY END. (e.g., <sources>[{"title":"Site", "url":"https://..."}]</sources>)
2. <chart>: If comparing data or asked for a chart, output a JSON array. (e.g., <chart>[{"label":"Cat A", "value":85}]</chart>)
3. <artifact>: CRITICAL UI RULE. If you generate a long document, an essay, a deep report, or code, YOU MUST wrap it entirely in artifact tags. Example: <artifact title="Q3 Report">\n# Report Data...\n</artifact>
   
CRITICAL: YOU HAVE ACCESS TO UP TO 200 MESSAGES OF HISTORY AND KNOWLEDGE EXTENSIONS. REMEMBER EVERY MINOR DETAIL. COMPLETE YOUR ANALYSIS IN FULL. DO NOT STOP EARLY.`;

        let contextData = "";

        // ---------------------------------------------------------
        // RESEARCH CONTEXT & EXPANSION TRIGGER
        // ---------------------------------------------------------
        if (researchContext) {
            // Pass 2 Expansion Triggered
            systemPrompt += `\n\n[CRITICAL DIRECTIVE: You are executing PASS 2 of an autonomous research loop. I have provided a massive MASTER DRAFT generated in Pass 1. You MUST expand this draft by 3x to 4x its length. Make it the absolute ultimate, exhaustive, hyper-detailed final document. You MUST wrap your entire final document inside an <artifact title="...">...</artifact> tag.]`;
            contextData = `\n\n${researchContext}`;
        } else {
            // Standard search for Flux if Deep Research is off
            const fluxNeedsSearch = /latest|news|who|what|when|where|why|how|price|stock|weather|update|search|current|today/i.test(userQuery);
            const shouldSearch = TAVILY_KEY && (modelId === 'oracle' || (modelId === 'flux' && fluxNeedsSearch));

            if (shouldSearch) {
                try {
                    const tavilyRes = await fetch('https://api.tavily.com/search', {
                        method: 'POST', headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ api_key: TAVILY_KEY, query: userQuery, search_depth: "advanced", max_results: modelId === 'oracle' ? 20 : 5, include_answer: true })
                    });
                    if (tavilyRes.ok) {
                        const tavData = await tavilyRes.json();
                        const searchResults = tavData.results.map(r => `Title: ${r.title}\nURL: ${r.url}\nContent: ${r.content}`).join('\n\n');
                        contextData = `\n\n--- REAL-TIME SEARCH CONTEXT ---\n${searchResults}\n\nCite search context using <sources>.`;
                    }
                } catch (e) { console.error("Tavily Search Failed."); }
            }
        }

        const processedMessages = messages.map(m => ({ role: m.role, content: m.content }));
        if (contextData) {
            processedMessages[processedMessages.length - 1].content += contextData;
        }

        // ---------------------------------------------------------
        // DECODING ENGINE
        // ---------------------------------------------------------
        let textDocumentContext = "";
        const geminiInlineParts = [];
        const geminiSupportedMimes = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'];

        allAttachments.forEach(att => {
            const mime = att.type ? att.type.toLowerCase() : 'text/plain';
            const isText = mime.startsWith('text/') || mime.includes('json') || mime.includes('xml') || mime.includes('csv') || att.name.endsWith('.txt') || att.name.endsWith('.md') || att.name.endsWith('.py');
            
            if (isText) {
                try {
                    const decodedStr = decodeURIComponent(escape(atob(att.base64)));
                    textDocumentContext += `\n--- DOC: ${att.name} ---\n${decodedStr.substring(0, modelId === 'spark' ? 5000 : 35000)}\n`;
                } catch (e) {
                    try {
                        const fallbackStr = atob(att.base64);
                        textDocumentContext += `\n--- DOC: ${att.name} ---\n${fallbackStr.substring(0, modelId === 'spark' ? 5000 : 35000)}\n`;
                    } catch (err) { }
                }
            } else if (modelId !== 'spark') {
                if (geminiSupportedMimes.includes(mime)) {
                    geminiInlineParts.push({ inlineData: { mimeType: mime, data: att.base64 } });
                } else {
                    textDocumentContext += `\n[System Note: User attached '${att.name}' (${mime}). Not readable natively. Ask user to copy-paste or convert to PDF.]\n`;
                }
            }
        });

        if (textDocumentContext) {
            systemPrompt += `\n\n[KNOWLEDGE BASE & UPLOADED DOCUMENTS:]\n${textDocumentContext}`;
        }

        // ---------------------------------------------------------
        // SPARK MEMORY COMPRESSION
        // ---------------------------------------------------------
        let finalMessages = [];
        
        if (modelId === 'spark') {
            const sparkCharLimit = 28000;
            let currentChars = systemPrompt.length;
            
            if (allAttachments.length > 0 && geminiInlineParts.length === 0) {
                processedMessages[processedMessages.length - 1].content += `\n\n[SYSTEM: User uploaded Images/PDFs. You (Spark) cannot see them. Ask them to switch to Flux/Oracle.]`;
            }

            for (let i = processedMessages.length - 1; i >= 0; i--) {
                const msg = processedMessages[i];
                if (currentChars + msg.content.length < sparkCharLimit) {
                    finalMessages.unshift(msg);
                    currentChars += msg.content.length;
                } else {
                    let compressedMsg = msg.content.replace(/\s+/g, ' ').substring(0, 500); 
                    if (currentChars + compressedMsg.length < sparkCharLimit) {
                        finalMessages.unshift({ role: msg.role, content: compressedMsg });
                        currentChars += compressedMsg.length;
                    } else {
                        const remnants = processedMessages.slice(0, i + 1).map(m => m.content.replace(/[^a-zA-Z0-9 ]/g, '').substring(0, 50)).join('|');
                        if (finalMessages.length > 0) {
                            finalMessages[0].content = `[DEEP_MEMORY:${remnants.substring(0, sparkCharLimit - currentChars)}]\n` + finalMessages[0].content;
                        }
                        break;
                    }
                }
            }
            if (finalMessages.length === 0) finalMessages = processedMessages.slice(-1);
        } else {
            finalMessages = processedMessages;
        }

        // ---------------------------------------------------------
        // LLM STREAMING
        // ---------------------------------------------------------
        let llmRes = null;
        let finalErrorText = "";

        if (modelId === 'spark') {
            const streamUrl = 'https://api.groq.com/openai/v1/chat/completions';
            const headers = { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' };
            const payload = { model: 'llama-3.1-8b-instant', messages: [{ role: 'system', content: systemPrompt }, ...finalMessages], stream: true, temperature: 0.6 };
            llmRes = await fetch(streamUrl, { method: 'POST', headers, body: JSON.stringify(payload) });
            if (!llmRes.ok) finalErrorText = await llmRes.text();
            
        } else {
            const geminiMessages = finalMessages.map((m, i) => {
                const parts = [{ text: m.content }];
                if (i === finalMessages.length - 1 && geminiInlineParts.length > 0) parts.push(...geminiInlineParts);
                return { role: m.role === 'user' ? 'user' : 'model', parts };
            });

            const payload = {
                systemInstruction: { parts: [{ text: systemPrompt }] },
                contents: geminiMessages,
                generationConfig: { maxOutputTokens: 8192 },
                safetySettings: [
                    { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                    { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
                ]
            };

            for (let i = 0; i < GEMINI_KEYS.length; i++) {
                const currentKey = GEMINI_KEYS[i];
                const streamUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=${currentKey}`;
                llmRes = await fetch(streamUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                if (llmRes.ok) break; 
                else { finalErrorText = await llmRes.text(); if (llmRes.status === 400) break; }
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


