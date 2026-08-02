export const config = { runtime: 'edge' };

export default async function handler(req) {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    try {
        const { prompt, clientTime, timeZone } = await req.json();
        
        // Use Groq for ultra-fast, cheap logic parsing
        const GROQ_KEY = process.env.GROQ_API_KEY ? process.env.GROQ_API_KEY.replace(/[\r\n\s]/g, '') : null;
        if (!GROQ_KEY) throw new Error("Missing Groq API Key");

        const systemPrompt = `You are a strict, hyper-intelligent time-parsing Sentinel Agent. 
        The user's current local timestamp is ${clientTime} (Unix MS). Their Timezone is: ${timeZone}.
        Your job is to read their request, extract the exact task description, and calculate the exact future Unix timestamp in milliseconds for when it should trigger.
        If they do not specify a time, default to 1 hour from the current timestamp.
        Output STRICTLY valid JSON with no markdown:
        {"task": "Exact task to remind them of", "timestamp": 1718293829000}`;

        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
                model: 'llama-3.1-8b-instant',
                response_format: { type: "json_object" },
                temperature: 0.1,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: prompt }
                ]
            })
        });

        if (!res.ok) throw new Error("Groq API parsing failed");

        const data = await res.json();
        const parsed = JSON.parse(data.choices[0].message.content);
        
        return new Response(JSON.stringify({ success: true, task: parsed.task, timestamp: parsed.timestamp }), { 
            status: 200, 
            headers: { 'Content-Type': 'application/json' } 
        });

    } catch (e) {
        return new Response(JSON.stringify({ success: false, error: e.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
    }
                                            }
