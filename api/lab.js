import { verifyAndLimit } from './auth.js';

export const config = {
    runtime: 'edge',
};

export default async function handler(req) {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    const encoder = new TextEncoder();

    return new Response(new ReadableStream({
        async start(controller) {
            const sendUIChunk = (textString) => {
                const chunk = JSON.stringify({ candidates: [{ content: { parts: [{ text: textString }] } }] });
                controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
            };

            const sendError = (msg) => {
                const chunk = JSON.stringify({ ui_error: msg });
                controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
            };

            try {
                const { idea, chatHistory } = await req.json();

                // 1. GATEWAY AUTHENTICATION & LIMIT CHECK
                const auth = await verifyAndLimit(req, 'oracle', 'lab');
                if (!auth.authorized && !auth.isCreator) {
                    sendError(auth.error);
                    return;
                }

                // 2. API KEY ROTATION MATRIX
                const GROQ_KEYS = [
                    process.env.GROQ_API_KEY,
                    process.env.GROQ_KEY_2,
                    process.env.GROQ_KEY_3
                ].filter(Boolean).map(k => k.replace(/[\r\n\s]/g, ''));

                const TAVILY_KEYS = [
                    process.env.TAVILY_API_KEY,
                    process.env.TAVILY_KEY_2,
                    process.env.TAVILY_KEY_3,
                    process.env.TAVILY_KEY_4,
                    process.env.TAVILY_KEY_5
                ].filter(Boolean).map(k => k.replace(/[\r\n\s]/g, ''));

                const GEMINI_KEYS = [
                    process.env.GEMINI_API_KEY_1,
                    process.env.GEMINI_API_KEY_2,
                    process.env.GEMINI_API_KEY_3,
                    process.env.GEMINI_API_KEY
                ].filter(Boolean).map(k => k.replace(/[\r\n\s]/g, ''));

                if (GEMINI_KEYS.length === 0) throw new Error("CRITICAL: No Gemini Keys configured on server.");

                sendUIChunk(`<div id="lexis-persistent-loader" class="flex items-center gap-2 text-[11px] text-purple-400 font-mono mb-3"><svg class="animate-spin h-3 w-3 text-purple-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg><span class="animate-pulse">Lexis Lab Engine: Scanning 200-chat memory & searching White Ocean vectors...</span></div>`);

                // 3. VIRTUALIZE 200-CHAT CONTEXT HISTORY
                let userProfileSummary = "No prior history available.";
                if (Array.isArray(chatHistory) && chatHistory.length > 0) {
                    const recent200 = chatHistory.slice(-200);
                    userProfileSummary = recent200.map(m => `${m.role.toUpperCase()}: ${m.content.substring(0, 150)}`).join('\n').substring(0, 15000);
                }

                // 4. GROQ INTENT DECOMPOSITION (White Ocean & Market Gap Search Vectors)
                let searchVectors = [
                    `${idea} market problems common complaints`,
                    `${idea} white ocean opportunities sub-niches`,
                    `${idea} trading arbitrage entrepreneurship potential`
                ];

                if (GROQ_KEYS.length > 0) {
                    for (const gKey of GROQ_KEYS) {
                        try {
                            const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                                method: 'POST',
                                headers: { 'Authorization': `Bearer ${gKey}`, 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    model: 'llama-3.1-8b-instant',
                                    response_format: { type: "json_object" },
                                    temperature: 0.2,
                                    messages: [
                                        {
                                            role: 'system',
                                            content: 'You are the Lexis Innovation Router. Decompose the user concept into 3 highly specific web search queries to locate consumer pain points, white ocean sub-niches, and market arbitrage. Output JSON: {"queries": ["q1", "q2", "q3"]}'
                                        },
                                        { role: 'user', content: `Concept/Idea: ${idea}` }
                                    ]
                                })
                            });

                            if (groqRes.ok) {
                                const groqData = await groqRes.json();
                                const parsed = JSON.parse(groqData.choices[0].message.content);
                                if (parsed.queries && Array.isArray(parsed.queries) && parsed.queries.length > 0) {
                                    searchVectors = parsed.queries.slice(0, 4);
                                    break;
                                }
                            }
                        } catch (e) {}
                    }
                }

                // 5. PARALLEL TAVILY SEARCH GROUNDING
                let searchGroundingContext = "";
                if (TAVILY_KEYS.length > 0) {
                    let successfulHits = 0;
                    for (let i = 0; i < searchVectors.length; i++) {
                        const tKey = TAVILY_KEYS[i % TAVILY_KEYS.length];
                        try {
                            const tavRes = await fetch('https://api.tavily.com/search', {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({ api_key: tKey, query: searchVectors[i], search_depth: "advanced", max_results: 5, include_answer: true })
                            });

                            if (tavRes.ok) {
                                const tavData = await tavRes.json();
                                const snippet = tavData.results.map(r => `[Source: ${r.title}] (${r.url}): ${r.content}`).join('\n');
                                searchGroundingContext += `\n--- SEARCH VECTOR: ${searchVectors[i]} ---\n${snippet}\n`;
                                successfulHits++;
                            }
                        } catch (e) {}
                    }
                }

                // 6. FINAL GEMINI 2.5 FLASH SYNTHESIS SYSTEM PROMPT
                const systemPrompt = `# ROLE & IDENTITY
You are the LexisAI Experimental Lab Master — an ultra-intelligent, pragmatic venture capitalist, market strategist, and quantitative trader.

# PURPOSE
Transform the user's idea or brainstorm into an exhaustive, high-depth Innovation Strategy and Execution Artifact. 

# USER HISTORICAL MEMORY (Up to 200 Chat Snapshot):
${userProfileSummary}

# REAL-TIME MARKET GROUNDING DATA:
${searchGroundingContext || "Internal market knowledge applied."}

# OUTPUT STRUCTURE REQUIREMENTS:
Output your answer as a complete, self-contained Markdown response, followed by an interactive Workspace Artifact:
<artifact title="Lexis Lab Strategy: ${idea.substring(0, 30)}" type="html">
Provide a complete, modern Tailwind CSS HTML dashboard summarizing:
1. Executive White Ocean Overview & Untapped Sub-Niches
2. Problem & Pain Point Breakdown (Common Complaints & Market Failures)
3. Trading / Arbitrage / Entrepreneurship Execution Blueprint
4. 5-Year Financial & Growth Projections
5. Risk-Mitigation Playbook
</artifact>

Also append a <chart> tag with JSON stats for ROI or Market Growth projection:
<chart>[{"label":"Year 1", "value":15},{"label":"Year 2", "value":45},{"label":"Year 3", "value":120},{"label":"Year 4", "value":280},{"label":"Year 5", "value":600}]</chart>

And an explicit sources tag at the end:
<sources>[{"title":"Market Grounding Report","url":"https://tavily.com"}]</sources>`;

                const finalPayload = {
                    systemInstruction: { parts: [{ text: systemPrompt }] },
                    contents: [{ role: 'user', parts: [{ text: `[BRAINSTORM & INNOVATE ON THIS IDEA/CONCEPT]:\n${idea}` }] }],
                    generationConfig: { maxOutputTokens: 16384, temperature: 0.3 }
                };

                // 7. GEMINI FAIL-SAFE STREAMING LOOP
                let geminiRes = null;
                let lastErr = "";

                for (let i = 0; i < GEMINI_KEYS.length; i++) {
                    geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=${GEMINI_KEYS[i]}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify(finalPayload)
                    });
                    if (geminiRes.ok) break;
                    lastErr = await geminiRes.text();
                }

                if (!geminiRes || !geminiRes.ok) throw new Error(lastErr || "All Gemini keys exhausted.");

                // 8. PARSE AND STREAM SSE PAYLOAD
                const reader = geminiRes.body.getReader();
                const decoder = new TextDecoder();
                let buffer = "";

                // Send CSS rule to hide loader seamlessly when text starts streaming
                sendUIChunk(`<style>#lexis-persistent-loader { display: none !important; }</style>`);

                while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;

                    buffer += decoder.decode(value, { stream: true });
                    const chunks = buffer.split(/\r?\n\r?\n/);
                    buffer = chunks.pop();

                    for (const chunk of chunks) {
                        const jsonStr = chunk.replace(/^data:\s*/gm, '').trim();
                        if (!jsonStr || jsonStr === '[DONE]') continue;

                        try {
                            const rawData = JSON.parse(jsonStr);
                            const cleanText = rawData.candidates?.[0]?.content?.parts?.[0]?.text || "";

                            if (cleanText) {
                                const cleanPayload = {
                                    id: "lab-" + Math.random().toString(36).substring(2, 10),
                                    object: "chat.completion.chunk",
                                    created: Math.floor(Date.now() / 1000),
                                    model: 'oracle',
                                    text: cleanText,
                                    message: cleanText,
                                    choices: [{ index: 0, delta: { role: "assistant", content: cleanText }, finish_reason: null }],
                                    candidates: [{ index: 0, content: { role: "model", parts: [{ text: cleanText }] }, finishReason: null }]
                                };
                                controller.enqueue(encoder.encode(`data: ${JSON.stringify(cleanPayload)}\n\n`));
                            }
                        } catch (e) {}
                    }
                }

            } catch (err) {
                sendError(`[Lab Engine Exception] ${err.message}`);
            } finally {
                controller.close();
            }
        }
    }));
            }
