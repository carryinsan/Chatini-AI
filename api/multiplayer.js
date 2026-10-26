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

function runtimeEnv() {
  const env = typeof process !== 'undefined' && process.env ? process.env : {};
  const url = "https://vvcpdfdofihdmzshglxr.supabase.co";
  const anonKey = String(env.SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || '').trim();
  const serviceKey = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ2Y3BmZG9maWhkbXpzaGRnbHhyIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NTA2NzQ5MCwiZXhwIjoyMTAwNjQzNDkwfQ.ACRUkwnNiVg-6ZNqSlKYYev0csd_cT6tgiL0T0fPKLQ";
  if (!url || !anonKey || !serviceKey) return null;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') return null;
    if (parsed.pathname !== '/' || parsed.search || parsed.hash) return null;
  } catch { return null; }
  return { url, anonKey, serviceKey };
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

function cookiesForSession(session) {
  const accessSeconds = Math.max(60, Math.min(Number(session.expires_in) || 3600, 86400));
  return [
    `arix_access=${session.access_token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${accessSeconds}`,
    `arix_refresh=${session.refresh_token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
  ];
}
function clearSessionCookies() {
  return [
    'arix_access=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
    'arix_refresh=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0',
  ];
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
function decodeSupabaseError(payload, fallback) {
  const message = String(payload?.msg || payload?.message || payload?.error_description || payload?.error || '');
  if (/rate limit|too many/i.test(message)) return 'Too many attempts. Please wait and try again.';
  if (/invalid login credentials|invalid email or password/i.test(message)) return 'Email or password is incorrect.';
  if (/email not confirmed/i.test(message)) return 'Please verify your email before signing in.';
  if (/already registered|already exists/i.test(message)) return 'An account with this email may already exist. Try signing in.';
  return fallback;
}
async function readJsonResponse(response) {
  try { return await response.json(); } catch { return {}; }
}
async function authFetch(cfg, path, method = 'GET', body = null, accessToken = '') {
  const headers = { apikey: cfg.anonKey, accept: 'application/json' };
  if (body !== null) headers['content-type'] = 'application/json';
  if (accessToken) headers.authorization = `Bearer ${accessToken}`;
  const response = await fetch(`${cfg.url}/auth/v1/${path}`, {
    method, headers, body: body === null ? undefined : JSON.stringify(body),
  });
  return { response, data: await readJsonResponse(response) };
}
async function authenticate(req, cfg) {
  const accessToken = cookieValue(req, 'arix_access');
  const refreshToken = cookieValue(req, 'arix_refresh');
  if (accessToken) {
    try {
      const result = await authFetch(cfg, 'user', 'GET', null, accessToken);
      if (result.response.ok && result.data?.id) return { user: result.data, accessToken, cookies: [] };
    } catch { /* Attempt refresh below. */ }
  }
  if (refreshToken) {
    try {
      const result = await authFetch(cfg, 'token?grant_type=refresh_token', 'POST', { refresh_token: refreshToken });
      if (result.response.ok && result.data?.access_token && result.data?.refresh_token && result.data?.user?.id) {
        return { user: result.data.user, accessToken: result.data.access_token, cookies: cookiesForSession(result.data) };
      }
    } catch { /* Treat an unavailable or invalid refresh token as signed out. */ }
  }
  return { user: null, accessToken: '', cookies: (accessToken || refreshToken) ? clearSessionCookies() : [] };
}
function userSummary(user) {
  const meta = user?.user_metadata || {};
  const email = String(user?.email || '');
  const fromEmail = email.includes('@') ? email.slice(0, email.indexOf('@')) : 'ArixChat user';
  return {
    id: String(user.id),
    email,
    displayName: cleanName(meta.display_name || meta.full_name || fromEmail) || 'ArixChat user',
  };
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
  // New Supabase secret API keys are not JWTs: send them as `apikey` only.
  // Legacy service_role keys are JWTs and also need the Authorization header.
  const out = { apikey: cfg.serviceKey, accept: 'application/json' };
  if (!cfg.serviceKey.startsWith('sb_secret_')) out.authorization = `Bearer ${cfg.serviceKey}`;
  if (jsonBody) out['content-type'] = 'application/json';
  return out;
}
async function rest(cfg, path, method = 'GET', body = null, prefer = '') {
  const headers = serviceHeaders(cfg, body !== null);
  if (prefer) headers.prefer = prefer;
  const response = await fetch(`${cfg.url}/rest/v1/${path}`, {
    method, headers, body: body === null ? undefined : JSON.stringify(body),
  });
  return { response, data: await readJsonResponse(response) };
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
  if (req.method !== 'POST') return json({ success: false, error: 'Method not allowed.' }, 405, { allow: 'POST' });
  const origin = req.headers.get('origin');
  if (origin) {
    try {
      if (new URL(origin).origin !== new URL(req.url).origin) return json({ success: false, error: 'Origin not allowed.' }, 403);
    } catch { return json({ success: false, error: 'Invalid origin.' }, 403); }
  }
  if (req.headers.get('sec-fetch-site') === 'cross-site') return json({ success: false, error: 'Cross-site requests are not allowed.' }, 403);
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
  if (!['signup', 'login', 'session', 'logout', 'profile_update', 'create_room', 'join_room', 'send', 'poll', 'history'].includes(action)) {
    return json({ success: false, error: 'Invalid action.' }, 400);
  }
  const cfg = runtimeEnv();
  if (!cfg) return json({ success: false, error: 'Chat service is not configured. Set SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY (or SUPABASE_ANON_KEY), and SUPABASE_SECRET_KEY (or SUPABASE_SERVICE_ROLE_KEY) in the server environment.' }, 503);

  let refreshCookies = [];
  try {
    if (action === 'signup') {
      const email = String(input.email || '').trim().toLowerCase();
      const password = typeof input.password === 'string' ? input.password : '';
      const displayName = cleanName(input.displayName);
      if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ success: false, error: 'Enter a valid email address.' }, 400);
      if (password.length < 8 || password.length > 128) return json({ success: false, error: 'Password must be between 8 and 128 characters.' }, 400);
      if (!displayName) return json({ success: false, error: 'Enter a display name.' }, 400);
      const result = await authFetch(cfg, 'signup', 'POST', { email, password, data: { display_name: displayName } });
      if (!result.response.ok) return json({ success: false, error: decodeSupabaseError(result.data, 'Account could not be created. Check the details and try again.') }, result.response.status === 429 ? 429 : 400);
      const session = result.data?.access_token && result.data?.refresh_token ? result.data : null;
      if (session) return json({ success: true, authenticated: true, user: userSummary(session.user) }, 200, {}, cookiesForSession(session));
      return json({ success: true, authenticated: false, needsEmailConfirmation: true, message: 'Account created. Check your email to verify the address, then sign in.' }, 200);
    }

    if (action === 'login') {
      const email = String(input.email || '').trim().toLowerCase();
      const password = typeof input.password === 'string' ? input.password : '';
      if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !password || password.length > 128) return json({ success: false, error: 'Enter a valid email and password.' }, 400);
      const result = await authFetch(cfg, 'token?grant_type=password', 'POST', { email, password });
      if (!result.response.ok || !result.data?.access_token || !result.data?.refresh_token || !result.data?.user?.id) {
        return json({ success: false, error: decodeSupabaseError(result.data, 'Sign-in failed. Check your email and password.') }, result.response.status === 429 ? 429 : 401, {}, clearSessionCookies());
      }
      return json({ success: true, authenticated: true, user: userSummary(result.data.user) }, 200, {}, cookiesForSession(result.data));
    }

    if (action === 'logout') {
      const refresh = cookieValue(req, 'arix_refresh');
      const auth = await authenticate(req, cfg);
      if (refresh) {
        try { await authFetch(cfg, 'logout', 'POST', null, auth.accessToken); } catch { /* Always clear this browser session. */ }
      }
      return json({ success: true }, 200, {}, clearSessionCookies());
    }

    const auth = await authenticate(req, cfg);
    const cookies = auth.cookies || [];
    refreshCookies = cookies;
    if (action === 'session') {
      if (!auth.user) return json({ success: true, authenticated: false }, 200, {}, cookies);
      return json({ success: true, authenticated: true, user: userSummary(auth.user) }, 200, {}, cookies);
    }
    if (!auth.user?.id || !auth.accessToken) return json({ success: false, error: 'Please sign in to continue.', code: 'AUTH_REQUIRED' }, 401, {}, cookies);
    const user = userSummary(auth.user);
    const nickname = user.displayName;

    if (action === 'profile_update') {
      const displayName = cleanName(input.displayName);
      if (!displayName) return json({ success: false, error: 'Enter a valid display name.' }, 400, {}, cookies);
      const result = await authFetch(cfg, 'user', 'PUT', { data: { ...(auth.user.user_metadata || {}), display_name: displayName } }, auth.accessToken);
      if (!result.response.ok || !result.data?.id) return json({ success: false, error: 'Profile could not be updated. Please retry.' }, 502, {}, cookies);
      return json({ success: true, user: userSummary(result.data) }, 200, {}, cookies);
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
  } catch {
    return json({ success: false, error: 'Chat service is temporarily unavailable. Please retry.' }, 502, {}, refreshCookies);
  }
}
