import { authenticateArixSession } from './otp.js';

export const config = { runtime: 'edge' };

const PREFIX = 'ARIXCHAT1:';
const MAX_REQUEST_CHARS = 220000;
const MAX_STORED_MESSAGE_CHARS = 190000;
const MAX_TEXT_CHARS = 4000;
const MAX_ATTACHMENT_DATA_CHARS = 150000;
const MAX_ACTIONS_PER_ROOM_PER_MINUTE = 80;
const ROOM_ID_RE = /^[a-zA-Z0-9_-]{24,80}$/;
const IDEM_RE = /^[a-zA-Z0-9_-]{8,128}$/;
const ALLOWED_ATTACHMENT_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'application/pdf', 'text/plain',
]);
const CHAT_SESSION_COOKIE = 'arixchat_session';
const CHAT_SESSION_TTL_SECONDS = 8 * 60 * 60;
const SHADOW_EMAIL_DOMAIN = 'identity.arixchat.invalid';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ARIX_CALL_ID_RE = /^ARX-[A-F0-9]{32}$/;
const CALL_ID_RE = /^[a-zA-Z0-9_-]{24,80}$/;
const CALL_USER_TTL_SECONDS = 2592000;
const CALL_PRESENCE_TTL_SECONDS = 55;
const CALL_RING_TTL_SECONDS = 50;
const CALL_SESSION_TTL_SECONDS = 21600;
const CALL_SIGNAL_TYPES = new Set(['accept', 'decline', 'cancel', 'hangup', 'offer', 'answer', 'ice']);

function runtimeEnv() {
  const env = typeof process !== 'undefined' && process.env ? process.env : {};
  const url = String(env.SUPABASE_URL || "https://vvcpfdofihdmzshdglxr.supabase.co").trim().replace(/\/+$/, '');
  const serviceKey = String(env.SUPABASE_SECRET_KEY || env.SUPABASE_SERVICE_ROLE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ2Y3BmZG9maWhkbXpzaGRnbHhyIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NTA2NzQ5MCwiZXhwIjoyMTAwNjQzNDkwfQ.ACRUkwnNiVg-6ZNqSlKYYev0csd_cT6tgiL0T0fPKLQ").trim();
  if (!url || !serviceKey) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') return null;
    if (parsed.pathname !== '/' && parsed.pathname !== '') return null;
  } catch { return null; }
  return { url, serviceKey };
}
function json(body, status = 200, extraHeaders = {}, cookies = []) {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store, max-age=0',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
    'permissions-policy': 'camera=(), microphone=(), geolocation=()',
    ...extraHeaders,
  });
  for (const cookie of cookies) headers.append('set-cookie', cookie);
  return new Response(JSON.stringify(body), { status, headers });
}

function cookieValue(req, name) {
  const header = req.headers.get('cookie') || '';
  for (const item of header.split(';')) {
    const i = item.indexOf('=');
    if (i < 0) continue;
    if (item.slice(0, i).trim() === name) return item.slice(i + 1).trim();
  }
  return '';
}
function cleanName(value) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 32);
}
function cleanRoomTitle(value) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 48) || 'New conversation';
}
function createId() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}
function validIdempotencyId(value) {
  return typeof value === 'string' && IDEM_RE.test(value) ? value : '';
}
function parseEnvelope(message) {
  if (typeof message !== 'string' || !message.startsWith(PREFIX)) return null;
  try {
    const value = JSON.parse(message.slice(PREFIX.length));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  } catch { return null; }
}
async function readJsonResponse(response) {
  try { return await response.json(); } catch { return {}; }
}
function cookiePairs(req, excludeChatCookie = true) {
  const header = req.headers.get('cookie') || '';
  const pairs = [];
  for (const item of header.split(';')) {
    const i = item.indexOf('=');
    if (i < 0) continue;
    const name = item.slice(0, i).trim();
    const value = item.slice(i + 1).trim();
    if (!name) continue;
    if (excludeChatCookie && (name.toLowerCase() === CHAT_SESSION_COOKIE || name.toLowerCase() === 'arix_access' || name.toLowerCase() === 'arix_refresh')) continue;
    pairs.push([name, value]);
  }
  return pairs;
}
async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(String(value));
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
}
async function parentCookieFingerprint(req) {
  const pairs = cookiePairs(req, true);
  if (!pairs.length) return '';
  // Prefer auth/session cookies; fall back to all non-ArixChat cookies for
  // deployments whose session-cookie name is custom.
  const relevant = pairs.filter(([name]) => /session|auth|access|refresh|token|(?:^|[_-])sid(?:$|[_-])/i.test(name));
  const chosen = (relevant.length ? relevant : pairs).sort((a, b) => a[0].localeCompare(b[0]));
  return sha256Hex(JSON.stringify(chosen));
}
function base64UrlBytes(bytes) {
  let binary = '';
  for (const value of bytes) binary += String.fromCharCode(value);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}
function decodeBase64Url(text) {
  const normalized = String(text).replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(normalized + '='.repeat((4 - normalized.length % 4) % 4));
  return Uint8Array.from(binary, ch => ch.charCodeAt(0));
}
async function hmacBase64Url(value, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value));
  return base64UrlBytes(new Uint8Array(signature));
}
function sameStringConstantTime(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
async function createChatSessionCookie(user, parentFingerprint, cfg) {
  const payload = {
    v: 1,
    sub: String(user.id),
    email: String(user.email || ''),
    displayName: cleanName(user.displayName || 'ArixAI user') || 'ArixAI user',
    parent: parentFingerprint,
    exp: Date.now() + CHAT_SESSION_TTL_SECONDS * 1000,
  };
  const encoded = base64UrlBytes(new TextEncoder().encode(JSON.stringify(payload)));
  const signature = await hmacBase64Url(encoded, cfg.serviceKey);
  return `${CHAT_SESSION_COOKIE}=${encoded}.${signature}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${CHAT_SESSION_TTL_SECONDS}`;
}
function clearChatSessionCookie() {
  return `${CHAT_SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}
async function readChatSessionCookie(req, cfg, parentFingerprint) {
  const value = cookieValue(req, CHAT_SESSION_COOKIE);
  if (!value || !parentFingerprint) return null;
  const dot = value.lastIndexOf('.');
  if (dot <= 0) return null;
  const encoded = value.slice(0, dot);
  const suppliedSignature = value.slice(dot + 1);
  let expectedSignature;
  try { expectedSignature = await hmacBase64Url(encoded, cfg.serviceKey); } catch { return null; }
  if (!sameStringConstantTime(suppliedSignature, expectedSignature)) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(decodeBase64Url(encoded)));
    if (payload?.v !== 1 || !UUID_RE.test(String(payload.sub || '')) || !Number.isFinite(Number(payload.exp))
        || Number(payload.exp) <= Date.now()) return null;
    if (!sameStringConstantTime(String(payload.parent || ''), parentFingerprint)) return null;
    return { id: String(payload.sub), email: String(payload.email || ''), displayName: cleanName(payload.displayName) || 'ArixAI user' };
  } catch { return null; }
}
function authAdminHeaders(cfg, jsonBody = false) {
  const headers = {
    apikey: cfg.serviceKey,
    authorization: `Bearer ${cfg.serviceKey}`,
    accept: 'application/json',
  };
  if (jsonBody) headers['content-type'] = 'application/json';
  return headers;
}
function candidateValue(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 256);
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return '';
}
function extractMainAppIdentity(body, displayNameHint, parentFingerprint) {
  const sources = [
    body, body?.user, body?.account, body?.profile, body?.auth,
    body?.data, body?.data?.user, body?.data?.account, body?.data?.profile,
    body?.data?.auth, body?.data?.session, body?.data?.account?.user,
  ].filter(Boolean);
  // Prefer ID fields nested under an explicit identity object. Do not accidentally
  // treat an arbitrary bootstrap payload's generic `data.id` as an account ID.
  const serverId = candidateValue(
    body?.user?.id, body?.account?.id, body?.profile?.id, body?.auth?.user?.id,
    body?.data?.user?.id, body?.data?.account?.id, body?.data?.profile?.id,
    body?.data?.auth?.user?.id, body?.userId, body?.user_id, body?.accountId, body?.account_id,
  );
  const email = candidateValue(...sources.map(source => source?.email)).toLowerCase();
  const handle = candidateValue(...sources.flatMap(source => [source?.arixName, source?.arixname, source?.username, source?.loginId, source?.login_id]));
  const serverName = candidateValue(...sources.flatMap(source => [source?.displayName, source?.display_name, source?.fullName, source?.full_name, source?.username, source?.arixName, source?.nickname, source?.name]));
  const identityKey = serverId ? `id:${serverId}` : email ? `email:${email}` : handle ? `handle:${handle.toLowerCase()}` : `session:${parentFingerprint}`;
  return {
    identityKey,
    displayName: cleanName(serverName || displayNameHint || handle || email.split('@')[0] || 'ArixAI user') || 'ArixAI user',
    email: email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : '',
  };
}
async function validateMainAppSession(req, parentFingerprint, displayNameHint) {
  let result;
  try {
    // Reuse the existing authoritative ArixAI session validator. The OTP API
    // validates the HttpOnly arix_session cookie against Redis and returns the
    // trusted user record; no browser token or localStorage identity is trusted.
    result = await authenticateArixSession(req);
  } catch (error) {
    const e = new Error('ArixAI session verification failed. Check that the main app authentication service is available.');
    e.code = error?.code === 'ORIGIN_DENIED' ? 'MAIN_SESSION_ORIGIN_DENIED' : 'MAIN_SESSION_UNAVAILABLE';
    throw e;
  }
  if (!result?.authenticated || !result?.user) return { authenticated: false };
  const mainUser = result.user;
  const data = {
    user: {
      id: candidateValue(mainUser.uid, mainUser.id, mainUser.userId),
      email: mainUser.email,
      arixName: mainUser.arixName,
      username: mainUser.displayName || mainUser.username,
      displayName: mainUser.displayName || mainUser.username || mainUser.arixName,
    },
  };
  return { authenticated: true, account: extractMainAppIdentity(data, displayNameHint, parentFingerprint) };
}
function runtimeRedisEnv() {
  const env = typeof process !== 'undefined' && process.env ? process.env : {};
  const url = String(env.UPSTASH_REDIS_REST_URL || "https://immortal-eagle-36171.upstash.io" || '').trim().replace(/\/+$/, '');
  const token = String(env.UPSTASH_REDIS_REST_TOKEN || "AY1LAAIgcDE5MjFiMmNkNGQ4M2M0ODQ2YWNhYjU0YmFmMzlhNjliNw" || '').trim();
  if (!url || !token) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
  } catch { return null; }
  return { url, token };
}
async function redisCommand(redis, ...command) {
  if (!redis) return null;
  try {
    const response = await fetch(redis.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${redis.token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(command),
      cache: 'no-store',
    });
    const data = await readJsonResponse(response);
    if (!response.ok || data?.error) return null;
    return data?.result ?? null;
  } catch { return null; }
}
function callFail(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  return error;
}

async function callRedisCommand(redis, ...command) {
  if (!redis) throw callFail('ArixCall signaling is not configured. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN on the server.', 503);
  let response;
  try {
    response = await fetch(redis.url, {
      method: 'POST',
      headers: { authorization: `Bearer ${redis.token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(command),
      cache: 'no-store',
    });
  } catch {
    throw callFail('ArixCall signaling could not reach Redis. Please retry.', 503);
  }
  const data = await readJsonResponse(response);
  if (!response.ok || data?.error) {
    // Do not expose Redis credentials or raw server details to the browser.
    throw callFail('ArixCall signaling is temporarily unavailable. Please retry.', 503);
  }
  return data?.result ?? null;
}

function callUserChannel(userId) { return `arixcall-user-${userId}`; }
function getCallIceServers() {
  const env = typeof process !== 'undefined' && process.env ? process.env : {};
  const servers = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ];
  const urls = String(env.ARIXCALL_TURN_URLS || '').split(',').map(value => value.trim()).filter(value => /^turns?:/i.test(value));
  const username = String(env.ARIXCALL_TURN_USERNAME || '').trim();
  const credential = String(env.ARIXCALL_TURN_CREDENTIAL || '').trim();
  if (urls.length && username && credential) servers.push({ urls, username, credential });
  return servers;
}
function callIdentityKey(arixCallId) { return `arixcall:identity:${arixCallId}`; }
function callProfileKey(userId) { return `arixcall:profile:${userId}`; }
function callPresenceKey(userId) { return `arixcall:online:${userId}`; }
function callSessionKey(callId) { return `arixcall:session:${callId}`; }
function callActiveKey(userId) { return `arixcall:active:${userId}`; }

async function makeArixCallId(userId, cfg) {
  const hash = await sha256Hex(`${cfg.serviceKey}|arixcall-v1|${userId}`);
  return `ARX-${hash.slice(0, 32).toUpperCase()}`;
}

async function registerCallIdentity(user, cfg, displayName) {
  const redis = runtimeRedisEnv();
  if (!redis) throw callFail('ArixCall needs UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN configured on the server.', 503);
  const arixCallId = await makeArixCallId(user.id, cfg);
  const name = cleanName(displayName || user.displayName || 'ArixChat user') || 'ArixChat user';
  await callRedisCommand(redis, 'SET', callIdentityKey(arixCallId), String(user.id), 'EX', String(CALL_USER_TTL_SECONDS));
  await callRedisCommand(redis, 'SET', callProfileKey(user.id), JSON.stringify({ arixCallId, displayName: name }), 'EX', String(CALL_USER_TTL_SECONDS));
  return arixCallId;
}

async function publishCallEvent(redis, userId, event) {
  const delivered = await callRedisCommand(redis, 'PUBLISH', callUserChannel(userId), JSON.stringify(event));
  return Number(delivered) || 0;
}

async function releaseCallSession(redis, session) {
  for (const participantId of [session.callerId, session.calleeId]) {
    const key = callActiveKey(participantId);
    const activeId = await callRedisCommand(redis, 'GET', key).catch(() => null);
    if (String(activeId || '') === String(session.callId)) {
      await callRedisCommand(redis, 'DEL', key).catch(() => null);
    }
  }
  await callRedisCommand(redis, 'DEL', callSessionKey(session.callId)).catch(() => null);
}

async function resolveCallPeer(redis, arixCallId) {
  if (typeof arixCallId !== 'string' || !ARIX_CALL_ID_RE.test(arixCallId)) {
    throw callFail('Enter a valid ArixID, such as ARX-12AB34CD56EF789012AB34CD56EF7890.');
  }
  const userId = await callRedisCommand(redis, 'GET', callIdentityKey(arixCallId));
  if (!UUID_RE.test(String(userId || ''))) throw callFail('That ArixID was not found. Ask the person to open ArixChat and share their current ArixID.', 404);
  const profileRaw = await callRedisCommand(redis, 'GET', callProfileKey(String(userId)));
  let profile = {};
  try { profile = JSON.parse(String(profileRaw || '{}')); } catch { profile = {}; }
  const online = await callRedisCommand(redis, 'GET', callPresenceKey(String(userId)));
  return {
    userId: String(userId),
    arixCallId,
    displayName: cleanName(profile?.displayName || 'ArixChat user') || 'ArixChat user',
    online: String(online || '') === '1',
  };
}

function normalizeCallSignal(signalType, payload) {
  if (!CALL_SIGNAL_TYPES.has(signalType)) throw callFail('Unsupported ArixCall signal.');
  if (signalType === 'offer' || signalType === 'answer') {
    const sdp = typeof payload?.sdp === 'string' ? payload.sdp : '';
    if (!sdp || sdp.length > 26000 || !/^v=0\r?\n/.test(sdp)) throw callFail('The WebRTC session description is invalid or too large.');
    return { sdp };
  }
  if (signalType === 'ice') {
    const candidate = String(payload?.candidate || '');
    if (!candidate || candidate.length > 4096) throw callFail('The network candidate is invalid.');
    const mid = payload?.sdpMid == null ? null : String(payload.sdpMid).slice(0, 128);
    const line = payload?.sdpMLineIndex == null ? null : Number(payload.sdpMLineIndex);
    if (line !== null && (!Number.isInteger(line) || line < 0 || line > 256)) throw callFail('The network candidate is invalid.');
    return { candidate, sdpMid: mid, sdpMLineIndex: line, usernameFragment: payload?.usernameFragment == null ? null : String(payload.usernameFragment).slice(0, 256) };
  }
  return {};
}

async function handleCallStream(req, cfg) {
  const auth = await authenticateMainApp(req, cfg, {});
  if (!auth.user?.id) return json({ success: false, authenticated: false, error: 'Open the main ArixAI app and authenticate before using ArixCall.' }, 401, {}, auth.cookies || []);
  const redis = runtimeRedisEnv();
  if (!redis) return json({ success: false, error: 'ArixCall needs UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN configured on the server.' }, 503, {}, auth.cookies || []);
  let arixCallId;
  try { arixCallId = await registerCallIdentity(auth.user, cfg); }
  catch (error) { return json({ success: false, error: error.message || 'ArixCall identity setup failed.' }, error.status || 503, {}, auth.cookies || []); }

  let upstream;
  try {
    upstream = await fetch(`${redis.url}/subscribe/${encodeURIComponent(callUserChannel(auth.user.id))}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${redis.token}`, accept: 'text/event-stream', 'cache-control': 'no-cache' },
      signal: req.signal,
      cache: 'no-store',
    });
  } catch {
    return json({ success: false, error: 'ArixCall signaling could not open its secure stream. Please retry.' }, 503, {}, auth.cookies || []);
  }
  if (!upstream.ok || !upstream.body) {
    try { await upstream.body?.cancel(); } catch {}
    return json({ success: false, error: 'ArixCall signaling could not open its secure stream. Please retry.' }, 503, {}, auth.cookies || []);
  }

  const reader = upstream.body.getReader();
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let closed = false;
  let heartbeat = null;
  let controllerRef = null;
  let buffer = '';
  const closeOutput = () => {
    if (closed) return;
    closed = true;
    if (heartbeat) clearInterval(heartbeat);
    try { controllerRef?.close(); } catch {}
    try { reader.cancel(); } catch {}
  };
  const enqueue = (text) => {
    if (closed || !controllerRef) return;
    try { controllerRef.enqueue(encoder.encode(text)); } catch { closeOutput(); }
  };
  const output = new ReadableStream({
    start(controller) {
      controllerRef = controller;
      enqueue('retry: 1500\n\n');
      heartbeat = setInterval(() => enqueue(': keep-alive\n\n'), 12000);
      const processFrame = (frame) => {
        const dataLines = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, ''));
        if (!dataLines.length) return;
        const raw = dataLines.join('\n');
        if (raw.startsWith('subscribe,')) {
          enqueue(`event: ready\ndata: ${JSON.stringify({ arixCallId, iceServers: getCallIceServers() })}\n\n`);
          return;
        }
        if (!raw.startsWith('message,')) return;
        const firstComma = raw.indexOf(',');
        const secondComma = raw.indexOf(',', firstComma + 1);
        if (secondComma < 0) return;
        const eventText = raw.slice(secondComma + 1);
        try {
          const event = JSON.parse(eventText);
          if (!event || typeof event !== 'object' || !CALL_SIGNAL_TYPES.has(event.type) && event.type !== 'invite') return;
          enqueue(`event: signal\ndata: ${JSON.stringify(event)}\n\n`);
        } catch { /* Ignore malformed or non-ArixCall pub/sub messages. */ }
      };
      const pump = async () => {
        try {
          while (!closed) {
            const part = await reader.read();
            if (part.done) { closeOutput(); break; }
            buffer += decoder.decode(part.value, { stream: true }).replace(/\r\n/g, '\n');
            let boundary;
            while ((boundary = buffer.indexOf('\n\n')) >= 0) {
              const frame = buffer.slice(0, boundary);
              buffer = buffer.slice(boundary + 2);
              processFrame(frame);
            }
            if (buffer.length > 40000) buffer = buffer.slice(-20000);
          }
        } catch { closeOutput(); }
      };
      pump();
      req.signal.addEventListener('abort', closeOutput, { once: true });
    },
    cancel() { closeOutput(); },
  });
  const headers = new Headers({
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    'x-accel-buffering': 'no',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
    'referrer-policy': 'no-referrer',
  });
  for (const cookie of auth.cookies || []) headers.append('set-cookie', cookie);
  return new Response(output, { status: 200, headers });
}

async function getCachedShadowUser(cfg, identityHash) {
  const redis = runtimeRedisEnv();
  if (!redis) return null;
  const userId = await redisCommand(redis, 'GET', `arixchat:shadow-user:${identityHash}`);
  if (!UUID_RE.test(String(userId || ''))) return null;
  try {
    const response = await fetch(`${cfg.url}/auth/v1/admin/users/${encodeURIComponent(String(userId))}`, {
      headers: authAdminHeaders(cfg), cache: 'no-store',
    });
    const data = await readJsonResponse(response);
    const user = data?.user || data;
    if (!response.ok || String(user?.id || '') !== String(userId) || user?.user_metadata?.arixchat_identity_hash !== identityHash) return null;
    return user;
  } catch { return null; }
}
async function cacheShadowUser(identityHash, userId) {
  const redis = runtimeRedisEnv();
  // The mapping is only an optimization; Supabase Auth remains authoritative.
  await redisCommand(redis, 'SET', `arixchat:shadow-user:${identityHash}`, String(userId), 'EX', '31536000');
}
async function lookupShadowAuthUser(cfg, email, identityHash) {
  const url = new URL(`${cfg.url}/auth/v1/admin/users`);
  url.searchParams.set('page', '1');
  url.searchParams.set('per_page', '1000');
  // Supabase Auth filters users by email/metadata. The hash is unique to this
  // main-app identity and avoids scanning unrelated users in normal deployments.
  url.searchParams.set('filter', identityHash.slice(0, 32));
  const response = await fetch(url.toString(), { headers: authAdminHeaders(cfg) });
  const data = await readJsonResponse(response);
  if (!response.ok) {
    const error = new Error('Supabase Auth admin lookup failed. Check that SUPABASE_SECRET_KEY is a server-side secret key with Auth admin access.');
    error.code = 'SUPABASE_AUTH_ADMIN_LOOKUP';
    error.status = response.status;
    throw error;
  }
  const users = Array.isArray(data?.users) ? data.users : Array.isArray(data) ? data : [];
  return users.find(user => String(user?.email || '').toLowerCase() === email.toLowerCase() || user?.user_metadata?.arixchat_identity_hash === identityHash) || null;
}
async function ensureShadowAuthUser(cfg, account) {
  const identityHash = await sha256Hex(account.identityKey);
  const email = `arixchat-${identityHash}@${SHADOW_EMAIL_DOMAIN}`;
  let user = await getCachedShadowUser(cfg, identityHash);
  if (!user) user = await lookupShadowAuthUser(cfg, email, identityHash);
  if (!user) {
    const password = createId();
    const response = await fetch(`${cfg.url}/auth/v1/admin/users`, {
      method: 'POST',
      headers: authAdminHeaders(cfg, true),
      body: JSON.stringify({
        email,
        password,
        email_confirm: true,
        user_metadata: {
          arixchat_shadow_user: true,
          arixchat_identity_hash: identityHash,
          display_name: account.displayName,
        },
      }),
    });
    const data = await readJsonResponse(response);
    user = data?.user || data;
    if (!response.ok || !user?.id) {
      // Concurrent first requests can race while provisioning the same user.
      if (/already registered|already exists|duplicate/i.test(String(data?.msg || data?.message || data?.error || ''))) {
        user = await lookupShadowAuthUser(cfg, email, identityHash).catch(() => null);
      }
      if (!user?.id) {
        const error = new Error('Could not create ArixChat’s internal account. Verify SUPABASE_SECRET_KEY and the Auth Admin API settings.');
        error.code = 'SUPABASE_AUTH_ADMIN_CREATE';
        error.status = response.status;
        throw error;
      }
    }
  }
  if (!user?.id || !UUID_RE.test(String(user.id))) {
    const error = new Error('Supabase Auth returned an invalid internal account ID.');
    error.code = 'SUPABASE_AUTH_ADMIN_BAD_USER';
    throw error;
  }
  await cacheShadowUser(identityHash, String(user.id));
  return {
    id: String(user.id),
    // Never expose the synthetic, non-deliverable Auth email as the user’s email.
    email: account.email || '',
    displayName: cleanName(account.displayName) || 'ArixAI user',
  };
}
async function authenticateMainApp(req, cfg, input) {
  const fingerprint = await parentCookieFingerprint(req);
  if (!fingerprint) return { user: null, cookies: [clearChatSessionCookie()] };
  const existing = await readChatSessionCookie(req, cfg, fingerprint);
  if (existing) return { user: existing, cookies: [] };
  const verified = await validateMainAppSession(req, fingerprint, input?.displayName || '');
  if (!verified.authenticated) return { user: null, cookies: [clearChatSessionCookie()] };
  const user = await ensureShadowAuthUser(cfg, verified.account);
  return { user, cookies: [await createChatSessionCookie(user, fingerprint, cfg)] };
}
function validateInputEnvelope(envelope, nickname) {
  if (!envelope || typeof envelope.type !== 'string') throw new Error('Invalid message format.');
  if (envelope.type === 'message') {
    const clientMessageId = validIdempotencyId(envelope.clientMessageId);
    if (!clientMessageId) throw new Error('Message is missing a valid retry identifier.');
    const text = typeof envelope.text === 'string' ? envelope.text : '';
    if (text.length > MAX_TEXT_CHARS) throw new Error('Message text is too long.');
    if (!text.trim() && !envelope.attachment) throw new Error('A message needs text or an attachment.');
    const payload = {
      type: 'message',
      clientMessageId,
      text,
      sentAt: Number.isFinite(Number(envelope.sentAt)) ? Number(envelope.sentAt) : Date.now(),
      replyTo: null,
      attachment: null,
    };
    if (envelope.replyTo && typeof envelope.replyTo === 'object') {
      payload.replyTo = {
        id: String(envelope.replyTo.id || '').slice(0, 128),
        serverId: String(envelope.replyTo.serverId || '').slice(0, 128) || null,
        sender: cleanName(envelope.replyTo.sender || 'Message'),
        text: String(envelope.replyTo.text || '').slice(0, 180),
      };
    }
    if (envelope.attachment) {
      const a = envelope.attachment;
      if (!a || typeof a !== 'object') throw new Error('Invalid attachment.');
      const mime = String(a.mime || '').toLowerCase();
      const data = typeof a.data === 'string' ? a.data : '';
      if (!ALLOWED_ATTACHMENT_MIMES.has(mime)) throw new Error('This attachment type is not supported.');
      if (!data || data.length > MAX_ATTACHMENT_DATA_CHARS) throw new Error('Attachment is too large.');
      const expectedPrefix = `data:${mime};base64,`;
      if (!data.toLowerCase().startsWith(expectedPrefix) || !/^[a-z0-9+/=\r\n]+$/i.test(data.slice(expectedPrefix.length))) {
        throw new Error('Attachment data is invalid.');
      }
      payload.attachment = {
        name: String(a.name || 'attachment').replace(/[\\/\u0000-\u001f]/g, '_').slice(0, 120),
        mime,
        data,
      };
    }
    return { payload, idempotencyKey: clientMessageId };
  }
  if (!['reaction', 'edit', 'delete'].includes(envelope.type)) throw new Error('Unsupported message action.');
  const eventId = validIdempotencyId(envelope.eventId);
  if (!eventId) throw new Error('Action is missing a valid retry identifier.');
  const targetId = String(envelope.targetId || '');
  if (!/^[a-zA-Z0-9_-]{8,128}$/.test(targetId)) throw new Error('Invalid message target.');
  const payload = {
    type: envelope.type,
    eventId,
    targetId,
    sentAt: Number.isFinite(Number(envelope.sentAt)) ? Number(envelope.sentAt) : Date.now(),
    by: nickname,
  };
  if (envelope.type === 'reaction') {
    const emoji = String(envelope.emoji || '');
    if (!emoji || [...emoji].length > 8) throw new Error('Invalid reaction.');
    payload.emoji = emoji;
    payload.add = envelope.add !== false;
  }
  if (envelope.type === 'edit') {
    if (typeof envelope.text !== 'string' || !envelope.text.trim() || envelope.text.length > MAX_TEXT_CHARS) throw new Error('Edited message text is invalid.');
    payload.text = envelope.text.trim();
  }
  return { payload, idempotencyKey: eventId };
}
function serviceHeaders(cfg, jsonBody = false) {
  const out = {
    apikey: cfg.serviceKey,
    authorization: `Bearer ${cfg.serviceKey}`,
    accept: 'application/json',
  };
  if (jsonBody) out['content-type'] = 'application/json';
  return out;
}
async function rpc(cfg, name, args) {
  const response = await fetch(`${cfg.url}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: serviceHeaders(cfg, true), body: JSON.stringify(args),
  });
  const data = await readJsonResponse(response);
  if (!response.ok) {
    const error = new Error(String(data?.message || data?.details || 'Database operation failed'));
    error.status = response.status;
    error.code = String(data?.code || '');
    throw error;
  }
  return data;
}
function mapDatabaseError(error) {
  const message = String(error?.message || '').toLowerCase();
  if (/target message/i.test(message)) return { status: 409, message: 'That message is not available yet. Wait for it to finish syncing, then try again.' };
  if (error?.code === '42501' || /membership|required|not authorized|permission/i.test(message)) return { status: 403, message: 'You do not have permission to perform this action in this room.' };
  if (/room.*not found|invite.*invalid|does not exist/i.test(message) || (error?.code === 'P0002' && !/target message/i.test(message))) return { status: 404, message: 'This room link is invalid or the room no longer exists.' };
  if (/rate limit|too many/i.test(message) || error?.code === 'P0001') return { status: 429, message: 'This room has reached its action limit. Please wait a minute and try again.' };
  return { status: 502, message: 'Chat storage is temporarily unavailable. Please retry.' };
}

export default async function handler(req) {
  const origin = req.headers.get('origin');
  if (origin) {
    try {
      if (new URL(origin).origin !== new URL(req.url).origin) return json({ success: false, error: 'Origin not allowed.' }, 403);
    } catch { return json({ success: false, error: 'Invalid origin.' }, 403); }
  }
  if (req.headers.get('sec-fetch-site') === 'cross-site') return json({ success: false, error: 'Cross-site requests are not allowed.' }, 403);
  if (req.method === 'GET') {
    const url = new URL(req.url);
    if (url.searchParams.get('action') !== 'call_stream') return json({ success: false, error: 'Method not allowed.' }, 405, { allow: 'POST, GET' });
    const cfg = runtimeEnv();
    if (!cfg) return json({ success: false, error: 'Chat storage is not configured. Set SUPABASE_URL and SUPABASE_SECRET_KEY as server-side environment variables.' }, 503);
    try { return await handleCallStream(req, cfg); }
    catch (error) { return json({ success: false, error: 'ArixCall signaling is temporarily unavailable.' }, error?.status || 503); }
  }
  if (req.method !== 'POST') return json({ success: false, error: 'Method not allowed.' }, 405, { allow: 'POST, GET' });
  const contentType = req.headers.get('content-type') || '';
  if (!contentType.toLowerCase().includes('application/json')) return json({ success: false, error: 'JSON is required.' }, 415);
  const claimedLength = Number(req.headers.get('content-length') || 0);
  if (Number.isFinite(claimedLength) && claimedLength > MAX_REQUEST_CHARS) return json({ success: false, error: 'Request is too large.' }, 413);
  let input;
  try {
    const body = await req.text();
    if (!body || body.length > MAX_REQUEST_CHARS) return json({ success: false, error: 'Request is too large or empty.' }, 413);
    input = JSON.parse(body);
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid body');
  } catch { return json({ success: false, error: 'Invalid JSON body.' }, 400); }

  const action = String(input.action || '');
  if (!['session', 'logout', 'create_room', 'join_room', 'send', 'poll', 'history', 'call_presence', 'call_lookup', 'call_invite', 'call_signal'].includes(action)) {
    return json({ success: false, error: 'Invalid action.' }, 400);
  }
  const cfg = runtimeEnv();
  if (!cfg) return json({ success: false, error: 'Chat storage is not configured. Set SUPABASE_URL and SUPABASE_SECRET_KEY as server-side environment variables.' }, 503);

  let sessionCookies = [];
  try {
    if (action === 'logout') return json({ success: true }, 200, {}, [clearChatSessionCookie()]);

    const auth = await authenticateMainApp(req, cfg, input);
    const cookies = auth.cookies || [];
    sessionCookies = cookies;
    if (action === 'session') {
      if (!auth.user) return json({ success: true, authenticated: false }, 200, {}, cookies);
      // Do not advertise an ArixID unless the Redis mapping was actually registered.
      // This avoids presenting a plausible-looking but uncallable ID during outages.
      let arixCallId = '';
      try { arixCallId = await registerCallIdentity(auth.user, cfg); } catch { /* Call signaling will surface the missing Redis configuration. */ }
      return json({ success: true, authenticated: true, user: { ...auth.user, arixCallId, callIceServers: getCallIceServers() } }, 200, {}, cookies);
    }
    if (!auth.user?.id) return json({ success: false, error: 'Open the main ArixAI app and authenticate there before using ArixChat.', code: 'AUTH_REQUIRED' }, 401, {}, cookies);
    const user = auth.user;
    const nickname = cleanName(input.displayName) || user.displayName || 'ArixAI user';

    if (action === 'call_presence') {
      try {
        const redis = runtimeRedisEnv();
        if (!redis) throw callFail('ArixCall needs UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN configured on the server.', 503);
        const arixCallId = await registerCallIdentity(user, cfg, nickname);
        await callRedisCommand(redis, 'SET', callPresenceKey(user.id), '1', 'EX', String(CALL_PRESENCE_TTL_SECONDS));
        return json({ success: true, arixCallId, iceServers: getCallIceServers(), expiresIn: CALL_PRESENCE_TTL_SECONDS }, 200, {}, cookies);
      } catch (error) {
        return json({ success: false, error: error.message || 'ArixCall presence could not be refreshed.' }, error.status || 503, {}, cookies);
      }
    }

    if (action === 'call_lookup') {
      try {
        const redis = runtimeRedisEnv();
        if (!redis) throw callFail('ArixCall signaling is not configured on the server.', 503);
        const target = String(input.targetArixId || '').trim().toUpperCase();
        const peer = await resolveCallPeer(redis, target);
        if (peer.userId === user.id) throw callFail('You cannot call your own ArixID.');
        return json({ success: true, peer: { arixCallId: peer.arixCallId, displayName: peer.displayName, online: peer.online } }, 200, {}, cookies);
      } catch (error) {
        return json({ success: false, error: error.message || 'Could not look up that ArixID.' }, error.status || 503, {}, cookies);
      }
    }

    if (action === 'call_invite') {
      const redis = runtimeRedisEnv();
      let callerLocked = false;
      let calleeLocked = false;
      let sessionWritten = false;
      let session = null;
      try {
        if (!redis) throw callFail('ArixCall signaling is not configured on the server.', 503);
        const callId = String(input.callId || '');
        if (!CALL_ID_RE.test(callId)) throw callFail('Invalid call identifier. Try again.');
        const mediaType = input.mediaType === 'video' ? 'video' : input.mediaType === 'audio' ? 'audio' : '';
        if (!mediaType) throw callFail('Choose a voice or video call.');
        const peer = await resolveCallPeer(redis, String(input.targetArixId || '').trim().toUpperCase());
        if (peer.userId === user.id) throw callFail('You cannot call your own ArixID.');
        if (!peer.online) throw callFail(`${peer.displayName} is not connected to ArixCall right now. Ask them to open ArixChat and try again.`, 409);
        const callerArixId = await registerCallIdentity(user, cfg, nickname);
        const callerLock = await callRedisCommand(redis, 'SET', callActiveKey(user.id), callId, 'EX', String(CALL_RING_TTL_SECONDS), 'NX');
        if (callerLock !== 'OK') throw callFail('You are already in another call. End it before starting a new one.', 409);
        callerLocked = true;
        const calleeLock = await callRedisCommand(redis, 'SET', callActiveKey(peer.userId), callId, 'EX', String(CALL_RING_TTL_SECONDS), 'NX');
        if (calleeLock !== 'OK') throw callFail(`${peer.displayName} is already on another call.`, 409);
        calleeLocked = true;
        session = {
          callId,
          callerId: user.id,
          calleeId: peer.userId,
          callerArixId,
          calleeArixId: peer.arixCallId,
          callerName: nickname,
          calleeName: peer.displayName,
          mediaType,
          status: 'ringing',
          createdAt: Date.now(),
        };
        const created = await callRedisCommand(redis, 'SET', callSessionKey(callId), JSON.stringify(session), 'EX', String(CALL_RING_TTL_SECONDS), 'NX');
        if (created !== 'OK') throw callFail('Could not reserve this call. Please try again.', 409);
        sessionWritten = true;
        const delivered = await publishCallEvent(redis, peer.userId, {
          type: 'invite', callId, fromArixId: callerArixId, fromName: nickname, mediaType, at: Date.now(),
        });
        if (delivered < 1) throw callFail(`${peer.displayName} disconnected. Please try again.`, 409);
        return json({ success: true, callId, status: 'ringing', peer: { arixCallId: peer.arixCallId, displayName: peer.displayName } }, 200, {}, cookies);
      } catch (error) {
        if (redis && sessionWritten && session) await callRedisCommand(redis, 'DEL', callSessionKey(session.callId)).catch(() => null);
        if (redis && callerLocked) {
          const active = await callRedisCommand(redis, 'GET', callActiveKey(user.id)).catch(() => null);
          if (String(active || '') === String(input.callId || '')) await callRedisCommand(redis, 'DEL', callActiveKey(user.id)).catch(() => null);
        }
        if (redis && calleeLocked && session?.calleeId) {
          const active = await callRedisCommand(redis, 'GET', callActiveKey(session.calleeId)).catch(() => null);
          if (String(active || '') === String(input.callId || '')) await callRedisCommand(redis, 'DEL', callActiveKey(session.calleeId)).catch(() => null);
        }
        return json({ success: false, error: error.message || 'Could not start this call.' }, error.status || 503, {}, cookies);
      }
    }

    if (action === 'call_signal') {
      const redis = runtimeRedisEnv();
      try {
        if (!redis) throw callFail('ArixCall signaling is not configured on the server.', 503);
        const callId = String(input.callId || '');
        const signalType = String(input.signalType || '');
        if (!CALL_ID_RE.test(callId)) throw callFail('Invalid call identifier.');
        if (!CALL_SIGNAL_TYPES.has(signalType)) throw callFail('Unsupported ArixCall signal.');
        const sessionRaw = await callRedisCommand(redis, 'GET', callSessionKey(callId));
        let session;
        try { session = JSON.parse(String(sessionRaw || '')); } catch { session = null; }
        if (!session || session.callId !== callId) throw callFail('This call has ended or expired.', 404);
        const isCaller = user.id === session.callerId;
        const isCallee = user.id === session.calleeId;
        if (!isCaller && !isCallee) throw callFail('You are not a participant in this call.', 403);
        if (signalType === 'accept' && (!isCallee || session.status !== 'ringing')) throw callFail('This call can no longer be answered.', 409);
        if (signalType === 'decline' && !isCallee) throw callFail('Only the invited person can decline this call.', 403);
        if (signalType === 'cancel' && !isCaller) throw callFail('Only the caller can cancel while it is ringing.', 403);
        if (signalType === 'offer' && !isCaller) throw callFail('Invalid WebRTC offer sender.', 403);
        if (signalType === 'answer' && !isCallee) throw callFail('Invalid WebRTC answer sender.', 403);
        if (['offer', 'answer', 'ice'].includes(signalType) && session.status !== 'active') throw callFail('Answer the call before exchanging WebRTC media details.', 409);
        if (['decline', 'cancel', 'hangup'].includes(signalType) && session.status === 'ended') return json({ success: true, delivered: false }, 200, {}, cookies);
        const payload = normalizeCallSignal(signalType, input.payload || {});
        if (signalType === 'accept') {
          for (const participantId of [session.callerId, session.calleeId]) {
            const activeId = await callRedisCommand(redis, 'GET', callActiveKey(participantId));
            if (String(activeId || '') !== callId) throw callFail('This call has expired. Please start a new call.', 409);
          }
          session.status = 'active';
          await callRedisCommand(redis, 'SET', callActiveKey(session.callerId), callId, 'EX', String(CALL_SESSION_TTL_SECONDS));
          await callRedisCommand(redis, 'SET', callActiveKey(session.calleeId), callId, 'EX', String(CALL_SESSION_TTL_SECONDS));
        }
        if (signalType === 'offer' || signalType === 'answer' || signalType === 'ice' || signalType === 'accept') {
          await callRedisCommand(redis, 'SET', callSessionKey(callId), JSON.stringify(session), 'EX', String(CALL_SESSION_TTL_SECONDS));
        }
        const recipientId = isCaller ? session.calleeId : session.callerId;
        const event = {
          type: signalType,
          callId,
          fromArixId: isCaller ? session.callerArixId : session.calleeArixId,
          fromName: isCaller ? session.callerName : session.calleeName,
          mediaType: session.mediaType,
        };
        if (signalType === 'offer' || signalType === 'answer') event.sdp = payload.sdp;
        if (signalType === 'ice') event.candidate = payload;
        const delivered = await publishCallEvent(redis, recipientId, event);
        if (['decline', 'cancel', 'hangup'].includes(signalType)) {
          session.status = 'ended';
          await releaseCallSession(redis, session);
        } else if (['accept', 'offer', 'answer'].includes(signalType) && delivered < 1) {
          await releaseCallSession(redis, session);
          throw callFail('The other person temporarily lost the signaling connection. Retry the call.', 503);
        }
        return json({ success: true, delivered: delivered > 0 }, 200, {}, cookies);
      } catch (error) {
        return json({ success: false, error: error.message || 'ArixCall signaling failed.' }, error.status || 503, {}, cookies);
      }
    }

    if (action === 'create_room') {
      const roomId = createId();
      const title = cleanRoomTitle(input.title);
      const room = await rpc(cfg, 'arixchat_create_room', { p_room_id: roomId, p_owner_id: user.id, p_title: title });
      return json({ success: true, room: { id: room.room_id, room_id: room.room_id, title: room.title, created_at: room.created_at } }, 200, {}, cookies);
    }

    const roomId = input.roomId;
    if (typeof roomId !== 'string' || !ROOM_ID_RE.test(roomId)) return json({ success: false, error: 'Invalid room ID.' }, 400, {}, cookies);

    if (action === 'join_room') {
      try {
        const room = await rpc(cfg, 'arixchat_join_room', { p_room_id: roomId, p_user_id: user.id });
        return json({ success: true, room: { id: room.room_id, room_id: room.room_id, title: room.title, created_at: room.created_at } }, 200, {}, cookies);
      } catch (error) {
        const mapped = mapDatabaseError(error);
        return json({ success: false, error: mapped.status === 502 ? 'This room link is invalid or the room no longer exists.' : mapped.message }, mapped.status === 502 ? 404 : mapped.status, {}, cookies);
      }
    }

    if (action === 'send') {
      if (typeof input.message !== 'string' || input.message.length > MAX_STORED_MESSAGE_CHARS) return json({ success: false, error: 'Message is invalid or too large.' }, 400, {}, cookies);
      const envelope = parseEnvelope(input.message);
      if (!envelope) return json({ success: false, error: 'Unsupported message format. Refresh ArixChat and try again.' }, 400, {}, cookies);
      let normalized;
      try { normalized = validateInputEnvelope(envelope, nickname); }
      catch (error) { return json({ success: false, error: String(error.message || 'Invalid message.') }, 400, {}, cookies); }
      const normalizedMessage = PREFIX + JSON.stringify(normalized.payload);
      if (normalizedMessage.length > MAX_STORED_MESSAGE_CHARS) return json({ success: false, error: 'Message or attachment is too large.' }, 413, {}, cookies);
      try {
        const result = await rpc(cfg, 'arixchat_send_message', {
          p_room_id: roomId,
          p_user_id: user.id,
          p_nickname: nickname,
          p_message: normalizedMessage,
          p_idempotency_key: normalized.idempotencyKey,
        });
        return json({ success: true, id: String(result.id), ts: Number(result.ts), created_at: result.created_at, updated_at: result.updated_at, duplicate: !!result.duplicate }, 200, {}, cookies);
      } catch (error) {
        const mapped = mapDatabaseError(error);
        return json({ success: false, error: mapped.message }, mapped.status, mapped.status === 429 ? { 'retry-after': '60' } : {}, cookies);
      }
    }

    // Poll is deliberately bounded. The client passes a timestamp cursor and deduplicates by stable server IDs.
    const memberUrl = new URL(`${cfg.url}/rest/v1/arixchat_room_members`);
    memberUrl.searchParams.set('select', 'room_id');
    memberUrl.searchParams.set('room_id', `eq.${roomId}`);
    memberUrl.searchParams.set('user_id', `eq.${user.id}`);
    memberUrl.searchParams.set('limit', '1');
    const memberResponse = await fetch(memberUrl.toString(), { headers: serviceHeaders(cfg) });
    const memberRows = await readJsonResponse(memberResponse);
    if (!memberResponse.ok || !Array.isArray(memberRows) || memberRows.length === 0) return json({ success: false, error: 'Join this room with its invite link before syncing messages.' }, 403, {}, cookies);

    const messagesUrl = new URL(`${cfg.url}/rest/v1/arixchat_messages`);
    messagesUrl.searchParams.set('select', 'id,room_id,sender_id,nickname,message,ts,created_at,updated_at,client_message_id');
    messagesUrl.searchParams.set('room_id', `eq.${roomId}`);
    if (action === 'history') {
      const beforeText = typeof input.before === 'string' ? input.before : '';
      const before = Date.parse(beforeText);
      const safeCursor = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(beforeText);
      if (!safeCursor || !Number.isFinite(before) || before <= 0 || before > Date.now() + 60000) return json({ success: false, error: 'Invalid history cursor.' }, 400, {}, cookies);
      // Preserve Postgres timestamp precision (up to microseconds) to avoid skipping messages
      // created in the same JavaScript millisecond. The cursor regex prevents filter injection.
      messagesUrl.searchParams.set('created_at', `lt.${beforeText}`);
      messagesUrl.searchParams.set('order', 'created_at.desc');
      messagesUrl.searchParams.set('limit', '101');
      const historyResponse = await fetch(messagesUrl.toString(), { headers: serviceHeaders(cfg) });
      const historyRows = await readJsonResponse(historyResponse);
      if (!historyResponse.ok || !Array.isArray(historyRows)) return json({ success: false, error: 'Earlier messages are temporarily unavailable.' }, 502, {}, cookies);
      const hasMore = historyRows.length > 100;
      const page = historyRows.slice(0, 100).reverse();
      return json({ success: true, messages: page, hasMore }, 200, {}, cookies);
    }
    const cursor = typeof input.after === 'string' ? Date.parse(input.after) : NaN;
    if (Number.isFinite(cursor) && cursor > 0 && cursor <= Date.now() + 60000) {
      const overlap = new Date(Math.max(0, cursor - 2000)).toISOString();
      messagesUrl.searchParams.set('or', `(created_at.gte.${overlap},updated_at.gte.${overlap})`);
      messagesUrl.searchParams.set('order', 'created_at.asc');
      messagesUrl.searchParams.set('limit', '500');
    } else {
      messagesUrl.searchParams.set('order', 'created_at.desc');
      messagesUrl.searchParams.set('limit', '201');
    }
    const messagesResponse = await fetch(messagesUrl.toString(), { headers: serviceHeaders(cfg) });
    let rows = await readJsonResponse(messagesResponse);
    if (!messagesResponse.ok || !Array.isArray(rows)) return json({ success: false, error: 'Message history is temporarily unavailable.' }, 502, {}, cookies);
    let hasMore = false;
    if (!(Number.isFinite(cursor) && cursor > 0 && cursor <= Date.now() + 60000)) {
      hasMore = rows.length > 200;
      rows = rows.slice(0, 200).reverse();
    }
    return json({ success: true, messages: rows, hasMore }, 200, {}, cookies);
  } catch (error) {
    console.error('[ArixChat API]', String(error?.code || 'UNEXPECTED'), String(error?.message || 'request failed'));
    const message = error?.code === 'MAIN_SESSION_ORIGIN_DENIED'
      ? 'ArixChat and the main ArixAI app must use the same allowed site origin.'
      : error?.code === 'MAIN_SESSION_UNAVAILABLE'
      ? 'ArixAI session verification failed. Check the main app authentication service and its Redis configuration.'
      : error?.code?.startsWith?.('SUPABASE_AUTH_ADMIN')
      ? String(error.message || 'Chat account setup failed. Check the Supabase server configuration.')
      : 'Chat storage is temporarily unavailable. Please retry.';
    return json({ success: false, error: message, code: error?.code }, 502, {}, sessionCookies);
  }
}
