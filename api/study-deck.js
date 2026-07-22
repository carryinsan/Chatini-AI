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
    return { deckName: "Error", cards: [] };
  }
}
export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  try {
    const { textContext } = await req.json();
    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    if (!OPENROUTER_API_KEY) throw new Error("OpenRouter API key missing.");
    
    // Safety truncation for massive documents
    const safeContext = textContext.length > 80000 ? textContext.substring(0, 80000) + "...[TRUNCATED]" : textContext;
    const systemPrompt = `You are LexisAI, an elite Academic Tutor.
    NEVER mention OpenAI, Google, Anthropic, or any other AI name. You are LexisAI.
    
    TASK: Convert the provided material into a high-yield Study Deck.
    Extract the most important facts, definitions, and concepts.
    
    OUTPUT FORMAT: You MUST output ONLY raw JSON. No markdown.
    SCHEMA:
    {
      "deckName": "Name of the topic",
      "cards": [
        { "q": "Question text here?", "a": "Clear, concise answer here.", "hint": "A subtle hint for the user." }
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
          { role: "user", content: `Create flashcards from this:\n\n${safeContext}` }
        ],
        temperature: 0.2,
        response_format: { type: "json_object" }
      })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    const deckData = extractJSON(data.choices[0].message.content);
    return new Response(JSON.stringify({ success: true, data: deckData }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), { 
      status: 500, headers: { 'Content-Type': 'application/json' } 
    });
  }
}
