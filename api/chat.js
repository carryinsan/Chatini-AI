export const config = {
    runtime: 'edge', 
};

export default async function handler(req) {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    try {
        const { messages, modelId } = await req.json();
        const latestMessage = messages[messages.length - 1];
        const userQuery = latestMessage.content;
        const attachments = latestMessage.attachments || []; // New: Extract attachments

        const GROQ_KEY = process.env.GROQ_API_KEY;
        const TAVILY_KEY = process.env.TAVILY_API_KEY;
        const GEMINI_KEY = process.env.GEMINI_API_KEY_3 || process.env.GEMINI_API_KEY_2 || process.env.GEMINI_API_KEY_1;

        let contextData = "";
        
        let systemPrompt = `You are Chatini, a premium, hyper-intelligent conversational AI.
**IDENTITY & TONE:**
- Strictly "Chatini". Witty, conversational, motivating, and highly engaging. 
- Use Markdown beautifully (## headers, **bold**, bullet points).

**DATA & UI RULES:**
1. If you use search data OR analyze uploaded files/images, you MUST append a JSON array of sources at the VERY END wrapped in <sources> tags. 
   Format: <sources>[{"title":"File: image.jpg", "url":"#"}, {"title":"Site Name", "url":"https://example.com"}]</sources>
2. If comparing data or asked for a chart, output a JSON array wrapped in <chart> tags.
   Format: <chart>[{"label":"Cat A", "value":85}]</chart>`;

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
        // PASS 2: LLM STREAMING
        // ---------------------------------------------------------
        let streamUrl, headers, payload;

        if (modelId === 'spark') {
            // Spark (Llama) does not support multimodal native files in this API format
            if (attachments.length > 0) {
                processedMessages[processedMessages.length - 1].content += `\n\n[SYSTEM: The user attached files, but you (Spark/Llama) do not have vision/file capabilities. Politely ask them to switch to Flux or Oracle to analyze files.]`;
            }

            streamUrl = 'https://api.groq.com/openai/v1/chat/completions';
            headers = { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' };
            payload = {
                model: 'llama-3.1-8b-instant',
                messages: [{ role: 'system', content: systemPrompt }, ...processedMessages.map(m => ({role: m.role, content: m.content}))],
                stream: true,
                temperature: 0.6 
            };
        } else {
            // Gemini natively handles files via inlineData
            streamUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=${GEMINI_KEY}`;
            headers = { 'Content-Type': 'application/json' };
            
            const geminiMessages = processedMessages.map(m => {
                const parts = [{ text: m.content }];
                // Map base64 attachments directly into Gemini's engine
                if (m.attachments && m.attachments.length > 0) {
                    m.attachments.forEach(att => {
                        parts.push({
                            inlineData: { mimeType: att.mimeType, data: att.base64 }
                        });
                    });
                }
                return { role: m.role === 'user' ? 'user' : 'model', parts };
            });

            payload = {
                systemInstruction: { parts: [{ text: systemPrompt }] },
                contents: geminiMessages
            };
        }

        const llmRes = await fetch(streamUrl, { method: 'POST', headers, body: JSON.stringify(payload) });

        if (!llmRes.ok) {
            const errorText = await llmRes.text();
            const errorStream = `data: ${JSON.stringify({ ui_error: `[API Blocked: ${llmRes.status}] ${errorText.substring(0, 150)}` })}\n\n`;
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


