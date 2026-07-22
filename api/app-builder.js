export const config = {
  runtime: 'edge',
};

async function callGemini(systemPrompt, userPrompt) {
  const rawKeys = [
    process.env.GEMINI_API_KEY_1, process.env.GEMINI_API_KEY_2, 
    process.env.GEMINI_API_KEY_3, process.env.GEMINI_API_KEY
  ];
  const keys = rawKeys.map(k => k ? k.replace(/[\r\n\s]/g, '') : null).filter(Boolean);
  if (keys.length === 0) throw new Error("No Gemini keys found.");

  let lastError = null;
  for (const key of keys) {
    try {
      const res = await fetch(`[https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=$](https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=$){key}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: "user", parts: [{ text: userPrompt }] }],
          generationConfig: { temperature: 0.3 }
        })
      });

      const data = await res.json();
      if (data.error) throw new Error(data.error.message);
      
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error("Empty payload.");
      return text;
    } catch (err) { lastError = err; }
  }
  throw new Error(`All keys failed. Last error: ${lastError?.message}`);
}

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  try {
    const { prompt } = await req.json();
    if (!prompt) throw new Error("No prompt provided.");

    const systemPrompt = `You are LexisAI, an elite Frontend Engineer.
    TASK: Build an interactive web widget, game, or tool based on the user's prompt.
    
    RULES:
    1. Include Tailwind CSS via CDN (<script src="[https://cdn.tailwindcss.com](https://cdn.tailwindcss.com)"></script>).
    2. Include all necessary HTML, CSS, and JS in this ONE file.
    3. Make it visually stunning, dark-mode preferred, with neon accents.
    4. OUTPUT ONLY the raw <!DOCTYPE html> string. Do not wrap in markdown blocks.`;

    let htmlOutput = await callGemini(systemPrompt, `Build this app: ${prompt}`);
    
    // Aggressive markdown block removal (fixes HTML iFrame rendering)
    htmlOutput = htmlOutput.replace(/```html/gi, '').replace(/```/g, '').trim();

    return new Response(JSON.stringify({ success: true, html: htmlOutput }), { status: 200 });
  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500 });
  }
}
