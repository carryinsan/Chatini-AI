export const config = {
    runtime: 'edge',
};

export default async function handler(req) {
    // Vercel Cron Authentication Check
    const authHeader = req.headers.get('authorization');
    if (authHeader !== `Bearer ${process.env.CRON_SECRET}` && process.env.CRON_SECRET) {
        return new Response('Unauthorized Cron', { status: 401 });
    }

    try {
        const UPSTASH_URL = "https://immortal-eagle-36171.upstash.io";
        const UPSTASH_TOKEN = "AY1LAAIgcDE5MjFiMmNkNGQ4M2M0ODQ2YWNhYjU0YmFmMzlhNjliNw";
        const GROQ_KEY = process.env.GROQ_API_KEY;
        const TAVILY_KEY = process.env.TAVILY_API_KEY;

        if (!GROQ_KEY || !TAVILY_KEY) return new Response('Missing AI Keys', { status: 500 });

        // 1. Fetch all active sentinel tasks
        const activeRes = await fetch(`${UPSTASH_URL}/smembers/sentinels:active`, {
            headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}` }
        });
        const activeData = await activeRes.json();
        const activeTaskIds = activeData.result || [];

        if (activeTaskIds.length === 0) return new Response('No active sentinels', { status: 200 });

        // 2. Fetch the payloads for these tasks
        const pipeline = activeTaskIds.map(id => ["HGET", `sentinel:${id}`, "data"]);
        const payloadRes = await fetch(`${UPSTASH_URL}/pipeline`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(pipeline)
        });
        const payloadData = await payloadRes.json();

        // 3. Process each task autonomously
        for (let i = 0; i < payloadData.length; i++) {
            if (!payloadData[i].result) continue;
            
            const taskObj = JSON.parse(payloadData[i].result);
            const { taskPrompt, subscription } = taskObj;

            // A. Tavily Real-Time Search
            const tavilyRes = await fetch('https://api.tavily.com/search', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ api_key: TAVILY_KEY, query: taskPrompt, search_depth: "basic", max_results: 3 })
            });
            const tavData = await tavilyRes.json();
            const searchResults = (tavData.results || []).map(r => r.content).join('\n');

            // B. Groq Analysis: Determine if there is new/relevant info to notify the user
            const groqPrompt = `You are a Sentinel Agent. The user asked to be notified about: "${taskPrompt}".
Here is the latest web data: ${searchResults}
Analyze this data. Is there significant news, updates, or alerts the user needs right now?
Output ONLY a JSON object: {"shouldNotify": boolean, "notificationTitle": "string", "notificationBody": "string"}. Keep it short and actionable.`;

            const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: 'llama-3.1-8b-instant',
                    messages: [{ role: 'user', content: groqPrompt }],
                    temperature: 0.1,
                    response_format: { type: "json_object" }
                })
            });

            const groqData = await groqRes.json();
            const analysis = JSON.parse(groqData.choices[0].message.content);

            // C. Fire Push Notification (If triggered)
            if (analysis.shouldNotify) {
                // Note: Standard Web Push requires VAPID keys. 
                // For edge execution, we relay to a standard Push Service endpoint.
                const pushPayload = JSON.stringify({ title: analysis.notificationTitle, body: analysis.notificationBody });
                
                await fetch(subscription.endpoint, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/octet-stream' }, // Standard for raw web push without VAPID libraries in Edge
                    body: pushPayload
                }).catch(() => {}); // Silent fail if user revoked push access
            }
        }

        return new Response('Cron executed successfully', { status: 200 });

    } catch (error) {
        return new Response(error.message, { status: 500 });
    }
}

