export const config = {
  runtime: 'edge',
};

export default async function handler(req) {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      // Formats chunks to match the Lexis Mega-Payload expected by the frontend parser
      const sendUIChunk = (textString) => {
        const chunk = JSON.stringify({ candidates: [{ content: { parts: [{ text: textString }] } }] });
        controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
      };
      
      const sendError = (msg) => {
        const chunk = JSON.stringify({ ui_error: msg });
        controller.enqueue(encoder.encode(`data: ${chunk}\n\n`));
        controller.close();
      };

      try {
        const { prompt } = await req.json();
        const GROQ_KEY = process.env.GROQ_API_KEY;
        const GEMINI_KEYS = [
          process.env.GEMINI_API_KEY_1,
          process.env.GEMINI_API_KEY_2,
          process.env.GEMINI_API_KEY_3
        ].filter(Boolean);

        if (!GROQ_KEY || GEMINI_KEYS.length === 0) return sendError("Missing required API keys.");

        // ==========================================
        // PASS 1: GROQ UI ARCHITECT (JSON SKELETON)
        // ==========================================
        const groqPrompt = `You are LexisAI's UI/UX Architect. Analyze the user query and design a structural Tailwind CSS HTML skeleton perfectly suited for the response. 
        Output STRICTLY a JSON object with no markdown:
        {
          "topHtml": "<div class='bg-gray-50 border border-gray-200 rounded-2xl p-6 shadow-sm'>\\n<h2 class='text-xl font-bold text-gray-900 mb-4 flex items-center gap-2'><i class='ph-bold ph-layout'></i> Generated View</h2>\\n<div class='prose prose-sm text-gray-700 max-w-none'>",
          "bottomHtml": "</div>\\n</div>",
          "geminiInstruction": "Specific instruction for the AI content writer based on the prompt."
        }`;

        const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${GROQ_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: 'llama-3.3-70b-versatile',
            response_format: { type: "json_object" },
            temperature: 0.1,
            messages: [
              { role: 'system', content: groqPrompt },
              { role: 'user', content: prompt }
            ]
          })
        });

        if (!groqRes.ok) throw new Error("Pass 1: Groq Architecture Failed.");
        const groqData = await groqRes.json();
        const rawJson = groqData.choices[0].message.content.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
        const uiSkeleton = JSON.parse(rawJson);

        // Instantly render the top half of the structural UI
        if (uiSkeleton.topHtml) sendUIChunk(uiSkeleton.topHtml);

        // ==========================================
        // PASS 2: GEMINI CONTENT STREAMING
        // ==========================================
        const geminiPayload = {
          systemInstruction: { parts: [{ text: uiSkeleton.geminiInstruction || "Provide a detailed, helpful response." }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { maxOutputTokens: 8192, temperature: 0.3 }
        };

        let geminiRes = null;
        let lastErr = "";
        
        // Key Rotation Loop
        for (const key of GEMINI_KEYS) {
          geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:streamGenerateContent?alt=sse&key=${key}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(geminiPayload)
          });
          if (geminiRes.ok) break;
          lastErr = await geminiRes.text();
        }

        if (!geminiRes || !geminiRes.ok) throw new Error(`Pass 2: Gemini Execution Failed. ${lastErr}`);

        const reader = geminiRes.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split(/\r\n\r\n/);
          buffer = chunks.pop();

          for (const chunk of chunks) {
            const jsonStr = chunk.replace(/^data:\s*/gm, '').trim();
            if (!jsonStr || jsonStr === '[DONE]') continue;
            
            try {
              const data = JSON.parse(jsonStr);
              const textChunk = data.candidates?.[0]?.content?.parts?.[0]?.text;
              if (textChunk) sendUIChunk(textChunk);
            } catch (e) {
              // Gracefully handle partial chunk breaks
            }
          }
        }

        // Close the structural UI wrapper
        if (uiSkeleton.bottomHtml) sendUIChunk(uiSkeleton.bottomHtml);

      } catch (err) {
        sendError(`[Dynamic UI Fault] ${err.message}`);
      } finally {
        controller.close();
      }
    }
  });

  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' }
  });
}
