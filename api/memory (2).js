export const config = {
    runtime: 'edge',
};

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

export default async function handler(req) {
    if (req.method !== 'POST') {
        return new Response(
            JSON.stringify({
                success: false,
                error: 'Method Not Allowed'
            }),
            {
                status: 405,
                headers: {
                    'Content-Type': 'application/json',
                    'Allow': 'POST'
                }
            }
        );
    }

    try {
        // ------------------------------------------------------------
        // 1. Validate request body safely
        // ------------------------------------------------------------
        let body;

        try {
            body = await req.json();
        } catch {
            return jsonResponse(
                {
                    success: false,
                    error: 'Invalid JSON request body'
                },
                400
            );
        }

        const {
            chatHistory = '',
            currentProfile = {}
        } = body || {};

        if (
            typeof chatHistory !== 'string' &&
            !Array.isArray(chatHistory)
        ) {
            return jsonResponse(
                {
                    success: false,
                    error: 'chatHistory must be a string or array'
                },
                400
            );
        }

        // ------------------------------------------------------------
        // 2. Read Groq key
        // ------------------------------------------------------------
        const GROQ_KEY = process.env.GROQ_API_KEY;

        if (!GROQ_KEY || typeof GROQ_KEY !== 'string') {
            console.error('[memory] GROQ_API_KEY is missing');
            return jsonResponse(
                {
                    success: false,
                    error: 'Memory service is not configured'
                },
                500
            );
        }

        // ------------------------------------------------------------
        // 3. Normalize history
        // ------------------------------------------------------------
        const normalizedHistory = Array.isArray(chatHistory)
            ? chatHistory
                .map(item => {
                    if (typeof item === 'string') return item;

                    try {
                        return JSON.stringify(item);
                    } catch {
                        return '';
                    }
                })
                .filter(Boolean)
                .join('\n')
            : chatHistory;

        // Prevent accidentally sending an enormous memory request.
        // Keep the most recent portion because memory extraction mainly
        // needs the latest conversation context.
        const MAX_HISTORY_CHARS = 40000;

        const trimmedHistory =
            normalizedHistory.length > MAX_HISTORY_CHARS
                ? normalizedHistory.slice(-MAX_HISTORY_CHARS)
                : normalizedHistory;

        // ------------------------------------------------------------
        // 4. System prompt
        // ------------------------------------------------------------
        const systemPrompt = `
You are LexisAI's background memory extractor.

Analyze the provided chat history and the user's current profile.

Extract ONLY durable, useful user information such as:
-user interest
-user's every information that personalises the ai for the user
- name
- profession
- stable interests
- coding languages/tools
- persistent hobbies
- stable location information
- communication/tone preferences
-and more that you think should be stored

Do NOT store:
- temporary requests
- one-time questions
- passwords
- API keys
- authentication secrets
- highly sensitive personal information
- speculative information
- psychological diagnoses
- inferred private traits

RULES:
1. Return ONLY a valid JSON object.
2. Merge new information with the current profile.
3. Never intentionally delete existing facts unless clearly contradicted.
4. Do not invent missing information.
5. Keep the result concise.
6. Use null when a scalar value is unknown.
7. Use arrays for preferences and facts.

JSON SCHEMA:
{
  "name": "string or null",
  "profession": "string or null",
  "preferences": ["string"],
  "facts": ["string"]
}
`.trim();

        // ------------------------------------------------------------
        // 5. Build Groq request
        // ------------------------------------------------------------
        const payload = {
            model: 'openai/gpt-oss-20b',
            messages: [
                {
                    role: 'system',
                    content: systemPrompt
                },
                {
                    role: 'user',
                    content:
                        `CURRENT PROFILE:\n${safeStringify(currentProfile)}\n\n` +
                        `CHAT HISTORY:\n${trimmedHistory || '(empty)'}`
                }
            ],
            temperature: 0.1,
            response_format: {
                type: 'json_object'
            },
            include_reasoning: false
        };

        // ------------------------------------------------------------
        // 6. Call Groq
        // ------------------------------------------------------------
        const res = await fetch(GROQ_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${GROQ_KEY}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(payload)
        });

        // ------------------------------------------------------------
        // 7. Read response safely
        // ------------------------------------------------------------
        const responseText = await res.text();

        if (!res.ok) {
            console.error('[memory] Groq HTTP error:', {
                status: res.status,
                body: responseText.slice(0, 4000)
            });

            return jsonResponse(
                {
                    success: false,
                    error: `Groq API returned HTTP ${res.status}`,
                    provider_status: res.status,
                    details: safeProviderError(responseText)
                },
                502
            );
        }

        let data;

        try {
            data = JSON.parse(responseText);
        } catch (error) {
            console.error(
                '[memory] Groq returned invalid JSON:',
                responseText.slice(0, 4000)
            );

            return jsonResponse(
                {
                    success: false,
                    error: 'Groq returned an invalid response'
                },
                502
            );
        }

        // ------------------------------------------------------------
        // 8. Validate completion shape
        // ------------------------------------------------------------
        const content =
            data?.choices?.[0]?.message?.content;

        if (typeof content !== 'string' || !content.trim()) {
            console.error(
                '[memory] Missing model content:',
                JSON.stringify(data).slice(0, 4000)
            );

            return jsonResponse(
                {
                    success: false,
                    error: 'Groq returned no memory content'
                },
                502
            );
        }

        // ------------------------------------------------------------
        // 9. Parse model JSON robustly
        // ------------------------------------------------------------
        const cleaned = content
            .replace(/^```json\s*/i, '')
            .replace(/^```\s*/i, '')
            .replace(/\s*```$/i, '')
            .trim();

        let updatedProfile;

        try {
            updatedProfile = JSON.parse(cleaned);
        } catch (error) {
            console.error(
                '[memory] Model returned invalid JSON:',
                cleaned.slice(0, 4000)
            );

            return jsonResponse(
                {
                    success: false,
                    error: 'Memory model returned invalid JSON'
                },
                502
            );
        }

        // ------------------------------------------------------------
        // 10. Normalize output
        // ------------------------------------------------------------
        updatedProfile = {
            name:
                typeof updatedProfile?.name === 'string'
                    ? updatedProfile.name
                    : null,

            profession:
                typeof updatedProfile?.profession === 'string'
                    ? updatedProfile.profession
                    : null,

            preferences:
                Array.isArray(updatedProfile?.preferences)
                    ? updatedProfile.preferences
                        .filter(item => typeof item === 'string')
                        .slice(0, 50)
                    : [],

            facts:
                Array.isArray(updatedProfile?.facts)
                    ? updatedProfile.facts
                        .filter(item => typeof item === 'string')
                        .slice(0, 100)
                    : []
        };

        return jsonResponse(
            {
                success: true,
                profile: updatedProfile
            },
            200
        );

    } catch (error) {
        console.error('[memory] Unexpected server error:', error);

        return jsonResponse(
            {
                success: false,
                error: 'Memory processing failed',
                details:
                    error instanceof Error
                        ? error.message
                        : String(error)
            },
            500
        );
    }
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------

function jsonResponse(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-store'
        }
    });
}

function safeStringify(value) {
    try {
        return JSON.stringify(value ?? {});
    } catch {
        return '{}';
    }
}

function safeProviderError(text) {
    try {
        const parsed = JSON.parse(text);

        return (
            parsed?.error?.message ||
            parsed?.error?.code ||
            parsed?.message ||
            'Provider request failed'
        );
    } catch {
        return text.slice(0, 1000) || 'Provider request failed';
    }
}
