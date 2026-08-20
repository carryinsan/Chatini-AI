export const config = {
    runtime: 'edge',
};

// Recognized Lexis Pulse Categories
const ALLOWED_TYPES = new Set(['DO', 'DECIDE', 'REMEMBER', 'REPLY']);
const CONFIDENCE_THRESHOLD = 0.85;

/**
 * Sanitizes and validates extracted items against strict safety rules.
 */
function validateAndSanitizeItems(rawItems, existingTasks = [], conversationId = 'current_session') {
    if (!Array.isArray(rawItems)) return [];

    const sanitized = [];

    for (const item of rawItems) {
        if (!item || typeof item !== 'object') continue;

        // 1. Strict Category Validation
        const type = String(item.type || '').toUpperCase().trim();
        if (!ALLOWED_TYPES.has(type)) continue;

        // 2. Strict Title Validation & Length Limit
        let title = String(item.title || '').replace(/[\r\n]+/g, ' ').replace(/[<>&]/g, '').trim();
        if (!title || title.length < 2) continue;
        if (title.length > 80) title = title.substring(0, 77) + '...';

        // 3. Confidence Threshold Check (Must be >= 0.85)
        const confidence = typeof item.confidence === 'number' ? item.confidence : parseFloat(item.confidence || 0);
        if (isNaN(confidence) || confidence < CONFIDENCE_THRESHOLD) continue;

        // 4. Strict Due Date Validation (YYYY-MM-DD or null - NO INFERRED DEADLINES)
        let due = null;
        if (item.due && typeof item.due === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(item.due.trim())) {
            due = item.due.trim();
        }

        // 5. Duplicate Protection Engine
        const isDuplicate = existingTasks.some(existing => {
            if (!existing || typeof existing !== 'object') return false;
            const sameType = existing.type === type;
            const sameDue = (existing.due || null) === due;
            const existingTitle = String(existing.title || '').toLowerCase();
            const currentTitle = title.toLowerCase();

            // Exact match or high substring similarity
            const titleMatch = existingTitle === currentTitle ||
                (existingTitle.length > 5 && currentTitle.includes(existingTitle)) ||
                (currentTitle.length > 5 && existingTitle.includes(currentTitle));

            return sameType && titleMatch && sameDue;
        });

        if (isDuplicate) continue;

        // 6. Build Immutable Safe Object
        sanitized.push({
            id: 'pulse_' + Math.random().toString(36).substring(2, 11) + '_' + Date.now(),
            type,
            title,
            due,
            confidence: Number(confidence.toFixed(2)),
            source: conversationId,
            context: item.context ? String(item.context).substring(0, 120) : null,
            status: 'suggested', // 'suggested' | 'confirmed' | 'completed' | 'dismissed'
            createdAt: new Date().toISOString()
        });
    }

    return sanitized;
}

export default async function handler(req) {
    if (req.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), {
            status: 405,
            headers: { 'Content-Type': 'application/json' }
        });
    }

    try {
        const body = await req.json();
        const {
            message,
            conversationId = 'current_session',
            existingTasks = [],
            userTime, // Client ISO string (e.g., "2026-08-20T18:20:00.000Z")
            userTimezone // Client timezone (e.g., "Asia/Kolkata")
        } = body;

        if (!message || typeof message !== 'string' || message.trim().length === 0) {
            return new Response(JSON.stringify({ hasSuggestions: false, items: [] }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // Setup Device Reference Time
        const deviceNow = userTime ? new Date(userTime) : new Date();
        const referenceDateStr = deviceNow.toISOString().split('T')[0]; // "YYYY-MM-DD"
        const dayOfWeekStr = deviceNow.toLocaleDateString('en-US', { weekday: 'long', timeZone: userTimezone || 'UTC' });

        // Collect Server Keys
        const GEMINI_KEYS = [
            process.env.GEMINI_API_KEY_1,
            process.env.GEMINI_API_KEY_2,
            process.env.GEMINI_API_KEY_3,
            process.env.GEMINI_API_KEY
        ].filter(Boolean).map(k => k.replace(/[\r\n\s]/g, ''));

        const GROQ_KEYS = [
            process.env.GROQ_API_KEY,
            process.env.GROQ_KEY_2
        ].filter(Boolean).map(k => k.replace(/[\r\n\s]/g, ''));

        const systemPrompt = `You are Lexis Pulse, an intelligent, high-precision background extraction engine.
Analyze the user's message for explicit tasks, decisions, facts to remember, or replies needed.

CURRENT REFERENCE TIME (CRITICAL GROUNDING):
- Device Date: ${referenceDateStr} (${dayOfWeekStr})
- Timezone: ${userTimezone || 'UTC'}

STRICT EXTRACTION CATEGORIES (ONLY THESE 4 ALLOWED):
1. "DO": An actionable task or commitment the user needs to perform (e.g. "Finish chapter 6", "Submit report").
2. "DECIDE": A choice or decision requiring resolution (e.g. "Choose presentation topic").
3. "REMEMBER": Crucial information, date, or event to retain (e.g. "Chemistry exam on Tuesday").
4. "REPLY": A communication step requiring a response to someone (e.g. "Reply to Alex about meeting").

CRITICAL CONSTRAINTS:
- IF NO explicit task/action/event/decision is mentioned, return "hasSuggestions": false and empty "items": [].
- DO NOT extract from general knowledge questions (e.g., "What is photosynthesis?", "Explain quantum physics").
- NEVER invent or infer a due date unless explicitly stated or directly calculable from reference date (${referenceDateStr}). If no date mentioned, set "due": null.
- Assign a confidence score from 0.00 to 1.00. Set confidence < 0.85 if uncertain.

OUTPUT ONLY VALID JSON WITH THIS STRICT SCHEMA:
{
  "hasSuggestions": boolean,
  "items": [
    {
      "type": "DO" | "DECIDE" | "REMEMBER" | "REPLY",
      "title": "Short, clear title (max 60 chars)",
      "due": "YYYY-MM-DD" | null,
      "confidence": number,
      "context": "Short 1-line quote from user text"
    }
  ]
}`;

        let extractedPayload = null;

        // 1. Primary Attempt: Gemini API
        if (GEMINI_KEYS.length > 0) {
            for (const key of GEMINI_KEYS) {
                try {
                    const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            contents: [{ role: 'user', parts: [{ text: `Analyze this user input:\n"${message.substring(0, 1000)}"` }] }],
                            systemInstruction: { parts: [{ text: systemPrompt }] },
                            generationConfig: {
                                responseMimeType: "application/json",
                                temperature: 0.1
                            }
                        })
                    });

                    if (geminiRes.ok) {
                        const data = await geminiRes.json();
                        const jsonText = data.candidates?.[0]?.content?.parts?.[0]?.text;
                        if (jsonText) {
                            extractedPayload = JSON.parse(jsonText);
                            break;
                        }
                    }
                } catch (e) {
                    // Fallthrough to next key or provider
                }
            }
        }

        // 2. Secondary Fallback: Groq API
        if (!extractedPayload && GROQ_KEYS.length > 0) {
            for (const key of GROQ_KEYS) {
                try {
                    const groqRes = await fetch('https://api.groq.com/openai/v1/chat/completions', {
                        method: 'POST',
                        headers: {
                            'Authorization': `Bearer ${key}`,
                            'Content-Type': 'application/json'
                        },
                        body: JSON.stringify({
                            model: 'llama-3.3-70b-versatile',
                            response_format: { type: "json_object" },
                            temperature: 0.1,
                            messages: [
                                { role: 'system', content: systemPrompt },
                                { role: 'user', content: message.substring(0, 1000) }
                            ]
                        })
                    });

                    if (groqRes.ok) {
                        const data = await groqRes.json();
                        const jsonText = data.choices?.[0]?.message?.content;
                        if (jsonText) {
                            extractedPayload = JSON.parse(jsonText);
                            break;
                        }
                    }
                } catch (e) {}
            }
        }

        // Handle failure or empty response
        if (!extractedPayload || !extractedPayload.hasSuggestions || !Array.isArray(extractedPayload.items)) {
            return new Response(JSON.stringify({ hasSuggestions: false, items: [] }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });
        }

        // Pass through Sanitization, Confidence Check & Deduplication
        const sanitizedItems = validateAndSanitizeItems(extractedPayload.items, existingTasks, conversationId);

        return new Response(JSON.stringify({
            hasSuggestions: sanitizedItems.length > 0,
            items: sanitizedItems,
            referenceDate: referenceDateStr
        }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });

    } catch (err) {
        return new Response(JSON.stringify({
            hasSuggestions: false,
            items: [],
            error: err.message
        }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' }
        });
    }
}
