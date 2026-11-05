/*
 * ArixAI Secure Billing Gateway — api/paid.js
 *
 * Edge-safe, dependency-free payment/account bridge for Vercel.
 *
 * Supported gateways:
 *   - Stripe Checkout (cards + Stripe-enabled local payment methods such as UPI)
 *   - Razorpay Orders + Checkout verification/webhooks (UPI, cards, netbanking, etc.)
 *
 * IMPORTANT SECURITY MODEL
 *   1. Prices, plan IDs, access duration and entitlements are SERVER CONTROLLED.
 *      Never trust price/amount/credits sent by the browser.
 *   2. Payment success is NEVER inferred from a browser redirect alone.
 *      A provider webhook or a server-side provider lookup must prove payment.
 *   3. Webhooks are verified against the RAW request body before JSON parsing.
 *   4. All payment mutations are idempotent and tied to an internal order record.
 *   5. Account sessions use an HttpOnly __Host- cookie signed by ARIX_SESSION_HMAC_SECRET
 *      and additionally backed by Redis for revocation/replay resistance.
 *   6. No card number, CVV, UPI PIN, bank password, or other payment credential is ever
 *      accepted, stored, or forwarded by this API.
 *
 * EXPECTED ENVIRONMENT VARIABLES
 *   Required for production:
 *     ARIX_PUBLIC_URL=https://your-domain.example
 *     ARIX_ALLOWED_ORIGINS=https://your-domain.example
 *     UPSTASH_REDIS_REST_URL=https://...
 *     UPSTASH_REDIS_REST_TOKEN=...
 *     ARIX_SESSION_HMAC_SECRET=<32+ random bytes, base64/hex/string>
 *
 *   Stripe:
 *     STRIPE_SECRET_KEY=sk_live_...
 *     STRIPE_WEBHOOK_SECRET=whsec_...
 *
 *   Razorpay:
 *     RAZORPAY_KEY_ID=rzp_live_...
 *     RAZORPAY_KEY_SECRET=...
 *     RAZORPAY_WEBHOOK_SECRET=...
 *
 *   Optional hardening:
 *     ARIX_LEGACY_SESSION_ENABLED=true|false  (default: true ONLY for session issuance)
 *     ARIX_BIND_SESSION_TO_DEVICE=true|false  (default: true)
 *     ARIX_BILLING_PERIOD_DAYS=30
 *     ARIX_SESSION_TTL_DAYS=7
 *     ARIX_SUCCESS_PATH=/plans.html?payment=success
 *     ARIX_CANCEL_PATH=/plans.html?payment=cancelled
 *     ARIX_ULTRA_CREDITS=4500000
 *
 * CURRENT ACCOUNT COMPATIBILITY
 *   The uploaded ArixAI codebase currently stores account records as user:<email> and
 *   exposes a legacy token derived from the password hash. This file accepts that legacy
 *   credential ONLY at action=issue_session, then upgrades the browser into a signed,
 *   HttpOnly session. Direct checkout/status/refund operations require the secure session.
 *
 * WEBHOOK URLs
 *   Stripe:    POST /api/paid?webhook=stripe
 *   Razorpay:  POST /api/paid?webhook=razorpay
 *
 * API ACTIONS
 *   Public:       plans
 *   Auth upgrade: issue_session, logout
 *   Auth:         create_checkout, get_entitlement, get_order, get_status,
 *                 verify_razorpay_payment
 *   Webhooks:     ?webhook=stripe / ?webhook=razorpay
 */

export const config = {
  runtime: 'edge',
};

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const MAX_JSON_BYTES = 16 * 1024;
const MAX_WEBHOOK_BYTES = 1024 * 1024;
const RATE_TTL_SECONDS = 60;
const ORDER_TTL_SECONDS = 60 * 60 * 24 * 120;
const IDEMPOTENCY_TTL_SECONDS = 60 * 60 * 24;
const EVENT_PROCESSING_TTL_SECONDS = 120;
const EVENT_DONE_TTL_SECONDS = 60 * 60 * 24 * 90;
const ACCOUNT_LOCK_TTL_SECONDS = 15;

const PLANS = Object.freeze({
  spark: Object.freeze({
    id: 'spark',
    name: 'Spark',
    amountInr: 99,
    monthlyCredits: 85000,
  }),
  plus: Object.freeze({
    id: 'plus',
    name: 'Plus',
    amountInr: 299,
    monthlyCredits: 250000,
  }),
  pro: Object.freeze({
    id: 'pro',
    name: 'Pro',
    amountInr: 499,
    monthlyCredits: 450000,
  }),
  max: Object.freeze({
    id: 'max',
    name: 'Max',
    amountInr: 1499,
    monthlyCredits: 1400000,
  }),
  ultra: Object.freeze({
    id: 'ultra',
    name: 'Ultra',
    amountInr: 9999,
    monthlyCredits: parsePositiveInt(process.env.ARIX_ULTRA_CREDITS, 4500000),
  }),
});

const PLAN_RANK = Object.freeze({ spark: 1, plus: 2, pro: 3, max: 4, ultra: 5 });

function parsePositiveInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  return Number.isSafeInteger(n) && n > 0 ? n : fallback;
}

function envBool(name, fallback = false) {
  const raw = String(process.env[name] ?? '').trim().toLowerCase();
  if (!raw) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(raw);
}

function cleanEnv(name, fallback = '') {
  return String(process.env[name] ?? fallback).replace(/[\r\n]/g, '').trim();
}

const CONFIG = Object.freeze({
  publicUrl: cleanEnv('ARIX_PUBLIC_URL', ''),
  allowedOrigins: cleanEnv('ARIX_ALLOWED_ORIGINS', '').split(',').map(s => s.trim()).filter(Boolean),
  redisUrl: cleanEnv('UPSTASH_REDIS_REST_URL', ''),
  redisToken: cleanEnv('UPSTASH_REDIS_REST_TOKEN', ''),
  sessionSecret: cleanEnv('ARIX_SESSION_HMAC_SECRET', ''),
  stripeSecret: cleanEnv('STRIPE_SECRET_KEY', ''),
  stripeWebhookSecret: cleanEnv('STRIPE_WEBHOOK_SECRET', ''),
  razorpayKeyId: cleanEnv('RAZORPAY_KEY_ID', ''),
  razorpayKeySecret: cleanEnv('RAZORPAY_KEY_SECRET', ''),
  razorpayWebhookSecret: cleanEnv('RAZORPAY_WEBHOOK_SECRET', ''),
  billingPeriodDays: Math.min(365, Math.max(1, parsePositiveInt(process.env.ARIX_BILLING_PERIOD_DAYS, 30))),
  sessionTtlDays: Math.min(30, Math.max(1, parsePositiveInt(process.env.ARIX_SESSION_TTL_DAYS, 7))),
  legacySessionEnabled: envBool('ARIX_LEGACY_SESSION_ENABLED', true),
  bindSessionToDevice: envBool('ARIX_BIND_SESSION_TO_DEVICE', true),
  successPath: cleanEnv('ARIX_SUCCESS_PATH', '/plans.html?payment=success'),
  cancelPath: cleanEnv('ARIX_CANCEL_PATH', '/plans.html?payment=cancelled'),
});

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
      ...headers,
    },
  });
}

function methodNotAllowed(allow = 'POST, OPTIONS') {
  return json({ success: false, error: 'Method not allowed.' }, 405, { Allow: allow });
}

function errorSafe(message = 'Request rejected.') {
  return json({ success: false, error: message });
}

function requireRuntimeConfig({ paymentProvider = null, session = false } = {}) {
  if (!CONFIG.redisUrl || !CONFIG.redisToken) throw new Error('Billing storage is not configured.');
  if (session && !CONFIG.sessionSecret) throw new Error('Secure session signing is not configured.');
  if (paymentProvider === 'stripe' && (!CONFIG.stripeSecret || !CONFIG.stripeWebhookSecret) && !session) {
    // Webhook handling only needs the webhook secret; checkout needs secret key.
  }
  if (paymentProvider === 'razorpay' && (!CONFIG.razorpayKeyId || !CONFIG.razorpayKeySecret) && !session) {
    // Webhook handling only needs the webhook secret; checkout needs both keys.
  }
}

function getOrigin(req) {
  const origin = String(req.headers.get('origin') || '').trim();
  return origin;
}

function originAllowed(origin) {
  if (!origin) return false;
  return CONFIG.allowedOrigins.includes(origin);
}

function corsHeaders(req) {
  const origin = getOrigin(req);
  const headers = { Vary: 'Origin' };
  if (origin && originAllowed(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Credentials'] = 'true';
    headers['Access-Control-Allow-Methods'] = 'POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization, X-Idempotency-Key, X-Device-ID';
    headers['Access-Control-Max-Age'] = '600';
  }
  return headers;
}

function assertBrowserOrigin(req, { allowNoOrigin = false } = {}) {
  const origin = getOrigin(req);
  if (!origin && allowNoOrigin) return;
  if (!originAllowed(origin)) throw new Error('Origin not allowed.');
}

function getClientIp(req) {
  const forwarded = String(req.headers.get('x-forwarded-for') || '').split(',')[0].trim();
  const real = String(req.headers.get('x-real-ip') || '').trim();
  return (forwarded || real || 'unknown').slice(0, 100);
}

function normalizeEmail(raw) {
  const email = String(raw || '').trim().toLowerCase();
  if (email.length < 3 || email.length > 254) throw new Error('Invalid account.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Invalid account.');
  return email;
}

function normalizeDeviceId(raw) {
  const id = String(raw || '').trim();
  if (!id || id.length > 256) return '';
  return id;
}

function validPlan(planId) {
  return Object.prototype.hasOwnProperty.call(PLANS, planId);
}

function planPublic(plan) {
  return {
    id: plan.id,
    name: plan.name,
    amountInr: plan.amountInr,
    monthlyCredits: plan.monthlyCredits,
    currency: 'INR',
    accessDays: CONFIG.billingPeriodDays,
  };
}

function parseCookieHeader(raw) {
  const map = {};
  for (const part of String(raw || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) map[k] = v;
  }
  return map;
}

function base64UrlFromBytes(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function bytesFromBase64Url(text) {
  const normalized = String(text || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function utf8Bytes(text) {
  return encoder.encode(String(text));
}

function bytesToHex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  const clean = String(hex || '').replace(/[^0-9a-f]/gi, '');
  const bytes = new Uint8Array(Math.floor(clean.length / 2));
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

async function sha256Hex(input) {
  const digest = await crypto.subtle.digest('SHA-256', utf8Bytes(input));
  return bytesToHex(new Uint8Array(digest));
}

async function hmacSha256Bytes(secret, input) {
  const key = await crypto.subtle.importKey(
    'raw',
    utf8Bytes(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, utf8Bytes(input)));
}

async function hmacHex(secret, input) {
  return bytesToHex(await hmacSha256Bytes(secret, input));
}

async function timingSafeEqualStrings(a, b) {
  const aa = await crypto.subtle.digest('SHA-256', utf8Bytes(String(a)));
  const bb = await crypto.subtle.digest('SHA-256', utf8Bytes(String(b)));
  const av = new Uint8Array(aa);
  const bv = new Uint8Array(bb);
  let diff = 0;
  for (let i = 0; i < av.length; i++) diff |= av[i] ^ bv[i];
  return diff === 0;
}

function randomBytes(length = 32) {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}

function randomToken() {
  return base64UrlFromBytes(randomBytes(32));
}

function validIdempotencyKey(value) {
  const key = String(value || '').trim();
  return key.length >= 12 && key.length <= 100 && /^[A-Za-z0-9._:-]+$/.test(key) ? key : '';
}

function sanitizeText(value, max = 500) {
  return String(value ?? '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').slice(0, max);
}

async function readJsonBody(req) {
  const contentType = String(req.headers.get('content-type') || '').toLowerCase();
  if (!contentType.includes('application/json')) throw new Error('Content-Type must be application/json.');
  const text = await req.text();
  if (encoder.encode(text).byteLength > MAX_JSON_BYTES) throw new Error('Payload too large.');
  try {
    const body = JSON.parse(text);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new Error('Invalid JSON payload.');
  }
}

async function readRawBody(req) {
  const body = await req.text();
  if (encoder.encode(body).byteLength > MAX_WEBHOOK_BYTES) throw new Error('Webhook payload too large.');
  return body;
}

async function parseStoredJson(value, fallback = null) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

async function redisCommand(commandArray) {
  requireRuntimeConfig();
  const res = await fetch(CONFIG.redisUrl.replace(/\/$/, ''), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${CONFIG.redisToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(commandArray),
  });
  if (!res.ok) throw new Error('Billing storage unavailable.');
  const data = await res.json();
  if (data?.error) throw new Error('Billing storage error.');
  return data?.result;
}

async function redisGet(key) {
  return redisCommand(['GET', key]);
}

async function redisSet(key, value, ttlSeconds = null) {
  if (ttlSeconds) return redisCommand(['SET', key, value, 'EX', String(ttlSeconds)]);
  return redisCommand(['SET', key, value]);
}

async function redisSetNx(key, value, ttlSeconds) {
  return redisCommand(['SET', key, value, 'NX', 'EX', String(ttlSeconds)]);
}

async function redisDel(key) {
  return redisCommand(['DEL', key]);
}

async function redisZadd(key, score, member) {
  return redisCommand(['ZADD', key, String(score), member]);
}

async function acquireLock(key, ttlSeconds = ACCOUNT_LOCK_TTL_SECONDS) {
  const token = randomToken();
  const result = await redisSetNx(key, token, ttlSeconds);
  return result === 'OK' ? token : null;
}

async function releaseLock(key, token) {
  if (!token) return;
  try {
    const current = await redisGet(key);
    if (current === token) await redisDel(key);
  } catch {
    // Do not fail the payment response because an expiring lock could not be released.
  }
}

async function rateLimit(req, bucket, limit, ttlSeconds = RATE_TTL_SECONDS) {
  const ipHash = await sha256Hex(getClientIp(req));
  const key = `billing:ratelimit:${bucket}:${ipHash}`;
  const count = Number(await redisCommand(['INCR', key]));
  if (count === 1) await redisCommand(['EXPIRE', key, String(ttlSeconds)]);
  if (count > limit) throw new Error('Too many requests. Please retry later.');
}

function sessionPayload(email, deviceId, ttlSeconds) {
  const now = Math.floor(Date.now() / 1000);
  return {
    v: 1,
    typ: 'arix-session',
    sub: email,
    did: deviceId || null,
    iat: now,
    exp: now + ttlSeconds,
    jti: base64UrlFromBytes(randomBytes(18)),
  };
}

async function signSession(payload) {
  if (!CONFIG.sessionSecret) throw new Error('Secure session signing is not configured.');
  const p = base64UrlFromBytes(utf8Bytes(JSON.stringify(payload)));
  const sig = base64UrlFromBytes(await hmacSha256Bytes(CONFIG.sessionSecret, `v1.${p}`));
  return `v1.${p}.${sig}`;
}

async function verifySessionToken(token) {
  requireRuntimeConfig({ session: true });
  const parts = String(token || '').split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') throw new Error('Authentication required.');
  const [version, payloadPart, sigPart] = parts;
  if (!/^[A-Za-z0-9_-]+$/.test(payloadPart) || !/^[A-Za-z0-9_-]+$/.test(sigPart)) {
    throw new Error('Authentication required.');
  }
  const expected = base64UrlFromBytes(await hmacSha256Bytes(CONFIG.sessionSecret, `${version}.${payloadPart}`));
  if (!(await timingSafeEqualStrings(expected, sigPart))) throw new Error('Authentication required.');
  let payload;
  try {
    payload = JSON.parse(decoder.decode(bytesFromBase64Url(payloadPart)));
  } catch {
    throw new Error('Authentication required.');
  }
  const now = Math.floor(Date.now() / 1000);
  if (!payload || payload.typ !== 'arix-session' || payload.v !== 1 || !payload.sub || !payload.jti) {
    throw new Error('Authentication required.');
  }
  if (!Number.isSafeInteger(payload.exp) || payload.exp <= now) throw new Error('Session expired.');
  if (payload.iat > now + 60) throw new Error('Authentication required.');
  const tokenHash = await sha256Hex(token);
  const sessionRecord = await parseStoredJson(await redisGet(`billing:session:${tokenHash}`), null);
  if (!sessionRecord || sessionRecord.revoked || sessionRecord.exp <= now) throw new Error('Session expired.');
  if (!(await timingSafeEqualStrings(String(sessionRecord.jti), String(payload.jti)))) {
    throw new Error('Authentication required.');
  }
  return payload;
}

function sessionCookie(token, maxAgeSeconds) {
  return [
    `__Host-arix_session=${token}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ].join('; ');
}

function clearedSessionCookie() {
  return '__Host-arix_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0';
}

function extractBearer(req) {
  const header = String(req.headers.get('authorization') || '').trim();
  if (!header) return '';
  const match = header.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

async function authenticateSecureSession(req) {
  assertBrowserOrigin(req, { allowNoOrigin: true });
  const bearer = extractBearer(req);
  const cookieToken = parseCookieHeader(req.headers.get('cookie')).__Host-arix_session || '';
  const token = bearer || cookieToken;
  if (!token) throw new Error('Authentication required.');
  const payload = await verifySessionToken(token);
  const email = normalizeEmail(payload.sub);
  const userRaw = await redisGet(`user:${email}`);
  const user = await parseStoredJson(userRaw, null);
  if (!user || user.status === 'blocked') throw new Error('Account unavailable.');
  if (CONFIG.bindSessionToDevice) {
    const deviceId = normalizeDeviceId(req.headers.get('x-device-id'));
    if (payload.did && deviceId && payload.did !== deviceId) throw new Error('Session device mismatch.');
  }
  return { email, user, payload, token };
}

async function issueSecureSession(req, email, deviceId) {
  requireRuntimeConfig({ session: true });
  const ttl = CONFIG.sessionTtlDays * 86400;
  const payload = sessionPayload(email, deviceId, ttl);
  const token = await signSession(payload);
  const tokenHash = await sha256Hex(token);
  await redisSet(`billing:session:${tokenHash}`, JSON.stringify({
    email,
    jti: payload.jti,
    iat: payload.iat,
    exp: payload.exp,
    deviceId: deviceId || null,
    revoked: false,
  }), ttl);
  return { token, ttl };
}

async function loadUserByEmail(email) {
  const raw = await redisGet(`user:${email}`);
  const user = await parseStoredJson(raw, null);
  if (!user || user.status === 'blocked') throw new Error('Account unavailable.');
  return user;
}

async function verifyLegacySession(req, email, legacyToken, deviceId) {
  if (!CONFIG.legacySessionEnabled) throw new Error('Legacy session upgrade is disabled.');
  const user = await loadUserByEmail(email);
  if (!legacyToken || !user?.pwdHash) throw new Error('Authentication required.');
  if (!(await timingSafeEqualStrings(String(user.pwdHash), String(legacyToken)))) {
    throw new Error('Authentication required.');
  }
  if (CONFIG.bindSessionToDevice) {
    const storedDevice = normalizeDeviceId(user.deviceId);
    if (storedDevice && deviceId && storedDevice !== deviceId) throw new Error('Account device mismatch.');
  }
  return user;
}

function makePublicOrigin(req) {
  if (!CONFIG.publicUrl) throw new Error('ARIX_PUBLIC_URL is not configured.');
  const url = new URL(CONFIG.publicUrl);
  if (url.protocol !== 'https:' && !/^(localhost|127\.0\.0\.1)$/i.test(url.hostname)) {
    throw new Error('ARIX_PUBLIC_URL must use HTTPS in production.');
  }
  return url.origin;
}

function buildSafeRedirect(req, configuredPath) {
  const origin = makePublicOrigin(req);
  const raw = String(configuredPath || '').trim();
  if (!raw.startsWith('/') || raw.startsWith('//') || /[\r\n]/.test(raw)) {
    throw new Error('Invalid payment redirect configuration.');
  }
  const u = new URL(raw, origin);
  if (u.origin !== origin) throw new Error('Invalid payment redirect configuration.');
  return u.toString();
}

function internalOrderId() {
  return `ord_${Date.now().toString(36)}_${base64UrlFromBytes(randomBytes(12)).slice(0, 16)}`;
}

function orderKey(orderId) {
  return `billing:order:${orderId}`;
}

async function saveOrder(order, ttl = ORDER_TTL_SECONDS) {
  await redisSet(orderKey(order.orderId), JSON.stringify(order), ttl);
  await redisSet(`billing:provider:${order.provider}:${order.providerOrderId}`, order.orderId, ttl);
  await redisZadd(`billing:orders:${order.accountHash}`, Date.now(), order.orderId);
}

async function loadOrderForAccount(orderId, accountHash) {
  const clean = sanitizeText(orderId, 120);
  if (!/^ord_[a-z0-9_\-]+$/i.test(clean)) throw new Error('Invalid order.');
  const order = await parseStoredJson(await redisGet(orderKey(clean)), null);
  if (!order || order.accountHash !== accountHash) throw new Error('Order not found.');
  return order;
}

async function saveIdempotency(accountHash, key, fingerprint, result) {
  const idHash = await sha256Hex(key);
  const redisKey = `billing:idempotency:${accountHash}:${idHash}`;
  const record = { fingerprint, result, createdAt: Date.now() };
  const existing = await redisSetNx(redisKey, JSON.stringify(record), IDEMPOTENCY_TTL_SECONDS);
  if (existing === 'OK') return { created: true, result };
  const previous = await parseStoredJson(await redisGet(redisKey), null);
  if (!previous || previous.fingerprint !== fingerprint) throw new Error('Idempotency key reuse conflict.');
  return { created: false, result: previous.result };
}

async function createInternalOrder(account, plan, provider, idempotencyKey) {
  const orderId = internalOrderId();
  const createdAt = Date.now();
  const fingerprint = await sha256Hex(JSON.stringify({
    provider,
    planId: plan.id,
    amountInr: plan.amountInr,
    accountHash: account.accountHash,
  }));
  const idempotency = await saveIdempotency(account.accountHash, idempotencyKey, fingerprint, {
    orderId,
    provider,
  });
  if (!idempotency.created) {
    const previousOrder = await loadOrderForAccount(idempotency.result.orderId, account.accountHash);
    return { existing: true, order: previousOrder };
  }
  const order = {
    version: 1,
    orderId,
    accountHash: account.accountHash,
    accountEmail: account.email,
    planId: plan.id,
    planName: plan.name,
    amountPaise: plan.amountInr * 100,
    currency: 'INR',
    provider,
    providerOrderId: null,
    status: 'created',
    createdAt,
    expiresAt: createdAt + 1000 * 60 * 60 * 48,
    accessDays: CONFIG.billingPeriodDays,
    activatedAt: null,
    paidAt: null,
    refundedAt: null,
    providerPaymentId: null,
    idempotencyKeyHash: await sha256Hex(idempotencyKey),
  };
  return { existing: false, order };
}

function stripeAuthHeader() {
  if (!CONFIG.stripeSecret) throw new Error('Stripe is not configured.');
  const encoded = btoa(`${CONFIG.stripeSecret}:`);
  return `Basic ${encoded}`;
}

async function stripeRequest(path, { method = 'GET', form = null, idempotencyKey = null } = {}) {
  const headers = {
    Authorization: stripeAuthHeader(),
  };
  let body;
  if (form) {
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(form).toString();
  }
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey;
  const res = await fetch(`https://api.stripe.com${path}`, { method, headers, body });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* keep null */ }
  if (!res.ok) throw new Error(data?.error?.message || 'Stripe request failed.');
  return data;
}

async function createStripeCheckout(order, plan, req) {
  requireRuntimeConfig({ paymentProvider: 'stripe' });
  if (!CONFIG.stripeSecret) throw new Error('Stripe is not configured.');
  const successUrl = buildSafeRedirect(req, CONFIG.successPath);
  const cancelUrl = buildSafeRedirect(req, CONFIG.cancelPath);
  const successWithSession = successUrl.includes('?')
    ? `${successUrl}&session_id={CHECKOUT_SESSION_ID}`
    : `${successUrl}?session_id={CHECKOUT_SESSION_ID}`;

  const form = {
    mode: 'payment',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'inr',
    'line_items[0][price_data][unit_amount]': String(order.amountPaise),
    'line_items[0][price_data][product_data][name]': `ArixAI ${plan.name}`,
    'line_items[0][price_data][product_data][description]': `${CONFIG.billingPeriodDays}-day ArixAI access`,
    'client_reference_id': order.orderId,
    'success_url': successWithSession,
    'cancel_url': cancelUrl,
    'expires_at': String(Math.floor(Math.min(order.expiresAt, Date.now() + 1000 * 60 * 60 * 24) / 1000)),
    'metadata[arix_order_id]': order.orderId,
    'metadata[arix_account]': order.accountHash,
    'metadata[arix_plan_id]': plan.id,
    'payment_intent_data[metadata][arix_order_id]': order.orderId,
    'payment_intent_data[metadata][arix_account]': order.accountHash,
    'payment_intent_data[metadata][arix_plan_id]': plan.id,
    customer_email: order.accountEmail,
  };
  // Do not specify payment_method_types here. Stripe Checkout can then expose the payment
  // methods enabled for the merchant, including UPI where the account is eligible.
  const session = await stripeRequest('/v1/checkout/sessions', {
    method: 'POST',
    form,
    idempotencyKey: `arix-${order.idempotencyKeyHash}`,
  });
  if (!session?.id || !session?.url) throw new Error('Stripe did not return a valid checkout session.');
  order.providerOrderId = session.id;
  order.providerCheckoutUrl = session.url;
  order.providerPaymentId = session.payment_intent || null;
  await saveOrder(order);
  return {
    provider: 'stripe',
    orderId: order.orderId,
    checkoutUrl: session.url,
    sessionId: session.id,
    amountInr: plan.amountInr,
    currency: 'INR',
    planId: plan.id,
  };
}

function razorpayAuthHeader() {
  if (!CONFIG.razorpayKeyId || !CONFIG.razorpayKeySecret) throw new Error('Razorpay is not configured.');
  const encoded = btoa(`${CONFIG.razorpayKeyId}:${CONFIG.razorpayKeySecret}`);
  return `Basic ${encoded}`;
}

async function razorpayRequest(path, { method = 'GET', body = null } = {}) {
  const headers = {
    Authorization: razorpayAuthHeader(),
    'Content-Type': 'application/json',
  };
  const res = await fetch(`https://api.razorpay.com${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch { /* keep null */ }
  if (!res.ok) throw new Error(data?.error?.description || 'Razorpay request failed.');
  return data;
}

async function createRazorpayOrder(order, plan) {
  const rzp = await razorpayRequest('/v1/orders', {
    method: 'POST',
    body: {
      amount: order.amountPaise,
      currency: 'INR',
      receipt: order.orderId.slice(0, 40),
      payment_capture: 1,
      notes: {
        arix_order_id: order.orderId,
        arix_plan_id: plan.id,
        arix_account: order.accountHash.slice(0, 32),
      },
    },
  });
  if (!rzp?.id || Number(rzp.amount) !== order.amountPaise || String(rzp.currency).toUpperCase() !== 'INR') {
    throw new Error('Razorpay returned an invalid order.');
  }
  order.providerOrderId = rzp.id;
  await saveOrder(order);
  return {
    provider: 'razorpay',
    orderId: order.orderId,
    providerOrderId: rzp.id,
    keyId: CONFIG.razorpayKeyId,
    amountInr: plan.amountInr,
    amountPaise: order.amountPaise,
    currency: 'INR',
    planId: plan.id,
    name: `ArixAI ${plan.name}`,
  };
}

async function getRazorpayPayment(paymentId) {
  if (!/^pay_[A-Za-z0-9]+$/.test(String(paymentId || ''))) throw new Error('Invalid payment.');
  return razorpayRequest(`/v1/payments/${encodeURIComponent(paymentId)}`);
}

async function getRazorpayOrderPayments(providerOrderId) {
  return razorpayRequest(`/v1/orders/${encodeURIComponent(providerOrderId)}/payments`);
}

async function stripeVerifyWebhook(rawBody, signatureHeader) {
  if (!CONFIG.stripeWebhookSecret) throw new Error('Stripe webhook secret is not configured.');
  const header = String(signatureHeader || '');
  const pairs = header.split(',').map(part => part.trim()).filter(Boolean);
  const timestamp = pairs.find(p => p.startsWith('t='))?.slice(2) || '';
  const signatures = pairs.filter(p => p.startsWith('v1=')).map(p => p.slice(3));
  if (!/^\d+$/.test(timestamp) || signatures.length === 0) throw new Error('Invalid Stripe signature.');
  const now = Math.floor(Date.now() / 1000);
  const age = Math.abs(now - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) throw new Error('Stale Stripe webhook.');
  const expected = await hmacHex(CONFIG.stripeWebhookSecret, `${timestamp}.${rawBody}`);
  let valid = false;
  for (const candidate of signatures) {
    if (await timingSafeEqualStrings(expected, candidate)) { valid = true; break; }
  }
  if (!valid) throw new Error('Invalid Stripe signature.');
}

async function razorpayVerifyWebhook(rawBody, signatureHeader) {
  if (!CONFIG.razorpayWebhookSecret) throw new Error('Razorpay webhook secret is not configured.');
  const actual = String(signatureHeader || '');
  if (!/^[0-9a-f]{64}$/i.test(actual)) throw new Error('Invalid Razorpay signature.');
  const expected = await hmacHex(CONFIG.razorpayWebhookSecret, rawBody);
  if (!(await timingSafeEqualStrings(expected, actual))) throw new Error('Invalid Razorpay signature.');
}

async function markEventProcessing(provider, eventId) {
  const cleanEvent = sanitizeText(eventId, 200);
  if (!cleanEvent || !/^[A-Za-z0-9._:-]+$/.test(cleanEvent)) throw new Error('Invalid event.');
  const key = `billing:event:${provider}:${cleanEvent}`;
  const result = await redisSetNx(key, JSON.stringify({ state: 'processing', ts: Date.now() }), EVENT_PROCESSING_TTL_SECONDS);
  if (result !== 'OK') {
    const existing = await parseStoredJson(await redisGet(key), null);
    if (existing?.state === 'done') return { duplicate: true, key, done: true };
    return { duplicate: true, key, done: false };
  }
  return { duplicate: false, key, done: false };
}

async function markEventDone(key) {
  await redisSet(key, JSON.stringify({ state: 'done', ts: Date.now() }), EVENT_DONE_TTL_SECONDS);
}

async function ensureOrderForActivation(provider, providerOrderId, accountHint = null) {
  const orderId = await redisGet(`billing:provider:${provider}:${providerOrderId}`);
  if (!orderId) throw new Error('Unknown provider order.');
  const order = await parseStoredJson(await redisGet(orderKey(orderId)), null);
  if (!order) throw new Error('Unknown internal order.');
  if (order.provider !== provider || order.providerOrderId !== providerOrderId) throw new Error('Order binding mismatch.');
  if (accountHint && order.accountHash !== accountHint) throw new Error('Order/account mismatch.');
  return order;
}

async function writeEntitlementFromOrder(order, providerPaymentId, paymentPaidAt = Date.now()) {
  const lockKey = `billing:lock:${order.accountHash}`;
  const lock = await acquireLock(lockKey);
  if (!lock) throw new Error('Account billing lock busy.');
  try {
    const entKey = `billing:entitlement:${order.accountHash}`;
    const current = await parseStoredJson(await redisGet(entKey), null);
    const now = Date.now();
    const activeCurrent = current && current.status === 'active' && Number(current.expiresAt) > now;
    const base = activeCurrent ? Number(current.expiresAt) : now;
    const expiresAt = base + CONFIG.billingPeriodDays * 86400000;
    const plan = PLANS[order.planId];
    if (!plan) throw new Error('Stored order contains unknown plan.');

    const next = {
      version: 1,
      accountHash: order.accountHash,
      status: 'active',
      planId: plan.id,
      planName: plan.name,
      amountInr: plan.amountInr,
      currency: 'INR',
      monthlyCredits: plan.monthlyCredits,
      creditBalance: activeCurrent && current.planId === plan.id
        ? Number(current.creditBalance || 0) + Number(plan.monthlyCredits || 0)
        : Number(plan.monthlyCredits || 0),
      startedAt: activeCurrent ? Number(current.startedAt || now) : now,
      expiresAt,
      accessDays: CONFIG.billingPeriodDays,
      provider: order.provider,
      providerPaymentId: providerPaymentId || order.providerPaymentId || null,
      latestOrderId: order.orderId,
      latestPaidAt: paymentPaidAt,
      sourceOrderCreatedAt: order.createdAt,
      updatedAt: now,
    };

    await redisSet(entKey, JSON.stringify(next), ORDER_TTL_SECONDS);
    order.status = 'paid';
    order.activatedAt = activeCurrent ? (order.activatedAt || now) : now;
    order.paidAt = paymentPaidAt;
    order.providerPaymentId = providerPaymentId || order.providerPaymentId || null;
    await saveOrder(order);
    return next;
  } finally {
    await releaseLock(lockKey, lock);
  }
}

async function revokeEntitlementForRefund(order, refundedAt = Date.now()) {
  const lockKey = `billing:lock:${order.accountHash}`;
  const lock = await acquireLock(lockKey);
  if (!lock) throw new Error('Account billing lock busy.');
  try {
    const entKey = `billing:entitlement:${order.accountHash}`;
    const current = await parseStoredJson(await redisGet(entKey), null);
    if (current?.latestOrderId === order.orderId) {
      const next = {
        ...current,
        status: Number(current.expiresAt || 0) > Date.now() ? 'refunded' : 'expired',
        refundedOrderId: order.orderId,
        refundedAt,
        updatedAt: Date.now(),
      };
      await redisSet(entKey, JSON.stringify(next), ORDER_TTL_SECONDS);
    }
    order.status = 'refunded';
    order.refundedAt = refundedAt;
    await saveOrder(order);
  } finally {
    await releaseLock(lockKey, lock);
  }
}

async function handleStripeEvent(event) {
  const type = sanitizeText(event?.type, 120);
  const object = event?.data?.object || null;
  if (!type || !object) return { ignored: true };

  if (type === 'checkout.session.completed' || type === 'checkout.session.async_payment_succeeded') {
    if (object.payment_status !== 'paid') return { ignored: true };
    const orderId = sanitizeText(object?.metadata?.arix_order_id || object?.client_reference_id, 120);
    if (!orderId) throw new Error('Stripe event missing internal order reference.');
    const order = await parseStoredJson(await redisGet(orderKey(orderId)), null);
    if (!order || order.provider !== 'stripe') throw new Error('Unknown Stripe order.');
    if (Number(object.amount_total) !== order.amountPaise) throw new Error('Stripe amount mismatch.');
    if (String(object.currency || '').toUpperCase() !== 'INR') throw new Error('Stripe currency mismatch.');
    await writeEntitlementFromOrder(order, object.payment_intent || null, Number(event.created || 0) * 1000 || Date.now());
    return { activated: true };
  }

  if (type === 'charge.refunded') {
    let orderId = sanitizeText(object?.metadata?.arix_order_id, 120);
    if (!orderId && object?.payment_intent && CONFIG.stripeSecret) {
      try {
        const pi = await stripeRequest(`/v1/payment_intents/${encodeURIComponent(object.payment_intent)}`);
        orderId = sanitizeText(pi?.metadata?.arix_order_id, 120);
      } catch {
        // Fall through to ignored below; never guess an account.
      }
    }
    if (!orderId) return { ignored: true };
    const order = await parseStoredJson(await redisGet(orderKey(orderId)), null);
    if (!order || order.provider !== 'stripe') return { ignored: true };
    const amountRefunded = Number(object.amount_refunded || 0);
    if (amountRefunded >= order.amountPaise) {
      await revokeEntitlementForRefund(order, Date.now());
      return { revoked: true };
    }
  }

  return { ignored: true };
}

async function handleRazorpayEvent(event) {
  const type = sanitizeText(event?.event, 120);
  const paymentEntity = event?.payload?.payment?.entity || null;
  const refundEntity = event?.payload?.refund?.entity || null;

  if (type === 'payment.captured' || type === 'order.paid') {
    let providerOrderId = paymentEntity?.order_id || event?.payload?.order?.entity?.id || '';
    providerOrderId = sanitizeText(providerOrderId, 120);
    if (!providerOrderId) return { ignored: true };
    const order = await ensureOrderForActivation('razorpay', providerOrderId);
    const amount = Number(paymentEntity?.amount ?? event?.payload?.order?.entity?.amount_paid ?? 0);
    if (amount !== order.amountPaise) throw new Error('Razorpay amount mismatch.');
    const currency = String(paymentEntity?.currency ?? event?.payload?.order?.entity?.currency ?? 'INR').toUpperCase();
    if (currency !== 'INR') throw new Error('Razorpay currency mismatch.');
    const paymentId = sanitizeText(paymentEntity?.id || '', 120) || null;
    if (type === 'payment.captured' && paymentEntity?.status && paymentEntity.status !== 'captured') {
      return { ignored: true };
    }
    await writeEntitlementFromOrder(order, paymentId, Date.now());
    return { activated: true };
  }

  if (type === 'refund.created') {
    const paymentId = sanitizeText(refundEntity?.payment_id, 120);
    if (!paymentId) return { ignored: true };
    const payment = await getRazorpayPayment(paymentId);
    const providerOrderId = sanitizeText(payment?.order_id, 120);
    if (!providerOrderId) return { ignored: true };
    const order = await ensureOrderForActivation('razorpay', providerOrderId);
    const refundAmount = Number(refundEntity?.amount || 0);
    if (refundAmount >= order.amountPaise) {
      await revokeEntitlementForRefund(order, Date.now());
      return { revoked: true };
    }
  }

  return { ignored: true };
}

async function handleStripeWebhook(req) {
  const raw = await readRawBody(req);
  await stripeVerifyWebhook(raw, req.headers.get('stripe-signature'));
  let event;
  try { event = JSON.parse(raw); } catch { throw new Error('Invalid webhook JSON.'); }
  const eventId = sanitizeText(event?.id, 200);
  if (!eventId) throw new Error('Webhook event id missing.');
  const marker = await markEventProcessing('stripe', eventId);
  if (marker.duplicate) return json({ received: true, duplicate: true }, 200);
  try {
    const result = await handleStripeEvent(event);
    await markEventDone(marker.key);
    return json({ received: true, processed: true, result }, 200);
  } catch (error) {
    // Let the provider retry. The processing marker expires quickly, avoiding permanent drops.
    console.error('[ARIX-BILLING] Stripe event processing failed:', error?.message || 'unknown');
    return json({ success: false, error: 'Webhook processing failed.' }, 500);
  }
}

async function handleRazorpayWebhook(req) {
  const raw = await readRawBody(req);
  await razorpayVerifyWebhook(raw, req.headers.get('x-razorpay-signature'));
  let event;
  try { event = JSON.parse(raw); } catch { throw new Error('Invalid webhook JSON.'); }
  const eventId = sanitizeText(
    req.headers.get('x-razorpay-event-id') || event?.id || `${event?.event || 'event'}:${event?.created_at || Date.now()}`,
    200,
  );
  const marker = await markEventProcessing('razorpay', eventId);
  if (marker.duplicate) return json({ received: true, duplicate: true }, 200);
  try {
    const result = await handleRazorpayEvent(event);
    await markEventDone(marker.key);
    return json({ received: true, processed: true, result }, 200);
  } catch (error) {
    console.error('[ARIX-BILLING] Razorpay event processing failed:', error?.message || 'unknown');
    return json({ success: false, error: 'Webhook processing failed.' }, 500);
  }
}

async function actionPlans() {
  return json({
    success: true,
    currency: 'INR',
    billingPeriodDays: CONFIG.billingPeriodDays,
    plans: Object.values(PLANS).map(planPublic),
  });
}

async function actionIssueSession(req, body) {
  assertBrowserOrigin(req);
  requireRuntimeConfig({ session: true });
  await rateLimit(req, 'issue-session', 12, 60);

  const email = normalizeEmail(body.email);
  const legacyToken = sanitizeText(body.token, 2048);
  const deviceId = normalizeDeviceId(req.headers.get('x-device-id') || body.deviceId);
  if (CONFIG.bindSessionToDevice && !deviceId) throw new Error('Device binding is required.');
  const user = await verifyLegacySession(req, email, legacyToken, deviceId);
  const session = await issueSecureSession(req, email, deviceId || normalizeDeviceId(user.deviceId));

  return json({
    success: true,
    account: { email },
    expiresAt: Date.now() + session.ttl * 1000,
    message: 'Secure billing session established.',
  }, 200, {
    ...corsHeaders(req),
    'Set-Cookie': sessionCookie(session.token, session.ttl),
  });
}

async function actionLogout(req) {
  assertBrowserOrigin(req, { allowNoOrigin: true });
  const cookieToken = parseCookieHeader(req.headers.get('cookie')).__Host_arix_session || '';
  if (cookieToken) {
    try {
      const tokenHash = await sha256Hex(cookieToken);
      await redisDel(`billing:session:${tokenHash}`);
    } catch {
      // Clear the browser cookie even if the session store is unavailable.
    }
  }
  return json({ success: true }, 200, { ...corsHeaders(req), 'Set-Cookie': clearedSessionCookie() });
}

async function actionCreateCheckout(req, body) {
  assertBrowserOrigin(req);
  const accountAuth = await authenticateSecureSession(req);
  await rateLimit(req, 'create-checkout-ip', 20, 60);
  const accountRateKey = (await sha256Hex(accountAuth.email)).slice(0, 40);
  await rateLimit(req, `create-checkout-account-${accountRateKey}`, 5, 3600);

  const planId = String(body.planId || '').trim().toLowerCase();
  const provider = String(body.provider || '').trim().toLowerCase();
  const idempotencyKey = validIdempotencyKey(req.headers.get('x-idempotency-key') || body.idempotencyKey);
  if (!validPlan(planId)) throw new Error('Invalid plan.');
  if (!['stripe', 'razorpay'].includes(provider)) throw new Error('Unsupported payment provider.');
  if (!idempotencyKey) throw new Error('A unique idempotency key is required.');
  const plan = PLANS[planId];
  const accountHash = await sha256Hex(accountAuth.email);
  const account = { email: accountAuth.email, accountHash };

  const draft = await createInternalOrder(account, plan, provider, idempotencyKey);
  if (draft.existing) {
    const existing = draft.order;
    if (existing.provider === 'stripe' && existing.providerCheckoutUrl) {
      return json({ success: true, reused: true, provider: 'stripe', orderId: existing.orderId, checkoutUrl: existing.providerCheckoutUrl, planId: existing.planId }, 200, corsHeaders(req));
    }
    if (existing.provider === 'razorpay' && existing.providerOrderId) {
      return json({ success: true, reused: true, provider: 'razorpay', orderId: existing.orderId, providerOrderId: existing.providerOrderId, keyId: CONFIG.razorpayKeyId, amountPaise: existing.amountPaise, amountInr: plan.amountInr, currency: 'INR', planId: existing.planId }, 200, corsHeaders(req));
    }
    throw new Error('Previous checkout is incomplete.');
  }

  const order = draft.order;
  try {
    let result;
    if (provider === 'stripe') result = await createStripeCheckout(order, plan, req);
    else result = await createRazorpayOrder(order, plan);
    return json({ success: true, ...result, accessDays: CONFIG.billingPeriodDays }, 200, corsHeaders(req));
  } catch (error) {
    order.status = 'checkout_failed';
    order.failureCode = await sha256Hex(String(error?.message || 'provider error')).then(h => h.slice(0, 16));
    await saveOrder(order).catch(() => {});
    throw new Error('Unable to start payment checkout.');
  }
}

async function actionGetEntitlement(req) {
  assertBrowserOrigin(req);
  const auth = await authenticateSecureSession(req);
  const accountHash = await sha256Hex(auth.email);
  const entitlement = await parseStoredJson(await redisGet(`billing:entitlement:${accountHash}`), null);
  if (!entitlement) {
    return json({ success: true, entitlement: { status: 'free', planId: 'free' } }, 200, corsHeaders(req));
  }
  if (entitlement.status === 'active' && Number(entitlement.expiresAt) <= Date.now()) {
    entitlement.status = 'expired';
    entitlement.updatedAt = Date.now();
    await redisSet(`billing:entitlement:${accountHash}`, JSON.stringify(entitlement), ORDER_TTL_SECONDS);
  }
  return json({ success: true, entitlement: publicEntitlement(entitlement) }, 200, corsHeaders(req));
}

function publicEntitlement(entitlement) {
  return {
    status: entitlement.status,
    planId: entitlement.planId,
    planName: entitlement.planName,
    amountInr: entitlement.amountInr,
    currency: entitlement.currency,
    monthlyCredits: entitlement.monthlyCredits,
    creditBalance: entitlement.creditBalance,
    startedAt: entitlement.startedAt,
    expiresAt: entitlement.expiresAt,
    accessDays: entitlement.accessDays,
    provider: entitlement.provider,
    latestOrderId: entitlement.latestOrderId,
    latestPaidAt: entitlement.latestPaidAt,
  };
}

/**
 * Server-side billing helpers for auth.js or other protected ArixAI routes.
 * These never trust plan/price information supplied by a client.
 */
export async function getPaidEntitlementForEmail(rawEmail) {
  requireRuntimeConfig();
  const email = normalizeEmail(rawEmail);
  const accountHash = await sha256Hex(email);
  const key = `billing:entitlement:${accountHash}`;
  const entitlement = await parseStoredJson(await redisGet(key), null);
  if (!entitlement) return null;
  if (entitlement.status === 'active' && Number(entitlement.expiresAt) <= Date.now()) {
    entitlement.status = 'expired';
    entitlement.updatedAt = Date.now();
    await redisSet(key, JSON.stringify(entitlement), ORDER_TTL_SECONDS);
  }
  return entitlement;
}

export async function hasPaidPlan(rawEmail, minimumPlan = 'spark') {
  if (!validPlan(minimumPlan)) return false;
  const entitlement = await getPaidEntitlementForEmail(rawEmail);
  if (!entitlement || entitlement.status !== 'active') return false;
  return PLAN_RANK[entitlement.planId] >= PLAN_RANK[minimumPlan];
}

export async function getPaidEntitlementForRequest(req) {
  const auth = await authenticateSecureSession(req);
  return getPaidEntitlementForEmail(auth.email);
}

async function actionGetOrder(req, body) {
  assertBrowserOrigin(req);
  const auth = await authenticateSecureSession(req);
  const accountHash = await sha256Hex(auth.email);
  const order = await loadOrderForAccount(body.orderId, accountHash);
  return json({ success: true, order: publicOrder(order) }, 200, corsHeaders(req));
}

function publicOrder(order) {
  return {
    orderId: order.orderId,
    planId: order.planId,
    planName: order.planName,
    amountInr: order.amountPaise / 100,
    currency: order.currency,
    provider: order.provider,
    status: order.status,
    createdAt: order.createdAt,
    paidAt: order.paidAt,
    activatedAt: order.activatedAt,
    refundedAt: order.refundedAt,
    providerPaymentId: order.providerPaymentId,
  };
}

async function actionGetStatus(req, body) {
  assertBrowserOrigin(req);
  const auth = await authenticateSecureSession(req);
  const accountHash = await sha256Hex(auth.email);
  const order = await loadOrderForAccount(body.orderId, accountHash);
  if (order.status === 'paid' || order.status === 'refunded') return json({ success: true, order: publicOrder(order) }, 200, corsHeaders(req));

  if (order.provider === 'stripe') {
    if (!CONFIG.stripeSecret || !order.providerOrderId) throw new Error('Stripe order not ready.');
    const session = await stripeRequest(`/v1/checkout/sessions/${encodeURIComponent(order.providerOrderId)}`);
    if (Number(session.amount_total) !== order.amountPaise || String(session.currency || '').toUpperCase() !== 'INR') throw new Error('Provider amount mismatch.');
    if (session.payment_status === 'paid') {
      await writeEntitlementFromOrder(order, session.payment_intent || null, Date.now());
    }
  } else if (order.provider === 'razorpay') {
    if (!order.providerOrderId) throw new Error('Razorpay order not ready.');
    const payments = await getRazorpayOrderPayments(order.providerOrderId);
    const items = Array.isArray(payments?.items) ? payments.items : [];
    const paid = items.find(p => p.status === 'captured' && Number(p.amount) === order.amountPaise && String(p.currency || '').toUpperCase() === 'INR');
    if (paid) {
      await writeEntitlementFromOrder(order, paid.id, Date.now());
    }
  }

  const refreshed = await parseStoredJson(await redisGet(orderKey(order.orderId)), order);
  return json({ success: true, order: publicOrder(refreshed) }, 200, corsHeaders(req));
}

async function actionVerifyRazorpayPayment(req, body) {
  assertBrowserOrigin(req);
  const auth = await authenticateSecureSession(req);
  await rateLimit(req, 'verify-rzp-ip', 20, 60);
  const accountHash = await sha256Hex(auth.email);
  const order = await loadOrderForAccount(body.orderId, accountHash);
  if (order.provider !== 'razorpay') throw new Error('Order provider mismatch.');

  const razorpayOrderId = sanitizeText(body.razorpay_order_id, 120);
  const razorpayPaymentId = sanitizeText(body.razorpay_payment_id, 120);
  const razorpaySignature = sanitizeText(body.razorpay_signature, 200);
  if (razorpayOrderId !== order.providerOrderId || !/^pay_[A-Za-z0-9]+$/.test(razorpayPaymentId) || !/^[0-9a-f]{64}$/i.test(razorpaySignature)) {
    throw new Error('Payment verification failed.');
  }
  const expected = await hmacHex(CONFIG.razorpayKeySecret, `${razorpayOrderId}|${razorpayPaymentId}`);
  if (!(await timingSafeEqualStrings(expected, razorpaySignature))) throw new Error('Payment verification failed.');
  const payment = await getRazorpayPayment(razorpayPaymentId);
  if (payment?.order_id !== order.providerOrderId || Number(payment?.amount) !== order.amountPaise || String(payment?.currency || '').toUpperCase() !== 'INR' || payment?.status !== 'captured') {
    throw new Error('Payment verification failed.');
  }
  const entitlement = await writeEntitlementFromOrder(order, razorpayPaymentId, Date.now());
  return json({ success: true, verified: true, order: publicOrder(await parseStoredJson(await redisGet(orderKey(order.orderId)), order)), entitlement: publicEntitlement(entitlement) }, 200, corsHeaders(req));
}

async function dispatchAction(req, body) {
  const action = String(body.action || '').trim().toLowerCase();
  switch (action) {
    case 'plans': return actionPlans();
    case 'issue_session': return actionIssueSession(req, body);
    case 'logout': return actionLogout(req);
    case 'create_checkout': return actionCreateCheckout(req, body);
    case 'get_entitlement': return actionGetEntitlement(req);
    case 'get_order': return actionGetOrder(req, body);
    case 'get_status': return actionGetStatus(req, body);
    case 'verify_razorpay_payment': return actionVerifyRazorpayPayment(req, body);
    default: throw new Error('Invalid action.');
  }
}

export default async function handler(req) {
  try {
    const url = new URL(req.url);
    const webhookProvider = String(url.searchParams.get('webhook') || '').toLowerCase();

    if (webhookProvider === 'stripe') {
      if (req.method !== 'POST') return methodNotAllowed('POST, OPTIONS');
      requireRuntimeConfig();
      return await handleStripeWebhook(req);
    }
    if (webhookProvider === 'razorpay') {
      if (req.method !== 'POST') return methodNotAllowed('POST, OPTIONS');
      requireRuntimeConfig();
      return await handleRazorpayWebhook(req);
    }

    const cors = corsHeaders(req);
    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (req.method !== 'POST') return methodNotAllowed();
    assertBrowserOrigin(req);

    const body = await readJsonBody(req);
    const action = String(body.action || '').trim().toLowerCase();
    // Public plan discovery still receives the same strict origin checks but requires no account.
    if (action === 'plans') return actionPlans();

    // High-risk actions must be rate-limited before authentication work becomes expensive.
    if (['issue_session', 'create_checkout', 'verify_razorpay_payment'].includes(action)) {
      await rateLimit(req, 'ip-global', 120, 60);
    }

    return await dispatchAction(req, body);
  } catch (error) {
    const safe = String(error?.message || 'Request rejected.');
    const message = [
      'Origin not allowed.',
      'Authentication required.',
      'Session expired.',
      'Account unavailable.',
      'Order not found.',
      'Invalid plan.',
      'Unsupported payment provider.',
      'A unique idempotency key is required.',
      'Too many requests. Please retry later.',
      'Payment verification failed.',
      'Invalid action.',
    ].includes(safe) ? safe : 'Request could not be completed.';
    return json({ success: false, error: message }, 400);
  }
}
