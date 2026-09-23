export const config = {
  runtime: 'edge',
};

/*
 * ArixAI Unified Visual Engine
 * -----------------------------
 * One Edge route for both image + video generation through Pixazo.
 *
 * ENVIRONMENT VARIABLE:
 *   PIZAXO_KEY = your Pixazo API key
 *
 * Primary endpoints requested by ArixAI:
 *   POST https://api.pixazo.ai/v1/images/generations
 *   POST https://api.pixazo.ai/v1/videos/generations
 *
 * Primary models:
 *   Image: flux-schnell
 *   Video: ltx-video
 *
 * The route accepts either:
 *   { prompt, modality: 'image' | 'video', settings: {...} }
 * or the simpler legacy shape:
 *   { prompt }
 * (which defaults to image generation).
 */

const PIXAZO_BASE = 'https://api.pixazo.ai/v1';
const IMAGE_ENDPOINT = `${PIXAZO_BASE}/images/generations`;
const VIDEO_ENDPOINT = `${PIXAZO_BASE}/videos/generations`;
const IMAGE_MODEL = 'flux-schnell';
const VIDEO_MODEL = 'ltx-video';

const MAX_PROMPT_CHARS = 4000;
const MAX_NEGATIVE_CHARS = 2000;
const MAX_REQUEST_BYTES = 12000;
const POLL_INTERVAL_MS = 3000;
const MAX_POLL_MS = 285000;
const FETCH_TIMEOUT_MS = 50000;
const WATERMARK_TEXT = 'ArixAI';

const IMAGE_STYLES = {
  auto: '',
  photorealistic: 'photorealistic, natural textures, realistic materials, physically plausible lighting',
  cinematic: 'cinematic composition, dramatic but natural lighting, 35mm lens look, depth of field, filmic contrast',
  anime: 'high-quality anime illustration, expressive linework, detailed background, polished 2D rendering',
  '3d': 'premium 3D render, physically based materials, global illumination, clean geometry, soft realistic shadows',
  illustration: 'editorial illustration, refined shapes, intentional composition, polished professional artwork',
  'digital-art': 'high-end digital artwork, refined detail, controlled edges, rich visual depth',
  watercolor: 'traditional watercolor painting, translucent washes, paper texture, delicate pigment variation',
  sketch: 'detailed pencil and ink sketch, controlled hatching, clean linework, paper grain',
  cyberpunk: 'cyberpunk atmosphere, neon accents, reflective surfaces, futuristic architecture, cinematic haze',
  vintage: 'vintage photographic character, subtle film grain, period-authentic color and lighting',
  product: 'commercial product photography, clean studio lighting, precise product geometry, premium presentation',
  portrait: 'professional portrait photography, flattering soft light, natural skin texture, realistic eyes and hair',
  architecture: 'architectural photography, straight verticals, precise geometry, balanced perspective, refined detail',
  minimalist: 'minimalist composition, restrained palette, clean negative space, crisp subject separation',
  fantasy: 'epic fantasy artwork, atmospheric depth, intricate worldbuilding detail, cinematic lighting',
};

const VIDEO_STYLES = {
  auto: '',
  cinematic: 'cinematic visual language, controlled exposure, realistic depth, intentional composition',
  photorealistic: 'photorealistic motion, natural textures, realistic lighting and physics',
  anime: 'polished anime animation, expressive motion, detailed background, coherent character design',
  '3d': 'premium 3D animation, physically based materials, smooth believable motion, soft shadows',
  artistic: 'stylized artistic animation, deliberate composition, expressive lighting, coherent motion',
  documentary: 'natural documentary cinematography, observational camera behavior, realistic lighting',
  commercial: 'premium advertising visual language, clean composition, polished motion, product-ready lighting',
};

const ASPECTS = new Set(['16:9', '9:16', '1:1', '4:3', '3:4', '21:9', '3:2', '2:3', '4:5']);
const IMAGE_SIZES = new Set(['1024x1024', '1024x576', '576x1024', '1024x768', '768x1024', '1024x440', '1024x683', '683x1024', '819x1024']);
const FPS_VALUES = new Set([24, 25, 30, 48, 50, 60]);
const VIDEO_STEPS_RANGE = [8, 30];
const GUIDANCE_RANGE = [0, 15];
const IMAGE_STEPS_RANGE = [1, 20];

function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      ...headers,
    },
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function clampInt(value, min, max, fallback) {
  return Math.round(clamp(value, min, max, fallback));
}

function cleanText(value, maxLength) {
  return String(value ?? '').replace(/\u0000/g, '').trim().slice(0, maxLength);
}

function escapeHTML(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function shortHash(input) {
  let h = 2166136261;
  const text = String(input);
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16).slice(0, 8).toUpperCase();
}

function parseInlineFlags(rawPrompt) {
  let prompt = cleanText(rawPrompt, MAX_PROMPT_CHARS);
  const flags = {};

  const ar = prompt.match(/--ar\s+(16:9|9:16|1:1|4:3|3:4|21:9|3:2|2:3|4:5)\b/i);
  if (ar) flags.aspectRatio = ar[1];

  const style = prompt.match(/--style\s+([a-z0-9-]+)\b/i);
  if (style) flags.style = style[1].toLowerCase();

  const seed = prompt.match(/--seed\s+(-?\d+)\b/i);
  if (seed) flags.seed = Number(seed[1]);

  const steps = prompt.match(/--steps\s+(\d+(?:\.\d+)?)\b/i);
  if (steps) flags.steps = Number(steps[1]);

  const guidance = prompt.match(/--guidance\s+(\d+(?:\.\d+)?)\b/i);
  if (guidance) flags.guidance = Number(guidance[1]);

  const fps = prompt.match(/--fps\s+(\d+(?:\.\d+)?)\b/i);
  if (fps) flags.fps = Number(fps[1]);

  const duration = prompt.match(/--duration\s+(\d+(?:\.\d+)?)\b/i);
  if (duration) flags.duration = Number(duration[1]);

  if (/--raw\b/i.test(prompt)) flags.raw = true;
  if (/--audio\s+off\b/i.test(prompt)) flags.audio = false;
  if (/--audio\s+on\b/i.test(prompt)) flags.audio = true;

  prompt = prompt
    .replace(/--ar\s+[^\s]+/gi, '')
    .replace(/--style\s+[^\s]+/gi, '')
    .replace(/--seed\s+[-\d]+/gi, '')
    .replace(/--steps\s+[\d.]+/gi, '')
    .replace(/--guidance\s+[\d.]+/gi, '')
    .replace(/--fps\s+[\d.]+/gi, '')
    .replace(/--duration\s+[\d.]+/gi, '')
    .replace(/--audio\s+(?:on|off)/gi, '')
    .replace(/--raw\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();

  return { prompt, flags };
}

function aspectToSize(aspect) {
  switch (aspect) {
    case '16:9': return '1024x576';
    case '9:16': return '576x1024';
    case '4:3': return '1024x768';
    case '3:4': return '768x1024';
    case '21:9': return '1024x440';
    case '3:2': return '1024x683';
    case '2:3': return '683x1024';
    case '4:5': return '819x1024';
    default: return '1024x1024';
  }
}

function aspectToDimensions(aspect) {
  switch (aspect) {
    case '16:9': return [1280, 720];
    case '9:16': return [720, 1280];
    case '4:3': return [1024, 768];
    case '3:4': return [768, 1024];
    case '21:9': return [1344, 576];
    case '3:2': return [1152, 768];
    case '2:3': return [768, 1152];
    case '4:5': return [960, 1200];
    default: return [1024, 1024];
  }
}

function snapLTXFrames(frames) {
  // LTX's documented frame pattern is 1 + 8k: 25, 33, 41 ...
  const raw = Math.max(9, Math.round(frames));
  const k = Math.max(1, Math.round((raw - 1) / 8));
  return 1 + 8 * k;
}

function optimizePrompt({ prompt, modality, style, negativePrompt, settings }) {
  const safePrompt = cleanText(prompt, MAX_PROMPT_CHARS);
  if (!safePrompt) throw new Error('Prompt is required.');

  const selectedStyle = String(style || 'auto').toLowerCase();
  const dictionary = modality === 'video' ? VIDEO_STYLES : IMAGE_STYLES;
  const styleModifier = dictionary[selectedStyle] || '';

  const explicitNegative = cleanText(negativePrompt, MAX_NEGATIVE_CHARS);
  const defaultNegative = modality === 'video'
    ? 'blurry, low quality, distorted anatomy, flicker, jitter, inconsistent character, warped objects, duplicate subjects, unreadable text, compression artifacts'
    : 'blurry, low quality, distorted anatomy, malformed hands, duplicate subjects, warped objects, oversaturated, compression artifacts';

  if (!settings.enhancePrompt || settings.raw) {
    return {
      prompt: safePrompt,
      negative: explicitNegative || defaultNegative,
    };
  }

  if (modality === 'video') {
    const motion = cleanText(settings.cameraMotion, 180);
    const lighting = cleanText(settings.lighting, 180);
    const detail = [
      styleModifier,
      motion ? `camera movement: ${motion}` : '',
      lighting ? `lighting: ${lighting}` : '',
      'strong temporal consistency, coherent subject identity, physically plausible movement, clean frames, intentional shot composition',
    ].filter(Boolean).join(', ');

    return {
      prompt: `${safePrompt}${detail ? `, ${detail}` : ''}`,
      negative: explicitNegative || defaultNegative,
    };
  }

  const camera = cleanText(settings.camera, 180);
  const lighting = cleanText(settings.lighting, 180);
  const composition = cleanText(settings.composition, 180);
  const detail = [
    styleModifier,
    camera ? `camera: ${camera}` : '',
    lighting ? `lighting: ${lighting}` : '',
    composition ? `composition: ${composition}` : '',
    'high detail, clean subject separation, coherent perspective, refined textures, professional visual quality',
  ].filter(Boolean).join(', ');

  return {
    prompt: `${safePrompt}${detail ? `, ${detail}` : ''}`,
    negative: explicitNegative || defaultNegative,
  };
}

function normalizeSettings(input, modality, flags) {
  const source = input && typeof input === 'object' ? input : {};

  const aspectCandidate = source.aspectRatio ?? source.aspect ?? flags.aspectRatio ?? '1:1';
  const aspectRatio = ASPECTS.has(String(aspectCandidate)) ? String(aspectCandidate) : (modality === 'video' ? '16:9' : '1:1');

  const style = String(source.style ?? flags.style ?? 'auto').toLowerCase();
  const raw = Boolean(source.raw ?? flags.raw ?? false);
  const enhancePrompt = source.enhancePrompt !== false && !raw;

  const settings = {
    aspectRatio,
    style,
    raw,
    enhancePrompt,
    seed: Number.isFinite(Number(source.seed ?? flags.seed)) ? Number(source.seed ?? flags.seed) : undefined,
    negativePrompt: cleanText(source.negativePrompt ?? source.negative ?? '', MAX_NEGATIVE_CHARS),
    camera: cleanText(source.camera ?? '', 180),
    cameraMotion: cleanText(source.cameraMotion ?? '', 180),
    lighting: cleanText(source.lighting ?? '', 180),
    composition: cleanText(source.composition ?? '', 180),
  };

  if (modality === 'image') {
    const requestedSize = String(source.size || aspectToSize(aspectRatio));
    settings.size = IMAGE_SIZES.has(requestedSize) ? requestedSize : aspectToSize(aspectRatio);
    settings.steps = clampInt(source.steps ?? flags.steps, IMAGE_STEPS_RANGE[0], IMAGE_STEPS_RANGE[1], 4);
    settings.guidance = clamp(source.guidance ?? flags.guidance, GUIDANCE_RANGE[0], GUIDANCE_RANGE[1], 3.5);
    settings.n = clampInt(source.n ?? 1, 1, 1, 1);
    settings.format = ['png', 'jpg', 'jpeg', 'webp'].includes(String(source.format || '').toLowerCase())
      ? String(source.format).toLowerCase()
      : 'png';
  } else {
    settings.duration = clampInt(source.duration ?? flags.duration, 2, 10, 6);
    settings.fps = FPS_VALUES.has(Number(source.fps ?? flags.fps)) ? Number(source.fps ?? flags.fps) : 24;
    settings.steps = clampInt(source.steps ?? flags.steps, VIDEO_STEPS_RANGE[0], VIDEO_STEPS_RANGE[1], 15);
    settings.guidance = clamp(source.guidance ?? flags.guidance, GUIDANCE_RANGE[0], GUIDANCE_RANGE[1], 3);
    settings.generateAudio = typeof source.generateAudio === 'boolean'
      ? source.generateAudio
      : (typeof flags.audio === 'boolean' ? flags.audio : true);
    settings.watermark = true;
    const [width, height] = aspectToDimensions(aspectRatio);
    settings.width = clampInt(source.width, 32, 1536, width);
    settings.height = clampInt(source.height, 32, 1536, height);
  }

  return settings;
}

function validatePrompt(prompt) {
  const value = cleanText(prompt, MAX_PROMPT_CHARS);
  if (!value) throw new Error('Prompt cannot be empty.');
  if (value.length > MAX_PROMPT_CHARS) throw new Error(`Prompt is limited to ${MAX_PROMPT_CHARS} characters.`);
  return value;
}

async function readBody(req) {
  const declared = Number(req.headers.get('content-length') || 0);
  if (declared && declared > MAX_REQUEST_BYTES) throw new Error('Request body is too large.');

  const raw = await req.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_REQUEST_BYTES) throw new Error('Request body is too large.');
  try {
    return JSON.parse(raw || '{}');
  } catch {
    throw new Error('Invalid JSON request body.');
  }
}

function getApiKey() {
  const key = String(process.env.PIZAXO_KEY || '').replace(/[\r\n\s]/g, '');
  if (!key) throw new Error('PIZAXO_KEY is not configured in Vercel Environment Variables.');
  return key;
}

function authHeaders(apiKey, scheme = 'bearer') {
  return scheme === 'subscription'
    ? {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'Ocp-Apim-Subscription-Key': apiKey,
      }
    : {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-cache',
        'Authorization': `Bearer ${apiKey}`,
      };
}

async function fetchWithTimeout(url, options, timeoutMs = FETCH_TIMEOUT_MS) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') throw new Error(`Pixazo request timed out after ${Math.round(timeoutMs / 1000)}s.`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function safeReadJSON(response) {
  const raw = await response.text();
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    data = { raw: raw.slice(0, 5000) };
  }
  return data;
}

function collectStrings(value, out = []) {
  if (value == null) return out;
  if (typeof value === 'string') out.push(value);
  else if (Array.isArray(value)) value.forEach((v) => collectStrings(v, out));
  else if (typeof value === 'object') Object.values(value).forEach((v) => collectStrings(v, out));
  return out;
}

function findFirstURL(data, type) {
  const strings = collectStrings(data);
  const url = strings.find((s) => {
    if (!/^https?:\/\//i.test(s)) return false;
    if (type === 'image') return /\.(png|jpe?g|webp|avif)(\?|#|$)/i.test(s) || /image/i.test(s);
    return /\.(mp4|webm|mov)(\?|#|$)/i.test(s) || /video/i.test(s);
  });
  return url || null;
}

function findBase64(data, type) {
  const candidates = [];
  const visit = (value) => {
    if (!value) return;
    if (typeof value === 'object') {
      const keys = Object.keys(value);
      for (const key of keys) {
        const v = value[key];
        if (typeof v === 'string') {
          const lower = key.toLowerCase();
          if (/base64|b64|bytes/.test(lower)) candidates.push(v);
          if (/dataurl|data_uri/.test(lower) && /^data:/i.test(v)) candidates.push(v);
        } else visit(v);
      }
    } else if (Array.isArray(value)) value.forEach(visit);
  };
  visit(data);
  for (const item of candidates) {
    if (/^data:/i.test(item)) {
      if (type === 'image' && /^data:image\//i.test(item)) return item;
      if (type === 'video' && /^data:video\//i.test(item)) return item;
    } else if (/^[A-Za-z0-9+/=]+$/.test(item) && item.length > 500) {
      return item;
    }
  }
  return null;
}

function findJobId(data) {
  const keys = ['job_id', 'jobId', 'request_id', 'requestId', 'id'];
  for (const key of keys) {
    const value = data?.[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function findPollURL(data) {
  const keys = ['poll_url', 'pollUrl', 'polling_url', 'pollingUrl', 'status_url', 'statusUrl'];
  for (const key of keys) {
    const value = data?.[key];
    if (typeof value === 'string' && /^https?:\/\//i.test(value)) return value;
  }
  const strings = collectStrings(data);
  return strings.find((s) => /^https?:\/\//i.test(s) && /(jobs|requests\/status|status)/i.test(s)) || null;
}

function readStatus(data) {
  return String(data?.status ?? data?.state ?? data?.phase ?? '').toUpperCase();
}

function findProgressValue(data) {
  const candidates = [data?.progress, data?.percentage, data?.percent, data?.progress_percent, data?.output?.progress];
  for (const value of candidates) {
    const n = Number(value);
    if (Number.isFinite(n)) {
      if (n <= 1) return Math.round(n * 100);
      return Math.round(Math.min(100, Math.max(0, n)));
    }
  }
  return null;
}

function isComplete(status) {
  return ['COMPLETED', 'COMPLETE', 'SUCCEEDED', 'SUCCESS', 'DONE', 'FINISHED'].includes(status);
}

function isFailed(status) {
  return ['FAILED', 'FAILURE', 'ERROR', 'CANCELLED', 'CANCELED', 'REJECTED'].includes(status);
}

function extractErrorMessage(data, fallback) {
  const values = [
    data?.error?.message,
    data?.error?.detail,
    data?.error,
    data?.message,
    data?.detail,
  ];
  const value = values.find((v) => typeof v === 'string' && v.trim());
  return cleanText(value || fallback || 'Pixazo returned an unknown error.', 1200);
}

async function requestPixazo({ url, body, apiKey, retries = 1 }) {
  const schemes = ['bearer', 'subscription'];
  let lastError = null;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    for (const scheme of schemes) {
      const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: authHeaders(apiKey, scheme),
        body: JSON.stringify(body),
      });

      const data = await safeReadJSON(response);
      if (response.ok) return { response, data, authScheme: scheme };

      lastError = new Error(`Pixazo ${response.status}: ${extractErrorMessage(data, response.statusText)}`);
      lastError.status = response.status;

      // Retry with the alternate documented auth convention on auth failures only.
      if (![401, 403].includes(response.status)) break;
    }

    if (lastError?.status === 429 || (lastError?.status >= 500 && lastError?.status <= 599)) {
      await sleep(900 * (attempt + 1));
      continue;
    }

    throw lastError;
  }

  throw lastError || new Error('Pixazo request failed.');
}

async function retryMinimalRequest({ url, richBody, coreBody, apiKey }) {
  try {
    return await requestPixazo({ url, body: richBody, apiKey, retries: 1 });
  } catch (error) {
    const status = Number(error?.status);
    if (![400, 404, 409, 422].includes(status)) throw error;
    return requestPixazo({ url, body: coreBody, apiKey, retries: 1 });
  }
}

async function pollStatus(pollURL, apiKey) {
  const schemes = ['bearer', 'subscription'];
  let lastResponse = null;
  let lastData = null;

  for (const scheme of schemes) {
    const response = await fetchWithTimeout(pollURL, {
      method: 'GET',
      headers: authHeaders(apiKey, scheme),
    }, 30000);
    const data = await safeReadJSON(response);
    lastResponse = response;
    lastData = data;
    if (response.ok) return { response, data };
    if (![401, 403].includes(response.status)) return { response, data };
  }

  return { response: lastResponse, data: lastData };
}

async function pollJob({ initialData, type, apiKey, sendProgress }) {
  const directURL = findFirstURL(initialData, type);
  const directBase64 = findBase64(initialData, type);
  if (directURL || directBase64) {
    return { data: initialData, mediaURL: directURL, base64: directBase64 };
  }

  const jobId = findJobId(initialData);
  let pollURL = findPollURL(initialData);
  if (!pollURL && jobId) {
    pollURL = `${PIXAZO_BASE}/jobs/${encodeURIComponent(jobId)}`;
  }
  if (!pollURL) {
    throw new Error('Pixazo accepted the request but did not return media, a job ID, or a polling URL.');
  }

  const started = Date.now();
  let lastProgress = 8;
  let lastStage = 'queued';

  while (Date.now() - started < MAX_POLL_MS) {
    const elapsed = Date.now() - started;
    const boundedEstimate = type === 'video' ? 7 + Math.min(82, Math.round((elapsed / 90000) * 82)) : 10 + Math.min(80, Math.round((elapsed / 30000) * 80));

    const { response, data } = await pollStatus(pollURL, apiKey);

    if (!response.ok) {
      const retryable = [408, 425, 429, 500, 502, 503, 504].includes(response.status);
      if (!retryable) throw new Error(`Pixazo status error ${response.status}: ${extractErrorMessage(data, response.statusText)}`);
    }

    const status = readStatus(data);
    const providerProgress = findProgressValue(data);
    const progress = Math.max(lastProgress, Math.min(99, providerProgress ?? boundedEstimate));

    if (status === 'PROCESSING') lastStage = 'rendering';
    else if (status === 'QUEUED') lastStage = 'queued';
    else if (status) lastStage = status.toLowerCase();

    lastProgress = progress;
    sendProgress(progress, lastStage, `${lastStage === 'rendering' ? 'Rendering' : 'Waiting'} • ${progress}%`);

    const mediaURL = findFirstURL(data, type);
    const base64 = findBase64(data, type);
    if (mediaURL || base64 || isComplete(status)) {
      if (!mediaURL && !base64) {
        // Some APIs nest the final output under `output.media_url` but hide the URL from generic recursion.
        const nested = data?.output?.media_url;
        const url = Array.isArray(nested) ? nested.find((x) => typeof x === 'string') : nested;
        if (typeof url === 'string') return { data, mediaURL: url, base64: null };
        throw new Error('Pixazo marked the job complete but no output media URL was returned.');
      }
      return { data, mediaURL, base64 };
    }

    if (isFailed(status)) {
      throw new Error(`Pixazo generation failed: ${extractErrorMessage(data, status)}`);
    }

    await sleep(POLL_INTERVAL_MS);
  }

  throw new Error('Pixazo generation exceeded the Edge route polling window.');
}

function bytesToBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function dataURLFromBytes(bytes, mime) {
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

async function ensureImageDataURL(mediaURL, base64) {
  if (base64) {
    return /^data:/i.test(base64)
      ? base64
      : `data:image/png;base64,${base64}`;
  }
  if (!mediaURL) throw new Error('Image output URL is missing.');
  if (/^data:image\//i.test(mediaURL)) return mediaURL;

  const response = await fetchWithTimeout(mediaURL, { method: 'GET' }, 40000);
  if (!response.ok) throw new Error(`Could not fetch Pixazo image output (${response.status}).`);
  const contentType = response.headers.get('content-type') || 'image/png';
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > 25 * 1024 * 1024) throw new Error('Image output is too large to watermark safely in the Edge runtime.');
  return dataURLFromBytes(bytes, contentType.split(';')[0] || 'image/png');
}

function svgWatermarkedImage({ sourceDataURL, aspectRatio, watermarkId }) {
  const [w, h] = aspectToDimensions(aspectRatio);
  const watermarkSize = Math.max(22, Math.round(Math.min(w, h) * 0.026));
  const pad = Math.max(18, Math.round(Math.min(w, h) * 0.022));
  const label = `${WATERMARK_TEXT} • ${watermarkId}`;
  const estimatedLabelWidth = Math.round(label.length * watermarkSize * 0.58);
  const badgeW = estimatedLabelWidth + pad * 1.4;
  const badgeH = watermarkSize * 1.65;
  const badgeX = w - badgeW - pad;
  const badgeY = h - badgeH - pad;

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">
  <rect width="100%" height="100%" fill="#111"/>
  <image href="${sourceDataURL}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="xMidYMid meet"/>
  <g>
    <rect x="${badgeX}" y="${badgeY}" width="${badgeW}" height="${badgeH}" rx="${Math.round(badgeH * 0.3)}" fill="rgba(0,0,0,0.62)" stroke="rgba(255,255,255,0.22)" stroke-width="1"/>
    <text x="${w - pad}" y="${badgeY + badgeH * 0.69}" text-anchor="end" font-family="Arial, Helvetica, sans-serif" font-size="${watermarkSize}px" font-weight="700" letter-spacing="0.4" fill="#FFFFFF">${escapeHTML(label)}</text>
  </g>
</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function findVideoURL(mediaURL, base64) {
  if (mediaURL) return mediaURL;
  if (base64) return /^data:/i.test(base64) ? base64 : `data:video/mp4;base64,${base64}`;
  return null;
}

function imageWidget({ imageDataURL, originalPrompt, settings, enhancedPrompt, watermarkId }) {
  const safePrompt = escapeHTML(originalPrompt);
  const safeEnhanced = escapeHTML(enhancedPrompt);
  const size = escapeHTML(settings.size);
  const aspect = escapeHTML(settings.aspectRatio);
  const style = escapeHTML(settings.style);
  const now = Date.now();

  return `<div class="mt-4 mb-2 flex flex-col bg-gray-900/60 border border-white/10 rounded-2xl overflow-hidden shadow-2xl w-full max-w-4xl backdrop-blur-sm">
    <div class="flex items-center justify-between px-4 py-3 border-b border-white/5 bg-black/40 gap-3">
      <div class="flex items-center gap-2 min-w-0">
        <span class="flex items-center justify-center w-7 h-7 rounded-full bg-gradient-to-tr from-blue-500 to-indigo-500 text-white text-xs">✦</span>
        <div class="min-w-0">
          <div class="text-sm font-semibold text-gray-200 truncate">ArixAI Image Studio</div>
          <div class="text-[10px] text-gray-500 font-mono">Pixazo • ${IMAGE_MODEL}</div>
        </div>
      </div>
      <div class="flex gap-2 items-center shrink-0">
        <span class="text-[10px] font-medium text-gray-500 bg-black/50 px-2 py-1 rounded-md">${aspect}</span>
        <a href="${imageDataURL}" download="ArixAI_${IMAGE_MODEL}_${now}.svg" class="text-xs font-medium text-blue-300 bg-blue-400/10 hover:bg-blue-400/20 px-3 py-1.5 rounded-md transition-colors cursor-pointer">HD Export</a>
      </div>
    </div>
    <div class="relative bg-black flex items-center justify-center">
      <img src="${imageDataURL}" alt="ArixAI generated image" class="w-full h-auto object-contain max-h-[72vh]" loading="lazy" />
    </div>
    <div class="p-4 bg-black/40">
      <p class="text-sm text-gray-300 font-medium leading-relaxed"><span class="text-blue-400/80 mr-1">“</span>${safePrompt}<span class="text-blue-400/80 ml-1">”</span></p>
      <details class="mt-2 text-xs text-gray-600 cursor-pointer">
        <summary class="hover:text-gray-400">Generation settings</summary>
        <div class="mt-2 p-3 bg-black/50 rounded border border-white/5 font-mono leading-relaxed">
          <span class="text-indigo-400">Model:</span> ${IMAGE_MODEL}<br/>
          <span class="text-indigo-400">Style:</span> ${style || 'auto'}<br/>
          <span class="text-indigo-400">Aspect:</span> ${aspect}<br/>
          <span class="text-indigo-400">Size:</span> ${size}<br/>
          <span class="text-indigo-400">Steps:</span> ${settings.steps}<br/>
          <span class="text-indigo-400">Guidance:</span> ${settings.guidance}<br/>
          <span class="text-indigo-400">Watermark:</span> ${escapeHTML(WATERMARK_TEXT)} • ${escapeHTML(watermarkId)}<br/>
          <span class="text-indigo-400">Prompt optimizer:</span> ${settings.enhancePrompt ? 'ON' : 'OFF'}<br/>
          <span class="text-indigo-400">Optimized prompt:</span> ${safeEnhanced}
        </div>
      </details>
    </div>
  </div>`;
}

function videoWidget({ videoURL, originalPrompt, settings, watermarkId }) {
  const safePrompt = escapeHTML(originalPrompt);
  const id = escapeHTML(watermarkId);
  const nonce = shortHash(`${watermarkId}:${videoURL || ''}`);
  const downloadName = `ArixAI_${VIDEO_MODEL}_${nonce}.mp4`;

  // IMPORTANT: Edge JS cannot reliably re-encode arbitrary MP4 bytes with a burned-in
  // text layer without shipping a large video codec/FFmpeg runtime. The preview below
  // therefore makes the watermark compulsory at presentation level. The generation
  // prompt also requests an ArixAI mark, and the API response carries watermark=true.
  // A client-side export/record step can burn the same overlay into the final MP4.
  return `<div class="mt-4 mb-2 flex flex-col bg-gray-900/60 border border-white/10 rounded-2xl overflow-hidden shadow-2xl w-full max-w-4xl backdrop-blur-sm">
    <div class="flex items-center justify-between px-4 py-3 border-b border-white/5 bg-black/40 gap-3">
      <div class="flex items-center gap-2 min-w-0">
        <span class="flex items-center justify-center w-7 h-7 rounded-full bg-gradient-to-tr from-fuchsia-500 to-indigo-500 text-white text-xs">▶</span>
        <div class="min-w-0">
          <div class="text-sm font-semibold text-gray-200 truncate">ArixAI Video Studio</div>
          <div class="text-[10px] text-gray-500 font-mono">Pixazo • ${VIDEO_MODEL}</div>
        </div>
      </div>
      <div class="flex gap-2 items-center shrink-0">
        <span class="text-[10px] font-medium text-gray-500 bg-black/50 px-2 py-1 rounded-md">${escapeHTML(settings.aspectRatio)}</span>
        <a href="${escapeHTML(videoURL || '#')}" target="_blank" rel="noopener noreferrer" download="${downloadName}" class="text-xs font-medium text-fuchsia-300 bg-fuchsia-400/10 hover:bg-fuchsia-400/20 px-3 py-1.5 rounded-md transition-colors cursor-pointer">Open MP4</a>
      </div>
    </div>
    <div class="relative bg-black overflow-hidden">
      <video controls playsinline preload="metadata" class="w-full max-h-[72vh] block">
        <source src="${escapeHTML(videoURL || '')}" type="video/mp4" />
      </video>
      <div aria-hidden="true" class="pointer-events-none absolute right-3 bottom-3 rounded-lg border border-white/20 bg-black/60 px-2.5 py-1.5 text-[11px] font-bold tracking-wide text-white shadow-lg backdrop-blur-sm">ArixAI • ${id}</div>
      <div aria-hidden="true" class="absolute left-3 top-3 rounded-md bg-black/40 px-2 py-1 text-[9px] font-semibold tracking-wide text-white/70">WATERMARK REQUIRED</div>
    </div>
    <div class="p-4 bg-black/40">
      <p class="text-sm text-gray-300 font-medium leading-relaxed"><span class="text-fuchsia-400/80 mr-1">“</span>${safePrompt}<span class="text-fuchsia-400/80 ml-1">”</span></p>
      <div class="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2 text-[10px] font-mono text-gray-500">
        <div class="bg-black/40 rounded-md p-2"><span class="text-indigo-400">Duration</span><br/>${settings.duration}s</div>
        <div class="bg-black/40 rounded-md p-2"><span class="text-indigo-400">FPS</span><br/>${settings.fps}</div>
        <div class="bg-black/40 rounded-md p-2"><span class="text-indigo-400">Steps</span><br/>${settings.steps}</div>
        <div class="bg-black/40 rounded-md p-2"><span class="text-indigo-400">Audio</span><br/>${settings.generateAudio ? 'ON' : 'OFF'}</div>
      </div>
      <div class="mt-3 text-[10px] text-gray-600 leading-relaxed">Watermark ID: ${id} • Overlay nonce: ${nonce}. The displayed preview always carries the ArixAI watermark.</div>
    </div>
  </div>`;
}

function makeImageBodies({ optimizedPrompt, optimizedNegative, settings }) {
  const rich = {
    model: IMAGE_MODEL,
    prompt: optimizedPrompt,
    negative_prompt: optimizedNegative || undefined,
    size: settings.size,
    aspect_ratio: settings.aspectRatio,
    steps: settings.steps,
    guidance_scale: settings.guidance,
    seed: settings.seed,
    n: 1,
    output_format: settings.format,
  };

  const core = {
    model: IMAGE_MODEL,
    prompt: optimizedPrompt,
    size: settings.size,
  };

  return { rich, core };
}

function makeVideoBodies({ optimizedPrompt, settings, watermarkId }) {
  const [defaultWidth, defaultHeight] = aspectToDimensions(settings.aspectRatio);
  const width = settings.width || defaultWidth;
  const height = settings.height || defaultHeight;
  const frames = snapLTXFrames(settings.duration * settings.fps);

  const rich = {
    model: VIDEO_MODEL,
    prompt: `${optimizedPrompt.prompt}, include a small clean readable “ArixAI” watermark at the bottom-right corner, unobtrusive and legible`,
    negative: optimizedPrompt.negative || undefined,
    negative_prompt: optimizedPrompt.negative || undefined,
    aspect: settings.aspectRatio,
    aspect_ratio: settings.aspectRatio,
    width,
    height,
    num_frames: frames,
    frame_rate: settings.fps,
    fps: settings.fps,
    steps: settings.steps,
    num_inference_steps: settings.steps,
    cfg: settings.guidance,
    guidance_scale: settings.guidance,
    generate_audio: settings.generateAudio,
    duration: settings.duration,
    watermark: true,
    watermark_text: WATERMARK_TEXT,
    watermark_position: 'bottom-right',
    watermark_id: watermarkId,
  };

  const core = {
    model: VIDEO_MODEL,
    prompt: `${optimizedPrompt.prompt}, small readable “ArixAI” watermark at bottom-right`,
    duration: settings.duration,
    aspect_ratio: settings.aspectRatio,
  };

  return { rich, core };
}

function progressText(progress, stage, detail) {
  return `> ${progress.toString().padStart(3, ' ')}% • ${stage} • ${detail}\n`;
}

async function handleGeneration({ body, sendProgress, sendText }) {
  const requestedModality = String(body.modality ?? body.type ?? body.mode ?? 'image').toLowerCase();
  const modality = ['video', 'text-to-video', 'vid'].includes(requestedModality) ? 'video' : 'image';
  const { prompt: strippedPrompt, flags } = parseInlineFlags(body.prompt ?? '');
  const prompt = validatePrompt(strippedPrompt);
  const settings = normalizeSettings(body.settings ?? body, modality, flags);
  const mergedNegative = cleanText(body.negativePrompt ?? body.negative ?? settings.negativePrompt, MAX_NEGATIVE_CHARS);

  const optimized = optimizePrompt({
    prompt,
    modality,
    style: settings.style,
    negativePrompt: mergedNegative,
    settings,
  });

  const watermarkId = shortHash(`${prompt}|${Date.now()}|${Math.random()}`);
  const apiKey = getApiKey();
  const endpoint = modality === 'video' ? VIDEO_ENDPOINT : IMAGE_ENDPOINT;

  sendProgress(4, 'preflight', `${modality === 'video' ? 'Video' : 'Image'} request validated`);
  sendProgress(8, 'optimizing', `Prompt optimizer ${settings.enhancePrompt ? 'enabled' : 'disabled'}`);

  const bodies = modality === 'video'
    ? makeVideoBodies({ optimizedPrompt: optimized, settings, watermarkId })
    : makeImageBodies({ optimizedPrompt: optimized.prompt, optimizedNegative: optimized.negative, settings });

  sendProgress(12, 'dispatching', `Pixazo • ${modality === 'video' ? VIDEO_MODEL : IMAGE_MODEL}`);

  const { data: initialData } = await retryMinimalRequest({
    url: endpoint,
    richBody: bodies.rich,
    coreBody: bodies.core,
    apiKey,
  });

  sendProgress(24, 'accepted', 'Pixazo accepted the generation request');

  const final = await pollJob({
    initialData,
    type: modality,
    apiKey,
    sendProgress,
  });

  sendProgress(86, 'assembling', 'Final media received');

  if (modality === 'image') {
    const rawImageData = await ensureImageDataURL(final.mediaURL, final.base64);
    const watermarked = svgWatermarkedImage({
      sourceDataURL: rawImageData,
      aspectRatio: settings.aspectRatio,
      watermarkId,
    });

    const widget = imageWidget({
      imageDataURL: watermarked,
      originalPrompt: prompt,
      settings,
      enhancedPrompt: optimized.prompt,
      watermarkId,
    });

    sendProgress(100, 'complete', 'Watermark baked into exported image container');
    sendText(widget);
    return { modality, watermarkId, mediaURL: final.mediaURL || null, watermarkedPreview: watermarked };
  }

  const videoURL = findVideoURL(final.mediaURL, final.base64);
  if (!videoURL) throw new Error('Video output URL is missing from Pixazo response.');

  const widget = videoWidget({
    videoURL,
    originalPrompt: prompt,
    settings,
    watermarkId,
  });

  sendProgress(100, 'complete', 'Video ready • ArixAI watermark overlay enabled');
  sendText(widget);
  return { modality, watermarkId, mediaURL: videoURL };
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
      },
    });
  }

  if (req.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405);

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

      const sendProgress = (progress, stage, detail) => {
        const safeProgress = Math.max(0, Math.min(100, Math.round(Number(progress) || 0)));
        send({
          event: 'progress',
          progress: safeProgress,
          stage,
          detail,
          text: progressText(safeProgress, stage, detail),
          timestamp: Date.now(),
        });
      };

      const sendText = (textValue) => send({ event: 'content', text: String(textValue ?? '') });

      try {
        const body = await readBody(req);
        sendProgress(1, 'starting', 'ArixAI Visual Engine initialized');
        await handleGeneration({ body, sendProgress, sendText });
      } catch (error) {
        const message = escapeHTML(error?.message || 'Unknown visual generation error.');
        sendProgress(100, 'error', 'Generation stopped safely');
        sendText(`<div class="mt-4 bg-red-500/10 border border-red-500/40 text-red-300 p-4 rounded-xl text-sm leading-relaxed"><strong>ArixAI Visual Engine Error</strong><br/>${message}</div>`);
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
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
    },
  });
}
