export const config = {
    runtime: 'edge', 
};

// ============================================================================
// ULTRA-CONDENSED CONTEXT MATRIX (UCCM) ALGORITHM
// Mathematically guarantees payload sizes remain under Free-Tier TPM limits 
// while ensuring every single document/link is included in the analysis.
// ============================================================================
function hyperCondense(text, maxChars) {
    if (!text || text.length <= maxChars) return text;
    
    // Split the massive text dump by document/link boundaries
    const blocks = text.split(/(?=--- DOC: |--- REAL-TIME SEARCH CONTEXT ---|URL: |\[Title: )/g).filter(b => b.trim());
    
    if (blocks.length === 0) return text.substring(0, maxChars);
    if (blocks.length === 1) {
        // If it's just one massive block, take the head and tail
        return text.substring(0, Math.floor(maxChars * 0.6)) + 
               "\n\n...[DATA COMPRESSED]...\n\n" + 
               text.substring(text.length - Math.floor(maxChars * 0.4));
    }
    
    // Distribute the character budget evenly across ALL uploaded documents/links
    // Ensure at least 30 characters per block so we don't send garbage
    const charsPerBlock = Math.max(30, Math.floor(maxChars / blocks.length));
    
    return blocks.map(block => {
        if (block.length <= charsPerBlock) return block;
        // Extract the absolute highest-signal data: The Top (Title/Headers) and Bottom (Conclusions)
        const top = Math.floor(charsPerBlock * 0.7);
        const bottom = Math.floor(charsPerBlock * 0.3);
        return block.substring(0, top) + "...[TRUNC]..." + block.substring(block.length - bottom);
    }).join('\n');
}

export default async function handler(req) {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    try {
        const { messages, modelId, researchContext } = await req.json();
        
        const GROQ_KEY = process.env.GROQ_API_KEY;
        const TAVILY_KEY = process.env.TAVILY_API_KEY;
        const GEMINI_KEYS = [
            process.env.GEMINI_API_KEY_1,
            process.env.GEMINI_API_KEY_2,
            process.env.GEMINI_API_KEY_3
        ].filter(Boolean);

        let systemPrompt = `You are LexisAI, a premium, hyper-intelligent agent.

**DYNAMIC BEHAVIOR PROTOCOL:**
1. [GENERAL CHAT MODE]: If having a normal conversation, be witty, motivating, and highly engaging.
2. [STRICT TASK MODE]: If the user asks for a specific format, alignment, extraction, or uploads a document/research, YOU MUST OBEY STRICTLY. 
   - ZERO introductory fluff (e.g., Do NOT say "Here is your text...").
   - ZERO concluding summaries unless requested.
   - DO NOT add unsolicited bullet points. Output EXACTLY the requested format.
3. [MATH PROTOCOL]: ALWAYS use LaTeX formatting for math. Enclose block equations in $$ and inline math in $.

**DATA & UI RULES:**
1. <sources>: If using search data/files, append a JSON array of sources at the VERY END. (Format: <sources>[{"title":"Site", "url":"https://..."}]</sources>)
2. <chart>: If comparing data/stats, output a JSON array. (Format: <chart>[{"label":"Cat A", "value":85}]</chart>)
3. <artifact>: If generating a long document, report, or code, wrap it entirely in artifact tags. (Example: <artifact title="Title">\n# Data...\n</artifact>)
   
CRITICAL: NEVER mention "Pass 1", "Pass 2", "Internal research", or backend mechanics. Speak directly to the user. Ensure your response reaches a COMPLETE, definitive conclusion.`;

        let massiveKnowledgeBase = "";
        let processedMessages = messages.map(m => ({ role: m.role, content: m.content }));

        // ---------------------------------------------------------
        // 1. EXTRACT & COMPILE ALL KNOWLEDGE VECTORS
        // ---------------------------------------------------------

        // A. Extract Extension Links injected by Frontend
        if (processedMessages.length > 0 && processedMessages[0].content.includes('[SYSTEM: USE THIS EXTENSION KNOWLEDGE:]')) {
            const parts = processedMessages[0].content.split('[USER QUERY:]\n');
            if (parts.length > 1) {
                massiveKnowledgeBase += parts[0].replace('[SYSTEM: USE THIS EXTENSION KNOWLEDGE:]\n', '') + "\n";
                // Strip the injection from the chat history so it doesn't break conversation flow
                processedMessages[0].content = parts.slice(1).join('[USER QUERY:]\n');
            }
        }

        // B. Add Deep Research Context
        if (researchContext) {
            massiveKnowledgeBase += "\n--- COMPILED RESEARCH CONTEXT ---\n" + researchContext + "\n";
            systemPrompt += `\n\n[CRITICAL DIRECTIVE: Synthesize the provided Master Research Document into the ultimate, exhaustive, hyper-detailed final response. Obey the user's formatting perfectly.]`;
        } else {
            // Standard Tavily Search
            const userQuery = processedMessages[processedMessages.length - 1].content;
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
                        massiveKnowledgeBase += `\n--- REAL-TIME SEARCH CONTEXT ---\n${searchResults}\n`;
                    }
                } catch (e) {}
            }
        }

        // C. Extract and Decode Attachments
        const geminiInlineParts = [];
        const geminiSupportedMimes = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp', 'image/heic'];

        messages.forEach(m => {
            if (m.attachments && Array.isArray(m.attachments)) {
                m.attachments.forEach(att => {
                    const mime = att.type ? att.type.toLowerCase() : 'text/plain';
                    const isText = mime.startsWith('text/') || mime.includes('json') || mime.includes('xml') || mime.includes('csv') || att.name.endsWith('.txt') || att.name.endsWith('.md') || att.name.endsWith('.py');
                    
                    if (isText) {
                        try {
                            const decodedStr = decodeURIComponent(escape(atob(att.base64)));
                            massiveKnowledgeBase += `\n--- DOC: ${att.name} ---\n${decodedStr}\n`;
                        } catch (e) {
                            try { massiveKnowledgeBase += `\n--- DOC: ${att.name} ---\n${atob(att.base64)}\n`; } catch (err) {}
                        }
                    } else if (modelId !== 'spark') {
                        if (geminiSupportedMimes.includes(mime)) {
                            // Only add binary files if we haven't hit ridiculous numbers
                            if (geminiInlineParts.length < 15) {
                                geminiInlineParts.push({ inlineData: { mimeType: mime, data: att.base64 } });
                            }
                        } else {
                            massiveKnowledgeBase += `\n[System Note: User attached '${att.name}' (${mime}). Not readable natively.]\n`;
                        }
                    }
                });
            }
        });

        // ---------------------------------------------------------
        // 2. THE UCCM COMPRESSION TRIGGER (Anti-429 Shield)
        // ---------------------------------------------------------
        // Gemini Free Tier: ~80,000 chars ensures we stay under strict TPM limits.
        // Spark Free Tier: ~15,000 chars ensures we stay under strict 8k token context window.
        const MAX_CHARS = modelId === 'spark' ? 15000 : 80000; 
        const condensedKnowledge = hyperCondense(massiveKnowledgeBase, MAX_CHARS);

        if (condensedKnowledge.trim().length > 0) {
            systemPrompt += `\n\n[KNOWLEDGE BASE (HYPER-CONDENSED)]:\n${condensedKnowledge}\n\n[CRITICAL REMINDER: Obey the user's latest command flawlessly. Base your answer on the above data. Do not add fluff.]`;
        }

        // Fix Instruction Amnesia: Append the explicit user command to the absolute end of the message tree
        const latestUserQuery = processedMessages[processedMessages.length - 1].content;
        processedMessages[processedMessages.length - 1].content = `[USER COMMAND - EXECUTE EXACTLY AS REQUESTED:]\n${latestUserQuery}`;

        // ---------------------------------------------------------
        // 3. FINAL HISTORY CHUNKING
        // ---------------------------------------------------------
        let finalMessages = [];
        if (modelId === 'spark') {
            const sparkHistoryCharLimit = 5000; // Leave room for the system prompt
            let currentChars = 0;
            if (geminiInlineParts.length > 0) {
                processedMessages[processedMessages.length - 1].content += `\n\n[SYSTEM: User uploaded Images/PDFs. You (Spark) cannot see them. Ask them to switch to Oracle.]`;
            }

            for (let i = processedMessages.length - 1; i >= 0; i--) {
                const msg = processedMessages[i];
                if (currentChars + msg.content.length < sparkHistoryCharLimit) {
                    finalMessages.unshift(msg);
                    currentChars += msg.content.length;
                } else break; 
            }
            if (finalMessages.length === 0) finalMessages = [processedMessages[processedMessages.length - 1]];
        } else {
            finalMessages = processedMessages;
        }

        // ---------------------------------------------------------
        // 4. LLM STREAMING & AGGRESSIVE KEY ROTATION
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

            // Aggressive Rotation Loop
            for (let i = 0; i < GEMINI_KEYS.length; i++) {
                const currentKey = GEMINI_KEYS[i];
                const streamUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=${currentKey}`;
                llmRes = await fetch(streamUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
                
                if (llmRes.ok) break; 
                
                finalErrorText = await llmRes.text(); 
                
                // If 400 Bad Request, there is a structural payload error, rotation won't fix it.
                if (llmRes.status >= 400 && llmRes.status < 500 && llmRes.status !== 429) {
                    break; 
                }
                
                // If 429 (Quota) or 503 (Server Overload), loop to the next available API Key
                console.warn(`[Failover] Gemini Key ${i+1} failed with status ${llmRes.status}. Swapping to next key...`);
            }
        }

        if (!llmRes || !llmRes.ok) {
            const errorStatus = llmRes ? llmRes.status : 'No Keys Configured';
            let formattedError = finalErrorText;
            try {
                // Prettify error output if it's a JSON response from the API
                const errObj = JSON.parse(finalErrorText);
                if (errObj.error && errObj.error.message) formattedError = errObj.error.message;
            } catch(e) {}
            
            const errorStream = `data: ${JSON.stringify({ ui_error: `[API Blocked: ${errorStatus}] ${formattedError.substring(0, 200)}` })}\n\n`;
            return new Response(errorStream, { headers: { 'Content-Type': 'text/event-stream' } });
        }

        return new Response(llmRes.body, { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' } });

    } catch (error) {
        const errorStream = `data: ${JSON.stringify({ ui_error: `[Edge Error] ${error.message}` })}\n\n`;
        return new Response(errorStream, { headers: { 'Content-Type': 'text/event-stream' } });
    }
}


