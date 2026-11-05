const MAX_INSPECTABLE_BODY_BYTES = 262144;
const OPAQUE_CONTENT_TYPES = /^(?:multipart\/form-data|application\/(?:octet-stream|pdf|zip|x-7z-compressed)|image\/|audio\/|video\/)/i;

function jsonError(status, error) {
  return Response.json({ error }, {
    status,
    headers: {
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'X-Content-Type-Options': 'nosniff'
    }
  });
}

function readShieldConfig(env) {
  const endpoint = String(env?.ARIX_ENDPOINT || '').trim().replace(/\/$/, '');
  const serverKey = String(env?.ARIX_SECRET_KEY || '').trim();
  if (!endpoint || !serverKey.startsWith('ARIX_SECRET_')) return null;
  try {
    const parsed = new URL(endpoint);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') return null;
  } catch {
    return null;
  }
  return { endpoint, serverKey };
}

function metadataOnlyRequest(request) {
  const method = String(request.method || 'GET').toUpperCase();
  const headers = new Headers(request.headers);
  headers.delete('content-length');
  headers.delete('transfer-encoding');
  const init = { method, headers, redirect: request.redirect, signal: request.signal };
  if (method !== 'GET' && method !== 'HEAD') init.body = '';
  return new Request(request.url, init);
}

async function bodyExceedsInspectionLimit(request, maxBytes) {
  if (!request.body || ['GET', 'HEAD'].includes(String(request.method || 'GET').toUpperCase())) return false;
  const probe = request.clone();
  if (!probe.body) return false;
  const reader = probe.body.getReader();
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return false;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        // Do not await cancellation: the original Request is the other tee branch
        // and must remain readable by the API handler after this middleware.
        void reader.cancel().catch(() => {});
        return true;
      }
    }
  } finally {
    try { reader.releaseLock(); } catch { /* The stream may already be cancelled. */ }
  }
}

export function createArixShieldProxy({
  next,
  withArixShield,
  ipAddress,
  waitUntil,
  getEnv = () => process.env
} = {}) {
  if (typeof next !== 'function' || typeof withArixShield !== 'function') {
    throw new TypeError('ArixShield proxy requires next and withArixShield functions.');
  }

  return async function arixShieldProxy(request) {
    let pathname;
    try { pathname = new URL(request.url).pathname; }
    catch { return jsonError(400, 'Invalid request URL.'); }

    if (pathname !== '/api' && !pathname.startsWith('/api/')) return next();

    const config = readShieldConfig(getEnv());
    if (!config) return jsonError(503, 'ArixShield protection is not configured.');

    let inspectionRequest;
    const contentType = String(request.headers.get('content-type') || '').trim();
    const declaredLength = Number(request.headers.get('content-length') || 0);
    const opaqueUpload = OPAQUE_CONTENT_TYPES.test(contentType);
    const declaredTooLarge = Number.isFinite(declaredLength) && declaredLength > MAX_INSPECTABLE_BODY_BYTES;

    if (opaqueUpload || declaredTooLarge) {
      inspectionRequest = metadataOnlyRequest(request);
    } else {
      let streamedTooLarge = false;
      if (!request.headers.has('content-length') && request.body) {
        try { streamedTooLarge = await bodyExceedsInspectionLimit(request, MAX_INSPECTABLE_BODY_BYTES); }
        catch { streamedTooLarge = true; }
      }
      inspectionRequest = streamedTooLarge ? metadataOnlyRequest(request) : request.clone();
    }

    const options = {
      endpoint: config.endpoint,
      serverKey: config.serverKey,
      mode: 'ENFORCE',
      rateLimitPerMinute: 120,
      globalRateLimit: true,
      abuseProtection: true,
      reputationProtection: true,
      failClosedPolicy: true,
      failClosedAbuse: true,
      failClosedReputation: true,
      failClosedRateLimitWeight: true,
      reportAllRequests: true,
      maxBodyBytes: MAX_INSPECTABLE_BODY_BYTES,
      maxLeafBytes: 65536,
      allowedLongFields: [
        'base64', 'data', 'content', 'prompt', 'message', 'text', 'bio', 'comment',
        'markdown', 'description', 'notes', 'researchContext', 'dataUrl',
        'fileData', 'imageData'
      ],
      getClientIp: (incoming) => {
        try { return typeof ipAddress === 'function' ? String(ipAddress(incoming) || '') : ''; }
        catch { return ''; }
      },
      waitUntil: typeof waitUntil === 'function'
        ? waitUntil
        : (promise) => { void Promise.resolve(promise).catch(() => {}); }
    };

    try {
      const protectedHandler = withArixShield(async () => next(), options);
      return await protectedHandler(inspectionRequest, {});
    } catch {
      return jsonError(503, 'ArixShield protection could not complete this request.');
    }
  };
}
