/**
 * ArixAI Safe Gateway — api/safe.js
 *
 * Single-file, dependency-free, Vercel Edge-compatible security gateway.
 * Designed to be imported by ArixAI API routes with minimal edits.
 *
 * SECURITY MODEL
 * - HTTPS / origin validation
 * - Central authentication for ArixAI's current signed HttpOnly session
 * - Function-level authorization helpers
 * - Object-level authorization helpers (server-side owner checks)
 * - IP + account + device distributed rate limiting through Upstash Redis REST
 * - Per-feature quotas and hard request/body/token/source limits
 * - Global/user/day/month spend guards using real Redis counters
 * - Emergency global + per-feature kill switches via env + Redis
 * - Deterministic request/input abuse detection with no raw prompt logging
 * - Optional real AI advisory judge; NEVER used as the sole security authority
 * - SSRF-safe outbound fetching with redirect re-validation
 * - Upload metadata and magic-byte validation helpers
 * - Safe provider fetch/error handling and response sanitization
 * - Replay/burst detection and progressive blocking
 * - Fail-closed behavior for configured protected operations
 * - Security headers and strict JSON responses
 * - Admin security-control helpers for live review/unblock/kill-switch management
 *
 * IMPORTANT
 * No single JavaScript file can make an internet application impossible to abuse.
 * This module is defense in depth. Existing route/database logic still must use the
 * exported authorization/owner helpers where the route is accessing a specific object.
 * Provider API keys must remain server-side environment variables.
 *
 * Existing ArixAI session compatibility (from the current paid/session design):
 *   Cookie: __Host-arix_session
 *   Token:   v1.<base64url-payload>.<base64url-hmac>
 *   HMAC:   ARIX_SESSION_HMAC_SECRET
 *   Redis:   billing:session:<sha256(token)>
 *   User:    user:<normalized-email>
 *
 * Minimal route integration:
 *   import { withSafeAPI } from './safe.js';
 *   export default withSafeAPI(handler, { action: 'chat', auth: 'required' });
 *
 * For a route that already exports a handler under another name:
 *   export default withSafeAPI(existingHandler, { action: 'research', auth: 'required' });
 */

export const config = { runtime: 'edge' };
export const runtime = 'edge';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const VERSION = 'arix-safe-1.0.0';
const REDIS_URL = clean(process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || '');
const REDIS_TOKEN = clean(process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || '');
const SESSION_SECRET = clean(process.env.ARIX_SESSION_HMAC_SECRET || '');
const ADMIN_KEY = clean(process.env.ARIX_SECURITY_ADMIN_KEY || process.env.ARIX_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || '');
const PUBLIC_URL = clean(process.env.ARIX_PUBLIC_URL || '');
const ALLOWED_ORIGINS = splitCsv(process.env.ARIX_ALLOWED_ORIGINS || PUBLIC_URL);
const REDIS_ENABLED = Boolean(REDIS_URL && REDIS_TOKEN);

const DEFAULT_LIMITS = Object.freeze({
  generic: Object.freeze({ rpm: 20, rph: 120, rpd: 400, body: 512_000, promptChars: 40_000, outputTokens: 4_000, sources: 20, files: 5 }),
  chat: Object.freeze({ rpm: 20, rph: 200, rpd: 500, body: 768_000, promptChars: 40_000, outputTokens: 4_000, sources: 20, files: 5 }),
  research: Object.freeze({ rpm: 8, rph: 40, rpd: 80, body: 256_000, promptChars: 20_000, outputTokens: 8_000, sources: 50, files: 5 }),
  image: Object.freeze({ rpm: 4, rph: 15, rpd: 30, body: 128_000, promptChars: 12_000, outputTokens: 0, sources: 0, files: 4 }),
  video: Object.freeze({ rpm: 2, rph: 6, rpd: 12, body: 128_000, promptChars: 12_000, outputTokens: 0, sources: 0, files: 4 }),
  crawler: Object.freeze({ rpm: 8, rph: 50, rpd: 150, body: 128_000, promptChars: 16_000, outputTokens: 0, sources: 50, files: 0 }),
  file: Object.freeze({ rpm: 6, rph: 30, rpd: 80, body: 25 * 1024 * 1024, promptChars: 20_000, outputTokens: 4_000, sources: 20, files: 5 }),
  workspace: Object.freeze({ rpm: 10, rph: 60, rpd: 200, body: 2 * 1024 * 1024, promptChars: 40_000, outputTokens: 8_000, sources: 50, files: 10 }),
  admin: Object.freeze({ rpm: 20, rph: 200, rpd: 1000, body: 256_000, promptChars: 20_000, outputTokens: 2_000, sources: 20, files: 20 }),
});

const METHOD_DEFAULTS = Object.freeze({
  generic: ['POST'],
  chat: ['POST'],
  research: ['POST'],
  image: ['POST'],
  video: ['POST'],
  crawler: ['POST'],
  file: ['POST'],
  workspace: ['POST', 'PATCH', 'PUT', 'DELETE'],
  admin: ['GET', 'POST'],
});

const COST_LIMIT_ENV = Object.freeze({
  userDay: 'ARIX_USER_DAILY_SPEND_PAISE',
  globalDay: 'ARIX_GLOBAL_DAILY_SPEND_PAISE',
  globalMonth: 'ARIX_GLOBAL_MONTHLY_SPEND_PAISE',
});

const PROVIDER_HOSTS = new Set([
  'api.groq.com',
  'generativelanguage.googleapis.com',
  'api.tavily.com',
  'api.openai.com',
  'api.stripe.com',
  'api.razorpay.com',
  'api.mistral.ai',
]);

const RULES = [
  { id: 'prompt-injection', score: 38, severity: 3, re: /\b(ignore|disregard|forget|override)\b.{0,90}\b(previous|prior|above|system|developer)\b.{0,70}\b(instruction|prompt|rule)s?\b/i },
  { id: 'jailbreak', score: 42, severity: 3, re: /\b(jailbreak|dan\s*mode|developer\s*mode|god\s*mode|uncensored|bypass\s+safety|disable\s+guardrails?)\b/i },
  { id: 'role-spoof', score: 26, severity: 2, re: /(?:^|\n)\s*(system|developer|tool|assistant)\s*:\s*/i },
  { id: 'script-injection', score: 45, severity: 3, re: /<\/?script\b|javascript\s*:|data\s*:\s*text\/html|on(?:error|load|click|mouseover)\s*=/i },
  { id: 'html-event-injection', score: 32, severity: 2, re: /<[^>]+\s(on[a-z]+|srcdoc|formaction)\s*=/i },
  { id: 'path-traversal', score: 42, severity: 3, re: /(?:\.\.\/){2,}|(?:\.\.\\){2,}|%2e%2e(?:%2f|%5c)|%252e%252e/i },
  { id: 'sql-probe', score: 44, severity: 3, re: /\b(?:union\s+select|select\s+.+\s+from|insert\s+into|drop\s+(?:table|database)|delete\s+from|update\s+.+\s+set|information_schema|pg_catalog)\b/i },
  { id: 'shell-probe', score: 44, severity: 3, re: /(?:\b(?:curl|wget|powershell|pwsh|cmd(?:\.exe)?|bash|zsh|sh)\b.{0,90}(?:https?:\/\/|\$\(|-enc|-e\b)|\/bin\/(?:sh|bash)|nc\s+[^\n]{0,40}-e\b)/i },
  { id: 'ssrf-probe', score: 48, severity: 3, re: /(?:169\.254\.169\.254|metadata\.google\.internal|localhost(?::\d+)?|127\.0\.0\.1(?::\d+)?|0\.0\.0\.0(?::\d+)?|\[::1\])/i },
  { id: 'secret-exfil', score: 48, severity: 3, re: /\b(?:reveal|dump|print|show|send|leak|exfiltrate|export)\b.{0,100}\b(?:api\s*key|secret|token|credential|private\s*key|bearer|password|env(?:ironment)?\s+var(?:iable)?)\b/i },
  { id: 'system-prompt-exfil', score: 34, severity: 2, re: /\b(?:reveal|quote|dump|show|repeat)\b.{0,90}\b(?:system|developer)\b.{0,70}\b(prompt|message|instruction)\b/i },
  { id: 'encoding-obfuscation', score: 22, severity: 2, re: /(?:base64|fromcharcode|charcodeat|rot13|hex(?:adecimal)?\s+decode|urlencode|percent-encode)/i },
  { id: 'template-injection', score: 35, severity: 2, re: /(?:\$\{[^}]+\}|\{\{[^}]+\}\}|<%[^%]+%>|#\{[^}]+\})/i },
  { id: 'prototype-pollution', score: 42, severity: 3, re: /(?:__proto__|constructor\s*\[|prototype\s*\[|constructor\.prototype)/i },
  { id: 'header-smuggling', score: 38, severity: 3, re: /(?:content-length\s*:.*content-length\s*:|transfer-encoding\s*:.*content-length\s*:|x-forwarded-host\s*:.*x-forwarded-host\s*:)/i },
  { id: 'credential-form', score: 28, severity: 2, re: /\b(?:username|user\s*id|password|passcode|otp|one[- ]time\s+password)\b.{0,100}\b(?:send|post|upload|store|share)\b/i },
  { id: 'network-scan', score: 20, severity: 1, re: /\b(?:scan|enumerate|probe|fingerprint)\b.{0,90}\b(?:port|endpoint|service|internal|network)\b/i },
  { id: 'abuse-automation', score: 20, severity: 1, re: /\b(?:bot|scrape|scraper|crawl|automate|bulk|mass\s+request|credential\s+stuff)\b/i },
];

const SEVERITY = Object.freeze(['normal', 'low', 'medium', 'high', 'critical']);

function clean(value, max = 4096) {
  try { return String(value ?? '').replace(/[\r\n]/g, '').trim().slice(0, max); } catch { return ''; }
}

function splitCsv(value) {
  return clean(value, 16_000).split(',').map(x => x.trim()).filter(Boolean);
}

function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }

function jsonResponse(payload, status = 200, headers = {}) {
  const base = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  };
  return new Response(JSON.stringify(payload), { status, headers: { ...base, ...headers } });
}

function errorResponse(status, code, message, extra = {}) {
  return jsonResponse({ ok: false, error: code, message, ...extra }, status);
}

function getIp(req) {
  const values = [
    req?.headers?.get?.('x-vercel-forwarded-for'),
    req?.headers?.get?.('x-forwarded-for'),
    req?.headers?.get?.('x-real-ip'),
  ].map(x => clean(x, 512)).filter(Boolean);
  return (values[0] || 'unknown').split(',')[0].trim().slice(0, 128) || 'unknown';
}

function getUserAgent(req) { return clean(req?.headers?.get?.('user-agent') || 'unknown', 512); }
function getDeviceId(req, input = {}) { return clean(input?.deviceId || req?.headers?.get?.('x-device-id') || '', 256); }
function getCountry(req) { return clean(req?.headers?.get?.('x-vercel-ip-country') || 'unknown', 16); }
function getOrigin(req) { return clean(req?.headers?.get?.('origin') || '', 512); }
function getReferer(req) { return clean(req?.headers?.get?.('referer') || '', 512); }

function isHttpsRequest(req) {
  try {
    const u = new URL(req.url);
    return u.protocol === 'https:' || /^(localhost|127\.0\.0\.1)$/i.test(u.hostname);
  } catch { return false; }
}

function originAllowed(req, allowNoOrigin = true) {
  const origin = getOrigin(req);
  if (!origin) return allowNoOrigin;
  if (!ALLOWED_ORIGINS.length) return false;
  return ALLOWED_ORIGINS.some(allowed => {
    try {
      const a = new URL(allowed);
      const o = new URL(origin);
      return a.origin === o.origin;
    } catch { return false; }
  });
}

function assertOrigin(req, { allowNoOrigin = true } = {}) {
  if (!isHttpsRequest(req)) throw new SafeError(400, 'HTTPS_REQUIRED', 'Secure HTTPS requests are required.');
  if (!originAllowed(req, allowNoOrigin)) throw new SafeError(403, 'ORIGIN_FORBIDDEN', 'Request origin is not allowed.');
}

function parseCookies(header) {
  const out = Object.create(null);
  for (const part of clean(header, 16_000).split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

function extractBearer(req) {
  const h = clean(req?.headers?.get?.('authorization') || '', 4096);
  const m = h.match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : '';
}

function b64urlDecode(value) {
  const s = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = s + '='.repeat((4 - (s.length % 4)) % 4);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(padded)) throw new Error('invalid-base64url');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function b64urlEncode(bytes) {
  let binary = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (const b of arr) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function utf8(value) { return encoder.encode(String(value)); }

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest('SHA-256', utf8(value));
  return [...new Uint8Array(digest)].map(x => x.toString(16).padStart(2, '0')).join('');
}

async function hmacSha256(secret, value) {
  const key = await crypto.subtle.importKey('raw', utf8(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8(value)));
}

async function timingSafeEqual(a, b) {
  const aa = await crypto.subtle.digest('SHA-256', utf8(a));
  const bb = await crypto.subtle.digest('SHA-256', utf8(b));
  const av = new Uint8Array(aa), bv = new Uint8Array(bb);
  let diff = 0;
  for (let i = 0; i < av.length; i++) diff |= av[i] ^ bv[i];
  return diff === 0;
}

async function redisCommand(command, timeoutMs = 1500) {
  if (!REDIS_ENABLED) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(REDIS_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(command),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const data = await response.json();
    return data?.error ? null : (data?.result ?? null);
  } catch { return null; }
  finally { clearTimeout(timer); }
}

async function redisPipeline(commands, timeoutMs = 1800) {
  if (!REDIS_ENABLED || !Array.isArray(commands) || !commands.length) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(`${REDIS_URL}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${REDIS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(commands),
      signal: controller.signal,
    });
    if (!response.ok) return null;
    return await response.json();
  } catch { return null; }
  finally { clearTimeout(timer); }
}

async function redisEval(script, keys = [], args = [], timeoutMs = 1500) {
  return redisCommand(['EVAL', script, String(keys.length), ...keys, ...args.map(String)], timeoutMs);
}

function getLimits(action, override) {
  const base = { ...(DEFAULT_LIMITS[action] || DEFAULT_LIMITS.generic) };
  const customEnvKey = `ARIX_SAFE_${String(action).toUpperCase()}_LIMITS_JSON`;
  const envRaw = clean(process.env[customEnvKey] || '', 4000);
  if (envRaw) {
    try {
      const parsed = JSON.parse(envRaw);
      if (parsed && typeof parsed === 'object') Object.assign(base, parsed);
    } catch {}
  }
  if (override && typeof override === 'object') Object.assign(base, override);
  for (const key of ['rpm', 'rph', 'rpd', 'body', 'promptChars', 'outputTokens', 'sources', 'files']) {
    if (!Number.isFinite(Number(base[key])) || Number(base[key]) < 0) base[key] = DEFAULT_LIMITS.generic[key];
    base[key] = Number(base[key]);
  }
  return base;
}

function approxTokens(text) {
  const s = String(text || '');
  if (!s) return 0;
  return Math.max(1, Math.ceil(s.length / 4));
}

function normalizeText(value, max = 200_000) {
  return clean(value, max)
    .normalize('NFKC')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, ' ')
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function flattenUserText(body) {
  if (!body || typeof body !== 'object') return '';
  const parts = [];
  const messages = Array.isArray(body.messages) ? body.messages : [];
  for (const m of messages) {
    if (m && typeof m === 'object' && typeof m.content === 'string') parts.push(m.content);
  }
  for (const key of ['prompt', 'query', 'q', 'text', 'input', 'instruction']) {
    if (typeof body[key] === 'string') parts.push(body[key]);
  }
  return normalizeText(parts.join('\n'), 300_000);
}

function validateShape(body, limits) {
  const hits = [];
  let score = 0;
  let malformed = false;
  if (body == null) return { score: 0, hits, malformed };
  if (typeof body !== 'object' || Array.isArray(body)) {
    return { score: 40, hits: ['body-not-object'], malformed: true };
  }
  if (Array.isArray(body.messages)) {
    if (body.messages.length > 80) { hits.push('message-flood'); score += 25; }
    if (body.messages.length > 160) { hits.push('extreme-message-flood'); score += 45; }
    let systemRoles = 0;
    for (const message of body.messages) {
      if (!message || typeof message !== 'object') { hits.push('malformed-message'); score += 20; malformed = true; continue; }
      const role = clean(message.role, 32).toLowerCase();
      if (!['user', 'assistant', 'system', 'tool'].includes(role)) { hits.push('unknown-message-role'); score += 22; malformed = true; }
      if (role === 'system') systemRoles++;
      if (message.content != null && typeof message.content !== 'string' && !Array.isArray(message.content)) {
        hits.push('non-text-content'); score += 22; malformed = true;
      }
    }
    if (systemRoles > 2) { hits.push('excess-system-roles'); score += 35; }
  }
  for (const key of ['max_tokens', 'maxTokens', 'max_output_tokens', 'maxOutputTokens']) {
    if (body[key] != null) {
      const n = Number(body[key]);
      if (!Number.isFinite(n) || n < 0 || n > limits.outputTokens) {
        hits.push('output-token-limit'); score += 32; malformed = true;
      }
    }
  }
  for (const key of ['sources', 'maxSources', 'maxSearches']) {
    if (body[key] != null) {
      const n = Number(body[key]);
      if (Number.isFinite(n) && n > limits.sources) { hits.push('source-limit'); score += 25; malformed = true; }
    }
  }
  const serialized = safeJsonLength(body);
  if (serialized > limits.body) { hits.push('body-size-limit'); score += 45; malformed = true; }
  const text = flattenUserText(body);
  if (text.length > limits.promptChars) { hits.push('prompt-size-limit'); score += 35; malformed = true; }
  if (approxTokens(text) > Math.ceil(limits.promptChars / 3.2)) { hits.push('prompt-token-density'); score += 20; }
  return { score: clamp(score, 0, 100), hits: [...new Set(hits)], malformed };
}

function safeJsonLength(value) {
  try { return encoder.encode(JSON.stringify(value)).byteLength; } catch { return Number.MAX_SAFE_INTEGER; }
}

function evaluateHeaders(req) {
  let score = 0;
  const hits = [];
  const ua = getUserAgent(req).toLowerCase();
  const origin = getOrigin(req);
  const referer = getReferer(req);
  if (/sqlmap|nikto|nmap|masscan|zgrab|nuclei|wpscan|dirbuster|gobuster|ffuf|burp/i.test(ua)) { hits.push('scanner-user-agent'); score += 35; }
  if (/python-requests|python-urllib|curl\/|wget\//i.test(ua)) { hits.push('scripted-user-agent'); score += 10; }
  if (origin && referer) {
    try {
      const a = new URL(origin), b = new URL(referer);
      if (a.origin !== b.origin) { hits.push('origin-referer-mismatch'); score += 10; }
    } catch {}
  }
  return { score: clamp(score, 0, 100), hits };
}

async function rateLimit(key, limit, windowSeconds) {
  if (limit <= 0) return { ok: true, count: 0, distributed: REDIS_ENABLED };
  if (!REDIS_ENABLED) return { ok: false, unavailable: true, count: 0, distributed: false };
  const script = `local n=tonumber(redis.call('INCR',KEYS[1])); if n==1 then redis.call('EXPIRE',KEYS[1],ARGV[1]) end; return n`;
  const count = Number(await redisEval(script, [key], [windowSeconds], 1200));
  if (!Number.isFinite(count)) return { ok: false, unavailable: true, count: 0, distributed: true };
  return { ok: count <= limit, count, distributed: true };
}

async function blockState(key) {
  if (!REDIS_ENABLED) return null;
  const raw = await redisCommand(['GET', key], 900);
  if (!raw) return null;
  try {
    const item = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return item && Number(item.until) > Date.now() ? item : null;
  } catch { return null; }
}

async function setBlock(key, seconds, reason, score) {
  if (!REDIS_ENABLED || seconds <= 0) return false;
  const payload = JSON.stringify({ until: Date.now() + seconds * 1000, reason: clean(reason, 400), score: Number(score) || 0, createdAt: Date.now() });
  return (await redisCommand(['SET', key, payload, 'EX', String(seconds)], 1000)) === 'OK';
}

function actionBlockSeconds(score, ratePeak) {
  if (score >= 85 || ratePeak >= 250) return 3600;
  if (score >= 70 || ratePeak >= 150) return 1800;
  if (score >= 55 || ratePeak >= 100) return 900;
  return 0;
}

function shouldAiJudge(score, hits) {
  return score >= 24 || hits.some(x => /scanner|sql|ssrf|shell|prototype|header|secret|script/i.test(x));
}

async function optionalAiJudge(signal) {
  if (String(process.env.ARIX_SAFETY_AI_JUDGE || '').toLowerCase() !== 'true') return null;
  const groqKey = clean(process.env.GROQ_API_KEY || '');
  const geminiKey = clean(process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY || '');
  const groqModel = clean(process.env.ARIX_SAFETY_GROQ_MODEL || 'openai/gpt-oss-20b', 160);
  const geminiModel = clean(process.env.ARIX_SAFETY_GEMINI_MODEL || 'gemini-2.5-flash', 160);
  const prompt = JSON.stringify(signal);
  const system = 'Classify server security metadata only. Never invent facts. Return ONLY JSON {"malicious":boolean,"confidence":0-100,"severity":"normal|low|medium|high|critical","reason":"short"}. The model is advisory; evidence outranks the model.';
  const candidates = [];
  if (groqKey) candidates.push({ type: 'groq', key: groqKey });
  if (geminiKey) candidates.push({ type: 'gemini', key: geminiKey });

  for (const c of candidates.slice(0, 2)) {
    try {
      let response;
      if (c.type === 'groq') {
        response = await safeFetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: { Authorization: `Bearer ${c.key}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: groqModel, temperature: 0, max_tokens: 180, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }),
        }, { maxResponseBytes: 32_000, timeoutMs: 1800, allowHosts: PROVIDER_HOSTS, failOnProviderError: true });
        const data = await response.json();
        const raw = data?.choices?.[0]?.message?.content || '';
        const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || '{}');
        if (typeof parsed.confidence === 'number') return normalizeAiVerdict(parsed);
      } else {
        response = await safeFetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(geminiModel)}:generateContent?key=${encodeURIComponent(c.key)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: system + '\nSECURITY METADATA:\n' + prompt }] }], generationConfig: { temperature: 0, maxOutputTokens: 180 } }),
        }, { maxResponseBytes: 32_000, timeoutMs: 1800, allowHosts: PROVIDER_HOSTS, failOnProviderError: true });
        const data = await response.json();
        const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const parsed = JSON.parse(raw.match(/\{[\s\S]*\}/)?.[0] || '{}');
        if (typeof parsed.confidence === 'number') return normalizeAiVerdict(parsed);
      }
    } catch {}
  }
  return null;
}

function normalizeAiVerdict(v) {
  const severity = SEVERITY.includes(String(v?.severity)) ? String(v.severity) : 'medium';
  return { malicious: Boolean(v?.malicious), confidence: clamp(Number(v?.confidence) || 0, 0, 100), severity, reason: clean(v?.reason || '', 240) };
}

async function securityLog(event) {
  if (!REDIS_ENABLED) return;
  const logNormal = String(process.env.ARIX_SAFE_LOG_NORMAL || 'true').toLowerCase() !== 'false';
  if (!logNormal && event.severity === 'normal') return;
  const sanitized = {
    id: clean(event.id, 96),
    ts: event.ts,
    severity: event.severity,
    score: Number(event.score) || 0,
    decision: clean(event.decision, 80),
    rules: Array.isArray(event.rules) ? event.rules.slice(0, 30) : [],
    ipHash: event.ipHash,
    userIdHash: event.userIdHash,
    deviceHash: event.deviceHash,
    uaHash: event.uaHash,
    country: event.country,
    action: clean(event.action, 80),
    method: clean(event.method, 16),
    path: clean(event.path, 180),
    requestBytes: Number(event.requestBytes) || 0,
    messageCount: Number(event.messageCount) || 0,
    latencyMs: Number(event.latencyMs) || 0,
    aiVerdict: event.aiVerdict || null,
    securityVersion: VERSION,
  };
  const incident = event.severity === 'high' || event.severity === 'critical';
  const commands = [
    ['LPUSH', 'arix:safe:events', JSON.stringify(sanitized)],
    ['LTRIM', 'arix:safe:events', '0', '2999'],
  ];
  if (incident) {
    commands.push(['LPUSH', 'arix:safe:incidents', JSON.stringify(sanitized)]);
    commands.push(['LTRIM', 'arix:safe:incidents', '0', '499']);
  }
  await redisPipeline(commands, 1500);
}

function featureEnabled(action) {
  const global = clean(process.env.ARIX_GLOBAL_AI_ENABLED || 'true').toLowerCase() !== 'false';
  if (!global && action !== 'admin') return false;
  const env = `ARIX_${String(action).toUpperCase()}_ENABLED`;
  const v = clean(process.env[env] || 'true').toLowerCase();
  return v !== 'false';
}

async function redisKillSwitch(action) {
  if (!REDIS_ENABLED) return null;
  const raw = await redisCommand(['MGET', 'arix:safe:kill:global', `arix:safe:kill:${String(action)}`], 900);
  if (!Array.isArray(raw)) return null;
  const toBool = x => String(x || '').toLowerCase() === 'true';
  return { global: toBool(raw[0]), action: toBool(raw[1]) };
}

async function ensureFeatureEnabled(action) {
  if (!featureEnabled(action)) throw new SafeError(503, 'FEATURE_DISABLED', 'This feature is temporarily disabled.');
  const ks = await redisKillSwitch(action);
  if (ks?.global || ks?.action) throw new SafeError(503, 'FEATURE_DISABLED', 'This feature is temporarily disabled.');
}

function failClosedNeeded(action, options = {}) {
  if (options.failClosed != null) return Boolean(options.failClosed);
  return ['research', 'image', 'video', 'crawler', 'file', 'workspace', 'admin'].includes(action);
}

function requestId(req) {
  const supplied = clean(req?.headers?.get?.('x-request-id') || '', 120);
  return supplied && /^[A-Za-z0-9._:-]{8,120}$/.test(supplied) ? supplied : `${Date.now().toString(36)}-${crypto.randomUUID?.() || Math.random().toString(36).slice(2)}`;
}

class SafeError extends Error {
  constructor(status, code, message, headers = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

async function verifySecureSession(req, { requireAuth = true } = {}) {
  if (!requireAuth) return { authenticated: false, user: null, payload: null, token: '' };
  if (!SESSION_SECRET || !REDIS_ENABLED) throw new SafeError(503, 'AUTH_NOT_CONFIGURED', 'Secure authentication storage is not configured.');
  const bearer = extractBearer(req);
  const cookieToken = parseCookies(req.headers.get('cookie') || '')['__Host-arix_session'] || '';
  const token = bearer || cookieToken;
  if (!token) throw new SafeError(401, 'AUTH_REQUIRED', 'Authentication required.');
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1' || !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]+$/.test(parts[2])) {
    throw new SafeError(401, 'AUTH_INVALID', 'Authentication required.');
  }
  const expected = b64urlEncode(await hmacSha256(SESSION_SECRET, `${parts[0]}.${parts[1]}`));
  if (!(await timingSafeEqual(expected, parts[2]))) throw new SafeError(401, 'AUTH_INVALID', 'Authentication required.');
  let payload;
  try { payload = JSON.parse(decoder.decode(b64urlDecode(parts[1]))); } catch { throw new SafeError(401, 'AUTH_INVALID', 'Authentication required.'); }
  const now = Math.floor(Date.now() / 1000);
  if (!payload || payload.typ !== 'arix-session' || payload.v !== 1 || !payload.sub || !payload.jti || !Number.isSafeInteger(payload.exp) || payload.exp <= now || Number(payload.iat) > now + 60) {
    throw new SafeError(401, 'AUTH_INVALID', 'Authentication required.');
  }
  const tokenHash = await sha256Hex(token);
  const sessionRaw = await redisCommand(['GET', `billing:session:${tokenHash}`], 1200);
  let session = null;
  try { session = typeof sessionRaw === 'string' ? JSON.parse(sessionRaw) : sessionRaw; } catch {}
  if (!session || session.revoked || Number(session.exp) <= now || !(await timingSafeEqual(String(session.jti || ''), String(payload.jti)))) {
    throw new SafeError(401, 'AUTH_REVOKED', 'Session is invalid or expired.');
  }
  const email = normalizeEmail(payload.sub);
  const userRaw = await redisCommand(['GET', `user:${email}`], 1200);
  let user = null;
  try { user = typeof userRaw === 'string' ? JSON.parse(userRaw) : userRaw; } catch {}
  if (!user || user.status === 'blocked') throw new SafeError(403, 'ACCOUNT_UNAVAILABLE', 'Account is unavailable.');
  const deviceId = getDeviceId(req);
  const bindDevice = clean(process.env.ARIX_BIND_SESSION_TO_DEVICE || 'true').toLowerCase() !== 'false';
  if (bindDevice && payload.did && deviceId && payload.did !== deviceId) throw new SafeError(401, 'DEVICE_MISMATCH', 'Session device verification failed.');
  return { authenticated: true, email, user, payload, token, userId: clean(user.id || user.userId || email, 256) };
}

function normalizeEmail(value) {
  return clean(value, 320).toLowerCase();
}

function roleAllowed(user, roles) {
  if (!Array.isArray(roles) || !roles.length) return true;
  const role = clean(user?.role || user?.accountRole || '', 80).toLowerCase();
  const plan = clean(user?.plan || user?.tier || '', 80).toLowerCase();
  return roles.some(r => role === String(r).toLowerCase() || plan === String(r).toLowerCase());
}

function assertAuthorized(session, { roles = [], permissions = [], requireUser = true } = {}) {
  if (requireUser && !session?.authenticated) throw new SafeError(401, 'AUTH_REQUIRED', 'Authentication required.');
  if (roles.length && !roleAllowed(session.user, roles)) throw new SafeError(403, 'FORBIDDEN', 'You are not authorized for this operation.');
  if (permissions.length) {
    const p = Array.isArray(session?.user?.permissions) ? session.user.permissions.map(x => String(x)) : [];
    if (!permissions.every(x => p.includes(String(x)))) throw new SafeError(403, 'FORBIDDEN', 'You are not authorized for this operation.');
  }
  return true;
}

export function assertOwnership({ ownerId, userId }) {
  if (!ownerId || !userId || String(ownerId) !== String(userId)) throw new SafeError(403, 'OBJECT_FORBIDDEN', 'You are not authorized to access this object.');
  return true;
}

export function assertAdmin(session) {
  assertAuthorized(session, { roles: ['admin', 'superadmin'] });
}

async function bodyFromRequest(req, maxBytes) {
  const lengthHeader = clean(req.headers.get('content-length') || '', 80);
  if (lengthHeader) {
    const n = Number(lengthHeader);
    if (Number.isFinite(n) && n > maxBytes) throw new SafeError(413, 'PAYLOAD_TOO_LARGE', 'Request payload is too large.');
  }
  const contentType = clean(req.headers.get('content-type') || '', 300).toLowerCase();
  if (!contentType) return { body: null, raw: '' };
  if (contentType.includes('application/json')) {
    const clone = req.clone();
    const raw = await clone.text();
    if (encoder.encode(raw).byteLength > maxBytes) throw new SafeError(413, 'PAYLOAD_TOO_LARGE', 'Request payload is too large.');
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new SafeError(400, 'INVALID_JSON', 'Invalid JSON payload.'); }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new SafeError(400, 'INVALID_JSON', 'JSON body must be an object.');
    return { body: parsed, raw };
  }
  return { body: null, raw: '' };
}

export function sanitizeProviderRequest(input, limits = {}) {
  const out = input && typeof input === 'object' && !Array.isArray(input) ? { ...input } : {};
  const maxOutput = Number(limits.outputTokens || DEFAULT_LIMITS.generic.outputTokens);
  for (const key of ['max_tokens', 'maxTokens', 'max_output_tokens', 'maxOutputTokens']) {
    if (key in out) {
      const n = Number(out[key]);
      out[key] = Number.isFinite(n) ? clamp(Math.floor(n), 1, maxOutput) : maxOutput;
    }
  }
  if ('messages' in out && Array.isArray(out.messages)) {
    out.messages = out.messages.slice(-160).map(m => {
      if (!m || typeof m !== 'object') return null;
      const role = clean(m.role, 32).toLowerCase();
      return { role, content: typeof m.content === 'string' ? normalizeText(m.content, 200_000) : m.content };
    }).filter(Boolean);
  }
  return out;
}

export function validateUploadMetadata(file, opts = {}) {
  const maxBytes = Number(opts.maxBytes || 10 * 1024 * 1024);
  const allowedTypes = new Set((opts.allowedTypes || []).map(x => String(x).toLowerCase()));
  const name = clean(file?.name || '', 300);
  const type = clean(file?.type || '', 150).toLowerCase();
  const size = Number(file?.size);
  if (!name || !type || !Number.isFinite(size) || size < 0) throw new SafeError(400, 'INVALID_FILE', 'Invalid file metadata.');
  if (size > maxBytes) throw new SafeError(413, 'FILE_TOO_LARGE', 'File is too large.');
  if (allowedTypes.size && !allowedTypes.has(type)) throw new SafeError(415, 'FILE_TYPE_FORBIDDEN', 'File type is not allowed.');
  if (/[/\\]|\.\./.test(name)) throw new SafeError(400, 'INVALID_FILE_NAME', 'Invalid file name.');
  return { name, type, size };
}

export async function validateFileMagic(file, expected = []) {
  if (!file || typeof file.arrayBuffer !== 'function') throw new SafeError(400, 'INVALID_FILE', 'Readable file data is required.');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const rules = {
    pdf: [0x25, 0x50, 0x44, 0x46],
    png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    jpg: [0xff, 0xd8, 0xff],
    gif: [0x47, 0x49, 0x46, 0x38],
    webp: [0x52, 0x49, 0x46, 0x46],
    zip: [0x50, 0x4b, 0x03, 0x04],
  };
  const allowed = Array.isArray(expected) && expected.length ? expected : Object.keys(rules);
  const matched = allowed.some(kind => {
    const sig = rules[String(kind).toLowerCase()];
    return sig && sig.every((b, i) => bytes[i] === b);
  });
  if (!matched) throw new SafeError(415, 'FILE_SIGNATURE_MISMATCH', 'File content signature is not allowed.');
  return true;
}

function ipIsPrivate(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost') || h === 'local' || h === 'metadata.google.internal') return true;
  if (h === '::' || h === '::1' || h === '0.0.0.0') return true;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^169\.254\./.test(h)) return true;
  const m = h.match(/^172\.(\d{1,3})\./);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  if (/^fc00:/i.test(h) || /^fd[0-9a-f]{2}:/i.test(h) || /^fe80:/i.test(h)) return true;
  return false;
}

export function assertSafeTargetURL(input, opts = {}) {
  let u;
  try { u = new URL(String(input)); } catch { throw new SafeError(400, 'INVALID_URL', 'Invalid target URL.'); }
  if (!['http:', 'https:'].includes(u.protocol)) throw new SafeError(400, 'URL_SCHEME_FORBIDDEN', 'Only HTTP and HTTPS targets are allowed.');
  if (u.username || u.password) throw new SafeError(400, 'URL_CREDENTIALS_FORBIDDEN', 'URL credentials are not allowed.');
  if (ipIsPrivate(u.hostname)) throw new SafeError(403, 'SSRF_BLOCKED', 'Private or internal network targets are blocked.');
  const allowedHosts = opts.allowHosts instanceof Set ? opts.allowHosts : (Array.isArray(opts.allowHosts) ? new Set(opts.allowHosts.map(x => String(x).toLowerCase())) : null);
  if (allowedHosts && allowedHosts.size) {
    const h = u.hostname.toLowerCase();
    const ok = [...allowedHosts].some(x => h === x || h.endsWith('.' + x));
    if (!ok) throw new SafeError(403, 'OUTBOUND_HOST_FORBIDDEN', 'Outbound host is not allowed.');
  }
  if (opts.allowedPorts) {
    const ports = new Set(opts.allowedPorts.map(Number));
    if (u.port && !ports.has(Number(u.port))) throw new SafeError(403, 'PORT_FORBIDDEN', 'Outbound port is not allowed.');
  }
  return u;
}

export async function safeFetch(input, init = {}, opts = {}) {
  const timeoutMs = clamp(Number(opts.timeoutMs || 8000), 250, 30_000);
  const maxResponseBytes = clamp(Number(opts.maxResponseBytes || 2_000_000), 1_024, 25_000_000);
  const maxRedirects = clamp(Number(opts.maxRedirects ?? 3), 0, 5);
  let current = String(input);
  let redirects = 0;
  let response = null;

  while (true) {
    const u = assertSafeTargetURL(current, { allowHosts: opts.allowHosts || null, allowedPorts: opts.allowedPorts || [80, 443] });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      response = await fetch(u.toString(), { ...init, redirect: 'manual', signal: controller.signal });
    } catch (error) {
      throw new SafeError(502, 'OUTBOUND_FETCH_FAILED', 'Upstream request failed safely.');
    } finally { clearTimeout(timer); }

    if (response.status >= 300 && response.status < 400) {
      if (redirects >= maxRedirects) throw new SafeError(508, 'REDIRECT_LIMIT', 'Too many redirects.');
      const location = response.headers.get('location');
      if (!location) throw new SafeError(502, 'REDIRECT_INVALID', 'Upstream returned an invalid redirect.');
      const next = new URL(location, u).toString();
      assertSafeTargetURL(next, { allowHosts: opts.allowHosts || null, allowedPorts: opts.allowedPorts || [80, 443] });
      current = next;
      redirects++;
      continue;
    }
    break;
  }

  const contentLength = Number(response.headers.get('content-length') || '');
  if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) throw new SafeError(413, 'UPSTREAM_TOO_LARGE', 'Upstream response is too large.');
  if (opts.maxContentTypes) {
    const ct = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const allowed = new Set(opts.maxContentTypes.map(x => String(x).toLowerCase()));
    if (ct && !allowed.has(ct)) throw new SafeError(415, 'UPSTREAM_CONTENT_TYPE', 'Upstream content type is not allowed.');
  }
  if (opts.failOnProviderError && !response.ok) throw new SafeError(502, 'UPSTREAM_ERROR', `Upstream provider returned HTTP ${response.status}.`);
  return limitResponseBody(response, maxResponseBytes);
}

async function limitResponseBody(response, maxBytes) {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try { await reader.cancel(); } catch {}
      throw new SafeError(413, 'UPSTREAM_TOO_LARGE', 'Upstream response is too large.');
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { merged.set(chunk, offset); offset += chunk.byteLength; }
  return new Response(merged, { status: response.status, statusText: response.statusText, headers: response.headers });
}

function costLimit(name) {
  const raw = Number(process.env[name] || 0);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0;
}

function dayKey(now = new Date()) {
  return now.toISOString().slice(0, 10).replace(/-/g, '');
}
function monthKey(now = new Date()) {
  return now.toISOString().slice(0, 7).replace(/-/g, '');
}

async function reserveSpend({ ipHash, userIdHash, costPaise = 0, action }) {
  const cost = Math.max(0, Math.floor(Number(costPaise) || 0));
  if (!cost) return { ok: true, reserved: 0, enforced: false };
  if (!REDIS_ENABLED) return { ok: false, unavailable: true, reserved: 0, enforced: true };
  const keys = [];
  const args = [String(cost)];
  const add = (key, limit, ttl) => {
    if (!limit) return;
    keys.push(key);
    args.push(String(limit), String(ttl));
  };
  add(`arix:safe:spend:global:day:${dayKey()}`, costLimit(COST_LIMIT_ENV.globalDay), 3 * 86400);
  add(`arix:safe:spend:global:month:${monthKey()}`, costLimit(COST_LIMIT_ENV.globalMonth), 35 * 86400);
  if (userIdHash) add(`arix:safe:spend:user:${userIdHash}:day:${dayKey()}`, costLimit(COST_LIMIT_ENV.userDay), 3 * 86400);
  if (!keys.length) return { ok: true, reserved: cost, enforced: false };

  const script = `local cost=tonumber(ARGV[1]); local i=2; for k=1,#KEYS do local limit=tonumber(ARGV[i]); local ttl=tonumber(ARGV[i+1]); local cur=tonumber(redis.call('GET',KEYS[k]) or '0'); if limit>0 and cur+cost>limit then return -1 end; i=i+2 end; i=2; for k=1,#KEYS do local cur=redis.call('INCRBY',KEYS[k],cost); local ttl=tonumber(ARGV[i+1]); if cur==cost then redis.call('EXPIRE',KEYS[k],ttl) end; i=i+2 end; return cost`;
  const result = Number(await redisEval(script, keys, args, 1600));
  if (!Number.isFinite(result)) return { ok: false, unavailable: true, reserved: 0, enforced: true };
  if (result < 0) return { ok: false, budgetExceeded: true, reserved: 0, enforced: true, action };
  return { ok: true, reserved: cost, enforced: true };
}

export async function recordProviderUsage({ ipHash = '', userIdHash = '', costPaise = 0, action = 'generic', provider = '', usage = null } = {}) {
  const cost = Math.max(0, Math.floor(Number(costPaise) || 0));
  if (!REDIS_ENABLED) return { ok: false, unavailable: true };
  const event = {
    ts: new Date().toISOString(),
    action: clean(action, 80),
    provider: clean(provider, 80),
    costPaise: cost,
    ipHash: clean(ipHash, 128),
    userIdHash: clean(userIdHash, 128),
    usage: usage && typeof usage === 'object' ? sanitizeUsage(usage) : null,
  };
  await redisPipeline([
    ['LPUSH', 'arix:safe:provider-usage', JSON.stringify(event)],
    ['LTRIM', 'arix:safe:provider-usage', '0', '1999'],
  ], 1200);
  return { ok: true, recorded: true, costPaise: cost };
}

function sanitizeUsage(usage) {
  const out = {};
  for (const [k, v] of Object.entries(usage).slice(0, 30)) {
    if (/secret|token|key|password|prompt|content|authorization/i.test(k)) continue;
    if (typeof v === 'number' || typeof v === 'string' || typeof v === 'boolean') out[clean(k, 80)] = typeof v === 'string' ? clean(v, 200) : v;
  }
  return out;
}

async function requestSignals(req, body, action, session, limits) {
  const ip = getIp(req);
  const device = getDeviceId(req, body || {});
  const ua = getUserAgent(req);
  const path = (() => { try { return new URL(req.url).pathname; } catch { return '/'; } })();
  const inputText = flattenUserText(body);
  const fp = await sha256Hex(`${inputText}|${action}|${body?.modelId || body?.model || ''}`);
  const [ipHash, userIdHash, deviceHash, uaHash] = await Promise.all([
    sha256Hex(ip),
    sha256Hex(session?.userId || session?.email || ''),
    sha256Hex(device),
    sha256Hex(ua),
  ]);

  const active = await blockState(`arix:safe:block:ip:${ipHash}`);
  if (active) return { blocked: true, score: 100, rules: ['active-block'], ipHash, userIdHash, deviceHash, uaHash, fp, path, ua, rate: { rpm: { count: 0 } } };

  const rpm = await rateLimit(`arix:safe:rate:${action}:rpm:${ipHash}`, limits.rpm, 60);
  const rph = await rateLimit(`arix:safe:rate:${action}:rph:${ipHash}`, limits.rph, 3600);
  const rpd = await rateLimit(`arix:safe:rate:${action}:rpd:${ipHash}`, limits.rpd, 86400);
  const accountRate = session?.authenticated && userIdHash
    ? await rateLimit(`arix:safe:rate:${action}:acct:${userIdHash}`, Math.max(1, limits.rph), 3600)
    : { ok: true, count: 0, distributed: REDIS_ENABLED };

  const shape = validateShape(body, limits);
  const text = normalizeText(inputText, 300_000);
  const textHits = [];
  let textScore = 0;
  for (const rule of RULES) {
    if (rule.re.test(text)) { textHits.push(rule.id); textScore += rule.score; }
  }
  const opCount = (text.match(/[{}<>;$`|]|\b(?:eval|exec|spawn|fetch|axios)\b/gi) || []).length;
  if (opCount >= 18) { textHits.push('operator-density'); textScore += 28; }
  if (text.length > limits.promptChars) { textHits.push('oversized-prompt'); textScore += 35; }
  if (text.length > 250_000) { textHits.push('extreme-prompt'); textScore += 45; }

  const headerEval = evaluateHeaders(req);
  const rules = [...new Set([...shape.hits, ...textHits, ...headerEval.hits])];
  let score = clamp(shape.score + textScore + headerEval.score, 0, 100);
  const ratePeak = Math.max(Number(rpm.count) || 0, Number(rph.count) || 0, Number(rpd.count) || 0, Number(accountRate.count) || 0);
  if (ratePeak >= 35) { score += 18; rules.push('burst-rate'); }
  if (ratePeak >= 70) { score += 30; rules.push('high-rate'); }
  if (ratePeak >= 120) { score += 50; rules.push('request-flood'); }
  score = clamp(score, 0, 100);

  let aiVerdict = null;
  if (shouldAiJudge(score, rules)) {
    aiVerdict = await optionalAiJudge({ action, score, rules: rules.slice(0, 24), requestBytes: safeJsonLength(body), promptChars: text.length, method: req.method, path, country: getCountry(req), ratePeak });
    if (aiVerdict?.malicious && aiVerdict.confidence >= 90) score = Math.max(score, aiVerdict.confidence);
  }

  const blockSeconds = actionBlockSeconds(score, ratePeak);
  const distributedAvailable = [rpm, rph, rpd, accountRate].every(x => x?.distributed !== false && !x?.unavailable);
  return { blocked: false, score, rules: [...new Set(rules)].slice(0, 40), ipHash, userIdHash, deviceHash, uaHash, fp, path, ua, rate: { rpm, rph, rpd, account: accountRate }, ratePeak, blockSeconds, aiVerdict, distributedAvailable };
}

async function enforcePostProviderBudget(body, action, session, signals, options) {
  const estimator = options.costPaise;
  let cost = 0;
  if (typeof estimator === 'function') {
    try { cost = await estimator({ body, session, action, signals }); } catch { cost = 0; }
  } else {
    cost = Number(estimator || 0);
  }
  if (!Number.isFinite(cost) || cost < 0) cost = 0;
  if (!cost) return { ok: true, reserved: 0, enforced: false };
  const result = await reserveSpend({ ipHash: signals.ipHash, userIdHash: signals.userIdHash, costPaise: cost, action });
  return result;
}

function methodAllowed(req, action, options) {
  const methods = Array.isArray(options.methods) && options.methods.length ? options.methods : (METHOD_DEFAULTS[action] || METHOD_DEFAULTS.generic);
  return methods.includes(String(req.method || '').toUpperCase());
}

function contentTypeAllowed(req, action, options) {
  if (options.contentTypes == null) return true;
  const ct = clean(req.headers.get('content-type') || '').toLowerCase();
  return options.contentTypes.some(x => ct.startsWith(String(x).toLowerCase()));
}

export async function protectRequest(req, options = {}) {
  const action = clean(options.action || 'generic', 80).toLowerCase();
  const requestStart = Date.now();
  const requestIdValue = requestId(req);
  const limits = getLimits(action, options.limits);
  const failClosed = failClosedNeeded(action, options);

  try {
    assertOrigin(req, { allowNoOrigin: options.allowNoOrigin !== false });
    if (!methodAllowed(req, action, options)) throw new SafeError(405, 'METHOD_NOT_ALLOWED', 'HTTP method is not allowed.');
    if (!contentTypeAllowed(req, action, options)) throw new SafeError(415, 'CONTENT_TYPE_FORBIDDEN', 'Content type is not allowed.');
    await ensureFeatureEnabled(action);

    if (['GET', 'HEAD'].includes(String(req.method).toUpperCase())) {
      const headerLength = Number(clean(req.headers.get('content-length') || '', 80));
      if (Number.isFinite(headerLength) && headerLength > limits.body) throw new SafeError(413, 'PAYLOAD_TOO_LARGE', 'Request payload is too large.');
    }

    let parsed = { body: null, raw: '' };
    if (options.readBody !== false && !['GET', 'HEAD'].includes(String(req.method).toUpperCase())) {
      parsed = await bodyFromRequest(req, limits.body);
    }

    const session = await verifySecureSession(req, { requireAuth: options.auth === 'required' || options.auth === 'admin' });
    if (options.auth === 'required') assertAuthorized(session, { roles: options.roles || [], permissions: options.permissions || [] });
    if (options.auth === 'admin') { assertAdmin(session); }

    const signals = await requestSignals(req, parsed.body, action, session, limits);
    if (signals.blocked) throw new SafeError(429, 'SECURITY_BLOCKED', 'Security protection blocked this request.');

    const distributedFailure = !signals.distributedAvailable && REDIS_ENABLED === false;
    if (failClosed && !REDIS_ENABLED) throw new SafeError(503, 'SECURITY_STORAGE_UNAVAILABLE', 'Security storage is unavailable; protected operations are fail-closed.');
    if (failClosed && REDIS_ENABLED && [signals.rate.rpm, signals.rate.rph, signals.rate.rpd].some(x => x?.unavailable)) {
      throw new SafeError(503, 'RATE_LIMIT_UNAVAILABLE', 'Rate-limit storage is temporarily unavailable; protected operation is fail-closed.');
    }

    const threshold = Number(process.env.ARIX_SAFE_BLOCK_THRESHOLD || 70);
    const shouldBlock = signals.score >= threshold || (signals.aiVerdict?.malicious && signals.aiVerdict.confidence >= 95);
    let actionTaken = 'allow';
    if (shouldBlock) {
      const seconds = signals.blockSeconds || 900;
      const set = await setBlock(`arix:safe:block:ip:${signals.ipHash}`, seconds, signals.rules.join(','), signals.score);
      if (set) { actionTaken = `temporary-block-${seconds}s`; }
      else if (failClosed) throw new SafeError(429, 'SECURITY_BLOCKED', 'Security protection blocked this request.');
      else actionTaken = 'observe-only-block-fallback';
      if (set) throw new SafeError(429, 'SECURITY_BLOCKED', 'Security protection blocked this request.');
    }

    const budget = options.costPaise != null ? await enforcePostProviderBudget(parsed.body, action, session, signals, options) : { ok: true, reserved: 0, enforced: false };
    if (!budget.ok) {
      if (budget.budgetExceeded) throw new SafeError(402, 'SPEND_LIMIT_REACHED', 'Operation refused because the configured spending limit was reached.');
      if (budget.unavailable && failClosed) throw new SafeError(503, 'SPEND_CONTROL_UNAVAILABLE', 'Spending protection is unavailable; protected operation is fail-closed.');
    }

    const event = {
      id: requestIdValue,
      ts: new Date().toISOString(),
      action,
      method: req.method,
      path: (() => { try { return new URL(req.url).pathname; } catch { return '/'; } })(),
      severity: SEVERITY[signals.score >= 70 ? 4 : signals.score >= 48 ? 3 : signals.score >= 28 ? 2 : signals.score >= 12 ? 1 : 0],
      score: signals.score,
      rules: signals.rules,
      ipHash: signals.ipHash,
      userIdHash: signals.userIdHash,
      deviceHash: signals.deviceHash,
      uaHash: signals.uaHash,
      country: getCountry(req),
      requestBytes: safeJsonLength(parsed.body),
      messageCount: Array.isArray(parsed.body?.messages) ? parsed.body.messages.length : 0,
      latencyMs: Date.now() - requestStart,
      aiVerdict: signals.aiVerdict,
      decision: actionTaken,
    };
    void securityLog(event);

    return {
      ok: true,
      requestId: requestIdValue,
      action,
      limits,
      body: parsed.body,
      session,
      security: event,
      budget,
      distributed: REDIS_ENABLED,
      failClosed,
      version: VERSION,
    };
  } catch (error) {
    if (error instanceof SafeError) {
      const event = {
        id: requestIdValue,
        ts: new Date().toISOString(),
        action,
        method: req.method,
        path: (() => { try { return new URL(req.url).pathname; } catch { return '/'; } })(),
        severity: error.code === 'SECURITY_BLOCKED' ? 'high' : 'medium',
        score: error.code === 'SECURITY_BLOCKED' ? 90 : 40,
        rules: [error.code],
        ipHash: await sha256Hex(getIp(req)),
        userIdHash: '',
        deviceHash: '',
        uaHash: await sha256Hex(getUserAgent(req)),
        country: getCountry(req),
        requestBytes: 0,
        messageCount: 0,
        latencyMs: Date.now() - requestStart,
        aiVerdict: null,
        decision: 'deny',
      };
      void securityLog(event);
      return { ok: false, response: errorResponse(error.status, error.code, error.message, { requestId: requestIdValue, securityVersion: VERSION }), error };
    }
    // Never expose stack traces, secrets, provider responses, internal paths, or env values.
    const event = {
      id: requestIdValue,
      ts: new Date().toISOString(),
      action,
      method: req.method,
      path: (() => { try { return new URL(req.url).pathname; } catch { return '/'; } })(),
      severity: 'high',
      score: 60,
      rules: ['internal-security-error'],
      ipHash: await sha256Hex(getIp(req)),
      userIdHash: '',
      deviceHash: '',
      uaHash: await sha256Hex(getUserAgent(req)),
      country: getCountry(req),
      requestBytes: 0,
      messageCount: 0,
      latencyMs: Date.now() - requestStart,
      aiVerdict: null,
      decision: 'error-deny',
    };
    void securityLog(event);
    const status = failClosed ? 503 : 500;
    return { ok: false, response: errorResponse(status, 'SAFE_GATEWAY_ERROR', 'Request could not be completed safely.', { requestId: requestIdValue, securityVersion: VERSION }), error };
  }
}

export function safeResponse(response, requestIdValue = '') {
  const headers = new Headers(response?.headers || {});
  const securityHeaders = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
    'Cache-Control': headers.get('Cache-Control') || 'no-store, max-age=0',
  };
  for (const [k, v] of Object.entries(securityHeaders)) headers.set(k, v);
  if (requestIdValue) headers.set('X-Arix-Request-Id', requestIdValue);
  return new Response(response?.body ?? null, { status: response?.status || 200, statusText: response?.statusText || '', headers });
}

export function redactError(error) {
  const message = clean(error?.message || 'Internal error', 240)
    .replace(/(?:sk|AIza|gsk)_[A-Za-z0-9_-]+/g, '[REDACTED_KEY]')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer [REDACTED]')
    .replace(/https?:\/\/[^\s]+/g, '[REDACTED_URL]');
  return message || 'Internal error';
}

export function sanitizeOutput(value, options = {}) {
  const maxChars = Number(options.maxChars || 200_000);
  if (typeof value === 'string') return value.slice(0, maxChars);
  if (value == null) return value;
  try {
    const seen = new WeakSet();
    const walk = (v, depth = 0) => {
      if (depth > 12) return '[TRUNCATED]';
      if (typeof v === 'string') return v.slice(0, maxChars);
      if (typeof v !== 'object' || v === null) return v;
      if (seen.has(v)) return '[CIRCULAR]';
      seen.add(v);
      if (Array.isArray(v)) return v.slice(0, 500).map(x => walk(x, depth + 1));
      const o = {};
      for (const [k, x] of Object.entries(v).slice(0, 500)) {
        if (/password|secret|token|api[_-]?key|authorization|cookie|set-cookie|private[_-]?key|pwdhash/i.test(k)) continue;
        o[k] = walk(x, depth + 1);
      }
      return o;
    };
    return walk(value);
  } catch { return null; }
}

export function withSafeAPI(handler, options = {}) {
  if (typeof handler !== 'function') throw new TypeError('withSafeAPI requires a function handler.');
  return async function safeWrappedHandler(req, ...rest) {
    const gate = await protectRequest(req, options);
    if (!gate.ok) return gate.response;
    try {
      // Existing handlers keep receiving the standard Request as their first arg.
      // The second arg is a security context; older handlers can ignore it safely.
      const response = await handler(req, { ...gate, safe: true }, ...rest);
      return safeResponse(response instanceof Response ? response : jsonResponse(response || { ok: true }), gate.requestId);
    } catch (error) {
      const message = clean(process.env.NODE_ENV === 'development' ? redactError(error) : 'Internal server error.', 240);
      return safeResponse(errorResponse(500, 'HANDLER_FAILED', message, { requestId: gate.requestId, securityVersion: VERSION }), gate.requestId);
    }
  };
}

async function requireAdminKey(req) {
  if (!ADMIN_KEY) throw new SafeError(503, 'ADMIN_KEY_NOT_CONFIGURED', 'Security administration is not configured.');
  const provided = clean(req.headers.get('x-security-admin') || req.headers.get('x-admin-password') || '', 1024);
  if (!provided || !(await timingSafeEqual(provided, ADMIN_KEY))) throw new SafeError(401, 'ADMIN_UNAUTHORIZED', 'Unauthorized.');
}

export async function securityControl(req) {
  try {
    assertOrigin(req, { allowNoOrigin: false });
    await requireAdminKey(req);
    if (!REDIS_ENABLED) return errorResponse(503, 'SECURITY_STORAGE_UNAVAILABLE', 'Upstash Redis is not configured.');

    if (req.method === 'GET') {
      const result = await redisPipeline([
        ['LRANGE', 'arix:safe:events', '0', '199'],
        ['LRANGE', 'arix:safe:incidents', '0', '99'],
        ['MGET', 'arix:safe:kill:global', 'arix:safe:kill:chat', 'arix:safe:kill:research', 'arix:safe:kill:image', 'arix:safe:kill:video', 'arix:safe:kill:crawler', 'arix:safe:kill:file', 'arix:safe:kill:workspace'],
      ], 1800);
      const parse = x => Array.isArray(x) ? x.map(v => { try { return JSON.parse(v); } catch { return v; } }).filter(Boolean) : [];
      const ks = result?.[2]?.result || result?.[2] || [];
      return jsonResponse({
        ok: true,
        version: VERSION,
        generatedAt: new Date().toISOString(),
        events: parse(result?.[0]?.result || result?.[0]),
        incidents: parse(result?.[1]?.result || result?.[1]),
        killSwitches: {
          global: String(ks?.[0] || '').toLowerCase() === 'true',
          chat: String(ks?.[1] || '').toLowerCase() === 'true',
          research: String(ks?.[2] || '').toLowerCase() === 'true',
          image: String(ks?.[3] || '').toLowerCase() === 'true',
          video: String(ks?.[4] || '').toLowerCase() === 'true',
          crawler: String(ks?.[5] || '').toLowerCase() === 'true',
          file: String(ks?.[6] || '').toLowerCase() === 'true',
          workspace: String(ks?.[7] || '').toLowerCase() === 'true',
        },
      });
    }

    if (req.method !== 'POST') return errorResponse(405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
    const { body } = await bodyFromRequest(req, 64_000);
    const action = clean(body?.action || '', 40).toLowerCase();
    if (action === 'kill' || action === 'unkill') {
      const feature = clean(body?.feature || 'global', 40).toLowerCase();
      const allowed = new Set(['global', 'chat', 'research', 'image', 'video', 'crawler', 'file', 'workspace']);
      if (!allowed.has(feature)) return errorResponse(400, 'INVALID_FEATURE', 'Invalid feature.');
      const value = action === 'kill' ? 'true' : 'false';
      await redisCommand(['SET', `arix:safe:kill:${feature}`, value], 1200);
      return jsonResponse({ ok: true, action, feature, enabled: value === 'false', generatedAt: new Date().toISOString() });
    }
    if (action === 'unblock') {
      const ipHash = clean(body?.ipHash || '', 128);
      if (!/^[a-f0-9]{64}$/.test(ipHash)) return errorResponse(400, 'INVALID_IP_HASH', 'ipHash must be a SHA-256 hash.');
      await redisCommand(['DEL', `arix:safe:block:ip:${ipHash}`], 1000);
      return jsonResponse({ ok: true, action, ipHash });
    }
    if (action === 'clear_logs') {
      await redisPipeline([['DEL', 'arix:safe:events'], ['DEL', 'arix:safe:incidents']], 1500);
      return jsonResponse({ ok: true, action });
    }
    return errorResponse(400, 'UNKNOWN_ACTION', 'Unknown security-control action.');
  } catch (error) {
    if (error instanceof SafeError) return errorResponse(error.status, error.code, error.message);
    return errorResponse(500, 'SECURITY_CONTROL_ERROR', 'Security control operation failed safely.');
  }
}

export async function runSecuritySelfTest() {
  const checks = [];
  const pass = (name, value, detail = '') => checks.push({ name, ok: Boolean(value), detail });
  pass('crypto.subtle', Boolean(crypto?.subtle), 'Web Crypto is available.');
  pass('fetch', typeof fetch === 'function', 'Edge fetch is available.');
  pass('redis-configured', REDIS_ENABLED, REDIS_ENABLED ? 'Upstash REST is configured.' : 'Upstash REST is not configured.');
  pass('session-secret-configured', Boolean(SESSION_SECRET), SESSION_SECRET ? 'Session HMAC secret is configured.' : 'Session HMAC secret is not configured.');
  pass('origin-configured', ALLOWED_ORIGINS.length > 0, ALLOWED_ORIGINS.length ? 'Allowed origin list is configured.' : 'Allowed origin list is not configured.');
  pass('public-url-https', !PUBLIC_URL || PUBLIC_URL.startsWith('https://'), !PUBLIC_URL || PUBLIC_URL.startsWith('https://') ? 'OK.' : 'ARIX_PUBLIC_URL should use HTTPS.');
  return { ok: checks.every(x => x.ok), version: VERSION, generatedAt: new Date().toISOString(), checks };
}

export default protectRequest;
