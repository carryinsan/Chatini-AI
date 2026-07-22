export const config = {
  runtime: 'edge',
};
function extractJSON(str) {
  try {
    let clean = str.replace(/```json/gi, '').replace(/```/g, '').trim();
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    return JSON.parse(clean.substring(start, end + 1));
  } catch (e) {
    return { nodes: [], links: [] };
  }
}
export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  try {
    const { chatHistory } = await req.json();
    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    if (!OPENROUTER_API_KEY) throw new Error("OpenRouter API key missing.");
    // Compress chat history for speed and payload safety
    const compressedHistory = chatHistory.slice(-30).map(m => `${m.role}: ${m.content}`).join('\n').substring(0, 40000);
    const systemPrompt = `You are LexisAI's Neural Core. Your job is to map the user's brain.
    NEVER mention OpenAI, Google, Anthropic, or any other AI name.
    
    TASK: Analyze the chat history and extract facts, projects, preferences, and skills about the user.
    Convert them into a 2D knowledge graph structure.
    
    OUTPUT FORMAT: You MUST output ONLY raw JSON. No markdown.
    SCHEMA:
    {
      "nodes": [
        { "id": "python", "label": "Python", "group": "skill" },
        { "id": "lexis", "label": "Building LexisAI", "group": "project" },
        { "id": "darkmode", "label": "Prefers Dark Mode", "group": "preference" }
      ],
      "links": [
        { "source": "lexis", "target": "python", "label": "uses" },
        { "source": "lexis", "target": "darkmode", "label": "designed in" }
      ]
    }`;
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://chatini-ai.vercel.app",
        "X-Title": "LexisAI"
      },
      body: JSON.stringify({
        model: "google/gemini-2.5-flash",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Map this history:\n\n${compressedHistory}` }
        ],
        temperature: 0.1,
        response_format: { type: "json_object" }
      })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    const constellationData = extractJSON(data.choices[0].message.content);
    return new Response(JSON.stringify({ success: true, data: constellationData }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), { 
      status: 500, headers: { 'Content-Type': 'application/json' } 
    });
  }
}
