export const config = {
  runtime: 'edge',
};
export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  try {
    const { prompt } = await req.json();
    const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
    if (!OPENROUTER_API_KEY) throw new Error("OpenRouter API key missing.");
    const systemPrompt = `You are LexisAI, an elite Frontend Engineer.
    NEVER mention OpenAI, Google, Anthropic, or any other AI name. You are LexisAI.
    
    TASK: The user wants to build an interactive web widget, game, or tool.
    You must generate a COMPLETE, self-contained HTML file.
    
    RULES:
    1. Include Tailwind CSS via CDN (<script src="https://cdn.tailwindcss.com"></script>).
    2. Include all necessary HTML, CSS, and JS in this ONE file.
    3. Make it visually stunning, dark-mode preferred, with neon accents.
    4. DO NOT wrap the output in markdown code blocks (\`\`\`html). Output ONLY the raw <!DOCTYPE html> string.
    5. The app must be fully functional and interactive.`;
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
          { role: "user", content: `Build this app: ${prompt}` }
        ],
        temperature: 0.3
      })
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    let htmlOutput = data.choices[0].message.content;
    // Strip markdown formatting if the AI disobeys
    htmlOutput = htmlOutput.replace(/^```html/gi, '').replace(/```$/g, '').trim();
    return new Response(JSON.stringify({ success: true, html: htmlOutput }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), { 
      status: 500, headers: { 'Content-Type': 'application/json' } 
    });
  }
}
