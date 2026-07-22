export const config = {
  runtime: 'edge',
};
// ============================================================================
// [ HYPER-RESILIENT JSON SANITIZER ]
// ============================================================================
function extractJSON(str) {
  try {
    let clean = str.replace(/```json/gi, '').replace(/```/g, '').trim();
    const start = clean.indexOf('{');
    const end = clean.lastIndexOf('}');
    return JSON.parse(clean.substring(start, end + 1));
  } catch (e) {
    return { title: "Audio Generation Failed", script: [{ host: "A", text: "I'm sorry, the document was too complex to process into audio." }] };
  }
}
export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  try {
    const { textContext } = await req.json();
    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    if (!OPENROUTER_API_KEY) throw new Error("OpenRouter API key missing.");
    if (!textContext) throw new Error("No text provided for podcast generation.");
    // Prevent Vercel Payload crashes (Cap at 80,000 characters)
    const safeContext = textContext.length > 80000 ? textContext.substring(0, 80000) + "...[TRUNCATED]" : textContext;
    const systemPrompt = `You are LexisAI, an advanced Neural Podcast Producer.
    NEVER mention OpenAI, Google, Anthropic, or any other AI name. You are purely LexisAI.
    
    TASK: Convert the provided text into a highly engaging, witty, and easy-to-understand 2-Host Podcast Script.
    Host A: The curious, energetic learner who asks great questions.
    Host B: The witty, deep expert who explains things simply.
    
    OUTPUT FORMAT: You MUST output ONLY raw JSON. No markdown. No introductory text.
    SCHEMA:
    {
      "title": "A catchy title for this audio session",
      "script": [
        { "host": "A", "text": "Wow, so what exactly is going on here?" },
        { "host": "B", "text": "It's simple! Think of it like..." }
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
          { role: "user", content: `DOCUMENT CONTENT:\n\n${safeContext}` }
        ],
        temperature: 0.7,
        response_format: { type: "json_object" }
      })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    const rawText = data.choices[0].message.content;
    const podcastData = extractJSON(rawText);
    return new Response(JSON.stringify({ success: true, data: podcastData }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), { 
      status: 500, headers: { 'Content-Type': 'application/json' } 
    });
  }
}
