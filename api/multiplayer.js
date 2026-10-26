export const config = { runtime: 'edge' };

const TTL_SECONDS = 43200;
const MAX_STORED_MESSAGES = 100;
const MAX_MESSAGE_CHARS = 190000;
const MAX_REQUEST_CHARS = 220000;
const MAX_SENDS_PER_MINUTE = 50;

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store, max-age=0',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
      'referrer-policy': 'no-referrer',
      ...extraHeaders,
    },
  });
}

function cleanNickname(value) {
  return String(value || 'Anonymous').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 32) || 'Anonymous';
}

function createId() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function hashText(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function getEnvelope(message) {
  const prefix = 'ARIXCHAT1:';
  if (typeof message !== 'string' || !message.startsWith(prefix)) return null;
  try {
    const parsed = JSON.parse(message.slice(prefix.length));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function validIdempotencyId(value) {
  return typeof value === 'string' && /^[a-zA-Z0-9_-]{8,128}$/.test(value) ? value : '';
}

async function upstash(url, token, commands) {
  const response = await fetch(`${url.replace(/\/+$/, '')}/pipeline`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify(commands),
  });
  if (!response.ok) throw new Error('Database request failed');
  const result = await response.json();
  if (!Array.isArray(result) || result.some(item => item && item.error)) throw new Error('Database operation failed');
  return result;
}

const SEND_LUA = `
local idem = ARGV[6]
if idem ~= '' then
  local prior = redis.call('GET', KEYS[2])
  if prior then return {0, prior} end
end
local count = redis.call('INCR', KEYS[3])
if count == 1 then redis.call('EXPIRE', KEYS[3], 60) end
if count > tonumber(ARGV[5]) then return {-1, 'rate_limited'} end
if idem ~= '' then redis.call('SET', KEYS[2], ARGV[1], 'EX', tonumber(ARGV[3])) end
redis.call('RPUSH', KEYS[1], ARGV[2])
redis.call('LTRIM', KEYS[1], -tonumber(ARGV[4]), -1)
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[3]))
return {1, ARGV[1]}
`;

export default async function handler(req) {
  if (req.method !== 'POST') return json({ success: false, error: 'Method not allowed' }, 405, { allow: 'POST' });

  const origin = req.headers.get('origin');
  if (origin) {
    try {
      if (new URL(origin).origin !== new URL(req.url).origin) return json({ success: false, error: 'Origin not allowed' }, 403);
    } catch {
      return json({ success: false, error: 'Invalid origin' }, 403);
    }
  }

  const contentType = req.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) return json({ success: false, error: 'JSON required' }, 415);
  const contentLength = Number(req.headers.get('content-length') || 0);
  if (contentLength > MAX_REQUEST_CHARS) return json({ success: false, error: 'Request is too large' }, 413);

  let input;
  try {
    const body = await req.text();
    if (!body || body.length > MAX_REQUEST_CHARS) return json({ success: false, error: 'Request is too large or empty' }, 413);
    input = JSON.parse(body);
  } catch {
    return json({ success: false, error: 'Invalid JSON body' }, 400);
  }

  const { roomId, action } = input || {};
  if (typeof roomId !== 'string' || !/^[a-zA-Z0-9_-]{4,80}$/.test(roomId)) return json({ success: false, error: 'Invalid room ID' }, 400);
  if (!['send', 'poll'].includes(action)) return json({ success: false, error: 'Invalid action' }, 400);

  const env = typeof process !== 'undefined' && process.env ? process.env : {};
  const upstashUrl = "https://immortal-eagle-36171.upstash.io";
  const upstashToken = "AY1LAAIgcDE5MjFiMmNkNGQ4M2M0ODQ2YWNhYjU0YmFmMzlhNjliNw";
  if (!upstashUrl || !upstashToken) return json({ success: false, error: 'Chat service is not configured' }, 503);

  const roomKey = `room:${roomId}`;
  try {
    if (action === 'send') {
      const { message } = input;
      if (typeof message !== 'string' || !message.length || message.length > MAX_MESSAGE_CHARS) {
        return json({ success: false, error: 'Message is invalid or too large' }, 400);
      }
      const nickname = cleanNickname(input.nickname);
      const envelope = getEnvelope(message);
      const idempotencyId = validIdempotencyId(envelope?.clientMessageId) || validIdempotencyId(envelope?.eventId);
      const id = createId();
      const ts = Date.now();
      const record = JSON.stringify({ id, nickname, message, ts });
      const idemKey = `idem:${roomId}:${idempotencyId || 'none'}`;
      const rateKey = `rate:${roomId}:${hashText(nickname.toLowerCase())}`;
      const result = await upstash(upstashUrl, upstashToken, [[
        'EVAL', SEND_LUA, 3, roomKey, idemKey, rateKey,
        id, record, TTL_SECONDS, MAX_STORED_MESSAGES, MAX_SENDS_PER_MINUTE, idempotencyId,
      ]]);
      const operation = result[0]?.result;
      if (!Array.isArray(operation) || operation.length < 2) return json({ success: false, error: 'Chat service could not save the message' }, 502);
      const code = Number(operation[0]);
      if (code === -1) return json({ success: false, error: 'Too many actions in this room. Please wait a minute.' }, 429, { 'retry-after': '60' });
      // code 0 means this clientMessageId/eventId was already saved; return the original ID.
      return json({ success: true, id: String(operation[1]), ts, duplicate: code === 0 });
    }

    const result = await upstash(upstashUrl, upstashToken, [
      ['LRANGE', roomKey, 0, -1],
      ['EXPIRE', roomKey, TTL_SECONDS],
    ]);
    const rawMessages = result[0]?.result;
    if (!Array.isArray(rawMessages)) return json({ success: false, error: 'Chat history is unavailable' }, 502);
    const messages = [];
    for (const raw of rawMessages) {
      if (typeof raw !== 'string') continue;
      try {
        const item = JSON.parse(raw);
        if (item && typeof item === 'object' && typeof item.message === 'string') messages.push(item);
      } catch {
        // Ignore corrupted historical records rather than failing the whole room poll.
      }
    }
    return json({ success: true, messages });
  } catch {
    // Keep provider credentials, request bodies, and infrastructure details out of client errors.
    return json({ success: false, error: 'Chat service is temporarily unavailable' }, 502);
  }
}
