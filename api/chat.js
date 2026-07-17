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
        let systemPrompt = `You are Chatini, a premium, highly analytical AI.
Use Markdown extensively (## headers, **bold**, bullet points, \`code\`).

**MANDATORY OUTPUT RULES:**
1. If you use search data, you MUST append a JSON array of sources at the very end wrapped in <sources> tags. 
   Format: <sources>[{"title":"Site Name", "url":"https://example.com"}]</sources>
2. If comparing data, showing stats, or asked for a chart, you MUST output a JSON array wrapped in <chart> tags. DO NOT wrap the JSON in markdown code blocks inside the tags.
   Format: <chart>[{"label":"Category A", "value":85}, {"label":"Category B", "value":42}]</chart>
3. Ensure no hallucinated data. Be concise but extremely insightful.`;

        // ---------------------------------------------------------
        // PASS 1: TAVILY DEEP SEARCH
        // ---------------------------------------------------------
        if ((modelId === 'flux' || modelId === 'oracle') && TAVILY_KEY) {
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
                    // Structure data cleanly so the LLM can extract Titles and URLs for the <sources> tag
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
                temperature: 0.2
            };
        } else {
            // Using Flash 2.5 for Gemini
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


