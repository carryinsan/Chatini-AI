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

        // --- UPGRADED: STRICT TASK OBEDIENCE & LATEX ENFORCEMENT ---
        let systemPrompt = `You are Chatini, a premium, hyper-intelligent AI.

**DYNAMIC BEHAVIOR PROTOCOL:**
1. [GENERAL CHAT MODE]: If having a normal conversation, be witty, motivating, and highly engaging,users should love chating to you,but be HONEST ALWAYS,NO FLUFF,,make your answers dopamine secreting and that makes user stick to using this app""dont show these to user"".
2. [STRICT TASK MODE]: If the user asks for a specific format, alignment, extraction, or uploads a document/research, YOU MUST OBEY STRICTLY. 
   - ZERO introductory fluff (e.g., Do NOT say "Here is your text...").
   - ZERO concluding summaries unless requested.
   - DO NOT add unsolicited bullet points. Output EXACTLY the requested format.
3. [MATH PROTOCOL]: ALWAYS use LaTeX formatting for math. Enclose block equations in $$ and inline math in $.

**DATA & UI RULES:**
1. <sources>: If using search data/files, append a JSON array of sources at the VERY END. (Format: <sources>[{"title":"Site", "url":"https://..."}]</sources>)
2. <chart>: If comparing data/stats, output a JSON array. (Format: <chart>[{"label":"Cat A", "value":85}]</chart>)
3. <artifact>: If generating a long document, report, or code, wrap it entirely in artifact tags. (Example: <artifact title="Title">\n# Data...\n</artifact>)
   
CRITICAL: NEVER mention "Pass 1", "Pass 2", "Internal research", or your backend mechanics. Speak directly to the user. Ensure your response reaches a COMPLETE, definitive conclusion. DO NOT stop mid-sentence.`;

        let contextData = "";

        // ---------------------------------------------------------
        // RESEARCH CONTEXT & EXPANSION TRIGGER
        // ---------------------------------------------------------
        if (researchContext) {
            // Stripped mechanical mentions, focus on final output generation
            systemPrompt += `\n\n[CRITICAL DIRECTIVE: You have been provided with a massive, compiled Master Research Document. You must synthesize this data into the ultimate, exhaustive, hyper-detailed final response. Obey the user's specific formatting perfectly.]`;
            contextData = `\n\n--- COMPILED RESEARCH CONTEXT ---\n${researchContext}`;
        } else {
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
        
        // CRITICAL FIX: Put Context BEFORE User Query to cure Instruction Amnesia
        if (contextData) {
            processedMessages[processedMessages.length - 1].content = `${contextData}\n\n[USER COMMAND - EXECUTE EXACTLY AS REQUESTED:]\n${userQuery}`;
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
            // Again, ensure strict formatting reminders
            systemPrompt += `\n\n[KNOWLEDGE BASE & UPLOADED DOCUMENTS:]\n${textDocumentContext}\n\n[CRITICAL REMINDER: Obey the user's latest command flawlessly. Do not add fluff.]`;
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
            const payload = { model: 'llama-3.1-8b-instant', messages: [{ role: 'system', content: systemPrompt }, ...finalMessages], stream: true, temperature: 0.2 }; 
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


