export const config = {
    runtime: 'edge',
};

// ============================================================================
// LEXIS-AI EXTENSION INTERCEPTOR & MEMORY ROUTER
// Autonomous evaluation of existing memory, deep web scraping, and 
// low-token Groq tagging for automated Knowledge Extension creation.
// ============================================================================

export default async function handler(req) {
    // Restrict to POST requests for secure payload transmission
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    try {
        // Expected payload from the frontend
        const { query, extensions = [] } = await req.json();

        const TAVILY_KEY = process.env.TAVILY_API_KEY;
        const GROQ_KEY = process.env.GROQ_API_KEY;

        if (!TAVILY_KEY || !GROQ_KEY) {
            return new Response(JSON.stringify({ success: false, error: "Missing required API keys (Tavily/Groq) in environment variables." }), { status: 400 });
        }

        let finalContext = "";
        let newExtensionToSave = null;
        let memorySufficient = false;

        // ====================================================================
        // PHASE 1: SMART MEMORY ROUTING (GROQ)
        // Check if our existing Extension database already knows the answer.
        // ====================================================================
        if (extensions && extensions.length > 0) {
            // Step 1A: Extract ONLY names/tags to prevent Groq token explosion
            const tagList = extensions.map((ext, i) => `[ID: ${i}] Tag: ${ext.name}`).join('\n');
            
            const routePrompt = `You are a LexisAI Memory Router.
User Query: "${query}"

Available Knowledge Clusters:
${tagList}

Does any cluster seem highly relevant to the query?
If YES, output ONLY the ID number (e.g., 0).
If NO, output ONLY "SEARCH".`;

            const routeRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: 'llama-3.1-8b-instant',
                    messages: [{ role: 'user', content: routePrompt }],
                    temperature: 0.1
                })
            });

            if (routeRes.ok) {
                const routeData = await routeRes.json();
                const routeDecision = routeData.choices[0].message.content.trim();

                // If Groq found a matching extension, we evaluate its content
                if (routeDecision !== "SEARCH" && !isNaN(parseInt(routeDecision))) {
                    const extId = parseInt(routeDecision);
                    
                    if (extensions[extId]) {
                        const candidateMemory = extensions[extId].content || "";

                        // Step 1B: CONTENT ADEQUACY CHECK
                        // Truncate to ~15,000 chars to guarantee we stay under Groq's 8k token limit
                        const safeContent = candidateMemory.substring(0, 15000);
                        const adequacyPrompt = `You are a Data Evaluator for LexisAI.
User Query: "${query}"

Data Source Snippet:
${safeContent}

Does this Data Source contain SUFFICIENT and COMPLETE information to perfectly answer the User Query?
If it lacks detail, requires updated info, or is missing data, output NO.
Otherwise, output YES. Output ONLY "YES" or "NO".`;

                        const adequacyRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                            method: 'POST',
                            headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                model: 'llama-3.1-8b-instant',
                                messages: [{ role: 'user', content: adequacyPrompt }],
                                temperature: 0.1
                            })
                        });

                        if (adequacyRes.ok) {
                            const adequacyData = await adequacyRes.json();
                            const isAdequate = adequacyData.choices[0].message.content.trim().toUpperCase();
                            
                            if (isAdequate.includes("YES")) {
                                memorySufficient = true;
                                finalContext = candidateMemory;
                                console.log("[Interceptor] Memory hit. Bypassing Tavily search.");
                            }
                        }
                    }
                }
            }
        }

        // ====================================================================
        // PHASE 2: TAVILY DEEP SEARCH (Fallback Triggered)
        // Executes if memory was missing, failed the adequacy test, or is empty.
        // ====================================================================
        if (!memorySufficient) {
            console.log("[Interceptor] Memory insufficient. Executing Tavily deep sweep.");
            
            const tavilyRes = await fetch('https://api.tavily.com/search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    api_key: TAVILY_KEY,
                    query: query,
                    search_depth: "advanced",
                    max_results: 15, // High depth for complex knowledge building
                    include_answer: true
                })
            });

            if (!tavilyRes.ok) throw new Error("Tavily Search API Failed.");
            const tavData = await tavilyRes.json();

            let compiledContent = "";
            const titlesOnly = []; // Isolated for Groq Token protection
            const links = [];

            tavData.results.forEach(r => {
                compiledContent += `[Title: ${r.title}]\n[URL: ${r.url}]\n${r.content}\n\n`;
                titlesOnly.push(r.title);
                // Pre-format the link object exactly as the UI expects it for extensions
                links.push({ 
                    url: r.url, 
                    status: 'Loaded ✅', 
                    text: r.content.substring(0, 5000) 
                });
            });

            finalContext = compiledContent;

            // ====================================================================
            // PHASE 3: ANTI-EXPLOSION CLUSTER TAGGING (GROQ)
            // Sending ONLY the raw titles to Groq to completely prevent token crashes.
            // ====================================================================
            const tagPrompt = `You are a Data Classifier for LexisAI.
Generate a highly descriptive, premium-sounding 2 to 4 word tag for this knowledge cluster so the AI can easily reference it later.
User Query: "${query}"

Scraped Titles:
${titlesOnly.slice(0, 10).join('\n')}

Output EXACTLY the tag name. No quotes, no markdown, no filler words.`;

            let clusterTag = "Deep Web Research"; // Fallback tag
            try {
                const tagRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        model: 'llama-3.1-8b-instant',
                        messages: [{ role: 'user', content: tagPrompt }],
                        temperature: 0.3
                    })
                });
                
                if (tagRes.ok) {
                    const tagData = await tagRes.json();
                    clusterTag = tagData.choices[0].message.content.trim().replace(/["']/g, '');
                }
            } catch(e) {
                console.error("[Interceptor] Groq tagging failed, defaulting tag.");
            }

            // Construct the immaculate Extension Object
            newExtensionToSave = {
                id: 'ext_' + Date.now().toString(36),
                name: clusterTag,
                links: links,
                files: [], // Kept empty as this is purely a web scrape cluster
                content: compiledContent
            };
        }

        // ====================================================================
        // FINAL PAYLOAD DELIVERY
        // ====================================================================
        return new Response(JSON.stringify({
            success: true,
            source: memorySufficient ? "memory" : "tavily",
            context: finalContext,
            // Will be null if memory was sufficient, otherwise contains the new Extension object
            extensionToSave: newExtensionToSave 
        }), {
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (error) {
        return new Response(JSON.stringify({ success: false, error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}

