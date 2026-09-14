// ArixAI Security Sentinel - shared module for api/chat.js
// Fast local detection first. Redis + AI escalation are fire-and-forget.
// No prompt/response bodies are written to Redis.

const REDIS_URL = (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '').replace(/\/$/, '');
const REDIS_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '';
const ADMIN_KEY = process.env.ARIX_SECURITY_ADMIN_KEY || process.env.ARIX_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || '';
const GROQ_KEYS = [
  process.env.GROQ_API_KEY,
  process.env.GROQ_KEY_2, process.env.GROQ_API_KEY_2,
  process.env.GROQ_KEY_3, process.env.GROQ_API_KEY_3,
  process.env.GROQ_KEY_4, process.env.GROQ_API_KEY_4,
  process.env.GROQ_KEY_5, process.env.GROQ_API_KEY_5
].filter(Boolean);
const GEMINI_KEYS = [
  process.env.GEMINI_API_KEY,
  process.env.GEMINI_API_KEY_1,
  process.env.GEMINI_API_KEY_2,
  process.env.GEMINI_API_KEY_3,
  process.env.GEMINI_API_KEY_4,
  process.env.GEMINI_API_KEY_5
].filter(Boolean);

const LOG_KEY = 'arix:security:events';
const PENDING_KEY = 'arix:security:pending';
const MAX_LOGS = 1000;

const LOCAL_RULES = [
  [40, /ignore\s+(all|any|the)\s+(previous|prior|above)\s+instructions?/i, 'prompt_injection'],
  [35, /\b(system|developer|assistant)\s*(message|prompt|instruction)\b/i, 'role_injection'],
  [35, /\b(jailbreak|dan\s+mode|bypass\s+safety|disable\s+guardrails?)\b/i, 'jailbreak'],
  [28, /(?:<\/?script\b|javascript:|onerror\s*=|onload\s*=)/i, 'script_injection'],
  [25, /(?:\.\.\/){2,}|(?:%2e%2e%2f){2,}|(?:%252e%252e)/i, 'path_traversal'],
  [25, /\b(?:union\s+select|or\s+1\s*=\s*1|drop\s+table|information_schema)\b/i, 'sql_injection'],
  [22, /(?:\bcurl\b|\bwget\b|\bpowershell\b|\bcmd\.exe\b|\/bin\/sh\b|\bnc\s+-e\b)/i, 'command_probe'],
  [22, /\b(?:169\.254\.169\.254|localhost:\d+|127\.0\.0\.1:\d+|0\.0\.0\.0:\d+)\b/i, 'ssrf_probe'],
  [18, /\b(?:api[_ -]?key|secret[_ -]?key|bearer\s+token|private\s+key)\b.*\b(?:reveal|show|dump|print|send)\b/i, 'secret_exfiltration'],
  [14, /\b(?:reveal|dump|exfiltrate|leak)\b.*\b(?:system|prompt|token|key|credential)\b/i, 'exfiltration_probe']
];

function clean(v, max = 300) {
  return String(v ?? '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, max);
}

function getIp(req) {
  const h = req?.headers;
  const raw = h?.get ? (h.get('x-forwarded-for') || h.get('x-real-ip') || 'unknown') : (h?.['x-forwarded-for'] || h?.['x-real-ip'] || 'unknown');
  return clean(String(raw).split(',')[0], 80);
}

function getDevice(req) {
  const h = req?.headers;
  return clean(h?.get ? (h.get('x-device-id') || 'unknown-device') : (h?.['x-device-id'] || 'unknown-device'), 120);
}

function country(req) {
  const h = req?.headers;
  return clean(h?.get ? (h.get('x-vercel-ip-country') || 'Unknown') : (h?.['x-vercel-ip-country'] || 'Unknown'), 12);
}

function redisReady() { return Boolean(REDIS_URL && REDIS_TOKEN); }

async function redis(command, timeoutMs = 1200) {
  if (!redisReady()) return null;
  try {
    const r = await fetch(REDIS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!r.ok) return null;
    const j = await r.json();
    return j.result ?? null;
  } catch { return null; }
}


async function redisPipeline(commands, timeoutMs = 150) {
  if (!redisReady() || !Array.isArray(commands) || !commands.length) return [];
  try {
    const r = await fetch(`${REDIS_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(commands),
      signal: AbortSignal.timeout(timeoutMs)
    });
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j) ? j.map(x => x?.result ?? null) : [];
  } catch { return []; }
}

async function sha256(value) {
  try {
    const data = new TextEncoder().encode(String(value));
    const digest = await crypto.subtle.digest('SHA-256', data);
    return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 32);
  } catch {
    let h = 2166136261;
    for (let i = 0; i < value.length; i++) h = Math.imul(h ^ value.charCodeAt(i), 16777619);
    return (`00000000${(h >>> 0).toString(16)}`).slice(-8);
  }
}

function safeJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function localScore({ query, messages, modelId }) {
  const text = clean(query, 12000);
  const all = Array.isArray(messages) ? messages : [];
  let score = 0;
  const hits = [];
  for (const [weight, rx, name] of LOCAL_RULES) {
    if (rx.test(text)) { score += weight; hits.push(name); }
  }
  const bytes = text.length;
  if (bytes > 120000) { score += 12; hits.push('oversized_prompt'); }
  if (all.length > 80) { score += 12; hits.push('message_flood'); }
  if (all.filter(m => String(m?.role || '') === 'system').length > 3) { score += 16; hits.push('role_spoofing'); }
  if (String(modelId || '').length > 80) { score += 10; hits.push('model_field_anomaly'); }
  return { score: Math.min(score, 100), hits: [...new Set(hits)], size: bytes, messages: all.length };
}

function severity(score) {
  if (score >= 50) return 'critical';
  if (score >= 30) return 'high';
  if (score >= 16) return 'medium';
  if (score >= 8) return 'low';
  return 'normal';
}

function autoAction(level) {
  if (level === 'critical') return { action: 'block_1h', blockSeconds: 3600 };
  if (level === 'high') return { action: 'block_10m', blockSeconds: 600 };
  if (level === 'medium') return { action: 'monitor_and_ai_review', blockSeconds: 0 };
  if (level === 'low') return { action: 'admin_review', blockSeconds: 0 };
  return { action: 'allow', blockSeconds: 0 };
}

async function writeEvent(event) {
  const payload = JSON.stringify(event);
  void redisPipeline([['LPUSH', LOG_KEY, payload], ['LTRIM', LOG_KEY, '0', String(MAX_LOGS - 1)]], 500);
}

async function addPending(event) {
  void redisPipeline([['LPUSH', PENDING_KEY, JSON.stringify(event)], ['LTRIM', PENDING_KEY, '0', '199']], 500);
}

async function countAndCheckBlock(identity) {
  const key = `arix:security:req:${identity}`;
  const result = await redisPipeline([['GET', `arix:security:block:${identity}`], ['INCR', key]], 150);
  const count = Number(result?.[1]) || 0;
  if (count === 1) void redis(['EXPIRE', key, '60'], 400);
  return { blocked: result?.[0] || null, count };
}

async function block(identity, seconds, reason) {
  if (!identity || !seconds) return;
  void redis(['SET', `arix:security:block:${identity}`, JSON.stringify({ until: Date.now() + seconds * 1000, reason }), 'EX', String(seconds)]);
}

async function aiReview(event) {
  try {
    const schema = {
      role: 'security-classifier',
      task: 'Classify an application abuse signal. Never request secrets or user content.',
      input: {
        localScore: event.score,
        severity: event.severity,
        ruleHits: event.ruleHits,
        requestRate60s: event.requestRate60s,
        messageCount: event.messageCount,
        payloadChars: event.payloadChars,
        model: event.model,
        country: event.country
      },
      output: 'Return JSON only: {"risk":"normal|low|medium|high|critical","confidence":0-100,"action":"allow|monitor|admin_review|block_10m|block_1h","reason":"short"}'
    };

    if (GROQ_KEYS.length) {
      const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${GROQ_KEYS[0]}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: process.env.ARIX_SECURITY_AI_MODEL || 'openai/gpt-oss-20b',
          temperature: 0,
          max_completion_tokens: 180,
          messages: [
            { role: 'system', content: 'You are ArixAI Security Sentinel. Be conservative, precise, and never output anything except the requested JSON.' },
            { role: 'user', content: JSON.stringify(schema) }
          ]
        }),
        signal: AbortSignal.timeout(1800)
      });
      const data = await res.json();
      const text = data?.choices?.[0]?.message?.content || '';
      return safeJson(text.replace(/^```json\s*|\s*```$/g, ''));
    }

    if (GEMINI_KEYS.length) {
      const model = process.env.ARIX_SECURITY_GEMINI_MODEL || 'gemini-2.5-flash-lite';
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'x-goog-api-key': GEMINI_KEYS[0], 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: JSON.stringify(schema) }] }], generationConfig: { temperature: 0, maxOutputTokens: 180 } }),
        signal: AbortSignal.timeout(1800)
      });
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.map(x => x.text || '').join('') || '';
      return safeJson(text.replace(/^```json\s*|\s*```$/g, ''));
    }
  } catch {}
  return null;
}

export async function inspectSecurity(req, { query = '', messages = [], modelId = 'unknown' } = {}) {
  const start = Date.now();
  const ip = getIp(req);
  const device = getDevice(req);
  const identity = await sha256(`${ip}|${device}`);
  const local = localScore({ query, messages, modelId });

  // One very short Redis pipeline runs in parallel with your normal auth path.
  let blocked = null;
  let requestRate60s = 1;
  if (redisReady()) {
    const gate = await countAndCheckBlock(identity);
    blocked = gate.blocked;
    requestRate60s = gate.count || 1;
  }
  if (blocked) {
    return { blocked: true, message: 'Security Sentinel blocked this request temporarily.', severity: 'high', score: 100, identity };
  }

  let score = local.score;
  const hits = [...local.hits];
  if (requestRate60s > 30) { score += 18; hits.push('burst_rate'); }
  if (requestRate60s > 60) { score += 25; hits.push('high_rate'); }
  if (requestRate60s > 120) { score += 35; hits.push('request_flood'); }
  score = Math.min(score, 100);

  const level = severity(score);
  const auto = autoAction(level);
  const event = {
    id: `sec_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    ts: new Date().toISOString(),
    identity,
    ipHash: await sha256(ip),
    deviceHash: await sha256(device),
    country: country(req),
    model: clean(modelId, 80),
    severity: level,
    score,
    ruleHits: [...new Set(hits)].slice(0, 12),
    requestRate60s,
    messageCount: local.messages,
    payloadChars: local.size,
    action: auto.action,
    elapsedMs: Date.now() - start,
    ai: null
  };

  // Never await telemetry writes, so the chat response is not held up by security logging.
  void writeEvent(event);
  if (level === 'low' || level === 'medium') void addPending(event);
  if (auto.blockSeconds) void block(identity, auto.blockSeconds, hits.join(',') || level);

  // AI is deliberately off the critical path and receives only metadata/signals.
  if (score >= 8) {
    void aiReview(event).then(async verdict => {
      if (!verdict) return;
      const normalized = {
        risk: severity(Math.max(score, Number(verdict.confidence) >= 90 && verdict.risk === 'high' ? 30 : score)),
        confidence: Math.max(0, Math.min(100, Number(verdict.confidence) || 0)),
        action: clean(verdict.action || 'monitor', 40),
        reason: clean(verdict.reason || 'AI review completed.', 180)
      };
      const enriched = { ...event, ai: normalized };
      void writeEvent(enriched);
      if (normalized.action === 'block_10m') void block(identity, 600, `ai:${normalized.reason}`);
      if (normalized.action === 'block_1h') void block(identity, 3600, `ai:${normalized.reason}`);
      if (normalized.risk === 'high' || normalized.risk === 'critical' || normalized.action.startsWith('block_')) {
        void block(identity, normalized.action === 'block_1h' ? 3600 : 600, `ai:${normalized.reason}`);
      }
    });
  }

  if (level === 'high' || level === 'critical') {
    return { blocked: true, severity: level, score, message: 'Security Sentinel blocked this request because an automated abuse threshold was exceeded.', identity };
  }
  return { blocked: false, severity: level, score, identity };
}

async function adminOk(req, body = {}) {
  const h = req?.headers;
  const headerKey = h?.get ? h.get('x-arix-security-key') : h?.['x-arix-security-key'];
  return Boolean(ADMIN_KEY && (headerKey === ADMIN_KEY || body?.adminKey === ADMIN_KEY));
}

export async function securityControl(req) {
  try {
    let body = {};
    if (req.method !== 'GET') {
      try { body = await req.json(); } catch {}
    }
    if (!(await adminOk(req, body))) return new Response(JSON.stringify({ error: 'Unauthorized security console.' }), { status: 401 });

    const action = body.action || new URL(req.url).searchParams.get('action') || 'read';
    if (action === 'decision') {
      const id = clean(body.id, 100);
      const decision = clean(body.decision, 30);
      if (!id || !decision) return new Response(JSON.stringify({ error: 'Missing decision payload.' }), { status: 400 });
      const pendingRaw = await redis(['LRANGE', PENDING_KEY, '0', '99']);
      const match = (Array.isArray(pendingRaw) ? pendingRaw : []).find(raw => {
        const item = safeJson(raw);
        return item?.id === id;
      });
      const event = match ? safeJson(match) : null;
      if (decision === 'block' && event?.identity) {
        void block(event.identity, 3600, 'admin_block');
      }
      void redis(['LPUSH', 'arix:security:admin_actions', JSON.stringify({ ts: new Date().toISOString(), id, decision })], 500);
      if (match) void redis(['LREM', PENDING_KEY, '1', match], 500);
      return new Response(JSON.stringify({ success: true, applied: decision === 'block' && Boolean(event?.identity) }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }

    const [logs, pending] = await Promise.all([
      redis(['LRANGE', LOG_KEY, '0', '199']),
      redis(['LRANGE', PENDING_KEY, '0', '99'])
    ]);
    const parse = (v) => safeJson(v) || null;
    const events = (Array.isArray(logs) ? logs.map(parse).filter(Boolean) : []);
    const queue = (Array.isArray(pending) ? pending.map(parse).filter(Boolean) : []);
    const stats = {
      total: events.length,
      critical: events.filter(x => x.severity === 'critical').length,
      high: events.filter(x => x.severity === 'high').length,
      medium: events.filter(x => x.severity === 'medium').length,
      low: events.filter(x => x.severity === 'low').length,
      normal: events.filter(x => x.severity === 'normal').length
    };
    return new Response(JSON.stringify({ success: true, stats, events, pending: queue }), { status: 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  } catch {
    return new Response(JSON.stringify({ error: 'Security console temporarily unavailable.' }), { status: 503 });
  }
}
