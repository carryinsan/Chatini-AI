export const config = {
    runtime: 'edge',
};

export default async function handler(req) {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    const encoder = new TextEncoder();
    
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
                    sendLog("Tavily API Key missing. Proceeding with internal knowledge.");
                    return sendDone("");
                }

                sendLog("Deploying Advanced Multi-Agent Swarm...");

                // ---------------------------------------------------------
                // PASS 1: QUERY EXPANSION (Generate 4 search vectors)
                // ---------------------------------------------------------
                let searchQueries = [query];
                if (GROQ_KEY) {
                    sendLog("Architecting parallel search vectors...");
                    
                    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            model: 'llama-3.1-8b-instant',
                            messages: [{
                                role: 'system',
                                content: 'You are an autonomous research architect. Given a user query, generate 3 additional distinct, highly targeted web search queries to gather comprehensive, exhaustive data. Output EXACTLY a JSON array of 4 strings (original + 3 new). Example: ["original", "target 1", "target 2", "target 3"]. Return NOTHING ELSE.'
                            }, { role: 'user', content: query }],
                            temperature: 0.2
                        })
                    });

                    if (groqRes.ok) {
                        const groqData = await groqRes.json();
                        try {
                            const parsed = JSON.parse(groqData.choices[0].message.content.trim());
                            if (Array.isArray(parsed)) searchQueries = parsed.slice(0, 4);
                            sendLog(`Vectors locked: ${searchQueries.map(q => `"${q}"`).join(', ')}`);
                        } catch (e) {
                            sendLog("Using primary search vector...");
                        }
                    }
                }

                // ---------------------------------------------------------
                // PASS 2: MASSIVE PARALLEL SEARCH (20 Sources per vector)
                // ---------------------------------------------------------
                sendLog(`Scanning up to ${searchQueries.length * 20} global sources simultaneously...`);
                
                const searchPromises = searchQueries.map(q =>
                    fetch('https://api.tavily.com/search', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            api_key: TAVILY_KEY,
                            query: q,
                            search_depth: "advanced",
                            max_results: 20, // Max depth requested
                            include_answer: true
                        })
                    }).then(res => res.ok ? res.json() : null).catch(() => null)
                );

                const results = await Promise.all(searchPromises);

                sendLog("Aggregating and deduplicating data pipelines...");
                let compiledContext = "";
                let uniqueUrls = new Set();
                let sourceCount = 0;

                results.forEach(tavData => {
                    if (tavData && tavData.results) {
                        tavData.results.forEach(r => {
                            if (!uniqueUrls.has(r.url)) {
                                uniqueUrls.add(r.url);
                                compiledContext += `Title: ${r.title}\nURL: ${r.url}\nContent: ${r.content}\n\n`;
                                sourceCount++;
                            }
                        });
                    }
                });

                sendLog(`Verified ${sourceCount} distinct high-value sources.`);

                // ---------------------------------------------------------
                // PASS 3: COGNITIVE PRE-SYNTHESIS ("Live Thoughts" Streaming)
                // ---------------------------------------------------------
                if (GROQ_KEY && compiledContext.length > 0) {
                    sendLog("Initiating cognitive reasoning pass (Live Thoughts):");
                    
                    const thoughtRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                        method: 'POST',
                        headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            model: 'llama-3.1-8b-instant',
                            messages: [{
                                role: 'system',
                                content: `You are the internal reasoning engine for Chatini. Review this raw data and briefly outline a master strategy for the final 4000-word response. Write your thought process step-by-step. Keep it brief, punchy, and analytical (e.g., "- Found X data. Will structure the report starting with Y..."). Do not write the final essay, just the mental plan.`
                            }, { 
                                role: 'user', 
                                content: `RAW DATA (Truncated):\n${compiledContext.substring(0, 20000)}\n\nUSER QUERY: ${query}` 
                            }],
                            stream: true,
                            temperature: 0.5
                        })
                    });

                    if (thoughtRes.ok) {
                        const reader = thoughtRes.body.getReader();
                        const decoder = new TextDecoder("utf-8");
                        let thoughtBuffer = "";

                        while (true) {
                            const { done, value } = await reader.read();
                            if (done) break;
                            const chunk = decoder.decode(value, { stream: true });
                            const lines = chunk.split('\n');
                            
                            for (const line of lines) {
                                if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                                    try {
                                        const data = JSON.parse(line.slice(6));
                                        const text = data.choices[0]?.delta?.content || "";
                                        thoughtBuffer += text;
                                        
                                        // Buffer by newline to stream complete thoughts to the UI terminal smoothly
                                        if (thoughtBuffer.includes('\n')) {
                                            const thoughtLines = thoughtBuffer.split('\n');
                                            thoughtBuffer = thoughtLines.pop(); 
                                            for (const tl of thoughtLines) {
                                                if (tl.trim()) sendLog(`<span class="text-purple-400">[Thought]</span> ${tl.trim()}`);
                                            }
                                        }
                                    } catch(e) {}
                                }
                            }
                        }
                        if (thoughtBuffer.trim()) sendLog(`<span class="text-purple-400">[Thought]</span> ${thoughtBuffer.trim()}`);
                    }
                }

                // ---------------------------------------------------------
                // PASS 4: 3x-4x LENGTH MEGA-PROMPT INJECTION
                // ---------------------------------------------------------
                const megaPromptOverride = `
                
[CRITICAL SYSTEM OVERRIDE FOR FINAL RESPONSE]
The user requires a response that is 3x to 4x LONGER, DEEPER, and MORE EXHAUSTIVE than normal. 
1. You MUST generate a massive, definitive master-document.
2. Break down every single concept into extreme granular detail.
3. Provide extensive historical context, multiple real-world examples, advanced analytical breakdowns, and edge cases.
4. DO NOT SUMMARIZE. EXPAND. Use high-density professional language.
5. YOU MUST wrap the entire core analysis inside an <artifact title="Comprehensive Deep-Dive Master Report"> tag so it opens in the Workspace Canvas.
6. Append <sources> at the absolute end outside the artifact.`;

                // Return massive context + override to `api/chat.js` for final generation
                sendDone(`\n\n--- ORACLE AUTONOMOUS RESEARCH MASTER CONTEXT ---\n${compiledContext}\n${megaPromptOverride}`);

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


