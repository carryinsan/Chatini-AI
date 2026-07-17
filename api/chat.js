export const config = {
    runtime: 'edge', 
};

export default async function handler(req) {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    try {
        const { messages, modelId } = await req.json();
        const userQuery = messages[messages.length - 1].content;

        const GROQ_KEY = process.env.GROQ_API_KEY;
        const TAVILY_KEY = process.env.TAVILY_API_KEY;
        const GEMINI_KEY = process.env.GEMINI_API_KEY_3 || process.env.GEMINI_API_KEY_2 || process.env.GEMINI_API_KEY_1;

        let contextData = "";
        
        // Brand & Persona Guardrails
        let systemPrompt = `You are Chatini, a premium, hyper-intelligent, and highly engaging conversational AI. 
**IDENTITY & TONE:**
- You are strictly "Chatini". NEVER mention OpenAI, Google, Gemini, Groq, Anthropic, or Llama. If asked about your origins, you are Chatini, built for premium assistance.
- Tone: Witty, conversational, motivating, and highly engaging. Do NOT be a dry, boring academic robot while talking with non serious or non academic topic only. Speak like a genius, caring mentor who is fun to talk to. Crave user engagement.
- Formatting: Use Markdown beautifully (## headers, **bold**, bullet points).

**DATA & UI RULES:**
1. If you use search data, you MUST append a JSON array of sources at the VERY END wrapped in <sources> tags. 
   Format: <sources>[{"title":"Site Name", "url":"https://example.com"}]</sources>
2. If comparing data, showing stats, or asked for a chart, you MUST output a JSON array wrapped in <chart> tags. DO NOT wrap the JSON in markdown code blocks inside the tags.
   Format: <chart>[{"label":"Category A", "value":85}, {"label":"Category B", "value":42}]</chart>`;

        // ---------------------------------------------------------
        // PASS 1: SMART TAVILY SEARCH (Oracle = Always, Flux = Smart, Spark = Never)
        // ---------------------------------------------------------
        // Flux Regex: Only triggers search if it detects knowledge-seeking keywords
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
                    systemPrompt += `\n\nSearch Context provided. You MUST cite these using the <sources> tag as instructed.`;
                }
            } catch (e) {
                console.error("Tavily Search Failed.");
            }
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
            streamUrl = 'https://api.groq.com/openai/v1/chat/completions';
            headers = { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' };
            payload = {
                model: 'llama-3.1-8b-instant',
                messages: [{ role: 'system', content: systemPrompt }, ...processedMessages],
                stream: true,
                temperature: 0.6 // Slightly higher temp for more witty/creative tone
            };
        } else {
            streamUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=${GEMINI_KEY}`;
            headers = { 'Content-Type': 'application/json' };
            
            const geminiMessages = processedMessages.map(m => ({
                role: m.role === 'user' ? 'user' : 'model',
                parts: [{ text: m.content }]
            }));

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


