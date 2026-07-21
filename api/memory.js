export const config = {
    runtime: 'edge',
};

export default async function handler(req) {
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    try {
        const { chatHistory, currentProfile } = await req.json();
        const GROQ_KEY = process.env.GROQ_API_KEY;

        if (!GROQ_KEY) return new Response(JSON.stringify({ error: 'Missing Groq Key' }), { status: 500 });

        const systemPrompt = `You are LexisAI's background psychological profiler. 
Analyze the provided chat history and the user's CURRENT profile. 
Extract any permanent, newly learned facts about the user (e.g., name, profession, coding languages, tone preferences, hobbies, location).

CRITICAL RULES:
1. Output ONLY a raw JSON object. Do not wrap in markdown \`\`\`json.
2. Merge new facts with the CURRENT profile. Do not delete old facts unless they are explicitly contradicted.
3. Keep it incredibly concise.

JSON SCHEMA:
{
  "name": "string or null",
  "profession": "string or null",
  "preferences": ["string array of tone/formatting preferences"],
  "facts": ["string array of hobbies, location, tools used"]
}`;

        const payload = {
            model: 'llama-3.1-8b-instant',
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: `CURRENT PROFILE: ${JSON.stringify(currentProfile || {})}\n\nCHAT HISTORY TO ANALYZE:\n${chatHistory}` }
            ],
            temperature: 0.1,
            response_format: { type: "json_object" }
        };

        const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        if (!res.ok) throw new Error("Groq API Failed");
        
        const data = await res.json();
        let updatedProfile = data.choices[0].message.content;

        // Strip markdown if AI hallucinates it
        updatedProfile = updatedProfile.replace(/```json/gi, '').replace(/```/g, '').trim();

        return new Response(JSON.stringify({ success: true, profile: JSON.parse(updatedProfile) }), { 
            status: 200, 
            headers: { 'Content-Type': 'application/json' } 
        });

    } catch (error) {
        return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500 });
    }
}

