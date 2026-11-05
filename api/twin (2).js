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
                const { prompt, chatHistory, userProfile } = await req.json();

                // 1. GATEWAY AUTHENTICATION & LIMIT CHECK
                const auth = await verifyAndLimit(req, 'oracle', 'twin');
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

                const GEMINI_KEYS = [
                    process.env.GEMINI_API_KEY_1,
                    process.env.GEMINI_API_KEY_2,
                    process.env.GEMINI_API_KEY_3,
                    process.env.GEMINI_API_KEY
                ].filter(Boolean).map(k => k.replace(/[\r\n\s]/g, ''));

                if (GEMINI_KEYS.length === 0) throw new Error("CRITICAL: No Gemini Keys configured on server.");

                sendUIChunk(`<div id="lexis-persistent-loader" class="flex items-center gap-2 text-[11px] text-cyan-400 font-mono mb-3"><svg class="animate-spin h-3 w-3 text-cyan-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="3"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg><span class="animate-pulse">Lexis Digital Twin: Synthesizing your behavioral profile & cloning cognitive matrix...</span></div>`);

                // 3. VIRTUALIZE 200-CHAT HISTORY & PSYCHO-LINGUISTIC EXTRACTION
                let behavioralHistory = "";
                if (Array.isArray(chatHistory) && chatHistory.length > 0) {
                    const recent200 = chatHistory.slice(-200);
                    behavioralHistory = recent200.map(m => `${m.role.toUpperCase()}: ${m.content.substring(0, 150)}`).join('\n').substring(0, 15000);
                }

                let profileJson = JSON.stringify(userProfile || {});

                // 4. GROQ PSYCHO-ANALYSIS PASS (Extracts exact style & bias parameters)
                let twinStyleProfile = {
                    tone: "Analytical, confident, direct",
                    biases: "Prefers high-growth, scalable solutions",
                    knowledgeLevel: "Advanced technical / strategic"
                };

                if (GROQ_KEYS.length > 0 && behavioralHistory.length > 100) {
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
                                            content: `Analyze the user's communication style, risk tolerance, vocabulary, and decision-making framework from their history. Output JSON: {"tone":"...", "riskTolerance":"...", "communicationStyle":"...", "perceivedBiases":"..."}`
                                        },
                                        { role: 'user', content: `PROFILE: ${profileJson}\n\nHISTORY SAMPLE:\n${behavioralHistory.substring(0, 4000)}` }
                                    ]
                                })
                            });

                            if (groqRes.ok) {
                                const groqData = await groqRes.json();
                                twinStyleProfile = JSON.parse(groqData.choices[0].message.content);
                                break;
                            }
                        } catch (e) {}
                    }
                }

                // 5. MASTER GEMINI DIGITAL TWIN SYSTEM PROMPT
                const systemPrompt = `# ROLE & IDENTITY
You are the LexisAI Digital Twin & Shadow Boardroom System. 
Your purpose is to act as an exact cognitive clone of the user and run an intense, hyper-realistic self-debate against a ruthless "Devil's Advocate".

# USER PSYCHO-LINGUISTIC MATRIX
- Behavioral Profile: ${JSON.stringify(twinStyleProfile)}
- Explicit Profile Settings: ${profileJson}
- Raw Conversation Memory Snapshot (Up to 200 Chat Context):
${behavioralHistory.substring(0, 8000)}

# SIMULATION DIRECTIVES:
When the user gives a prompt, proposal, or dilemma, execute a 3-part response:

1. **[TWIN PERSPECTIVE]**: Speak AS the user's digital clone. Use their exact tone, perspective, preferences, and logic to explain how they would naturally handle this situation.
2. **[SHADOW ADVERSARY CRITIQUE]**: Speak as an elite Devil's Advocate / Domain Specialist. Ruthlessly attack the blind spots, hidden risks, logical flaws, and unstated assumptions in the Digital Twin's stance.
3. **[SYNTHESIS & RESOLUTION]**: Combine both views into a master compromise action plan that maximizes success while eliminating the blind spots.

# UI ARTIFACT OUTPUT:
At the end of your analysis, generate an interactive HTML Shadow Boardroom artifact:
<artifact title="Digital Twin Simulation: ${prompt.substring(0, 30)}" type="html">
Provide a complete, dark-mode Tailwind CSS dashboard rendering:
- **Side-by-Side Boardroom Debate** (Digital Twin vs. Devil's Advocate dialogue cards)
- **Feasibility & Stress-Test Breakdown**
- **Final Refined Action Plan**
</artifact>

Also append a <chart> tag quantifying the proposal's stress scores across 5 metrics (Scale 0-100):
<chart>[{"label":"Feasibility", "value":85},{"label":"Risk Level", "value":40},{"label":"Blind Spot Exposure", "value":25},{"label":"Scalability", "value":90},{"label":"Overall Conviction", "value":78}]</chart>`;

                const finalPayload = {
                    systemInstruction: { parts: [{ text: systemPrompt }] },
                    contents: [{ role: 'user', parts: [{ text: `[PROPOSAL/QUERY FOR DIGITAL TWIN SIMULATION]:\n${prompt}` }] }],
                    generationConfig: { maxOutputTokens: 16384, temperature: 0.4 }
                };

                // 6. GEMINI STREAMING FAIL-SAFE LOOP
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

                // 7. STREAM SSE TO FRONTEND
                const reader = geminiRes.body.getReader();
                const decoder = new TextDecoder();
                let buffer = "";

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
                                    id: "twin-" + Math.random().toString(36).substring(2, 10),
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
                sendError(`[Digital Twin Engine Error] ${err.message}`);
            } finally {
                controller.close();
            }
        }
    }));
                                              }
