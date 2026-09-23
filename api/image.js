export const config = {
  runtime: 'edge',
};

export const maxDuration = 300;

/*
 * ArixAI Unified Visual Engine
 *
 * One route:
 *   POST /api/image
 *
 * Image:
 *   Pixazo Flux 1 Schnell (free)
 *   https://gateway.pixazo.ai/flux-1-schnell/v1/getData
 *
 * Video:
 *   Pixazo LTX Video (free)
 *   https://gateway.pixazo.ai/ltx-video/v1/text-to-video
 *
 * Environment variable:
 *   PIZAXO_KEY   (preferred)
 *
 * Diagnostic:
 *   GET /api/image?health=1
 *
 * IMPORTANT:
 * - Never returns the API key.
 * - Never invents provider progress percentages.
 * - When Pixazo gives no exact percentage, progress is null and the UI
 *   should show an active/indeterminate state instead of a fake number.
 */

const VERSION = 'arixai-pixazo-visual-4.0.0';
const WATERMARK_TEXT = 'ArixAI';

const PIXAZO = {
  image: {
    model: 'flux-schnell',
    endpoint: 'https://gateway.pixazo.ai/flux-1-schnell/v1/getData',
  },
  video: {
    model: 'ltx-video',
    endpoint: 'https://gateway.pixazo.ai/ltx-video/v1/text-to-video',
  },
};

const MAX_PROMPT = 2048;
const MAX_NEGATIVE = 1500;
const MAX_BODY_BYTES = 16000;
const REQUEST_TIMEOUT_MS = 45000;
const STATUS_TIMEOUT_MS = 30000;
const VIDEO_POLL_INTERVAL_MS = 5000;
const VIDEO_MAX_POLL_MS = 292000;

const ALLOWED_ASPECTS = new Set([
  'auto', '21:9', '2:1', '16:9', '4:3', '1:1', '3:4', '9:16', '4:5', '2:3', '3:2'
]);

const IMAGE_STYLE = {
  auto: '',
  photorealistic: 'photorealistic, natural materials, realistic textures, physically plausible lighting',
  cinematic: 'cinematic composition, filmic lighting, realistic depth, controlled contrast, professional cinema frame',
  anime: 'polished anime illustration, coherent linework, expressive composition, detailed environment',
  '3d': 'premium 3D render, physically based materials, global illumination, clean geometry, soft realistic shadows',
  illustration: 'professional editorial illustration, clean shapes, intentional composition, polished artwork',
  'digital-art': 'high-end digital artwork, refined detail, layered depth, controlled edges',
  watercolor: 'traditional watercolor painting, translucent washes, paper texture, delicate pigment variation',
  sketch: 'detailed pencil and ink sketch, controlled hatching, clean linework, paper grain',
  cyberpunk: 'cyberpunk atmosphere, neon accents, reflective surfaces, futuristic architecture, cinematic haze',
  vintage: 'vintage photographic character, authentic film grain, period-appropriate lighting',
  product: 'commercial product photography, clean studio lighting, premium presentation, accurate product geometry',
  portrait: 'professional portrait photography, flattering soft light, natural skin texture, realistic eyes and hair',
  architecture: 'architectural photography, straight verticals, precise geometry, balanced perspective',
  minimalist: 'minimalist composition, clean negative space, restrained palette, crisp subject separation',
  fantasy: 'epic fantasy artwork, atmospheric depth, intricate worldbuilding detail, cinematic lighting',
  documentary: 'documentary photography, observational realism, authentic lighting, natural scene detail',
  commercial: 'premium commercial advertising imagery, polished composition, clean visual hierarchy',
};

const VIDEO_STYLE = {
  auto: '',
  photorealistic: 'photorealistic motion, natural textures, realistic lighting and physics',
  cinematic: 'cinematic visual language, intentional camera movement, realistic depth, controlled exposure',
  anime: 'polished anime animation, expressive motion, coherent character design, detailed backgrounds',
  '3d': 'premium 3D animation, physically believable motion, realistic materials, soft shadows',
  artistic: 'stylized artistic animation, expressive lighting, deliberate composition, coherent movement',
  documentary: 'natural documentary cinematography, observational camera behavior, realistic lighting',
  commercial: 'premium advertising visual language, clean composition, polished motion, product-ready lighting',
};

function nowISO() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampInteger(value, min, max, fallback) {
  return Math.round(clampNumber(value, min, max, fallback));
}

function cleanText(value, max) {
  return String(value ?? '')
    .replace(/\u0000/g, '')
    .trim()
    .slice(0, max);
}

function escapeHTML(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function hash32(input) {
  let h = 2166136261;
  const s = String(input);
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).padStart(8, '0').toUpperCase();
}

function getEnvSnapshot() {
  const candidates = [
    { name: 'PIZAXO_KEY', value: process.env.PIZAXO_KEY },
    // Compatibility fallbacks for common naming mistakes.
    { name: 'PIXAZO_KEY', value: process.env.PIXAZO_KEY },
    { name: 'PIZAXO_API_KEY', value: process.env.PIZAXO_API_KEY },
  ];

  const configured = candidates.find((item) => typeof item.value === 'string' && item.value.trim());

  return {
    configured: Boolean(configured),
    source: configured?.name || null,
    preferredPresent: Boolean(String(process.env.PIZAXO_KEY || '').trim()),
    previewPresent: Boolean(String(process.env.PIXAZO_KEY || '').trim()),
    apiAliasPresent: Boolean(String(process.env.PIZAXO_API_KEY || '').trim()),
    vercelEnv: process.env.VERCEL_ENV || 'unknown',
  };
}

function getApiKey() {
  const snapshot = getEnvSnapshot();
  if (!snapshot.configured) {
    const err = new Error(
      'The deployed ArixAI function cannot see a Pixazo API key. Expected Vercel variable PIZAXO_KEY (or compatibility alias PIXAZO_KEY / PIZAXO_API_KEY).'
    );
    err.code = 'CONFIG_PIZAXO_KEY_MISSING';
    err.stage = 'configuration';
    err.env = snapshot;
    throw err;
  }

  const candidates = [
    process.env.PIZAXO_KEY,
    process.env.PIXAZO_KEY,
    process.env.PIZAXO_API_KEY,
  ];

  const key = candidates.find((value) => typeof value === 'string' && value.trim());
  return String(key).replace(/[\r\n\s]/g, '');
}

function parseInlineFlags(raw) {
  let prompt = cleanText(raw, MAX_PROMPT);
  const flags = {};

  const ar = prompt.match(/--ar\s+(auto|21:9|2:1|16:9|4:3|1:1|3:4|9:16|4:5|2:3|3:2)\b/i);
  if (ar) flags.aspect = ar[1].toLowerCase();

  const style = prompt.match(/--style\s+([a-z0-9-]+)\b/i);
  if (style) flags.style = style[1].toLowerCase();

  const seed = prompt.match(/--seed\s+(-?\d+)\b/i);
  if (seed) flags.seed = Number(seed[1]);

  const steps = prompt.match(/--steps\s+(\d+)\b/i);
  if (steps) flags.steps = Number(steps[1]);

  const fps = prompt.match(/--fps\s+(\d+(?:\.\d+)?)\b/i);
  if (fps) flags.fps = Number(fps[1]);

  const duration = prompt.match(/--duration\s+(\d+)\b/i);
  if (duration) flags.duration = Number(duration[1]);

  if (/--raw\b/i.test(prompt)) flags.raw = true;
  if (/--audio\s+off\b/i.test(prompt)) flags.audio = false;
  if (/--audio\s+on\b/i.test(prompt)) flags.audio = true;

  prompt = prompt
    .replace(/--ar\s+[^\s]+/gi, '')
    .replace(/--style\s+[^\s]+/gi, '')
    .replace(/--seed\s+-?\d+/gi, '')
    .replace(/--steps\s+\d+/gi, '')
    .replace(/--fps\s+[\d.]+/gi, '')
    .replace(/--duration\s+\d+/gi, '')
    .replace(/--audio\s+(?:on|off)/gi, '')
    .replace(/--raw\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return { prompt, flags };
}

function stylePrompt(prompt, modality, settings) {
  const dictionary = modality === 'video' ? VIDEO_STYLE : IMAGE_STYLE;
  const style = String(settings.style || 'auto').toLowerCase();
  const parts = [];

  if (!settings.raw) {
    if (dictionary[style]) parts.push(dictionary[style]);

    if (modality === 'image') {
      if (settings.camera) parts.push(`camera: ${settings.camera}`);
      if (settings.lighting) parts.push(`lighting: ${settings.lighting}`);
      if (settings.composition) parts.push(`composition: ${settings.composition}`);
      parts.push('high detail, coherent perspective, refined textures, clean subject separation');
    } else {
      if (settings.cameraMotion) parts.push(`camera movement: ${settings.cameraMotion}`);
      if (settings.lighting) parts.push(`lighting: ${settings.lighting}`);
      parts.push('strong temporal consistency, coherent subject identity, physically plausible motion, stable composition');
    }
  }

  const result = `${prompt}${parts.length ? `, ${parts.join(', ')}` : ''}`.slice(0, 4000);
  return result;
}

function normalizeSettings(body, modality, flags) {
  const source = body && typeof body === 'object' ? body : {};

  let aspect = String(source.aspect ?? source.aspectRatio ?? flags.aspect ?? (modality === 'video' ? '16:9' : '1:1')).toLowerCase();
  if (!ALLOWED_ASPECTS.has(aspect)) aspect = modality === 'video' ? '16:9' : '1:1';

  const settings = {
    aspect,
    style: String(source.style ?? flags.style ?? 'auto').toLowerCase(),
    raw: Boolean(source.raw ?? flags.raw ?? false),
    enhancePrompt: source.enhancePrompt !== false && !(source.raw ?? flags.raw),
    negativePrompt: cleanText(source.negativePrompt ?? source.negative ?? '', MAX_NEGATIVE),
    seed: Number.isFinite(Number(source.seed ?? flags.seed)) ? Number(source.seed ?? flags.seed) : undefined,
    camera: cleanText(source.camera, 180),
    cameraMotion: cleanText(source.cameraMotion, 180),
    lighting: cleanText(source.lighting, 180),
    composition: cleanText(source.composition, 180),
  };

  if (modality === 'image') {
    // Flux Schnell documents 1-8 steps. Width/height are accepted by the API.
    settings.steps = clampInteger(source.steps ?? flags.steps, 1, 8, 4);
    settings.width = normalizeDimension(source.width, aspectToImageDimensions(aspect)[0]);
    settings.height = normalizeDimension(source.height, aspectToImageDimensions(aspect)[1]);
  } else {
    settings.duration = clampInteger(source.duration ?? flags.duration, 2, 10, 6);
    settings.fps = clampNumber(source.fps ?? flags.fps, 1, 60, 24);
    settings.audio = typeof source.generateAudio === 'boolean'
      ? source.generateAudio
      : (typeof flags.audio === 'boolean' ? flags.audio : true);
  }

  return settings;
}

function normalizeDimension(value, fallback) {
  let n = Number(value);
  if (!Number.isFinite(n)) n = fallback;
  n = Math.round(n / 32) * 32;
  return Math.min(1920, Math.max(256, n));
}

function aspectToImageDimensions(aspect) {
  switch (aspect) {
    case '16:9': return [1024, 576];
    case '9:16': return [576, 1024];
    case '4:3': return [1024, 768];
    case '3:4': return [768, 1024];
    case '21:9': return [1024, 440];
    case '2:1': return [1024, 512];
    case '4:5': return [819, 1024];
    case '2:3': return [682, 1024];
    case '3:2': return [1024, 682];
    default: return [1024, 1024];
  }
}

function aspectToVideoResolution(aspect) {
  switch (aspect) {
    case '21:9': return [1280, 544];
    case '2:1': return [1280, 640];
    case '16:9': return [1280, 720];
    case '4:3': return [1152, 864];
    case '1:1': return [1024, 1024];
    case '3:4': return [864, 1152];
    case '9:16': return [720, 1280];
    case '4:5': return [896, 1120];
    case '2:3': return [768, 1152];
    case '3:2': return [1152, 768];
    default: return [1280, 720];
  }
}

function ltxFrameCount(duration, fps) {
  // LTX documents the 8k+1 frame pattern.
  const wanted = Math.max(9, Math.round(duration * fps));
  const k = Math.max(1, Math.round((wanted - 1) / 8));
  return Math.min(241, 1 + 8 * k);
}

function readStatus(data) {
  return String(data?.status ?? data?.state ?? '').toUpperCase();
}

function extractProviderProgress(data) {
  const values = [
    data?.progress,
    data?.percentage,
    data?.percent,
    data?.progress_percent,
    data?.output?.progress,
  ];

  for (const value of values) {
    if (value === null || value === undefined || value === '') continue;
    const n = Number(value);
    if (!Number.isFinite(n)) continue;
    const normalized = n <= 1 ? n * 100 : n;
    return Math.max(0, Math.min(100, Math.round(normalized)));
  }

  return null;
}

function isDone(status) {
  return ['COMPLETED', 'COMPLETE', 'SUCCEEDED', 'SUCCESS', 'DONE', 'FINISHED'].includes(status);
}

function isFailure(status) {
  return ['FAILED', 'FAILURE', 'ERROR', 'CANCELLED', 'CANCELED', 'REJECTED'].includes(status);
}

function collectStrings(value, output = []) {
  if (value == null) return output;
  if (typeof value === 'string') output.push(value);
  else if (Array.isArray(value)) value.forEach((item) => collectStrings(item, output));
  else if (typeof value === 'object') Object.values(value).forEach((item) => collectStrings(item, output));
  return output;
}

function findMediaURL(data, kind) {
  const candidates = collectStrings(data);
  const looksLikeVideo = /\.(mp4|webm|mov)(?:\?|#|$)/i;
  const looksLikeImage = /\.(png|jpe?g|webp|avif)(?:\?|#|$)/i;

  for (const item of candidates) {
    if (!/^https?:\/\//i.test(item)) continue;
    if (kind === 'image' && (looksLikeImage.test(item) || /image/i.test(item))) return item;
    if (kind === 'video' && (looksLikeVideo.test(item) || /video/i.test(item))) return item;
  }

  return null;
}

function findPollingURL(data) {
  const direct = [
    data?.polling_url,
    data?.pollingUrl,
    data?.poll_url,
    data?.pollUrl,
    data?.status_url,
    data?.statusUrl,
  ].find((value) => typeof value === 'string' && /^https?:\/\//i.test(value));

  if (direct) return direct;

  return collectStrings(data).find(
    (item) => /^https?:\/\//i.test(item) && /(requests\/status|jobs|status)/i.test(item)
  ) || null;
}

function findRequestId(data) {
  for (const key of ['request_id', 'requestId', 'job_id', 'jobId', 'id']) {
    const value = data?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function extractOutputURL(data, kind) {
  const direct = findMediaURL(data, kind);
  if (direct) return direct;

  const media = data?.output?.media_url;
  if (Array.isArray(media)) {
    const first = media.find((value) => typeof value === 'string' && /^https?:\/\//i.test(value));
    if (first) return first;
  }

  if (typeof media === 'string' && /^https?:\/\//i.test(media)) return media;

  const preview = data?.output?.preview_video?.url;
  if (kind === 'video' && typeof preview === 'string' && /^https?:\/\//i.test(preview)) return preview;

  if (typeof data?.output === 'string' && /^https?:\/\//i.test(data.output)) return data.output;
  if (typeof data?.output?.url === 'string' && /^https?:\/\//i.test(data.output.url)) return data.output.url;

  return null;
}

function providerErrorMessage(data, fallback) {
  const possible = [
    data?.error?.message,
    typeof data?.error === 'string' ? data.error : null,
    data?.message,
    data?.detail,
  ];

  return cleanText(possible.find((value) => typeof value === 'string' && value.trim()) || fallback || 'Pixazo returned an unspecified error.', 1500);
}

function makeError(message, code, stage, extra = {}) {
  const error = new Error(message);
  error.code = code;
  error.stage = stage;
  Object.assign(error, extra);
  return error;
}

async function fetchJSON(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });

    const raw = await response.text();
    let data = null;

    try {
      data = JSON.parse(raw || '{}');
    } catch {
      data = { raw: raw.slice(0, 5000) };
    }

    return { response, data };
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw makeError(
        `Network request timed out after ${Math.round(timeoutMs / 1000)} seconds.`,
        'PIXAZO_NETWORK_TIMEOUT',
        'network',
        { url }
      );
    }

    throw makeError(
      `Network error while contacting Pixazo: ${error?.message || 'unknown fetch error'}`,
      'PIXAZO_NETWORK_ERROR',
      'network',
      { url }
    );
  } finally {
    clearTimeout(timer);
  }
}

function pixazoHeaders(apiKey) {
  return {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-cache',
    'Ocp-Apim-Subscription-Key': apiKey,
  };
}

function classifyProviderError(status, data, endpoint, model) {
  let code = 'PIXAZO_API_ERROR';
  let stage = 'provider_request';

  if (status === 400) code = 'PIXAZO_BAD_REQUEST';
  else if (status === 401) code = 'PIXAZO_AUTH_INVALID';
  else if (status === 402) code = 'PIXAZO_BALANCE';
  else if (status === 403) code = 'PIXAZO_FORBIDDEN';
  else if (status === 404) code = 'PIXAZO_ENDPOINT_OR_MODEL_NOT_FOUND';
  else if (status === 408) code = 'PIXAZO_REQUEST_TIMEOUT';
  else if (status === 429) code = 'PIXAZO_RATE_LIMITED';
  else if (status >= 500) code = 'PIXAZO_SERVER_ERROR';

  return makeError(
    `Pixazo HTTP ${status}: ${providerErrorMessage(data, 'No provider message returned.')}`,
    code,
    stage,
    { status, endpoint, model, providerResponse: data }
  );
}

async function submitImage({ apiKey, prompt, settings }) {
  const endpoint = PIXAZO.image.endpoint;

  const body = {
    prompt: prompt.slice(0, MAX_PROMPT),
    num_steps: settings.steps,
    seed: settings.seed,
    width: settings.width,
    height: settings.height,
  };

  const { response, data } = await fetchJSON(endpoint, {
    method: 'POST',
    headers: pixazoHeaders(apiKey),
    body: JSON.stringify(body),
  }, REQUEST_TIMEOUT_MS);

  if (!response.ok) {
    throw classifyProviderError(response.status, data, endpoint, PIXAZO.image.model);
  }

  const outputURL = findMediaURL(data, 'image') || extractOutputURL(data, 'image');

  if (!outputURL) {
    throw makeError(
      'Pixazo returned HTTP success, but no image output URL was found in the response.',
      'PIXAZO_IMAGE_OUTPUT_MISSING',
      'provider_response',
      { status: response.status, endpoint, model: PIXAZO.image.model, providerResponse: data }
    );
  }

  return {
    outputURL,
    providerResponse: data,
  };
}

async function submitVideo({ apiKey, prompt, settings }) {
  const endpoint = PIXAZO.video.endpoint;
  const [width, height] = aspectToVideoResolution(settings.aspect);
  const frames = ltxFrameCount(settings.duration, settings.fps);

  // Only parameters documented for the current free ltx-video endpoint are forwarded.
  // Unsupported generic knobs are deliberately NOT sent because doing so causes avoidable 400s.
  const body = {
    prompt: prompt.slice(0, 4000),
    aspect: settings.aspect,
    width: settings.aspect === 'auto' ? undefined : width,
    height: settings.aspect === 'auto' ? undefined : height,
    num_frames: frames,
    frame_rate: settings.fps,
    seed: settings.seed,
    enhance_prompt: settings.enhancePrompt,
  };

  Object.keys(body).forEach((key) => body[key] === undefined && delete body[key]);

  // This model derives audio from the prompt but the current documented free endpoint
  // does not expose a generate_audio request field. We therefore keep the UI setting
  // as metadata and do not send an undocumented parameter.

  const { response, data } = await fetchJSON(endpoint, {
    method: 'POST',
    headers: pixazoHeaders(apiKey),
    body: JSON.stringify(body),
  }, REQUEST_TIMEOUT_MS);

  if (!response.ok) {
    throw classifyProviderError(response.status, data, endpoint, PIXAZO.video.model);
  }

  return {
    requestId: findRequestId(data),
    pollingURL: findPollingURL(data),
    providerResponse: data,
  };
}

async function pollVideo({ apiKey, requestId, pollingURL, emitProgress }) {
  let statusURL = pollingURL;

  if (!statusURL && requestId) {
    statusURL = `https://gateway.pixazo.ai/v2/requests/status/${encodeURIComponent(requestId)}`;
  }

  if (!statusURL) {
    throw makeError(
      'Pixazo accepted the video request but returned neither request_id nor polling_url.',
      'PIXAZO_VIDEO_POLL_TARGET_MISSING',
      'queue',
      { model: PIXAZO.video.model, endpoint: PIXAZO.video.endpoint }
    );
  }

  const started = Date.now();
  let lastStatus = '';
  let lastExactProgress = null;

  while (Date.now() - started < VIDEO_MAX_POLL_MS) {
    const { response, data } = await fetchJSON(statusURL, {
      method: 'GET',
      headers: pixazoHeaders(apiKey),
    }, STATUS_TIMEOUT_MS);

    if (!response.ok) {
      const retryable = [408, 425, 429, 500, 502, 503, 504].includes(response.status);
      if (!retryable) {
        throw classifyProviderError(response.status, data, statusURL, PIXAZO.video.model);
      }

      emitProgress(null, 'polling', `Provider status temporarily unavailable (HTTP ${response.status}); retrying.`);
      await sleep(VIDEO_POLL_INTERVAL_MS);
      continue;
    }

    const status = readStatus(data);
    const exactProgress = extractProviderProgress(data);

    if (exactProgress !== null) lastExactProgress = exactProgress;

    if (status !== lastStatus || exactProgress !== null) {
      lastStatus = status;
      let detail = 'Waiting for Pixazo...';
      if (status === 'QUEUED') detail = 'Pixazo queued the generation.';
      else if (status === 'PROCESSING') detail = 'Pixazo is rendering the video.';
      else if (status) detail = `Pixazo status: ${status}`;

      emitProgress(exactProgress, status === 'PROCESSING' ? 'rendering' : 'polling', detail);
    } else {
      emitProgress(lastExactProgress, 'polling', status ? `Pixazo status: ${status}` : 'Pixazo is still processing.');
    }

    if (isFailure(status)) {
      throw makeError(
        `Pixazo video job failed: ${providerErrorMessage(data, status)}`,
        'PIXAZO_VIDEO_GENERATION_FAILED',
        'generation',
        { status, requestId, pollingURL: statusURL, model: PIXAZO.video.model, providerResponse: data }
      );
    }

    const outputURL = extractOutputURL(data, 'video');
    if (outputURL || isDone(status)) {
      if (!outputURL) {
        throw makeError(
          'Pixazo marked the video job complete, but no output media URL was returned.',
          'PIXAZO_VIDEO_OUTPUT_MISSING',
          'provider_response',
          { status, requestId, pollingURL: statusURL, model: PIXAZO.video.model, providerResponse: data }
        );
      }

      return {
        outputURL,
        providerResponse: data,
        exactProgress: exactProgress ?? lastExactProgress,
        requestId,
      };
    }

    await sleep(VIDEO_POLL_INTERVAL_MS);
  }

  throw makeError(
    `Video generation exceeded the ${Math.round(VIDEO_MAX_POLL_MS / 1000)} second server polling window. The Pixazo job may still be running; request_id=${requestId || 'unknown'}.`,
    'PIXAZO_VIDEO_POLL_TIMEOUT',
    'polling',
    { requestId, pollingURL: statusURL, model: PIXAZO.video.model }
  );
}

async function readBody(req) {
  const declared = Number(req.headers.get('content-length') || 0);
  if (declared && declared > MAX_BODY_BYTES) {
    throw makeError('Request body is too large.', 'REQUEST_TOO_LARGE', 'request');
  }

  const raw = await req.text();
  const bytes = new TextEncoder().encode(raw).byteLength;
  if (bytes > MAX_BODY_BYTES) {
    throw makeError('Request body is too large.', 'REQUEST_TOO_LARGE', 'request');
  }

  try {
    return JSON.parse(raw || '{}');
  } catch {
    throw makeError('Request body is not valid JSON.', 'INVALID_JSON', 'request');
  }
}

function makeWatermarkId(prompt) {
  return hash32(`${prompt}|${Date.now()}|${Math.random()}`);
}

function makeWatermarkedImageURL(sourceURL, aspect, watermarkId) {
  const [width, height] = aspectToImageDimensions(aspect);
  const fontSize = Math.max(18, Math.round(Math.min(width, height) * 0.023));
  const padding = Math.max(14, Math.round(Math.min(width, height) * 0.018));
  const label = `${WATERMARK_TEXT} • ${watermarkId}`;
  const estimatedWidth = Math.round(label.length * fontSize * 0.58) + padding * 2;
  const badgeHeight = Math.round(fontSize * 1.7);
  const x = width - estimatedWidth - padding;
  const y = height - badgeHeight - padding;

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <rect width="100%" height="100%" fill="#111111"/>
  <image href="${escapeHTML(sourceURL)}" x="0" y="0" width="${width}" height="${height}" preserveAspectRatio="xMidYMid meet"/>
  <rect x="${x}" y="${y}" width="${estimatedWidth}" height="${badgeHeight}" rx="${Math.round(badgeHeight * 0.28)}" fill="#000000" fill-opacity="0.62" stroke="#ffffff" stroke-opacity="0.22"/>
  <text x="${width - padding}" y="${y + Math.round(fontSize * 1.15)}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}px" font-weight="700" letter-spacing="0.4" fill="#ffffff">${escapeHTML(label)}</text>
</svg>`;

  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function imageWidget({ sourceURL, watermarkedURL, prompt, settings, watermarkId }) {
  const safePrompt = escapeHTML(prompt);
  const safeSource = escapeHTML(sourceURL);
  const safeWatermarked = escapeHTML(watermarkedURL);
  const safeStyle = escapeHTML(settings.style || 'auto');
  const fileName = `ArixAI_Flux_Schnell_${watermarkId}.svg`;

  return `<div class="mt-4 mb-2 flex flex-col bg-gray-900/60 border border-white/10 rounded-2xl overflow-hidden shadow-2xl w-full max-w-4xl backdrop-blur-sm">
    <div class="flex items-center justify-between px-4 py-3 border-b border-white/5 bg-black/40 gap-3">
      <div class="flex items-center gap-2 min-w-0">
        <span class="flex items-center justify-center w-7 h-7 rounded-full bg-fuchsia-500 text-white text-xs">✦</span>
        <div class="min-w-0">
          <div class="text-sm font-semibold text-gray-200 truncate">ArixAI Image Studio</div>
          <div class="text-[10px] text-gray-500 font-mono">Pixazo • flux-schnell</div>
        </div>
      </div>
      <a href="${safeWatermarked}" download="${fileName}" class="text-xs font-semibold text-fuchsia-300 bg-fuchsia-400/10 hover:bg-fuchsia-400/20 px-3 py-1.5 rounded-md transition-colors shrink-0">Download Watermarked Image</a>
    </div>

    <div class="relative bg-black flex items-center justify-center overflow-hidden">
      <img src="${safeWatermarked}" alt="ArixAI generated image" class="w-full h-auto object-contain max-h-[72vh]" loading="eager" />
    </div>

    <div class="p-4 bg-black/40">
      <p class="text-sm text-gray-300 font-medium leading-relaxed">“${safePrompt}”</p>
      <div class="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2 text-[10px] font-mono text-gray-500">
        <div class="bg-black/40 rounded-md p-2"><span class="text-fuchsia-300">Aspect</span><br/>${escapeHTML(settings.aspect)}</div>
        <div class="bg-black/40 rounded-md p-2"><span class="text-fuchsia-300">Steps</span><br/>${settings.steps}</div>
        <div class="bg-black/40 rounded-md p-2"><span class="text-fuchsia-300">Size</span><br/>${settings.width}×${settings.height}</div>
        <div class="bg-black/40 rounded-md p-2"><span class="text-fuchsia-300">Watermark</span><br/>ArixAI • ${escapeHTML(watermarkId)}</div>
      </div>
      <details class="mt-3 text-[10px] text-gray-500">
        <summary class="cursor-pointer hover:text-gray-300">Generation details</summary>
        <div class="mt-2 bg-black/40 rounded-md p-3 font-mono leading-relaxed">
          Model: flux-schnell<br/>
          Style: ${safeStyle}<br/>
          Provider output: <a href="${safeSource}" target="_blank" rel="noopener noreferrer" class="text-fuchsia-300 underline">Open original provider file</a><br/>
          Watermark: algorithmic ArixAI SVG export
        </div>
      </details>
    </div>
  </div>`;
}

function videoWidget({ sourceURL, prompt, settings, watermarkId, exactProgress }) {
  const safeURL = escapeHTML(sourceURL);
  const safePrompt = escapeHTML(prompt);
  const safeId = escapeHTML(watermarkId);
  const accurateProgress = exactProgress == null ? 'Provider did not report an exact percentage' : `${exactProgress}% provider-reported`;

  return `<div class="mt-4 mb-2 flex flex-col bg-gray-900/60 border border-white/10 rounded-2xl overflow-hidden shadow-2xl w-full max-w-4xl backdrop-blur-sm">
    <div class="flex items-center justify-between px-4 py-3 border-b border-white/5 bg-black/40 gap-3">
      <div class="flex items-center gap-2 min-w-0">
        <span class="flex items-center justify-center w-7 h-7 rounded-full bg-violet-500 text-white text-xs">▶</span>
        <div class="min-w-0">
          <div class="text-sm font-semibold text-gray-200 truncate">ArixAI Video Studio</div>
          <div class="text-[10px] text-gray-500 font-mono">Pixazo • ltx-video</div>
        </div>
      </div>
      <a href="${safeURL}" target="_blank" rel="noopener noreferrer" download="ArixAI_ltx-video_${safeId}.mp4" class="text-xs font-semibold text-violet-300 bg-violet-400/10 hover:bg-violet-400/20 px-3 py-1.5 rounded-md transition-colors shrink-0">Download / Open MP4</a>
    </div>

    <div class="relative bg-black overflow-hidden">
      <video controls playsinline preload="metadata" class="w-full max-h-[72vh] block">
        <source src="${safeURL}" type="video/mp4" />
      </video>
      <div aria-hidden="true" class="pointer-events-none absolute right-3 bottom-3 rounded-lg border border-white/20 bg-black/60 px-2.5 py-1.5 text-[11px] font-bold tracking-wide text-white shadow-lg backdrop-blur-sm">ArixAI • ${safeId}</div>
    </div>

    <div class="p-4 bg-black/40">
      <p class="text-sm text-gray-300 font-medium leading-relaxed">“${safePrompt}”</p>
      <div class="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2 text-[10px] font-mono text-gray-500">
        <div class="bg-black/40 rounded-md p-2"><span class="text-violet-300">Aspect</span><br/>${escapeHTML(settings.aspect)}</div>
        <div class="bg-black/40 rounded-md p-2"><span class="text-violet-300">Duration</span><br/>${settings.duration}s</div>
        <div class="bg-black/40 rounded-md p-2"><span class="text-violet-300">FPS</span><br/>${settings.fps}</div>
        <div class="bg-black/40 rounded-md p-2"><span class="text-violet-300">Progress</span><br/>${accurateProgress}</div>
      </div>
      <div class="mt-3 text-[10px] text-gray-500 leading-relaxed">
        ArixAI watermark is enforced on the visible player overlay and requested in the generation prompt. The raw Pixazo MP4 is not falsely claimed to be pixel-burned when the provider does not expose server-side watermarking.
      </div>
    </div>
  </div>`;
}

function errorWidget(error) {
  const code = escapeHTML(error?.code || 'ARIXAI_VISUAL_ERROR');
  const stage = escapeHTML(error?.stage || 'unknown');
  const message = escapeHTML(error?.message || 'Unknown visual generation error.');
  const status = Number.isFinite(Number(error?.status)) ? String(error.status) : '—';
  const endpoint = escapeHTML(error?.endpoint || '—');
  const model = escapeHTML(error?.model || '—');
  const requestId = escapeHTML(error?.requestId || '—');
  const env = error?.env || null;

  let envLine = '';
  if (env) {
    envLine = `
      <div class="mt-3 rounded-lg bg-black/30 p-3 font-mono text-[10px] leading-relaxed">
        <div><span class="text-red-300">PIZAXO_KEY visible to deployed function:</span> ${env.configured ? 'YES' : 'NO'}</div>
        <div><span class="text-red-300">Resolved variable:</span> ${escapeHTML(env.source || 'none')}</div>
        <div><span class="text-red-300">VERCEL_ENV:</span> ${escapeHTML(env.vercelEnv)}</div>
      </div>`;
  }

  return `<div class="mt-4 bg-red-500/10 border border-red-500/40 text-red-300 p-4 rounded-xl text-sm leading-relaxed">
    <div class="flex items-center gap-2 font-bold mb-2"><i class="ph-bold ph-warning-circle"></i>ArixAI Visual Engine Error</div>
    <div>${message}</div>
    <div class="mt-3 rounded-lg bg-black/25 p-3 font-mono text-[10px] leading-relaxed">
      <div><span class="text-red-300">Code:</span> ${code}</div>
      <div><span class="text-red-300">Stage:</span> ${stage}</div>
      <div><span class="text-red-300">HTTP:</span> ${status}</div>
      <div><span class="text-red-300">Model:</span> ${model}</div>
      <div><span class="text-red-300">Request ID:</span> ${requestId}</div>
      <div class="break-all"><span class="text-red-300">Endpoint:</span> ${endpoint}</div>
    </div>
    ${envLine}
  </div>`;
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  };
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      ...corsHeaders(),
    },
  });
}

export async function OPTIONS(req) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

export async function GET(req) {
  const url = new URL(req.url);

  if (url.searchParams.get('health') === '1') {
    const env = getEnvSnapshot();
    return jsonResponse({
      ok: true,
      version: VERSION,
      route: '/api/image',
      environment: env.vercelEnv,
      pixazoKey: {
        configured: env.configured,
        resolvedFrom: env.source,
        preferredPIZAXO_KEYPresent: env.preferredPresent,
      },
      endpoints: {
        image: PIXAZO.image.endpoint,
        video: PIXAZO.video.endpoint,
      },
      models: {
        image: PIXAZO.image.model,
        video: PIXAZO.video.model,
      },
      serverTime: nowISO(),
    });
  }

  return jsonResponse({
    ok: true,
    service: 'ArixAI Unified Visual Engine',
    version: VERSION,
    hint: 'Use GET /api/image?health=1 for non-secret deployment diagnostics.',
  });
}

export async function POST(req) {

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;

      const send = (payload) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        } catch {
          closed = true;
        }
      };

      const sendProgress = (progress, stage, detail, extra = {}) => {
        let safeProgress = null;
        if (progress !== null && progress !== undefined && Number.isFinite(Number(progress))) {
          safeProgress = Math.max(0, Math.min(100, Math.round(Number(progress))));
        }

        send({
          event: 'progress',
          progress: safeProgress,
          progressSource: safeProgress === null ? 'indeterminate' : 'pixazo',
          stage,
          detail,
          timestamp: Date.now(),
          ...extra,
        });
      };

      const sendContent = (html) => {
        send({
          event: 'content',
          text: html,
          timestamp: Date.now(),
        });
      };

      try {
        sendProgress(null, 'starting', 'ArixAI Visual Engine initialized');

        const body = await readBody(req);
        const requested = String(body.modality ?? body.type ?? body.mode ?? 'image').toLowerCase();
        const modality = ['video', 'vid', 'text-to-video'].includes(requested) ? 'video' : 'image';

        const parsed = parseInlineFlags(body.prompt ?? '');
        if (!parsed.prompt) {
          throw makeError('A prompt is required.', 'PROMPT_EMPTY', 'request');
        }

        const settings = normalizeSettings(body.settings ?? body, modality, parsed.flags);
        const basePrompt = parsed.prompt;
        const optimizedPrompt = stylePrompt(basePrompt, modality, settings);
        const watermarkId = makeWatermarkId(basePrompt);

        sendProgress(null, 'configuration', `${modality === 'video' ? 'Video' : 'Image'} request validated`);
        sendProgress(null, 'prompt', settings.enhancePrompt ? 'Prompt enhancement applied' : 'Using prompt without enhancement');
        sendProgress(null, 'authentication', 'Checking server-side Pixazo credential');

        const apiKey = getApiKey();

        sendProgress(null, 'dispatching', `Calling Pixazo ${modality === 'video' ? PIXAZO.video.model : PIXAZO.image.model}`);

        if (modality === 'image') {
          const result = await submitImage({
            apiKey,
            prompt: optimizedPrompt,
            settings,
          });

          sendProgress(null, 'assembling', 'Pixazo returned the image file');

          const watermarkedURL = makeWatermarkedImageURL(
            result.outputURL,
            settings.aspect,
            watermarkId
          );

          sendProgress(null, 'complete', 'Watermarked image ready');

          sendContent(imageWidget({
            sourceURL: result.outputURL,
            watermarkedURL,
            prompt: basePrompt,
            settings,
            watermarkId,
          }));
        } else {
          const submitted = await submitVideo({
            apiKey,
            prompt: optimizedPrompt,
            settings,
          });

          sendProgress(null, 'queued', 'Pixazo accepted the video job; waiting for provider status.', {
            requestId: submitted.requestId || null,
          });

          const result = await pollVideo({
            apiKey,
            requestId: submitted.requestId,
            pollingURL: submitted.pollingURL,
            emitProgress: (progress, stage, detail) => sendProgress(progress, stage, detail, {
              requestId: submitted.requestId || null,
            }),
          });

          sendProgress(result.exactProgress ?? null, 'complete', 'Video ready', {
            requestId: result.requestId || submitted.requestId || null,
          });

          sendContent(videoWidget({
            sourceURL: result.outputURL,
            prompt: basePrompt,
            settings,
            watermarkId,
            exactProgress: result.exactProgress,
          }));
        }
      } catch (error) {
        if (error?.env) {
          error.endpoint = error.endpoint || '—';
        }

        sendProgress(null, 'error', 'Generation stopped safely', {
          code: error?.code || 'ARIXAI_VISUAL_ERROR',
        });

        sendContent(errorWidget(error));
      } finally {
        if (!closed) {
          closed = true;
          try { controller.close(); } catch {}
        }
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...corsHeaders(),
    },
  });
}
