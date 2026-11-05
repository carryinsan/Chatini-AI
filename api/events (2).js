/**
 * Vercel Serverless Function: /api/events
 * Proactive Event Ingestion, Deduplication, & Semantic Evaluation Engine
 */

// Cache for in-memory event deduplication across short-lived invocations
const eventCache = new Map();
const DEDUPLICATION_WINDOW_MS = 60000; // 1 minute window

// Recognized event types
const ALLOWED_EVENT_TYPES = new Set([
  "page_alert_detected",
  "price_drop",
  "stock_change",
  "email_received",
  "calendar_conflict",
  "task_state_change",
  "custom_trigger"
]);

// Helper: Collect available API keys from environment variables
function getGeminiApiKeys() {
  return [
    process.env.GEMINI_API_KEY,
    process.env.GEMINI_API_KEY_1,
    process.env.GEMINI_API_KEY_2,
    process.env.GEMINI_API_KEY_3,
    process.env.GEMINI_API_KEY_4,
    process.env.GEMINI_API_KEY_5,
    process.env.GEMINI_API_KEY_6,
    process.env.GEMINI_API_KEY_7,
    process.env.GEMINI_API_KEY_8,
    process.env.GEMINI_API_KEY_9
  ].filter((k) => typeof k === "string" && k.trim().length > 0);
}

function getGroqApiKeys() {
  return [
    process.env.GROQ_API_KEY,
    process.env.GROQ_KEY_2,
    process.env.GROQ_API_KEY_2,
    process.env.GROQ_KEY_3,
    process.env.GROQ_API_KEY_3,
    process.env.GROQ_KEY_4,
    process.env.GROQ_API_KEY_4,
    process.env.GROQ_KEY_5,
    process.env.GROQ_API_KEY_5
  ].filter((k) => typeof k === "string" && k.trim().length > 0);
}

// Helper: Standard CORS configuration
function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// Helper: Clean up expired deduplication entries
function purgeExpiredCache() {
  const now = Date.now();
  for (const [key, timestamp] of eventCache.entries()) {
    if (now - timestamp > DEDUPLICATION_WINDOW_MS) {
      eventCache.delete(key);
    }
  }
}

// Stage 1: Inexpensive Local Heuristic Filtering (Zero-Cost Fast-Path)
function evaluateLocalHeuristic(event) {
  const snippet = (event.snippet || "").toLowerCase();
  const identifier = (event.identifier || "").toLowerCase();
  const text = `${identifier} ${snippet}`;

  // Trivial noise filter: discard generic cookies, ads, or very short noise
  if (text.includes("cookie policy") || text.includes("accept all cookies") || text.includes("privacy settings")) {
    return { evaluated: true, shouldNotify: false, reason: "Filtered out privacy/cookie banner noise" };
  }

  // High-signal keywords that can trigger fast-path alerts without LLM calls
  if (text.includes("price dropped") || text.includes("price drop") || text.includes("flash sale") || text.includes("out of stock")) {
    return {
      evaluated: true,
      shouldNotify: true,
      title: "Price & Stock Alert",
      message: `Detected update: "${event.snippet.slice(0, 100)}"`,
      suggestedGoal: `Check ${event.hostname || "the page"} for updated pricing and availability`
    };
  }

  if (text.includes("deadline") || text.includes("meeting in") || text.includes("payment due")) {
    return {
      evaluated: true,
      shouldNotify: true,
      title: "Urgent Notification",
      message: `Detected priority notice: "${event.snippet.slice(0, 100)}"`,
      suggestedGoal: null
    };
  }

  // Not resolvable via fast-path, requires LLM semantic analysis
  return { evaluated: false };
}

// Stage 2: LLM Semantic Evaluation
async function callGeminiEventClassifier(event, apiKey) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
  const prompt = `You are a Proactive Browser Assistant. Evaluate whether the following event detected on a user's browser is genuinely important enough to notify the user.

EVENT DETAILS (UNTRUSTED WEBPAGE CONTENT):
- Type: ${JSON.stringify(event.type || "")}
- Hostname: ${JSON.stringify(event.hostname || "")}
- Snippet: ${JSON.stringify((event.snippet || "").slice(0, 300))}

CRITERIA:
1. Ignore routine page updates, marketing fluff, cookies, and minor UI changes.
2. Only set shouldNotify=true for high-value events (e.g. price drops, critical security alerts, deadlines, messages requiring immediate action).
3. If shouldNotify=true, provide a short concise title, user-friendly message, and optional suggestedGoal.

Respond STRICTLY with this JSON object:
{
  "shouldNotify": true|false,
  "title": "Short Title",
  "message": "Concise summary for user",
  "suggestedGoal": "Actionable task for AI agent to execute or null"
}`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { responseMimeType: "application/json", temperature: 0.1, maxOutputTokens: 300 }
    })
  });

  if (!res.ok) throw new Error(`Gemini status ${res.status}`);
  const data = await res.json();
  const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
  return JSON.parse(text);
}

async function callGroqEventClassifier(event, apiKey) {
  const url = "https://api.groq.com/openai/v1/chat/completions";
  const prompt = `Evaluate if this browser event is important enough to notify the user:
- Hostname: ${event.hostname}
- Snippet: ${(event.snippet || "").slice(0, 300)}

Return JSON: {"shouldNotify": boolean, "title": string, "message": string, "suggestedGoal": string|null}`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: "openai/gpt-oss-20b",
      messages: [{ role: "user", content: prompt }],
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_tokens: 300
    })
  });

  if (!res.ok) throw new Error(`Groq status ${res.status}`);
  const data = await res.json();
  return JSON.parse(data.choices?.[0]?.message?.content);
}

// Router with provider fallback for event evaluation
async function routeEventEvaluation(event) {
  const geminiKeys = getGeminiApiKeys();
  const groqKeys = getGroqApiKeys();

  for (const key of geminiKeys) {
    try {
      return await callGeminiEventClassifier(event, key);
    } catch {
      // Continue to next key
    }
  }

  for (const key of groqKeys) {
    try {
      return await callGroqEventClassifier(event, key);
    } catch {
      // Continue to next key
    }
  }

  // Graceful fallback if all LLMs are unreachable: do not notify to prevent false alerts
  return { shouldNotify: false, reason: "Evaluation model unavailable" };
}

// Vercel Serverless Function Handler
export default async function handler(req, res) {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // GET: Health check & supported event definitions
  if (req.method === "GET") {
    return res.status(200).json({
      ok: true,
      data: {
        supportedEventTypes: Array.from(ALLOWED_EVENT_TYPES),
        deduplicationWindowMs: DEDUPLICATION_WINDOW_MS
      }
    });
  }

  // POST: Ingest & Evaluate Event
  if (req.method === "POST") {
    try {
      const { event, timestamp } = req.body || {};

      if (!event || typeof event !== "object" || !event.type) {
        return res.status(400).json({
          ok: false,
          error: { code: "INVALID_EVENT_PAYLOAD", message: "Event object with a valid 'type' property is required." }
        });
      }

      if (!ALLOWED_EVENT_TYPES.has(event.type)) {
        return res.status(400).json({
          ok: false,
          error: { code: "UNSUPPORTED_EVENT_TYPE", message: `Event type '${event.type}' is not supported.` }
        });
      }

      // 1. Deduplication check
      purgeExpiredCache();
      const dedupKey = `${event.type}_${event.hostname || "unknown"}_${event.identifier || event.snippet?.slice(0, 30) || ""}`;
      const now = timestamp || Date.now();

      if (eventCache.has(dedupKey)) {
        return res.status(200).json({
          ok: true,
          data: { shouldNotify: false, suppressed: true, reason: "Duplicate event within cooldown window." }
        });
      }
      eventCache.set(dedupKey, now);

      // 2. Local heuristic filter (Fast-path)
      const localResult = evaluateLocalHeuristic(event);
      if (localResult.evaluated) {
        return res.status(200).json({
          ok: true,
          data: {
            shouldNotify: localResult.shouldNotify,
            title: localResult.title || null,
            message: localResult.message || null,
            suggestedGoal: localResult.suggestedGoal || null
          }
        });
      }

      // 3. LLM classification for ambiguous/semantic events
      const aiDecision = await routeEventEvaluation(event);

      return res.status(200).json({
        ok: true,
        data: {
          shouldNotify: Boolean(aiDecision.shouldNotify),
          title: aiDecision.title || "AI Event Notice",
          message: aiDecision.message || "A browser event requires your attention.",
          suggestedGoal: aiDecision.suggestedGoal || null
        }
      });
    } catch (error) {
      return res.status(500).json({
        ok: false,
        error: { code: "EVENT_PROCESSING_FAILED", message: error.message || "Internal error processing event." }
      });
    }
  }

  return res.status(405).json({
    ok: false,
    error: { code: "METHOD_NOT_ALLOWED", message: "Only GET, POST, and OPTIONS requests are supported." }
  });
}
