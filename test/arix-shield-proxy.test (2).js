import test from 'node:test';
import assert from 'node:assert/strict';
import { createArixShieldProxy } from '../lib/arix-shield/route-proxy.js';
import { protectRequest } from '../lib/arix-shield/sdk/next.js';

const ENV = {
  ARIX_ENDPOINT: 'https://arix-shield.vercel.app',
  ARIX_SECRET_KEY: 'ARIX_SECRET_TESTKEY123456789'
};

function harness({ env = ENV, decision = { allowed: true }, onInspect } = {}) {
  const calls = { next: 0, inspect: 0, options: null, request: null };
  const originalRequests = [];
  const next = async () => {
    calls.next++;
    const original = originalRequests[0];
    const body = original?.body ? await original.text() : null;
    return Response.json({ reachedHandler: true, body });
  };
  const withArixShield = (handler, options) => async (request) => {
    calls.inspect++;
    calls.options = options;
    calls.request = request;
    await onInspect?.(request, options, calls);
    if (!decision.allowed) return decision.response || Response.json({ error: 'blocked' }, { status: decision.status || 403 });
    return handler(request, {});
  };
  const proxy = createArixShieldProxy({
    next,
    withArixShield,
    ipAddress: () => '203.0.113.10',
    waitUntil: (promise) => { void Promise.resolve(promise).catch(() => {}); },
    getEnv: () => env
  });
  return { proxy, calls, originalRequests };
}

test('non-API routes bypass the API Shield middleware', async () => {
  const h = harness();
  const response = await h.proxy(new Request('https://chatini.example/app.html'));
  assert.equal(response.status, 200);
  assert.equal(h.calls.next, 1);
  assert.equal(h.calls.inspect, 0);
});

test('small JSON API body is inspected while the original body reaches the handler', async () => {
  const body = JSON.stringify({ prompt: 'hello from Chatini' });
  const request = new Request('https://chatini.example/api/chat1', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
    body
  });
  const h = harness({ onInspect: async (inspectionRequest) => {
    assert.equal(await inspectionRequest.text(), body);
  } });
  h.originalRequests.push(request);
  const response = await h.proxy(request);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).body, body);
  assert.equal(h.calls.inspect, 1);
  assert.equal(h.calls.options.mode, 'ENFORCE');
  assert.equal(h.calls.options.globalRateLimit, true);
  assert.equal(h.calls.options.reportAllRequests, true);
  assert.equal(h.calls.options.endpoint, ENV.ARIX_ENDPOINT);
});

test('oversized declared payload gets metadata inspection without consuming the original body', async () => {
  const body = 'x'.repeat(300000);
  const request = new Request('https://chatini.example/api/storage', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
    body
  });
  const h = harness({ onInspect: async (inspectionRequest) => {
    assert.equal(inspectionRequest.headers.has('content-length'), false);
    assert.equal(await inspectionRequest.text(), '');
  } });
  h.originalRequests.push(request);
  const response = await h.proxy(request);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).body, body);
});

test('oversized unknown-length payload gets metadata inspection and remains readable downstream', async () => {
  const body = 'z'.repeat(300000);
  const request = new Request('https://chatini.example/api/chat1', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body
  });
  const h = harness({ onInspect: async (inspectionRequest) => {
    assert.equal(inspectionRequest.headers.has('content-length'), false);
    assert.equal(await inspectionRequest.text(), '');
  } });
  h.originalRequests.push(request);
  const response = await h.proxy(request);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).body, body);
});

test('multipart uploads receive metadata inspection, preserving the original upload', async () => {
  const body = '--boundary\r\ncontent\r\n--boundary--';
  const request = new Request('https://chatini.example/api/upload', {
    method: 'POST',
    headers: { 'content-type': 'multipart/form-data; boundary=boundary' },
    body
  });
  const h = harness({ onInspect: async (inspectionRequest) => {
    assert.equal(await inspectionRequest.text(), '');
  } });
  h.originalRequests.push(request);
  const response = await h.proxy(request);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).body, body);
});

test('Shield blocks a request before the API handler is invoked', async () => {
  const h = harness({ decision: { allowed: false, status: 403 } });
  const response = await h.proxy(new Request('https://chatini.example/api/auth'));
  assert.equal(response.status, 403);
  assert.equal(h.calls.next, 0);
  assert.equal(h.calls.inspect, 1);
});

test('missing Shield configuration fails closed', async () => {
  const h = harness({ env: {} });
  const response = await h.proxy(new Request('https://chatini.example/api/auth'));
  assert.equal(response.status, 503);
  assert.equal(h.calls.next, 0);
  assert.equal(h.calls.inspect, 0);
});


test('bundled ArixShield SDK allows a clean Chatini-shaped request', async () => {
  const request = new Request('https://chatini.example/api/chat1', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'Please summarize this short note.' }] })
  });
  const decision = await protectRequest(request, {
    mode: 'ENFORCE',
    globalRateLimit: false,
    abuseProtection: false,
    reputationProtection: false,
    rateLimitPerMinute: 120,
    maxBodyBytes: 262144,
    maxLeafBytes: 65536,
    allowedLongFields: ['content', 'message', 'prompt', 'text']
  });
  assert.equal(decision.allowed, true);
});

test('bundled ArixShield SDK blocks a private-network SSRF destination', async () => {
  const request = new Request('https://chatini.example/api/probe?url=http%3A%2F%2F127.0.0.1');
  const decision = await protectRequest(request, {
    mode: 'ENFORCE',
    globalRateLimit: false,
    abuseProtection: false,
    reputationProtection: false,
    rateLimitPerMinute: 120
  });
  assert.equal(decision.allowed, false);
  assert.equal(decision.status, 403);
});
