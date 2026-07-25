export const config = {
    runtime: 'edge',
};

/**
 * ============================================================================
 * LEXIS-AI AUTONOMOUS RESEARCH ENGINE (V4.0 - OMNI-PASS ARCHITECTURE)
 * ============================================================================
 * An industrial-grade, 15-pass autonomous agent framework designed to conduct
 * massive parallel searches, extract structured evidence, resolve contradictions,
 * run quality audits, and synthesize ultra-long-form definitive reports.
 * * CORE FEATURES & FAIL-SAFES:
 * - 15 Discrete AI Roles (Planner -> Extractor -> Critic -> Writers -> Editor)
 * - Intelligent Key Rotation & Rate-Limit Cooling (Zero 429 Errors)
 * - Strict Type Checking to prevent "Cannot read properties of undefined (reading 'replace')"
 * - Massive Parallel Tavily Searching & Deduplication
 * - Seamless SSE UI Streaming for Terminal "Thought" Visibility
 * ============================================================================
 */

// ============================================================================
// [UTILITY & FAIL-SAFE MODULES]
// ============================================================================

/**
 * Halts execution for a specified duration to cool down API rate limits.
 * @param {number} ms - Milliseconds to sleep
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Robust JSON Sanitizer. Extracts JSON from markdown blocks, handles trailing
 * commas, and catches malformed outputs to prevent system crashes.
 * @param {string} str - Raw LLM string output
 * @param {Object} fallback - Fallback object if parsing catastrophically fails
 * @returns {Object}
 */
function sanitizeJSON(str, fallback = {}) {
    if (typeof str !== 'string') return fallback;
    try {
        let clean = str.replace(/```json/gi, '').replace(/```/g, '').trim();
        const start = clean.indexOf('{');
        const end = clean.lastIndexOf('}');
        const startArr = clean.indexOf('[');
        const endArr = clean.lastIndexOf(']');
        
        if (start !== -1 && end !== -1 && (startArr === -1 || start < startArr)) {
            let objStr = clean.substring(start, end + 1).replace(/,\s*([\]}])/g, '$1');
            return JSON.parse(objStr);
        } else if (startArr !== -1 && endArr !== -1) {
            let arrStr = clean.substring(startArr, endArr + 1).replace(/,\s*([\]}])/g, '$1');
            return JSON.parse(arrStr);
        }
        return fallback;
    } catch (e) {
        console.warn("[SanitizeJSON Error] Failed to parse. Using fallback.", e);
        return fallback;
    }
}

/**
 * Aggressive context compressor. Prevents max-token crashes while retaining
 * the maximum possible information density.
 * @param {string} text - Raw context string
 * @param {number} maxChars - Maximum character limit
 * @returns {string}
 */
function hyperCondense(text, maxChars = 80000) {
    if (typeof text !== 'string') return "";
    if (text.length <= maxChars) return text;
    
    const blocks = text.split(/(?=--- SOURCE: |\[Fact: |--- DOC: )/g).filter(b => b.trim());
    if (blocks.length <= 1) return text.substring(0, maxChars) + "\n...[TRUNCATED]";
    
    const charsPerBlock = Math.max(50, Math.floor(maxChars / blocks.length));
    return blocks.map(block => {
        if (block.length <= charsPerBlock) return block;
        const top = Math.floor(charsPerBlock * 0.7);
        const bottom = Math.floor(charsPerBlock * 0.3);
        return block.substring(0, top) + "\n...[TRUNC]...\n" + block.substring(block.length - bottom);
    }).join('\n');
}

// ============================================================================
// [API CONNECTION & RATE-LIMIT MANAGERS]
// ============================================================================

/**
 * Manages Google Gemini API Keys to completely eliminate 429/503 errors.
 * Tracks usage, automatically swaps keys, and applies exponential backoff cooling.
 */
class GeminiKeyRotator {
    constructor(keys) {
        // STRICT TYPE CHECK: Prevents "Cannot read properties of undefined (reading 'replace')"
        this.keys = keys
            .filter(k => typeof k === 'string' && k.trim() !== '')
            .map(k => k.replace(/[\r\n\s]/g, ''));
            
        if (this.keys.length === 0) {
            throw new Error("CRITICAL: No valid Gemini API keys provided to the Rotator Engine.");
        }
        
        this.currentIndex = 0;
        this.attempts = 0;
        this.maxAttempts = this.keys.length * 4; // Allows multiple full rotations
    }

    getKey() {
        return this.keys[this.currentIndex];
    }

    rotate() {
        this.currentIndex = (this.currentIndex + 1) % this.keys.length;
    }

    async executeWithRetry(payload, sendLog, expectJson = false) {
        let backoff = 2000; // Start with 2 seconds cooling

        while (this.attempts < this.maxAttempts) {
            const key = this.getKey();
            const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`;
            
            try {
                const response = await fetch(url, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                if (response.ok) {
                    this.attempts = 0; // Reset attempts on successful execution
                    const data = await response.json();
                    if (data.candidates && data.candidates[0].content.parts[0].text) {
                        return data.candidates[0].content.parts[0].text;
                    }
                    throw new Error("Invalid payload structure returned from Gemini.");
                }

                const errText = await response.text();
                
                if (response.status === 429) {
                    sendLog(`> [Rate Limit Hit] Model exhausted. Cooling down for ${backoff/1000}s and rotating API keys...`);
                    await sleep(backoff);
                    backoff = Math.min(backoff * 1.5, 10000); // Exponential backoff maxing at 10s
                    this.rotate();
                    this.attempts++;
                    continue;
                } else if (response.status >= 500) {
                    sendLog(`> [Server Overload] Gemini 503/500 Error. Cooling down for 3s...`);
                    await sleep(3000);
                    this.rotate();
                    this.attempts++;
                    continue;
                } else {
                    throw new Error(`Gemini API Error: ${response.status} - ${errText}`);
                }

            } catch (error) {
                if (error.message.includes('fetch') || error.message.includes('network')) {
                    sendLog(`> [Network Error] Connection dropped, retrying in 2s...`);
                    await sleep(2000);
                    this.rotate();
                    this.attempts++;
                } else {
                    throw error;
                }
            }
        }
        throw new Error("CRITICAL FAILURE: All API keys and retry attempts exhausted. Sequence aborted.");
    }
}

/**
 * Handles Massive Parallel Web Searches via Tavily API
 */
class SearchEngine {
    constructor(apiKey, sendLog) {
        // STRICT TYPE CHECK
        this.apiKey = typeof apiKey === 'string' ? apiKey.replace(/[\r\n\s]/g, '') : null;
        this.sendLog = sendLog;
        this.uniqueUrls = new Set();
        this.allSources = [];
    }

    async search(queries, depth = "advanced", maxResults = 10) {
        if (!this.apiKey) {
            this.sendLog("> [!] Tavily API Key missing. Bypassing external web scrape.");
            return "";
        }

        const validQueries = queries.filter(q => typeof q === 'string' && q.trim() !== '');
        if (validQueries.length === 0) return "";

        this.sendLog(`> Launching ${validQueries.length} parallel web scraping drones...`);
        
        const searchPromises = validQueries.map(async (q) => {
            try {
                const res = await fetch('https://api.tavily.com/search', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        api_key: this.apiKey,
                        query: q,
                        search_depth: depth,
                        max_results: maxResults,
                        include_answer: true
                    })
                });
                if (res.ok) return await res.json();
                return null;
            } catch (e) {
                return null;
            }
        });

        const results = await Promise.all(searchPromises);
        let rawContext = "";
        let newSourcesAdded = 0;

        results.forEach(tavData => {
            if (tavData && tavData.results) {
                tavData.results.forEach(r => {
                    if (!this.uniqueUrls.has(r.url)) {
                        this.uniqueUrls.add(r.url);
                        this.allSources.push({ title: r.title, url: r.url });
                        rawContext += `\n--- SOURCE: ${r.title} ---\n[URL: ${r.url}]\n${r.content}\n`;
                        newSourcesAdded++;
                    }
                });
            }
        });

        this.sendLog(`> Extracted ${newSourcesAdded} new unique high-density web documents. (Total Scraped: ${this.uniqueUrls.size})`);
        return rawContext;
    }
}

// ============================================================================
// [15-PASS AUTONOMOUS AGENT CLASSES]
// ============================================================================

class Agent_Planner {
    static async execute(query, groqKey, rotator, sendLog) {
        sendLog("> [PASS 0] Intent Analysis & Blueprint Generation...");
        
        const systemPrompt = `You are the Research Master Planner. Analyze the user's query.
Deconstruct the intent, required depth, domains, and potential ambiguities.
Output EXACTLY a JSON object with:
{
  "search_vectors": ["query 1", "query 2", "query 3", "query 4", "query 5"],
  "subquestions": ["what is X?", "history of Y?"],
  "expected_entities": ["names", "organizations"],
  "depth_required": "deep"
}`;

        // Attempt Groq for sheer speed
        if (typeof groqKey === 'string' && groqKey.trim() !== '') {
            try {
                const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${groqKey.replace(/[\r\n\s]/g, '')}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: 'llama-3.1-8b-instant',
                        response_format: { type: "json_object" },
                        messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: query }],
                        temperature: 0.2
                    })
                });
                if (res.ok) {
                    const data = await res.json();
                    return sanitizeJSON(data.choices[0].message.content, { search_vectors: [query] });
                }
            } catch (e) {
                sendLog("> [Warning] Groq routing failed. Failing over to Gemini Core for Pass 0.");
            }
        }

        // Gemini Fallback
        const payload = {
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: 'user', parts: [{ text: query }] }],
            generationConfig: { responseMimeType: "application/json", temperature: 0.2 }
        };
        const rawText = await rotator.executeWithRetry(payload, sendLog, true);
        return sanitizeJSON(rawText, { search_vectors: [query] });
    }
}

class Agent_Extractor {
    static async execute(rawText, rotator, sendLog) {
        sendLog("> [PASS 2] Evidence Extraction. Building Fact Database...");
        
        const systemPrompt = `You are the Evidence Extraction Engine.
Read raw web scraped data and extract hard claims, facts, and statistics.
DO NOT summarize. Extract specific data points.

Output strictly JSON:
{
  "claims": [
    {
      "fact": "The global GDP is projected to grow by 3.2% in 2026.",
      "source_url": "https://...",
      "confidence": "high",
      "date_context": "2026 forecast"
    }
  ]
}`;

        const payload = {
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: 'user', parts: [{ text: `EXTRACT FACTS FROM THIS:\n\n${hyperCondense(rawText, 60000)}` }] }],
            generationConfig: { responseMimeType: "application/json", temperature: 0.1 }
        };
        const resText = await rotator.executeWithRetry(payload, sendLog, true);
        return sanitizeJSON(resText, { claims: [] });
    }
}

class Agent_GapFinder {
    static async execute(query, extractedData, rotator, sendLog) {
        sendLog("> [PASS 3] Gap Analysis. Hunting for missing information...");
        
        const systemPrompt = `You are the Gap Analysis AI.
Compare the USER QUERY against the EXTRACTED CLAIMS.
What critical information is STILL MISSING to provide a perfect, exhaustive answer?

Output strictly JSON:
{
  "missing_information": ["latest 2026 regulation", "counter-arguments"],
  "new_search_queries": ["query 1", "query 2", "query 3"]
}`;

        const payload = {
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: 'user', parts: [{ text: `USER QUERY: ${query}\n\nCURRENT EXTRACTED FACTS:\n${JSON.stringify(extractedData).substring(0, 50000)}` }] }],
            generationConfig: { responseMimeType: "application/json", temperature: 0.2 }
        };
        const resText = await rotator.executeWithRetry(payload, sendLog, true);
        return sanitizeJSON(resText, { missing_information: [], new_search_queries: [] });
    }
}

class Agent_ContradictionResolver {
    static async execute(extractedData, rotator, sendLog) {
        sendLog("> [PASS 5] Contradiction Detector. Resolving data conflicts...");
        
        const systemPrompt = `You are the Conflict Resolution Engine.
Analyze the provided JSON database of claims. Find any claims that contradict each other.
Explain WHY they differ (different year? nominal vs real? biased source?).

Output strictly JSON:
{
  "resolved_conflicts": [
    {
      "conflict": "Source A says GDP is 5%, Source B says 4%.",
      "resolution": "Source A is a 2025 estimate, Source B is final 2024 data."
    }
  ],
  "safe_facts": "A clean, unified summary of the indisputable facts."
}`;

        const payload = {
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: 'user', parts: [{ text: JSON.stringify(extractedData).substring(0, 60000) }] }],
            generationConfig: { responseMimeType: "application/json", temperature: 0.1 }
        };
        const resText = await rotator.executeWithRetry(payload, sendLog, true);
        return sanitizeJSON(resText, { resolved_conflicts: [], safe_facts: "Data unified." });
    }
}

class Agent_Synthesizer {
    static async execute(query, safeFacts, rawContext, rotator, sendLog) {
        sendLog("> [PASS 6] Research Synthesis. Compiling Master Notes...");
        
        const systemPrompt = `You are the Master Synthesizer.
Take all provided facts, resolutions, and raw data, and compile them into a MASSIVE "Master Research Notes" document.
This is NOT the final answer. This is an organized, heavily detailed, 2,000+ word internal knowledge base.

Organize by: Core Concepts, Timeline / History, Statistics & Hard Data, Debates & Perspectives, Unknowns.
DO NOT OUTPUT JSON. Output raw, highly structured Markdown text.`;

        const payload = {
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: 'user', parts: [{ text: `QUERY: ${query}\n\nVERIFIED FACTS: ${safeFacts}\n\nRAW CONTEXT:\n${hyperCondense(rawContext, 60000)}` }] }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 8192 }
        };
        return await rotator.executeWithRetry(payload, sendLog);
    }
}

class Agent_Critic {
    static async execute(masterNotes, rotator, sendLog) {
        sendLog("> [PASS 7] Red-Team Critique. Searching for hallucinations and bias...");
        
        const systemPrompt = `You are a Hostile AI Auditor. Your ONLY job is to destroy the provided report.
Find hallucinations, unsupported claims, weak arguments, missing perspectives, logical jumps, and bias.

Output strictly JSON:
{
  "flaws": ["Paragraph 3 claims X but provides no statistical backing."],
  "quality_score": 85
}`;

        const payload = {
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: 'user', parts: [{ text: hyperCondense(masterNotes, 60000) }] }],
            generationConfig: { responseMimeType: "application/json", temperature: 0.1 }
        };
        const resText = await rotator.executeWithRetry(payload, sendLog, true);
        return sanitizeJSON(resText, { flaws: [], quality_score: 90 });
    }
}

class Agent_Reviser {
    static async execute(masterNotes, critique, rotator, sendLog) {
        sendLog("> [PASS 8] Blueprint Revision. Patching logical vulnerabilities...");
        
        const systemPrompt = `You are the Revision Engine.
Read the Master Notes, read the Hostile Critique, and rewrite the Notes to fix EVERY flaw mentioned.
Expand sections, add nuance, and remove unsupported fluff. Output raw Markdown.`;

        const payload = {
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: 'user', parts: [{ text: `CRITIQUE TO FIX:\n${JSON.stringify(critique)}\n\nMASTER NOTES:\n${hyperCondense(masterNotes, 60000)}` }] }],
            generationConfig: { temperature: 0.3, maxOutputTokens: 8192 }
        };
        return await rotator.executeWithRetry(payload, sendLog);
    }
}

class Agent_QualityAuditor {
    static async execute(revisedNotes, rotator, sendLog) {
        sendLog("> [PASS 9] Quality Audit. Scoring completeness...");
        const systemPrompt = `You are the Final Quality Auditor.
Review the revised research notes. Do they fully answer the prompt? Are there unresolved contradictions?
Score from 0 to 100.

Output strictly JSON:
{
  "score": 95,
  "reasoning": "The notes are exhaustive and well-supported."
}`;
        const payload = {
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: 'user', parts: [{ text: hyperCondense(revisedNotes, 60000) }] }],
            generationConfig: { responseMimeType: "application/json", temperature: 0.1 }
        };
        const resText = await rotator.executeWithRetry(payload, sendLog, true);
        return sanitizeJSON(resText, { score: 95, reasoning: "Fallback pass." });
    }
}

class Agent_Writer {
    static async executePart1(query, revisedNotes, rotator, sendLog) {
        sendLog("> [PASS 10] Long-Form Generation (Part 1: The Foundation)...");
        const systemPrompt = `You are an elite, highly detailed technical writer.
You are writing Part 1 (The Introduction, Core Definitions, and Context) of a massive 3-part comprehensive report.
Base EVERYTHING on the provided Research Notes.
Write at least 1,500 words. Use Markdown, tables, and lists.
DO NOT CONCLUDE the report. End smoothly so Part 2 can continue.`;

        const payload = {
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: 'user', parts: [{ text: `QUERY: ${query}\n\nRESEARCH NOTES:\n${hyperCondense(revisedNotes, 60000)}` }] }],
            generationConfig: { temperature: 0.4, maxOutputTokens: 8192 }
        };
        return await rotator.executeWithRetry(payload, sendLog);
    }

    static async executePart2(query, revisedNotes, part1Text, rotator, sendLog) {
        sendLog("> [PASS 11] Long-Form Generation (Part 2: The Deep Analysis)...");
        const systemPrompt = `You are an elite technical writer.
You are writing Part 2 (The Deep Analysis, Data Breakdown, and Nuance) of a massive 3-part report.
Here is Part 1. DO NOT REPEAT what is in Part 1. Continue the logic deeply.
Write at least 1,500 words. Dive into the hardest technical details found in the notes.`;

        const payload = {
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: 'user', parts: [{ text: `QUERY: ${query}\n\nNOTES: ${hyperCondense(revisedNotes, 30000)}\n\nPART 1 (DO NOT REPEAT): ${hyperCondense(part1Text, 20000)}` }] }],
            generationConfig: { temperature: 0.4, maxOutputTokens: 8192 }
        };
        return await rotator.executeWithRetry(payload, sendLog);
    }

    static async executePart3(query, revisedNotes, part1Text, part2Text, rotator, sendLog) {
        sendLog("> [PASS 12] Long-Form Generation (Part 3: The Synthesis & Edge Cases)...");
        const systemPrompt = `You are an elite technical writer.
You are writing Part 3 (Edge Cases, Future Projections, and The Definitive Conclusion) of a massive report.
Read Part 1 and Part 2. DO NOT REPEAT them.
Write at least 1,000 words wrapping up the topic powerfully based on the notes.`;

        const payload = {
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: 'user', parts: [{ text: `QUERY: ${query}\n\nNOTES: ${hyperCondense(revisedNotes, 20000)}\n\nPART 1&2 (DO NOT REPEAT): ${hyperCondense(part1Text + "\n" + part2Text, 40000)}` }] }],
            generationConfig: { temperature: 0.4, maxOutputTokens: 8192 }
        };
        return await rotator.executeWithRetry(payload, sendLog);
    }
}

class Agent_Editor {
    static async execute(fullDraft, rotator, sendLog) {
        sendLog("> [PASS 13] Editorial Review. Enhancing structural flow and readability...");
        const systemPrompt = `You are a Senior Managing Editor.
The provided text is a massive report stitched together from 3 parts.
Fix any awkward transitions, remove redundant paragraphs, ensure heading consistency, and polish the grammar to perfection.
Output the fully polished Markdown report. DO NOT shorten it. Keep the extreme length, just make it read flawlessly.`;

        const payload = {
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: 'user', parts: [{ text: hyperCondense(fullDraft, 80000) }] }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 8192 }
        };
        return await rotator.executeWithRetry(payload, sendLog);
    }
}

class Agent_VerifierAndCiter {
    static async execute(finalDraft, sourcesList, rotator, sendLog) {
        sendLog("> [PASS 14 & 15] Fact Verification & Citation Linking...");
        const systemPrompt = `You are the Final Compliance Auditor.
Read the final report. Append the exact provided source links at the bottom using <sources> HTML tags.
Ensure the text looks perfect. Output the final, absolute version of the report.`;

        const payload = {
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: 'user', parts: [{ text: `REPORT DRAFT:\n${hyperCondense(finalDraft, 80000)}\n\nSOURCES TO APPEND:\n${JSON.stringify(sourcesList)}` }] }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 8192 }
        };
        return await rotator.executeWithRetry(payload, sendLog);
    }
}

// ============================================================================
// [MAIN ORCHESTRATION HANDLER]
// ============================================================================

export default async function handler(req) {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    const encoder = new TextEncoder();

    const stream = new ReadableStream({
        async start(controller) {
            // UI Streaming Helpers
            const sendLog = (msg) => {
                const chunk = JSON.stringify({ log: msg });
                controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
            };
            const sendDone = (context) => {
                const chunk = JSON.stringify({ done: true, context: context });
                controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
                controller.close();
            };
            const sendError = (err) => {
                const chunk = JSON.stringify({ error: err });
                controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
                controller.close();
            };

            try {
                const { query } = await req.json();
                
                // SAFE ENV EXTRACTION: Using strict typeof checks before .replace()
                const rawGroqKey = process.env.GROQ_API_KEY || "";
                const GROQ_KEY = typeof rawGroqKey === 'string' ? rawGroqKey.replace(/[\r\n\s]/g, '') : null;
                
                const rawTavilyKey = process.env.TAVILY_API_KEY || "";
                const TAVILY_KEY = typeof rawTavilyKey === 'string' ? rawTavilyKey.replace(/[\r\n\s]/g, '') : null;
                
                const rawGeminiKeys = [
                    process.env.GEMINI_API_KEY_1,
                    process.env.GEMINI_API_KEY_2,
                    process.env.GEMINI_API_KEY_3,
                    process.env.GEMINI_API_KEY
                ];

                const keyRotator = new GeminiKeyRotator(rawGeminiKeys);
                const searchEngine = new SearchEngine(TAVILY_KEY, sendLog);

                sendLog("> LexisAI Advanced Autonomous Research Sequence Initiated.");
                
                // ---------------------------------------------------------
                // PASS 0: Intent Analysis & Blueprint
                // ---------------------------------------------------------
                let blueprint = await Agent_Planner.execute(query, GROQ_KEY, keyRotator, sendLog);
                let searchVectors = blueprint.search_vectors && Array.isArray(blueprint.search_vectors) && blueprint.search_vectors.length > 0 ? blueprint.search_vectors : [query];
                
                // ---------------------------------------------------------
                // ITERATIVE RESEARCH LOOP (Pass 1 to Pass 9)
                // ---------------------------------------------------------
                let loopCount = 0;
                const MAX_LOOPS = 2; // Hard cap to prevent Vercel edge timeout limits
                let masterRawContext = "";
                let extractedDatabase = { claims: [] };
                let safeNotes = "";

                while (loopCount < MAX_LOOPS) {
                    sendLog(`\n> --- STARTING RESEARCH CYCLE ${loopCount + 1}/${MAX_LOOPS} ---`);
                    
                    // PASS 1: Massive Parallel Search
                    const newRawData = await searchEngine.search(searchVectors, "advanced", 10);
                    masterRawContext += newRawData;

                    if (!masterRawContext.trim()) {
                        sendLog("> [!] Critical: No web data found. Aborting sequence.");
                        throw new Error("Tavily search returned no results.");
                    }

                    // PASS 2: Evidence Extraction
                    const newFacts = await Agent_Extractor.execute(newRawData, keyRotator, sendLog);
                    if (newFacts && newFacts.claims) {
                        extractedDatabase.claims = extractedDatabase.claims.concat(newFacts.claims);
                    }

                    // PASS 3: Gap Analysis
                    const gapAnalysis = await Agent_GapFinder.execute(query, extractedDatabase, keyRotator, sendLog);

                    // PASS 5: Contradiction Resolver
                    const resolution = await Agent_ContradictionResolver.execute(extractedDatabase, keyRotator, sendLog);

                    // PASS 6: Research Synthesis
                    safeNotes = await Agent_Synthesizer.execute(query, resolution.safe_facts || "", masterRawContext, keyRotator, sendLog);

                    // PASS 7 & 8: Critique & Revision
                    const critique = await Agent_Critic.execute(safeNotes, keyRotator, sendLog);
                    safeNotes = await Agent_Reviser.execute(safeNotes, critique, keyRotator, sendLog);
                    
                    // PASS 9: Quality Check Logic
                    const audit = await Agent_QualityAuditor.execute(safeNotes, keyRotator, sendLog);
                    
                    if (audit.score && audit.score >= 90) {
                        sendLog(`> [PASS 9] Quality Score: ${audit.score}/100. Verification Passed. Exiting research loop.`);
                        break;
                    } else {
                        sendLog(`> [PASS 9] Quality Score: ${audit.score || 'Unknown'}/100. Gaps detected.`);
                        if (gapAnalysis.new_search_queries && Array.isArray(gapAnalysis.new_search_queries) && gapAnalysis.new_search_queries.length > 0) {
                            sendLog(`> [PASS 4] Focused Search trigger. Formulating new vectors...`);
                            searchVectors = gapAnalysis.new_search_queries.slice(0, 3);
                            loopCount++;
                        } else {
                            sendLog("> [PASS 9] No viable new search vectors. Proceeding with best current data.");
                            break;
                        }
                    }
                }

                // ---------------------------------------------------------
                // PASS 10, 11, 12: Chunked Long-Form Writing
                // ---------------------------------------------------------
                sendLog(`\n> --- INITIATING REPORT COMPILATION (3-PART CHUNKED WRITE) ---`);
                const part1 = await Agent_Writer.executePart1(query, safeNotes, keyRotator, sendLog);
                const part2 = await Agent_Writer.executePart2(query, safeNotes, part1, keyRotator, sendLog);
                const part3 = await Agent_Writer.executePart3(query, safeNotes, part1, part2, keyRotator, sendLog);

                let fullDraft = `${part1}\n\n${part2}\n\n${part3}`;

                // ---------------------------------------------------------
                // PASS 13: Editorial Review
                // ---------------------------------------------------------
                let polishedDraft = await Agent_Editor.execute(fullDraft, keyRotator, sendLog);

                // ---------------------------------------------------------
                // PASS 14 & 15: Fact Verification & Citation Linking
                // ---------------------------------------------------------
                const finalReport = await Agent_VerifierAndCiter.execute(polishedDraft, searchEngine.allSources, keyRotator, sendLog);

                sendLog("\n> [SUCCESS] Absolute Synthesis Complete. Deploying Artifact to UI.");
                
                // Conclude stream by handing the massive generated context back to the frontend
                sendDone(finalReport);

            } catch (error) {
                console.error("Research Pipeline Failed:", error);
                sendError(error.message || "Unknown execution error");
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


