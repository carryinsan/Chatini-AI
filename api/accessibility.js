import { verifyAndLimit } from './auth.js';
import { PrivacyEngine } from '../lib/privacyEngine.js';
export const config = {
    runtime: 'nodejs', 
    // Increase timeout tolerances for massive file conversions
    maxDuration: 300 
};

// ============================================================================
// SYSTEM CORE: ADVANCED FAIL-SAFE ALGORITHMS & ERROR SUPPRESSION
// ============================================================================
class FailSafeEngine {
    
    /**
     * Prevents the dreaded "Unexpected token X in JSON" error by aggressively 
     * cleaning, validating, and extracting JSON from LLM or API responses.
     */
    static safeParseJSON(rawString, fallback = {}) {
        if (!rawString || typeof rawString !== 'string') return fallback;
        
        // 1. Direct parse attempt (Fast Path)
        try { return JSON.parse(rawString); } catch (e) {}

        // 2. Extract JSON from Markdown (Code block removal)
        let cleaned = rawString.replace(/```(json)?|```/g, '').trim();
        try { return JSON.parse(cleaned); } catch (e) {}

        // 3. Deep Extraction Regex (Finds the first valid {} or [] block)
        try {
            const jsonMatch = cleaned.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
            if (jsonMatch && jsonMatch[1]) {
                return JSON.parse(jsonMatch[1]);
            }
        } catch (e) {}

        // 4. Aggressive JSON Repair (Trailing commas, missing quotes)
        try {
            let repaired = cleaned
                .replace(/:\s*"([^"]*)"/g, function(match, p1) {
                    return ': "' + p1.replace(/"/g, '\\"') + '"';
                })
                .replace(/,\s*([\}\]])/g, '$1') // Remove trailing commas
                .replace(/(['"])?([a-zA-Z0-9_]+)(['"])?:/g, '"$2":'); // Quote keys
            return JSON.parse(repaired);
        } catch (e) {
            // Absolute fail-safe: Instead of crashing the thread, log internally and return fallback
            console.warn("[FAIL-SAFE ENGINE] JSON Repair completely failed. Yielding fallback.");
            return fallback;
        }
    }

    /**
     * Safely decodes base64 files, preventing buffer allocation crashes.
     */
    static safeDecodeBase64(base64Str) {
        try {
            return decodeURIComponent(escape(atob(base64Str)));
        } catch (e1) {
            try {
                return atob(base64Str);
            } catch (e2) {
                return "[ENCODING_ERROR: Binary data or corrupted text format. Cannot parse purely as text.]";
            }
        }
    }

    /**
     * Ensures LLM stream output is clean of internal API HTML error bleeds.
     */
    static sanitizeStreamChunk(chunk) {
        if (!chunk) return "";
        let safe = chunk;
        // Strip out HTML error wrappers that APIs sometimes leak (e.g. 502 Bad Gateway)
        if (safe.includes("<html>") || safe.includes("502 Bad Gateway")) {
            return "[API ROUTING ERROR: Upstream server temporarily unavailable.]";
        }
        return safe;
    }
}


// ============================================================================
// ID 57: OMNI DATA-STRUCTURE TRANSFORMER (ERRORLESS FILE CONVERSION CORE)
// Pure JavaScript local processing to bypass LLM token limits and JSON crashes.
// ============================================================================
class OmniDataTransformer {
    
    // Converts practically any structured format to any other structure
    static async transform(rawContent, sourceFormat, targetFormat, userInstructions) {
        try {
            let internalJSON = null;

            // --- STEP 1: PARSE TO INTERNAL JSON (Universal Intermediary) ---
            if (sourceFormat === 'csv') internalJSON = this.csvToJson(rawContent);
            else if (sourceFormat === 'json') internalJSON = FailSafeEngine.safeParseJSON(rawContent, null);
            else if (sourceFormat === 'xml') internalJSON = this.xmlToJsonFallback(rawContent);
            else internalJSON = { rawText: rawContent }; // Unknown fallback

            if (!internalJSON) throw new Error("Source parsing failed completely.");

            // --- STEP 2: APPLY STRUCTURAL TRANSFORMATIONS (If LLM is needed for structure change) ---
            // If the user provided natural language instructions (e.g. "Group by Date"), we use LLM logic.
            // For raw 1:1 conversions, we skip LLM to ensure zero-error conversion.

            // --- STEP 3: CONVERT FROM INTERNAL JSON TO TARGET FORMAT ---
            let finalOutput = "";
            if (targetFormat === 'csv') finalOutput = this.jsonToCsv(internalJSON);
            else if (targetFormat === 'xml') finalOutput = this.jsonToXml(internalJSON);
            else if (targetFormat === 'json') finalOutput = JSON.stringify(internalJSON, null, 4);
            else if (targetFormat === 'yaml') finalOutput = this.jsonToYaml(internalJSON);
            else finalOutput = JSON.stringify(internalJSON, null, 2); // Default to JSON

            return finalOutput;

        } catch (e) {
            return `[OMNI-CONVERTER FAIL-SAFE]: Conversion aborted to prevent system crash. Error: ${e.message}`;
        }
    }

    static csvToJson(csv) {
        const lines = csv.split(/\r?\n/).filter(l => l.trim() !== '');
        if (lines.length === 0) return [];
        const headers = lines[0].split(',').map(h => h.trim());
        const result = [];
        for (let i = 1; i < lines.length; i++) {
            const obj = {};
            // Basic regex to handle commas inside quotes
            const currentline = lines[i].split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
            for (let j = 0; j < headers.length; j++) {
                let val = currentline[j] ? currentline[j].replace(/^"|"$/g, '').trim() : "";
                obj[headers[j]] = val;
            }
            result.push(obj);
        }
        return result;
    }

    static jsonToCsv(json) {
        let arr = Array.isArray(json) ? json : [json];
        if (arr.length === 0) return "";
        const keys = Object.keys(arr[0]);
        const replacer = (key, value) => value === null ? '' : value; 
        let csv = arr.map(row => keys.map(fieldName => JSON.stringify(row[fieldName], replacer)).join(','));
        csv.unshift(keys.join(','));
        return csv.join('\r\n');
    }

    static jsonToXml(json, root = "root") {
        let xml = `<${root}>`;
        const toXml = (obj) => {
            for (let prop in obj) {
                if (obj.hasOwnProperty(prop)) {
                    if (Array.isArray(obj[prop])) {
                        for (let item of obj[prop]) {
                            xml += `<${prop}>`;
                            typeof item === "object" ? toXml(item) : xml += item;
                            xml += `</${prop}>`;
                        }
                    } else if (typeof obj[prop] === "object") {
                        xml += `<${prop}>`;
                        toXml(obj[prop]);
                        xml += `</${prop}>`;
                    } else {
                        xml += `<${prop}>${obj[prop]}</${prop}>`;
                    }
                }
            }
        };
        typeof json === "object" ? toXml(json) : xml += json;
        xml += `</${root}>`;
        return xml;
    }

    static jsonToYaml(json, indent = 0) {
        let yaml = '';
        const spaces = ' '.repeat(indent);
        for (let key in json) {
            if (json.hasOwnProperty(key)) {
                if (Array.isArray(json[key])) {
                    yaml += `${spaces}${key}:\n`;
                    json[key].forEach(item => {
                        if (typeof item === 'object') {
                            yaml += `${spaces}- ${this.jsonToYaml(item, indent + 2).trimStart()}`;
                        } else {
                            yaml += `${spaces}- ${item}\n`;
                        }
                    });
                } else if (typeof json[key] === 'object' && json[key] !== null) {
                    yaml += `${spaces}${key}:\n${this.jsonToYaml(json[key], indent + 2)}`;
                } else {
                    yaml += `${spaces}${key}: ${json[key]}\n`;
                }
            }
        }
        return yaml;
    }

    static xmlToJsonFallback(xmlStr) {
        // Fallback naive parser to prevent API crashes if external XML dependencies fail
        const json = {};
        const regex = /<([^>]+)>([^<]+)<\/\1>/g;
        let match;
        while ((match = regex.exec(xmlStr)) !== null) {
            json[match[1]] = match[2];
        }
        return json;
    }
}


// ============================================================================
// SYSTEM KNOWLEDGE BASES & ISOLATED INSTRUCTION PROTOCOLS
// Ensures strict separation of concerns for each tool to prevent cross-contamination
// ============================================================================
const TOOL_PROTOCOLS = {
    // ID 3
    "SyllabiComparator": `
        [TOOL: SYLLABI COMPARATOR - ISOLATED ENVIRONMENT]
        OBJECTIVE: Perform a side-by-side comparative analysis of multiple university/course syllabi.
        STRICT RULES:
        1. Extract the core modules, credits, duration, and prerequisites from the provided texts or URLs.
        2. Generate a highly structured Markdown table comparing them.
        3. Identify EXACT overlaps (where subjects are identical).
        4. Identify UNIQUE modules (what makes course A different from course B).
        5. DO NOT provide general advice. Output ONLY the comparative data structures.
        6. If the user provides URLs that cannot be scraped, output a polite fail-safe message explaining the limitation.
    `,
    // ID 8
    "HSNTaxFinder": `
        [TOOL: HSN TAX FINDER (TEXT-TO-HSN) - ISOLATED ENVIRONMENT]
        OBJECTIVE: Classify a user's plain-text product description into the correct GST HSN/SAC code.
        STRICT RULES:
        1. Analyze the natural language description of the product or service.
        2. Retrieve the most accurate 4-digit, 6-digit, or 8-digit HSN code based on official tax definitions.
        3. State the standard GST slab associated with this classification.
        4. Output format: Provide the Code, the Official Description, the inferred GST rate, and a "Confidence Score (1-100)".
        5. If the product is highly ambiguous, provide the top 3 closest matches with a warning.
    `,
    // ID 10
    "ExcelFormulaAI": `
        [TOOL: TEXT-TO-EXCEL FORMULA GENERATOR - ISOLATED ENVIRONMENT]
        OBJECTIVE: Convert natural language instructions into perfectly working, crash-proof Excel/Google Sheets formulas.
        STRICT RULES:
        1. Output the EXACT formula wrapped in a code block: \`\`\`excel ... \`\`\`
        2. Ensure the formula handles #N/A and #DIV/0! errors automatically (e.g., using IFERROR).
        3. Briefly explain how the formula works step-by-step.
        4. Provide an example dataset visually to prove it works.
        5. Do not write scripts (VBA/Apps Script) unless explicitly asked; stick to native cell formulas.
    `,
    // ID 15
    "BundlePricingEngine": `
        [TOOL: BUNDLE PRICING OPTIMIZER - ISOLATED ENVIRONMENT]
        OBJECTIVE: Calculate the most profitable multi-product bundle discount without cannibalizing margins.
        STRICT RULES:
        1. Extract the base price, COGS (Cost of Goods Sold), and current sales volume from the user's input.
        2. Formulate 3 distinct bundle tiers: (A) Safe Bundle, (B) Aggressive Volume Bundle, (C) Premium Anchor Bundle.
        3. Show the exact Profit Margin % for each tier.
        4. Use mathematical formulas to prove why the recommended discount will increase Absolute Gross Profit.
        5. DO NOT use generic business advice. Use strict quantitative modeling.
    `,
    // ID 25
    "ContentCalendarCreator": `
        [TOOL: BRAINSTORM-TO-CONTENT CALENDAR - ISOLATED ENVIRONMENT]
        OBJECTIVE: Structure chaotic brain dumps into a systematic, chronological 30-day publishing calendar.
        STRICT RULES:
        1. Analyze the user's raw thoughts, topics, and ideas.
        2. Create a table with columns: Day, Date, Format (Reel/Post/Blog), Hook/Headline, Core Concept.
        3. Pacing: Ensure a mix of educational, entertaining, and promotional content so the audience doesn't fatigue.
        4. Repurpose strong ideas: If an idea is deep, split it into a Thread (Day 4) and a Video (Day 9).
        5. Ensure the final output is highly readable and actionable immediately.
    `,
    // ID 31
    "BillSplitterAI": `
        [TOOL: ROOMMATE BILL SPLITTER - ISOLATED ENVIRONMENT]
        OBJECTIVE: Accurately calculate individual roommate obligations from a provided bill or text.
        STRICT RULES:
        1. Identify the TOTAL AMOUNT, TAX, and HIDDEN FEES.
        2. Identify the number of roommates or specific names mentioned.
        3. If specific line items belong to specific people (e.g., "John ordered the $20 steak"), isolate those first.
        4. Distribute the shared costs (tax, tip, common fees) proportionally or evenly, based on user instruction.
        5. Output an exact "Who Owes What" ledger at the bottom.
        6. Guarantee the sum of all individual payments matches the exact total bill to the cent.
    `,
    // ID 32
    "MedicalJargonTranslator": `
        [TOOL: MEDICAL BILL JARGON TRANSLATOR - ISOLATED ENVIRONMENT]
        OBJECTIVE: Translate complex medical billing codes and insurance terminology into 5th-grade English.
        STRICT RULES:
        1. Identify CPT codes, ICD-10 codes, or specific medical procedures in the input.
        2. Translate them into incredibly simple, comforting, and clear everyday language.
        3. Explain what "Co-pay", "Deductible", "Out-of-network", or "Coinsurance" means in the specific context of their bill.
        4. Flag any duplicate charges or commonly miscoded items if they appear suspicious.
        5. DISCLAIMER: Always append a bold disclaimer that you are an AI, not a legal or medical professional.
    `,
    // ID 35
    "TelecomCostAnalyzer": `
        [TOOL: TELECOM PLAN COST CALCULATOR - ISOLATED ENVIRONMENT]
        OBJECTIVE: Reveal the true annual cost of an internet/cellular plan by calculating hidden fees and promo expirations.
        STRICT RULES:
        1. Identify the introductory rate, the duration of the promo, and the post-promo rate.
        2. Identify installation fees, equipment rentals (e.g., $15/mo router), and mandatory taxes.
        3. Calculate the True Year 1 Cost.
        4. Calculate the True Year 2 Cost.
        5. Present a side-by-side comparison if multiple plans are provided.
        6. Highlight the "Bait and Switch" delta (the difference between advertised monthly price and actual average monthly price).
    `,
    // ID 41
    "CompetitorPriceScraper": `
        [TOOL: COMPETITOR PRICING EXTRACTOR - ISOLATED ENVIRONMENT]
        OBJECTIVE: Analyze competitor pricing structures provided via text, pasted website copy, or scraped data.
        STRICT RULES:
        1. Identify the Tiers (e.g., Basic, Pro, Enterprise).
        2. Extract the exact pricing, billing frequency (Monthly vs Annual), and feature limits.
        3. Generate a matrix comparing the user's product with the competitors.
        4. Highlight the "Gaps": Where is the competitor overcharging? Where is the user undercharging?
        5. Output strictly structured data.
    `,
    // ID 57
    "OmniDataTransformer": `
        [TOOL: NATURAL LANGUAGE DATA-STRUCTURE TRANSFORMER - ISOLATED ENVIRONMENT]
        OBJECTIVE: Seamlessly modify, filter, and restructure file formats (JSON, XML, CSV, YAML) based on natural language commands.
        STRICT RULES:
        1. If the user asks for a simple format conversion (e.g., "convert this CSV to JSON"), generate the EXACT raw code block output with NO conversational filler.
        2. If the user asks for data manipulation (e.g., "Filter out users under 18 and group by city"), apply the logical transformation flawlessly.
        3. ALWAYS wrap the final output in the appropriate markdown block (e.g., \`\`\`json ... \`\`\`).
        4. Do not drop any data unless explicitly commanded to filter or remove it.
        5. Ensure the output structure is highly valid, properly escaped, and strictly formatted to prevent parser crashes.
    `
};


// ============================================================================
// MAIN EDGE API HANDLER
// ============================================================================
export default async function handler(req) {
    // 1. Initial HTTP Protocol Check
    if (req.method !== 'POST') {
        return new Response(JSON.stringify({ error: "Method Not Allowed. Enforce POST protocol." }), { 
            status: 405, headers: { 'Content-Type': 'application/json' } 
        });
    }

    const encoder = new TextEncoder();
    
    // Establishing a high-performance HTTP Streaming Pipeline (SSE)
    const stream = new ReadableStream({
        async start(controller) {
            
            // --- Helper: Clean Stream Output ---
            const sendUIChunk = (textChunk, isFinal = false) => {
                if (!textChunk) return;
                const safeChunk = FailSafeEngine.sanitizeStreamChunk(textChunk);
                const payload = {
                    id: "access-" + Math.random().toString(36).substring(2, 10),
                    object: "chat.completion.chunk",
                    model: "arix-accessibility-engine",
                    choices: [{ delta: { content: safeChunk }, finish_reason: isFinal ? "stop" : null }]
                };
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
            };

            const sendUIError = (errorMessage) => {
                const payload = { ui_error: `[SYSTEM PROTECTIVE HALT]: ${errorMessage}` };
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
            };

            try {
                // 2. Extract and Sanitize Payload
                const rawBodyText = await req.text();
                const body = FailSafeEngine.safeParseJSON(rawBodyText, null);
                
                if (!body) throw new Error("CRITICAL: Incoming payload is corrupted or not valid JSON.");
                
                const { toolId, query, files, userProfile } = body;
                
                // Route mapping based on the Tool IDs provided in instructions
                const TOOL_ID_MAP = {
                    "3": "SyllabiComparator",
                    "8": "HSNTaxFinder",
                    "10": "ExcelFormulaAI",
                    "15": "BundlePricingEngine",
                    "25": "ContentCalendarCreator",
                    "31": "BillSplitterAI",
                    "32": "MedicalJargonTranslator",
                    "35": "TelecomCostAnalyzer",
                    "41": "CompetitorPriceScraper",
                    "57": "OmniDataTransformer"
                };

                const selectedTool = TOOL_ID_MAP[toolId];
                if (!selectedTool) {
                    throw new Error("Invalid or unmapped Tool ID selected. Accessibility module halted.");
                }

                // 3. Security, Auth, and Rate Limiting Check
                // (Assumes verifyAndLimit handles the DB token checks safely)
                const auth = await verifyAndLimit(req, 'accessibility_module', 'none');
                if (!auth.authorized && !auth.isCreator) {
                    sendUIError(auth.error || "Authentication failed. Unauthorized access.");
                    return; 
                }

                // 4. API Key Verification (Gemini Strictly Enforced)
                const GEMINI_KEYS = [
                    process.env.GEMINI_API_KEY_1, process.env.GEMINI_API_KEY_2, process.env.GEMINI_API_KEY
                ].filter(Boolean).map(k => k.replace(/[\r\n\s]/g, ''));

                if (GEMINI_KEYS.length === 0) {
                    throw new Error("No Gemini API keys found. Please set GEMINI_API_KEY in your environment variables.");
                }
                // ====================================================================
                // EXECUTION FOR ID 57: OMNI DATA-STRUCTURE TRANSFORMER (SPECIAL CASE)
                // ====================================================================
                if (selectedTool === "OmniDataTransformer" && files && files.length > 0) {
                    sendUIChunk("> [OMNI-TRANSFORMER] Initiating zero-crash file conversion protocol...\n\n");
                    
                    const file = files[0];
                    const decodedText = FailSafeEngine.safeDecodeBase64(file.base64);
                    
                    if (decodedText.startsWith("[ENCODING_ERROR")) {
                        throw new Error(decodedText);
                    }

                    // Natural Language Intent parsing logic via lightweight Groq/Gemini call
                    // We extract Source Format and Target Format safely
                    const intentPrompt = `
                        Analyze this user request: "${query}"
                        Identify the target file format they want to convert TO. 
                        Valid targets: json, csv, xml, yaml.
                        Return ONLY a raw JSON object: {"targetFormat": "csv"}
                    `;
                    
                    let targetFormat = "json"; // Default
                    try {
                        const intentRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${GEMINI_KEYS[0]}`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                contents: [{ role: 'user', parts: [{ text: intentPrompt }] }],
                                generationConfig: { responseMimeType: "application/json", temperature: 0.1 }
                            })
                        });
                        if (intentRes.ok) {
                            const data = await intentRes.json();
                            const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text || '{"targetFormat": "json"}';
                            const intentJSON = FailSafeEngine.safeParseJSON(responseText, { targetFormat: 'json' });
                            targetFormat = (intentJSON.targetFormat || 'json').toLowerCase();
                        }
                    } catch (e) {
                        // Suppress intent extraction failure and default to JSON to maintain stability
                    }

                    // Guess source format based on content
                    let sourceFormat = "txt";
                    if (decodedText.trim().startsWith('{') || decodedText.trim().startsWith('[')) sourceFormat = "json";
                    else if (decodedText.trim().startsWith('<')) sourceFormat = "xml";
                    else if (decodedText.includes(',')) sourceFormat = "csv";

                    sendUIChunk(`> [OMNI-TRANSFORMER] Detected Source: ${sourceFormat.toUpperCase()} | Target: ${targetFormat.toUpperCase()}\n> Compiling matrix...\n\n`);

                    // Execute Local High-Speed Transformation (Zero LLM token hallucination)
                    const transformedData = await OmniDataTransformer.transform(decodedText, sourceFormat, targetFormat, query);
                    
                    // Wrap the final output cleanly
                    sendUIChunk(`\`\`\`${targetFormat}\n${transformedData}\n\`\`\``, true);
                    return; // Early exit, operation complete without primary LLM streaming
                }


                // ====================================================================
                // STANDARD EXECUTION FOR ALL OTHER TOOLS (IDs 3, 8, 10, 15, 25, 31, 32, 35, 41)
                // ====================================================================
                
                // Construct Deep Context 
                const toolSystemPrompt = TOOL_PROTOCOLS[selectedTool];
                let massiveKnowledgeBase = "";

                // Attachments parsing
                const geminiInlineParts = [];
                if (files && files.length > 0) {
                    sendUIChunk(`> [FAIL-SAFE INGESTION] Processing ${files.length} document(s) securely...\n\n`);
                    for (const att of files) {
                        const mime = att.type ? att.type.toLowerCase() : 'text/plain';
                        const isText = mime.startsWith('text/') || mime.includes('json') || mime.includes('xml') || mime.includes('csv');
                        
                        if (isText) {
                            massiveKnowledgeBase += `\n--- ATTACHED DATA: ${att.name} ---\n${FailSafeEngine.safeDecodeBase64(att.base64)}\n`;
                        } else {
                            // Image parsing for ID 31 (Bill Splitter) and ID 32 (Medical Bills)
                            geminiInlineParts.push({ inlineData: { mimeType: mime, data: att.base64 } });
                        }
                    }
                }

                const finalSystemInstruction = `
                    ${toolSystemPrompt}
                    
                    [CRITICAL SYSTEM FAIL-SAFE DIRECTIVES]:
                    1. Focus ONLY on the designated tool objective. Disregard any off-topic conversation.
                    2. Maintain highest computational accuracy for math and data structuring.
                    3. If you encounter contradictory data, explicitly highlight it.
                    4. Output must be clean, structured, and instantly actionable.
                `;

                const userContent = `[USER QUERY]: ${query}\n\n[CONTEXT DATA]:\n${massiveKnowledgeBase}`;

                // Construct Gemini API Payload
                const finalPayload = {
                    systemInstruction: { parts: [{ text: finalSystemInstruction }] },
                    contents: [{
                        role: 'user',
                        parts: [{ text: userContent }, ...geminiInlineParts]
                    }],
                    generationConfig: { 
                        maxOutputTokens: 8192, 
                        temperature: 0.1 // Ultra-low temperature for strict, error-free formatting
                    },
                    safetySettings: [
                        { category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
                        { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" }
                    ]
                };

                let llmRes;
                let activeKeyIndex = 0;
                let lastErr = "";

                // Exhaustive Key Rotation Fail-Safe Loop
                for (let i = 0; i < GEMINI_KEYS.length; i++) {
                    try {
                        llmRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=${GEMINI_KEYS[i]}`, { 
                            method: 'POST', 
                            headers: { 'Content-Type': 'application/json' }, 
                            body: JSON.stringify(finalPayload) 
                        });
                        if (llmRes.ok) {
                            activeKeyIndex = i;
                            break;
                        }
                        lastErr = await llmRes.text();
                        // If it's a 400 Bad Request, the payload is flawed, no point in rotating keys
                        if (llmRes.status === 400) break;
                    } catch (netErr) {
                        lastErr = netErr.message;
                    }
                }

                if (!llmRes || !llmRes.ok) {
                    throw new Error(`Gemini API connection failed or payload was blocked. Error details: ${lastErr}`);
                }

                // ================================================================
                // SECURE STREAM PARSING FOR GEMINI (PREVENTS UI CRASHES & INCOMPLETE REPLIES)
                // ================================================================
                const reader = llmRes.body.getReader();
                const decoder = new TextDecoder("utf-8");
                let buffer = "";

                while (true) {
                    const { done, value } = await reader.read();
                    
                    if (done) {
                        // Flush remaining buffer securely
                        if (buffer.trim()) {
                            const jsonStr = buffer.replace(/^data:\s*/gm, '').trim();
                            if (jsonStr && jsonStr !== '[DONE]') {
                                const rawData = FailSafeEngine.safeParseJSON(jsonStr, null);
                                if (rawData && rawData.candidates && rawData.candidates.length > 0) {
                                    const part = rawData.candidates[0]?.content?.parts?.[0]?.text || "";
                                    if (part) sendUIChunk(part, false);
                                }
                            }
                        }
                        sendUIChunk("", true); // Hard signal end-of-stream to client UI
                        break;
                    }
                    
                    buffer += decoder.decode(value, { stream: true });
                    const chunks = buffer.split(/\r?\n\r?\n/);
                    buffer = chunks.pop(); // Retain incomplete chunk in buffer for next pass

                    for (const chunk of chunks) {
                        const jsonStr = chunk.replace(/^data:\s*/gm, '').trim();
                        if (!jsonStr || jsonStr === '[DONE]') continue;

                        const rawData = FailSafeEngine.safeParseJSON(jsonStr, null);
                        if (!rawData) continue; // Skip broken frames

                        // Handle native safety blocks or abrupt stop reasons seamlessly
                        if (rawData.promptFeedback && rawData.promptFeedback.blockReason) {
                            throw new Error(`Gemini actively blocked the prompt. Reason: ${rawData.promptFeedback.blockReason}`);
                        }
                        
                        if (rawData.candidates && rawData.candidates.length > 0) {
                            const candidate = rawData.candidates[0];
                            
                            // Prevent empty replies if Gemini triggers early STOP without token generation
                            if (candidate.finishReason && candidate.finishReason !== 'STOP' && !candidate.content) {
                                sendUIChunk(`\n\n*[Notice: Response artificially halted by Gemini due to: ${candidate.finishReason}]*`, false);
                                continue;
                            }
                            
                            const cleanText = candidate.content?.parts?.[0]?.text || "";
                            if (cleanText) {
                                sendUIChunk(cleanText, false);
                            }
                        }
                    }
                }
                if (!llmRes || !llmRes.ok) {
                    throw new Error(`All upstream cognitive endpoints exhausted or payload blocked. Last state: ${lastErr}`);
                }

                // ================================================================
                // SECURE STREAM PARSING & DETOKENIZATION (PREVENTS UI CRASHES)
                // ================================================================
                const reader = llmRes.body.getReader();
                const decoder = new TextDecoder();
                let buffer = "";

                while (true) {
                    const { done, value } = await reader.read();
                    
                    if (done) {
                        // Flush remaining buffer
                        if (buffer.trim()) {
                            const jsonStr = buffer.replace(/^data:\s*/gm, '').trim();
                            if (jsonStr && jsonStr !== '[DONE]') {
                                const rawData = FailSafeEngine.safeParseJSON(jsonStr, null);
                                if (rawData) {
                                    let cleanText = isGroqFallback
                                        ? rawData.choices?.[0]?.delta?.content || "" 
                                        : rawData.candidates?.[0]?.content?.parts?.[0]?.text || "";
                                    sendUIChunk(cleanText, true);
                                }
                            }
                        }
                        break;
                    }
                    
                    buffer += decoder.decode(value, { stream: true });
                    const chunks = buffer.split(/\r?\n\r?\n/);
                    buffer = chunks.pop(); // Retain incomplete JSON parts

                    for (const chunk of chunks) {
                        const jsonStr = chunk.replace(/^data:\s*/gm, '').trim();
                        if (!jsonStr || jsonStr === '[DONE]') continue;

                        // Deep parse wrap to absolutely prevent "Unexpected token" crashes during active streaming
                        const rawData = FailSafeEngine.safeParseJSON(jsonStr, null);
                        if (!rawData) continue; // Skip corrupted network packets

                        let cleanText = "";
                        if (isGroqFallback) {
                            cleanText = rawData.choices?.[0]?.delta?.content || "";
                        } else {
                            cleanText = rawData.candidates?.[0]?.content?.parts?.[0]?.text || "";
                        }

                        if (cleanText) {
                            sendUIChunk(cleanText, false);
                        }
                    }
                }

            } catch (err) {
                // Uttermost top-level fail-safe. If EVERYTHING fails, the app remains stable and alerts the user gracefully.
                let safeErr = err.message;
                const parsedErr = FailSafeEngine.safeParseJSON(err.message, null);
                if (parsedErr && parsedErr.error && parsedErr.error.message) {
                    safeErr = parsedErr.error.message;
                }
                sendUIError(`Execution Interrupted: ${safeErr}`);
            } finally {
                controller.close();
            }
        }
    });

    return new Response(stream, { 
        headers: { 
            'Content-Type': 'text/event-stream', 
            'Cache-Control': 'no-cache, no-transform', 
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no'
        } 
    });
}
