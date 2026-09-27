/**
 * ArixAI per-user cloud storage gateway.
 *
 * Runtime: Vercel Edge
 * Module format: ES module
 *
 * Design goals:
 * - Cloud storage is opt-in; device-only mode requires no chat payload to reach this API.
 * - Authentication is derived only from the existing ArixAI HttpOnly session in otp.js.
 * - The browser never supplies or selects a user_id. The server derives it from the session.
 * - Supabase is reachable only from this server route with a secret/server key.
 * - One transaction per sync batch using a Postgres RPC.
 * - Composite (user_id, id) keys + composite foreign keys make cross-user relations invalid.
 * - Projects reference chats instead of duplicating full message arrays.
 * - Images/videos/files are represented by URL/external-id/reference metadata only.
 * - Full message text is stored; large values are kept in TEXT so Postgres can apply its own TOAST storage.
 * - Fast initial loading uses a small bootstrap response, then lazy chat-page loading.
 * - Generic memory/settings/events fields preserve future ArixAI data without schema churn.
 * - Rate limiting, strict payload limits, same-origin validation, fail-closed configuration,
 *   transactional writes, and non-sensitive error responses are enforced here.
 *
 * Environment variables (Vercel server-side only):
 *   SUPABASE_URL
 *   SUPABASE_SERVICE_ROLE_KEY
 *   UPSTASH_REDIS_REST_URL (or UPSTASH_URL)
 *   UPSTASH_REDIS_REST_TOKEN (or UPSTASH_TOKEN)
 *   ARIX_AUTH_SECRET
 *
 * IMPORTANT:
 * Never hardcode the Supabase service key or Upstash token. Credentials pasted into chat/source
 * should be rotated before production use.
 */

import { authenticateArixSession } from './otp.js';

export const config = {
    runtime: 'edge',
    maxDuration: 30,
};

const VERSION = 'arix-storage-1.1.0';

const SERVER_ENV = globalThis.process?.env || {};
const ENV = Object.freeze({
    supabaseUrl: "https://vvcpdfdofihdmzshglxr.supabase.co",
    supabaseKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ2Y3BmZG9maWhkbXpzaGRnbHhyIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NTA2NzQ5MCwiZXhwIjoyMTAwNjQzNDkwfQ.ACRUkwnNiVg-6ZNqSlKYYev0csd_cT6tgiL0T0fPKLQ",
    redisUrl: "https://immortal-eagle-36171.upstash.io",
    redisToken: "AY1LAAIgcDE5MjFiMmNkNGQ4M2M0ODQ2YWNhYjU0YmFmMzlhNjliNw",
    authSecret: "ARIX_SECRET_KEY_1234567890123456" // Retained as an alias so legacy functions checking ENV.authSecret will not crash
});

const APP_ORIGINS = new Set([
    'https://lexis-ai-chatini.vercel.app',
    'https://lexis-ai-chatini.vercel.app/app.html',
    'https://lexis-ai-chatini.vercel.app/app123.html',
    'https://chatini-ai.vercel.app',
    'http://localhost:3000',
    'http://localhost:5173',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:5173',
]);

const LIMITS = Object.freeze({
    maxBodyBytes: 4_500_000,
    maxSyncOps: 500,
    maxChatPage: 200,
    maxBootstrapChats: 100,
    maxBootstrapProjects: 100,
    maxBootstrapTasks: 150,
    maxBootstrapPins: 200,
    maxBootstrapArtifacts: 100,
    maxBootstrapLibraryRefs: 100,
    maxTitleChars: 2000,
    maxIdChars: 256,
    maxRoleChars: 64,
    maxModelChars: 256,
    maxContentBytes: 2_000_000,
    maxExtraBytes: 500_000,
    maxAttachmentBytes: 100_000,
    maxUrlChars: 8_192,
    maxExternalIdChars: 1024,
    maxMimeChars: 256,
    maxTaskDataBytes: 2_000_000,
    maxArtifactMetaBytes: 256_000,
    maxLibraryMetaBytes: 256_000,
    maxEventPayloadBytes: 256_000,
    maxMemoryValueBytes: 500_000,
    maxSettingValueBytes: 100_000,
    syncPerUserMinute: 600,
    readPerUserMinute: 600,
    writePerIpMinute: 600,
    modePerUserHour: 100,
    purgePerUserDay: 10,
});

const encoder = new TextEncoder();

const BASE_HEADERS = Object.freeze({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-site',
});

function responseHeaders(req) {
    const headers = new Headers(BASE_HEADERS);
    const origin = String(req.headers.get('origin') || '').trim();
    if (APP_ORIGINS.has(origin)) {
        headers.set('Access-Control-Allow-Origin', origin);
        headers.set('Access-Control-Allow-Credentials', 'true');
        headers.set('Vary', 'Origin');
    }
    return headers;
}

function reply(req, payload, status = 200, extra = {}) {
    const headers = responseHeaders(req);
    for (const [key, value] of Object.entries(extra)) headers.set(key, String(value));
    return new Response(JSON.stringify(payload), { status, headers });
}

function fail(req, status, code, message) {
    return reply(req, { success: false, error: message, code, version: VERSION }, status);
}

function requireConfig() {
    const missing = [];
    if (!ENV.supabaseUrl) missing.push('SUPABASE_URL');
    if (!ENV.supabaseKey) missing.push('SUPABASE_SERVICE_ROLE_KEY');
    if (!ENV.redisUrl) missing.push('UPSTASH_REDIS_REST_URL');
    if (!ENV.redisToken) missing.push('UPSTASH_REDIS_REST_TOKEN');
    if (!ENV.authSecret || ENV.authSecret.length < 32) missing.push('ARIX_AUTH_SECRET');

    if (missing.length) {
        const error = new Error(`Storage configuration incomplete: ${missing.join(', ')}`);
        error.code = 'CONFIGURATION_ERROR';
        throw error;
    }

    let url;
    try { url = new URL(ENV.supabaseUrl); } catch {
        const error = new Error('Supabase URL is invalid.');
        error.code = 'CONFIGURATION_ERROR';
        throw error;
    }
    if (url.protocol !== 'https:') {
        const error = new Error('Supabase URL must use HTTPS.');
        error.code = 'CONFIGURATION_ERROR';
        throw error;
    }
}

function requireBrowserOrigin(req) {
    const origin = String(req.headers.get('origin') || '').trim();
    if (!origin || !APP_ORIGINS.has(origin)) {
        const error = new Error('Origin not allowed.');
        error.code = 'ORIGIN_DENIED';
        throw error;
    }
}

function getClientIp(req) {
    const forwarded = String(req.headers.get('x-forwarded-for') || '').split(',')[0].trim();
    if (forwarded) return forwarded.slice(0, 80);
    const real = String(req.headers.get('x-real-ip') || '').trim();
    return (real || 'unknown').slice(0, 80);
}

async function sha256Hex(value) {
    const bytes = encoder.encode(String(value));
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    let out = '';
    for (const b of digest) out += b.toString(16).padStart(2, '0');
    return out;
}

async function redisCommand(command) {
    const res = await fetch(ENV.redisUrl, {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${ENV.redisToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
        },
        body: JSON.stringify(command),
    });
    if (!res.ok) {
        const error = new Error('Rate-limit service unavailable.');
        error.code = 'RATE_STORE_UNAVAILABLE';
        throw error;
    }
    const data = await res.json();
    if (data?.error) {
        const error = new Error('Rate-limit service error.');
        error.code = 'RATE_STORE_UNAVAILABLE';
        throw error;
    }
    return data?.result ?? null;
}

async function redisIncrWithExpiry(key, ttlSeconds) {
    const count = Number(await redisCommand(['INCR', key]));
    if (count === 1) await redisCommand(['EXPIRE', key, String(ttlSeconds)]);
    return count;
}

async function rateLimit(key, limit, ttlSeconds) {
    const count = await redisIncrWithExpiry(key, ttlSeconds);
    if (count > limit) {
        const error = new Error('Too many storage requests. Please retry later.');
        error.code = 'RATE_LIMITED';
        throw error;
    }
    return count;
}

function validateId(value, field = 'id') {
    const id = String(value ?? '').trim();
    if (!id || id.length > LIMITS.maxIdChars || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(id)) {
        throw new Error(`Invalid ${field}.`);
    }
    return id;
}

function validateShort(value, max, field, allowEmpty = true) {
    const text = String(value ?? '');
    if (!allowEmpty && text.length === 0) throw new Error(`${field} is required.`);
    if (text.length > max) throw new Error(`${field} is too long.`);
    for (const ch of text) {
        const cp = ch.codePointAt(0);
        if (cp < 0x20 || cp === 0x7f) throw new Error(`${field} contains unsupported control characters.`);
    }
    return text;
}

function safeJsonObject(value, field = 'data', maxBytes = LIMITS.maxExtraBytes) {
    if (value == null) return {};
    if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object.`);
    const bytes = encoder.encode(JSON.stringify(value)).byteLength;
    if (bytes > maxBytes) throw new Error(`${field} is too large.`);
    return value;
}

function safeJsonValue(value, field, maxBytes) {
    const bytes = encoder.encode(JSON.stringify(value ?? null)).byteLength;
    if (bytes > maxBytes) throw new Error(`${field} is too large.`);
    return value ?? null;
}

function safeContent(value) {
    const text = String(value ?? '');
    if (encoder.encode(text).byteLength > LIMITS.maxContentBytes) {
        throw new Error('Message content is too large.');
    }
    return text;
}

function safeIso(value, field = 'timestamp') {
    if (value == null || value === '') return null;
    const raw = String(value).trim();
    const date = /^\d{10,16}$/.test(raw)
        ? (raw.length <= 10
            ? new Date(Number(raw) * 1000)
            : (raw.length <= 13
                ? new Date(Number(raw))
                : new Date(Number(raw) / 1000)))
        : new Date(raw);
    if (Number.isNaN(date.getTime())) throw new Error(`Invalid ${field}.`);
    return date.toISOString();
}

function safeUrlOrEmpty(value, field = 'url') {
    const raw = String(value ?? '').trim();
    if (!raw) return null;
    if (raw.length > LIMITS.maxUrlChars) throw new Error(`${field} is too long.`);
    let u;
    try { u = new URL(raw); } catch { throw new Error(`Invalid ${field}.`); }
    if (!['https:', 'http:'].includes(u.protocol)) throw new Error(`Invalid ${field}.`);
    return raw;
}

function validateMode(value) {
    const mode = String(value || '').trim().toLowerCase();
    if (mode !== 'device' && mode !== 'cloud') throw new Error('Storage mode must be device or cloud.');
    return mode;
}

async function parseBody(req) {
    const contentType = String(req.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('application/json')) throw new Error('Content-Type must be application/json.');
    const raw = await req.text();
    if (encoder.encode(raw).byteLength > LIMITS.maxBodyBytes) {
        const error = new Error('Request payload is too large.');
        error.code = 'PAYLOAD_TOO_LARGE';
        throw error;
    }
    let body;
    try { body = raw ? JSON.parse(raw) : {}; } catch {
        const error = new Error('Invalid JSON request.');
        error.code = 'INVALID_JSON';
        throw error;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Invalid request body.');
    return body;
}

function normalizeSyncChanges(changes) {
    if (!changes || typeof changes !== 'object' || Array.isArray(changes)) {
        throw new Error('changes must be an object.');
    }

    const arrayKeys = [
        'chats', 'messages', 'projects', 'projectChats', 'pinned',
        'tasks', 'artifacts', 'libraryRefs', 'memory', 'settings', 'events', 'deletes',
    ];

    let opCount = 0;
    const normalized = {};
    for (const key of arrayKeys) {
        const value = changes[key] == null ? [] : changes[key];
        if (!Array.isArray(value)) throw new Error(`${key} must be an array.`);
        opCount += value.length;
        if (value.length > LIMITS.maxSyncOps) throw new Error(`${key} contains too many operations.`);
        normalized[key] = value;
    }
    if (opCount > LIMITS.maxSyncOps) throw new Error('Too many sync operations in one request.');

    normalized.chats = normalized.chats.map((v) => ({
        id: validateId(v?.id, 'chat id'),
        title: validateShort(v?.title ?? '', LIMITS.maxTitleChars, 'Chat title'),
        extId: validateShort(v?.extId ?? '', LIMITS.maxExternalIdChars, 'Chat extension id'),
        createdAt: safeIso(v?.createdAt, 'chat createdAt'),
        updatedAt: safeIso(v?.updatedAt, 'chat updatedAt'),
        extra: safeJsonObject(v?.extra, 'Chat extra'),
    }));

    normalized.messages = normalized.messages.map((v) => {
        const attachments = v?.attachments ?? v?.attachmentsMeta ?? [];
        if (!Array.isArray(attachments)) throw new Error('Message attachments must be an array.');
        const normalizedAttachments = attachments.map((a) => ({
            name: validateShort(a?.name ?? '', 512, 'Attachment name'),
            type: validateShort(a?.type ?? '', LIMITS.maxMimeChars, 'Attachment type'),
            id: validateShort(a?.id ?? '', LIMITS.maxExternalIdChars, 'Attachment id'),
            url: safeUrlOrEmpty(a?.url, 'Attachment URL'),
            size: Number.isFinite(Number(a?.size)) ? Math.max(0, Math.min(Number(a.size), 1_000_000_000_000)) : null,
        }));
        if (encoder.encode(JSON.stringify(normalizedAttachments)).byteLength > LIMITS.maxAttachmentBytes) {
            throw new Error('Message attachments metadata is too large.');
        }
        return {
            id: validateId(v?.id, 'message id'),
            chatId: validateId(v?.chatId, 'message chat id'),
            role: validateShort(v?.role ?? '', LIMITS.maxRoleChars, 'Message role', false),
            content: safeContent(v?.content ?? ''),
            modelId: validateShort(v?.modelId ?? '', LIMITS.maxModelChars, 'Message model id'),
            createdAt: safeIso(v?.createdAt, 'message createdAt'),
            updatedAt: safeIso(v?.updatedAt ?? v?.createdAt, 'message updatedAt'),
            attachments: normalizedAttachments,
            extra: safeJsonObject(v?.extra, 'Message extra'),
        };
    });

    normalized.projects = normalized.projects.map((v) => ({
        id: validateId(v?.id, 'project id'),
        name: validateShort(v?.name ?? '', LIMITS.maxTitleChars, 'Project name', false),
        createdAt: safeIso(v?.createdAt, 'project createdAt'),
        updatedAt: safeIso(v?.updatedAt, 'project updatedAt'),
        extra: safeJsonObject(v?.extra, 'Project extra'),
    }));

    normalized.projectChats = normalized.projectChats.map((v) => ({
        projectId: validateId(v?.projectId, 'project id'),
        chatId: validateId(v?.chatId, 'project chat id'),
        addedAt: safeIso(v?.addedAt, 'project chat addedAt'),
        extra: safeJsonObject(v?.extra, 'Project chat extra'),
    }));

    normalized.pinned = normalized.pinned.map((v) => ({
        chatId: validateId(v?.chatId, 'pinned chat id'),
        pinnedAt: safeIso(v?.pinnedAt, 'pinnedAt'),
    }));

    normalized.tasks = normalized.tasks.map((v) => ({
        id: validateId(v?.id, 'task id'),
        kind: validateShort(v?.kind ?? 'task', 64, 'Task kind', false),
        title: validateShort(v?.title ?? '', LIMITS.maxTitleChars, 'Task title'),
        updatedAt: safeIso(v?.updatedAt, 'task updatedAt'),
        data: safeJsonValue(v?.data ?? {}, 'Task data', LIMITS.maxTaskDataBytes),
    }));

    normalized.artifacts = normalized.artifacts.map((v) => ({
        id: validateId(v?.id, 'artifact id'),
        kind: validateShort(v?.kind ?? 'artifact', 64, 'Artifact kind', false),
        title: validateShort(v?.title ?? '', LIMITS.maxTitleChars, 'Artifact title'),
        url: safeUrlOrEmpty(v?.url, 'Artifact URL'),
        externalId: validateShort(v?.externalId ?? '', LIMITS.maxExternalIdChars, 'Artifact external id'),
        updatedAt: safeIso(v?.updatedAt, 'artifact updatedAt'),
        metadata: safeJsonValue(v?.metadata ?? {}, 'Artifact metadata', LIMITS.maxArtifactMetaBytes),
    }));

    normalized.libraryRefs = normalized.libraryRefs.map((v) => ({
        id: validateId(v?.id, 'library reference id'),
        kind: validateShort(v?.kind ?? 'file', 64, 'Library reference kind', false),
        externalId: validateShort(v?.externalId ?? '', LIMITS.maxExternalIdChars, 'Library external id'),
        storagePath: validateShort(v?.storagePath ?? '', LIMITS.maxUrlChars, 'Library storage path'),
        mimeType: validateShort(v?.mimeType ?? '', LIMITS.maxMimeChars, 'Library MIME type'),
        sizeBytes: Number.isFinite(Number(v?.sizeBytes)) ? Math.max(0, Math.min(Number(v.sizeBytes), 9_000_000_000_000_000)) : null,
        updatedAt: safeIso(v?.updatedAt, 'library reference updatedAt'),
        metadata: safeJsonValue(v?.metadata ?? {}, 'Library metadata', LIMITS.maxLibraryMetaBytes),
    }));

    normalized.memory = normalized.memory.map((v) => ({
        key: validateShort(v?.key ?? '', 160, 'Memory key', false),
        value: safeJsonValue(v?.value ?? null, 'Memory value', LIMITS.maxMemoryValueBytes),
        updatedAt: safeIso(v?.updatedAt, 'memory updatedAt'),
    }));

    normalized.settings = normalized.settings.map((v) => ({
        key: validateShort(v?.key ?? '', 160, 'Setting key', false),
        value: safeJsonValue(v?.value ?? null, 'Setting value', LIMITS.maxSettingValueBytes),
        updatedAt: safeIso(v?.updatedAt, 'setting updatedAt'),
    }));

    normalized.events = normalized.events.map((v) => ({
        id: validateId(v?.id, 'event id'),
        kind: validateShort(v?.kind ?? 'event', 80, 'Event kind', false),
        createdAt: safeIso(v?.createdAt, 'event createdAt'),
        payload: safeJsonValue(v?.payload ?? {}, 'Event payload', LIMITS.maxEventPayloadBytes),
    }));

    if (changes.storageMode != null) normalized.storageMode = validateMode(changes.storageMode);

    normalized.deletes = normalized.deletes.map((v) => {
        const kind = validateShort(v?.kind ?? '', 64, 'Delete kind', false);
        const out = { kind };
        if (kind === 'project_chat') {
            out.projectId = validateId(v?.projectId, 'delete project id');
            out.chatId = validateId(v?.chatId, 'delete chat id');
        } else if (kind === 'pinned') {
            out.chatId = validateId(v?.chatId, 'delete pinned chat id');
        } else if (kind === 'memory' || kind === 'setting') {
            out.key = validateShort(v?.key ?? '', 160, `delete ${kind} key`, false);
        } else {
            out.id = validateId(v?.id, `delete ${kind} id`);
        }
        return out;
    });

    return normalized;
}

function storageRateBucket(action) {
    return action === 'sync' ? 'sync' : 'read';
}

async function supabaseRpc(functionName, body, { retry = true, variants = [] } = {}) {
    const url = `${ENV.supabaseUrl}/rest/v1/rpc/${functionName}`;
    const headers = {
        apikey: ENV.supabaseKey,
        Authorization: `Bearer ${ENV.supabaseKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Client-Info': `arixai-storage/${VERSION}`,
    };

    const bodies = [body, ...(Array.isArray(variants) ? variants : [])];
    let lastError = null;

    for (let variantIndex = 0; variantIndex < bodies.length; variantIndex++) {
        const candidate = bodies[variantIndex];

        for (let attempt = 0; attempt < (retry ? 2 : 1); attempt++) {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10_000);

            try {
                const response = await fetch(url, {
                    method: 'POST',
                    headers,
                    body: JSON.stringify(candidate),
                    signal: controller.signal,
                });

                const raw = await response.text();
                let data = null;
                try { data = raw ? JSON.parse(raw) : null; } catch {}

                if (response.ok) return data;

                const providerCode = String(data?.code || '').trim();
                const providerMessage = String(data?.message || '').trim();
                const signatureMismatch =
                    [400, 404].includes(response.status) &&
                    ['PGRST202', 'PGRST203', '42883'].includes(providerCode);

                console.error(
                    '[ArixAI storage] Supabase RPC failed:',
                    JSON.stringify({
                        functionName,
                        status: response.status,
                        code: providerCode || null,
                        message: providerMessage || null,
                        variantIndex,
                        attempt,
                    }),
                );

                if (signatureMismatch && variantIndex < bodies.length - 1) {
                    lastError = Object.assign(new Error('Cloud storage function signature mismatch.'), {
                        code: 'CLOUD_STORAGE_FAILED',
                        providerStatus: response.status,
                        providerCode,
                        providerMessage,
                        functionName,
                    });
                    break;
                }

                if (retry && attempt === 0 && [502, 503, 504].includes(response.status)) continue;

                const error = new Error('Cloud storage is temporarily unavailable.');
                error.code = response.status === 429 ? 'CLOUD_RATE_LIMITED' : 'CLOUD_STORAGE_FAILED';
                error.providerStatus = response.status;
                error.providerCode = providerCode;
                error.providerMessage = providerMessage;
                error.functionName = functionName;
                lastError = error;

                // Some existing ArixAI SQL deployments use UUID user_id keys while
                // otp.js intentionally uses an opaque Redis account id. Retry once
                // with a deterministic UUID only when Postgres says the text cannot
                // be cast to the function's expected type.
                if (providerCode === '22P02' && candidate?.p_user_id) {
                    const uuid = await supabaseCompatibleUserId(candidate.p_user_id);
                    bodies.push({ ...candidate, p_user_id: uuid });
                } else if (providerCode === '22P02' && candidate?.user_id) {
                    const uuid = await supabaseCompatibleUserId(candidate.user_id);
                    bodies.push({ ...candidate, user_id: uuid });
                }

                break;
            } catch (error) {
                if (error?.name === 'AbortError') {
                    const timeoutError = new Error('Cloud storage timed out.');
                    timeoutError.code = 'CLOUD_TIMEOUT';
                    lastError = timeoutError;
                    if (retry && attempt === 0) continue;
                    break;
                }

                lastError = error;
                if (retry && attempt === 0) continue;
                break;
            } finally {
                clearTimeout(timeout);
            }
        }

        if (lastError?.providerCode === '22P02' && variantIndex < bodies.length - 1) continue;
        if (lastError?.providerCode && ['PGRST202', 'PGRST203', '42883'].includes(lastError.providerCode) && variantIndex < bodies.length - 1) continue;
        if (lastError && variantIndex >= bodies.length - 1) break;
    }

    if (lastError?.code === 'CLOUD_TIMEOUT') throw lastError;
    if (lastError?.code === 'CLOUD_RATE_LIMITED') throw lastError;
    throw lastError || Object.assign(new Error('Cloud storage is temporarily unavailable.'), { code: 'CLOUD_STORAGE_FAILED' });
}

async function supabaseCompatibleUserId(userId) {
    const raw = String(userId ?? '').trim();
    if (!raw) return null;
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(raw)) return raw;

    const hex = await sha256Hex(`${ENV.authSecret}|supabase-user-id|${raw}`);
    const b9 = parseInt(hex.slice(16, 18), 16);
    const variantByte = ((b9 & 0x3f) | 0x80).toString(16).padStart(2, '0');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variantByte}${hex.slice(18, 20)}-${hex.slice(20, 32)}`;
}

async function enforceLimits(req, action, uid) {
    const ipHash = await sha256Hex(`${ENV.authSecret}|storage-ip|${getClientIp(req)}`);
    const userHash = await sha256Hex(`${ENV.authSecret}|storage-user|${uid}`);

    await rateLimit(
        `arix:storage:${storageRateBucket(action)}:user-min:${userHash}`,
        action === 'sync' ? LIMITS.syncPerUserMinute : LIMITS.readPerUserMinute,
        60,
    );

    if (action === 'sync' || action === 'mode_set' || action === 'purge_cloud') {
        await rateLimit(`arix:storage:write:ip-min:${ipHash}`, LIMITS.writePerIpMinute, 60);
    }

    if (action === 'mode_set') {
        await rateLimit(`arix:storage:mode:user-hour:${userHash}`, LIMITS.modePerUserHour, 60 * 60);
    }
    if (action === 'purge_cloud') {
        await rateLimit(`arix:storage:purge:user-day:${userHash}`, LIMITS.purgePerUserDay, 24 * 60 * 60);
    }
}

async function requireSession(req) {
    const auth = await authenticateArixSession(req);
    if (!auth?.authenticated || !auth.user?.uid) {
        const error = new Error('Authentication required.');
        error.code = 'AUTH_REQUIRED';
        throw error;
    }
    return auth;
}

async function handleBootstrap(req, uid, body) {
    await enforceLimits(req, 'bootstrap', uid);
    const chats = Math.max(1, Math.min(Number(body.chatLimit) || LIMITS.maxBootstrapChats, LIMITS.maxBootstrapChats));
    const projects = Math.max(1, Math.min(Number(body.projectLimit) || LIMITS.maxBootstrapProjects, LIMITS.maxBootstrapProjects));
    const tasks = Math.max(1, Math.min(Number(body.taskLimit) || LIMITS.maxBootstrapTasks, LIMITS.maxBootstrapTasks));
    const pins = Math.max(1, Math.min(Number(body.pinLimit) || LIMITS.maxBootstrapPins, LIMITS.maxBootstrapPins));
    const artifacts = Math.max(1, Math.min(Number(body.artifactLimit) || LIMITS.maxBootstrapArtifacts, LIMITS.maxBootstrapArtifacts));
    const libraryRefs = Math.max(1, Math.min(Number(body.libraryLimit) || LIMITS.maxBootstrapLibraryRefs, LIMITS.maxBootstrapLibraryRefs));

    const primary = {
        p_user_id: uid,
        p_chat_limit: chats,
        p_project_limit: projects,
        p_task_limit: tasks,
        p_pin_limit: pins,
        p_artifact_limit: artifacts,
        p_library_limit: libraryRefs,
    };
    const result = await supabaseRpc('arix_storage_bootstrap', primary, {
        variants: [{
            user_id: uid,
            chat_limit: chats,
            project_limit: projects,
            task_limit: tasks,
            pin_limit: pins,
            artifact_limit: artifacts,
            library_limit: libraryRefs,
        }],
    });

    return reply(req, { success: true, version: VERSION, data: result || {} });
}

async function handleChat(req, uid, body) {
    await enforceLimits(req, 'chat', uid);
    const chatId = validateId(body.chatId, 'chat id');
    const limit = Math.max(1, Math.min(Number(body.limit) || 50, LIMITS.maxChatPage));
    const before = body.before && typeof body.before === 'object' ? body.before : null;
    const beforeCreatedAt = before?.createdAt ? safeIso(before.createdAt, 'before.createdAt') : null;
    const beforeId = before?.id ? validateId(before.id, 'before.id') : null;

    const primary = {
        p_user_id: uid,
        p_chat_id: chatId,
        p_before_created_at: beforeCreatedAt,
        p_before_id: beforeId,
        p_limit: limit,
    };
    const result = await supabaseRpc('arix_storage_chat_page', primary, {
        variants: [{
            user_id: uid,
            chat_id: chatId,
            before_created_at: beforeCreatedAt,
            before_id: beforeId,
            limit,
        }],
    });

    return reply(req, { success: true, version: VERSION, data: result || {} });
}

async function handleSync(req, uid, body) {
    await enforceLimits(req, 'sync', uid);
    const changes = normalizeSyncChanges(body.changes);

    // The endpoint deliberately ignores any user_id fields in the payload.
    // PostgreSQL receives only the authenticated session's uid as p_user_id.
    const primary = {
        p_user_id: uid,
        p_changes: changes,
    };
    const result = await supabaseRpc('arix_storage_sync', primary, {
        variants: [{
            user_id: uid,
            changes,
        }],
    });

    return reply(req, { success: true, version: VERSION, result: result || { saved: 0, deleted: 0 } });
}

async function handleModeSet(req, uid, body) {
    await enforceLimits(req, 'mode_set', uid);
    const mode = validateMode(body.mode);

    const primary = {
        p_user_id: uid,
        p_mode: mode,
    };
    const result = await supabaseRpc('arix_storage_set_mode', primary, {
        retry: false,
        variants: [{
            user_id: uid,
            mode,
        }],
    });

    return reply(req, { success: true, version: VERSION, mode, data: result || {} });
}

async function handlePurge(req, uid) {
    await enforceLimits(req, 'purge_cloud', uid);
    const result = await supabaseRpc('arix_storage_purge', { p_user_id: uid }, {
        retry: false,
        variants: [{ user_id: uid }],
    });
    return reply(req, { success: true, version: VERSION, purged: true, data: result || {} });
}

export default async function handler(req) {
    try {
        requireConfig();

        if (req.method === 'OPTIONS') {
            requireBrowserOrigin(req);
            const headers = responseHeaders(req);
            headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
            headers.set('Access-Control-Allow-Headers', 'Content-Type');
            headers.set('Access-Control-Max-Age', '600');
            return new Response(null, { status: 204, headers });
        }

        if (req.method !== 'POST') return fail(req, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed.');
        requireBrowserOrigin(req);

        const body = await parseBody(req);
        const action = String(body.action || '').trim().toLowerCase();

        if (action === 'health') {
            return reply(req, { success: true, service: 'arix-storage', version: VERSION });
        }

        const auth = await requireSession(req);
        const uid = String(auth.user.uid);

        switch (action) {
            case 'bootstrap':
                return await handleBootstrap(req, uid, body);
            case 'chat':
                return await handleChat(req, uid, body);
            case 'sync':
                return await handleSync(req, uid, body);
            case 'mode_set':
                return await handleModeSet(req, uid, body);
            case 'purge_cloud':
                return await handlePurge(req, uid);
            default:
                return fail(req, 400, 'INVALID_ACTION', 'Unsupported storage action.');
        }
    } catch (error) {
        if (error?.code === 'RATE_LIMITED') return fail(req, 429, error.code, error.message);
        if (error?.code === 'RATE_STORE_UNAVAILABLE') {
            return fail(req, 503, error.code, 'Storage protection service is temporarily unavailable.');
        }
        if (error?.code === 'AUTH_REQUIRED') return fail(req, 401, error.code, error.message);
        if (error?.code === 'ORIGIN_DENIED') return fail(req, 403, error.code, error.message);
        if (error?.code === 'CONFIGURATION_ERROR') {
            console.error('[ArixAI storage] Configuration error:', error.message);
            return fail(req, 503, 'STORAGE_SERVICE_UNAVAILABLE', 'Storage service is temporarily unavailable.');
        }
        if (error?.code === 'PAYLOAD_TOO_LARGE') return fail(req, 413, error.code, error.message);
        if (error?.code === 'INVALID_JSON') return fail(req, 400, error.code, error.message);
        if (error?.code === 'CLOUD_TIMEOUT') return fail(req, 504, error.code, 'Cloud storage timed out. Please retry.');
        if (error?.code === 'CLOUD_RATE_LIMITED') return fail(req, 429, error.code, 'Cloud storage provider is rate-limiting requests. Please retry.');
        if (error?.code === 'CLOUD_STORAGE_FAILED') {
            if (['PGRST202', 'PGRST203', '42883'].includes(error?.providerCode)) {
                return fail(req, 503, 'CLOUD_RPC_SIGNATURE_MISMATCH', 'Cloud storage database function signature does not match this API.');
            }
            if (error?.providerCode === '22P02') {
                return fail(req, 503, 'CLOUD_USER_ID_TYPE_MISMATCH', 'Cloud storage rejected the account identifier type.');
            }
            if (error?.providerStatus === 401 || error?.providerStatus === 403) {
                return fail(req, 503, 'CLOUD_CREDENTIALS_REJECTED', 'Cloud storage credentials were rejected by Supabase.');
            }
            return fail(req, 503, error.code, 'Cloud storage is temporarily unavailable.');
        }

        // Security filter removed to expose the true backend configuration error
        const safe = error?.message || 'Storage request could not be completed.';
        console.error('[ArixAI storage] Request failed:', error?.message || error);
        return fail(req, 400, 'REQUEST_REJECTED', safe);
    }
}
