export const config = {
    runtime: 'edge',
};

export default async function handler(req) {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    const encoder = new TextEncoder();
    
    // We use Server-Sent Events (SSE) to stream the AI's internal thought process back to the UI
    const stream = new ReadableStream({
        async start(controller) {
            const sendLog = (msg) => controller.enqueue(encoder.encode(`data: ${JSON.stringify({ log: msg })}\n\n`));
            const sendDone = (context) => {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true, context })}\n\n`));
                controller.close();
            };
            const sendError = (err) => {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: err })}\n\n`));
                controller.close();
            };

            try {
                const { query } = await req.json();
                const GROQ_KEY = process.env.GROQ_API_KEY;
                const TAVILY_KEY = process.env.TAVILY_API_KEY;

                if (!TAVILY_KEY) {
                    sendLog("Tavily API Key missing. Proceeding with internal knowledge only.");
                    return sendDone("");
                }

                sendLog("Deploying Oracle Autonomous Agent...");

                // Phase 1: Query Expansion via Groq
                // The AI acts as a researcher, breaking the user's single question into 3 targeted search vectors
                let searchQueries = [query];
                if (GROQ_KEY) {
                    sendLog("Analyzing query architecture...");
                    
                    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            model: 'llama-3.1-8b-instant',
                            messages: [{
                                role: 'system',
                                content: 'You are an autonomous research agent. Given a user query, generate 2 additional distinct, highly targeted web search queries to gather comprehensive data. Output EXACTLY a JSON array of 3 strings (the original query + 2 new ones). Example: ["original", "new target 1", "new target 2"]. Return NOTHING ELSE.'
                            }, { role: 'user', content: query }],
                            temperature: 0.1
                        })
                    });

                    if (groqRes.ok) {
                        const groqData = await groqRes.json();
                        try {
                            const parsed = JSON.parse(groqData.choices[0].message.content.trim());
                            if (Array.isArray(parsed)) searchQueries = parsed.slice(0, 3);
                            sendLog(`Generated search vectors: ${searchQueries.join(', ')}`);
                        } catch (e) {
                            sendLog("Using primary search vector...");
                        }
                    }
                }

                // Phase 2: Parallel Deep Searching
                sendLog(`Scanning ${searchQueries.length * 5}+ live sources globally...`);
                
                // Fire all searches simultaneously for massive speed gains
                const searchPromises = searchQueries.map(q =>
                    fetch('https://api.tavily.com/search', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            api_key: TAVILY_KEY,
                            query: q,
                            search_depth: "advanced",
                            max_results: 5,
                            include_answer: true
                        })
                    }).then(res => res.ok ? res.json() : null).catch(() => null)
                );

                const results = await Promise.all(searchPromises);

                // Phase 3: Data Synthesis & Deduplication
                sendLog("Cross-referencing and compiling data vectors...");
                let compiledContext = "";
                let uniqueUrls = new Set();

                results.forEach(tavData => {
                    if (tavData && tavData.results) {
                        tavData.results.forEach(r => {
                            if (!uniqueUrls.has(r.url)) {
                                uniqueUrls.add(r.url);
                                compiledContext += `Title: ${r.title}\nURL: ${r.url}\nContent: ${r.content}\n\n`;
                            }
                        });
                    }
                });

                sendLog(`Research complete. ${uniqueUrls.size} verified sources integrated.`);
                
                // Return the massive compiled dataset to the frontend to feed to Gemini
                sendDone(`\n\n--- ORACLE AUTONOMOUS RESEARCH MASTER CONTEXT ---\n${compiledContext}`);

            } catch (error) {
                sendError(error.message);
            }
        }
    });

    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
        }
    });
}

