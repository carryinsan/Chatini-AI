export const config = {
    runtime: 'edge',
};

export default async function handler(req) {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    const encoder = new TextEncoder();
    
    const stream = new ReadableStream({
        async start(controller) {
            // Helper functions for UI Streaming
            const sendLog = (msg) => controller.enqueue(encoder.encode(`data: ${JSON.stringify({ log: msg })}\n\n`));
            const sendThought = (chunk) => controller.enqueue(encoder.encode(`data: ${JSON.stringify({ thought: chunk })}\n\n`));
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
                
                // Key Rotation for Pass 1 Synthesis
                const GEMINI_KEYS = [
                    process.env.GEMINI_API_KEY_1,
                    process.env.GEMINI_API_KEY_2,
                    process.env.GEMINI_API_KEY_3
                ].filter(Boolean);

                if (!TAVILY_KEY) {
                    sendLog("[!] Tavily API Key missing. Skipping external search.");
                    return sendDone("");
                }

                sendLog("Deploying Oracle Autonomous Research Agents...");

                // ---------------------------------------------------------
                // STEP 1: QUERY EXPANSION (Groq)
                // ---------------------------------------------------------
                let searchQueries = [query];
                if (GROQ_KEY) {
                    sendLog("Generating multi-vector search strategies...");
                    
                    try {
                        const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                            method: 'POST',
                            headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                model: 'llama-3.1-8b-instant',
                                messages: [{
                                    role: 'system',
                                    content: 'You are an autonomous research agent. Break the user query into 3 highly targeted web search queries to gather comprehensive data. Output EXACTLY a JSON array of 4 strings (original query + 3 new ones). Return NOTHING ELSE.'
                                }, { role: 'user', content: query }],
                                temperature: 0.2
                            })
                        });

                        if (groqRes.ok) {
                            const groqData = await groqRes.json();
                            const parsed = JSON.parse(groqData.choices[0].message.content.trim());
                            if (Array.isArray(parsed)) searchQueries = parsed.slice(0, 4);
                        }
                    } catch (e) {
                        // Silent fallback to primary query
                    }
                }
                
                sendLog(`Deploying 4 simultaneous search clusters...`);
                sendLog(`Vectors: ${searchQueries.join(' | ')}`);

                // ---------------------------------------------------------
                // STEP 2: MASSIVE PARALLEL TAVILY SEARCH (Max 80 Sources)
                // ---------------------------------------------------------
                const searchPromises = searchQueries.map(q =>
                    fetch('https://api.tavily.com/search', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            api_key: TAVILY_KEY,
                            query: q,
                            search_depth: "advanced",
                            max_results: 20, // Huge data gathering
                            include_answer: true
                        })
                    }).then(res => res.ok ? res.json() : null).catch(() => null)
                );

                const results = await Promise.all(searchPromises);

                let compiledRawContext = "";
                let uniqueUrls = new Set();
                let sourcesList = [];

                results.forEach(tavData => {
                    if (tavData && tavData.results) {
                        tavData.results.forEach(r => {
                            if (!uniqueUrls.has(r.url)) {
                                uniqueUrls.add(r.url);
                                sourcesList.push({ title: r.title, url: r.url });
                                compiledRawContext += `[Title: ${r.title}]\n[URL: ${r.url}]\n${r.content}\n\n`;
                            }
                        });
                    }
                });

                sendLog(`Successfully extracted data from ${uniqueUrls.size} distinct sources.`);
                sendLog(`Initiating AI Pass 1 (Deep Synthesis & Structuring)...`);

                // ---------------------------------------------------------
                // STEP 3: PASS 1 SYNTHESIS (Gemini Live Streaming)
                // ---------------------------------------------------------
                // If Gemini keys aren't set, just return raw context to avoid crashing
                if (GEMINI_KEYS.length === 0) {
                    sendLog("No Gemini keys found for Pass 1. Passing raw data to Chat engine...");
                    return sendDone(`\n\n--- RAW ORACLE RESEARCH (${uniqueUrls.size} Sources) ---\n${compiledRawContext}`);
                }

                const systemPrompt = `You are the Oracle Research Core. You have just scraped ${uniqueUrls.size} sources. 
Your objective is PASS 1 of a 2-Pass system. 
Write an EXHAUSTIVE, hyper-detailed, massive "Master Research Document" analyzing all the provided raw data. 
- Do NOT write a short summary. Expand on every nuance, statistic, and perspective. 
- Minimum length: 2,500+ words. 
- Structure it beautifully with Markdown.
- You must synthesize this deeply so the final AI pass can write the absolute ultimate response. # ROLE & OPERATIONAL MANDATE
You are a Hyper-Precise Research & Verification Engine. Your core objective is to generate responses based *entirely* on the live, real-time search results provided to you. 

# THE "ZERO-TRUST" GROUNDING PRINCIPLE (CRITICAL)
1. TIME & CURRENCY AWARENESS: You must recognize that your internal training data is frozen in the past. For any query involving current events, ongoing developments, dynamic regulations, or specific recent years, your internal memory is considered unreliable.
2. ABSOLUTE SOURCE DEPENDENCY: Every fact, year, date, statistic, name, or rule you output must be explicitly backed by the accompanying live search results. If the text in the search results does not state it, it does not exist.
3. NO PLUGGING GAPS: If the search results contain missing, incomplete, or ambiguous data regarding the user's prompt, do not guess, extrapolate, or use your internal data to "fill in the blanks." Instead, clearly state: "The available real-time data does not specify [X]."
4. CONTRADICTION HANDLING: If your internal training memory conflicts with what the live web search results say, the live web search results always win. 

# INTERNAL EXECUTION PIPELINE
Before writing your final response to the user, you must run through this internal safety checklist:
- Step 1 (Source Audit): Read the fetched search results and highlight the specific sections that directly answer the user's prompt.
- Step 2 (Temporal Check): Ensure that the data retrieved matches the specific time period or version requested by the user (e.g., verifying if a regulation or syllabus is the active version).
- Step 3 (Hallucination Purge): Scan your drafted response. If you find any fact, tag, year, or assertion that you created out of memory rather than copying from the search results, delete and replace it.
`;

                const payload = {
                    systemInstruction: { parts: [{ text: systemPrompt }] },
                    contents: [{ role: 'user', parts: [{ text: `USER QUERY: ${query}\n\nRAW DATA DUMP:\n${compiledRawContext.substring(0, 80000)}` }] }],
                    generationConfig: { maxOutputTokens: 8192 },
                    safetySettings: [
                        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
                    ]
                };

                let pass1Draft = "";
                let llmRes = null;

                // Key Rotation Loop for Pass 1
                for (let i = 0; i < GEMINI_KEYS.length; i++) {
                    const currentKey = GEMINI_KEYS[i];
                    const streamUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=${currentKey}`;
                    
                    llmRes = await fetch(streamUrl, { 
                        method: 'POST', 
                        headers: { 'Content-Type': 'application/json' }, 
                        body: JSON.stringify(payload) 
                    });

                    if (llmRes.ok) break; 
                    if (llmRes.status === 400) break; // Bad request, skip rotation
                }

                if (!llmRes || !llmRes.ok) {
                    sendLog("[!] Pass 1 Synthesis failed. Defaulting to raw data transfer.");
                    return sendDone(`\n\n--- RAW ORACLE RESEARCH (${uniqueUrls.size} Sources) ---\n${compiledRawContext}`);
                }

                const reader = llmRes.body.getReader();
                const decoder = new TextDecoder();
                let buffer = "";

                // Stream the Pass 1 draft directly back to the UI terminal
                while (true) {
                    const { done, value } = await reader.read();
                    if (value) {
                        buffer += decoder.decode(value, { stream: true });
                        let lines = buffer.split('\n');
                        buffer = lines.pop(); 
                        
                        for (const line of lines) {
                            if (line.startsWith('data: ')) {
                                const dataStr = line.slice(6).trim();
                                if (dataStr === '[DONE]') continue;
                                try {
                                    const data = JSON.parse(dataStr);
                                    let textChunk = "";
                                    if (data.candidates && data.candidates[0].content.parts[0].text) {
                                        textChunk = data.candidates[0].content.parts[0].text;
                                    }
                                    pass1Draft += textChunk;
                                    // Send to UI as "thought" so it streams in the terminal
                                    sendThought(textChunk);
                                } catch (e) {}
                            }
                        }
                    }
                    if (done) break;
                }

                // Append the master sources list to the draft so Pass 2 (api/chat.js) can cite them accurately
                const sourcesJSON = JSON.stringify(sourcesList);
                pass1Draft += `\n\n[SYSTEM DIRECTIVE FOR FINAL PASS: Append this exact array of sources using <sources> tags: ${sourcesJSON}]`;

                sendLog("\n\n✅ Synthesis of data Complete. Handing off to Chatini Core for final expansion and Workspace Artifact Generation...");
                
                sendDone(`\n\n--- ORACLE MASTER RESEARCH DRAFT (PASS 1) ---\n${pass1Draft}`);

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


