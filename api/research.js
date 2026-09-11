/**
 * ArixAI Oracle Research Engine.
 * -----------------------------
 * Evidence-first, adaptive, multi-pass web research for ArixAI.
 *
 * Design goals:
 *   1. Search broadly, but never confuse "retrieved" with "verified".
 *   2. Convert sources into structured claims + evidence.
 *   3. Detect contradictions and unresolved gaps.
 *   4. Perform targeted follow-up searches based on those gaps.
 *   5. Generate a long-form research report from the evidence dossier.
 *   6. Audit the report against the evidence before returning it.
 *   7. Stay inside documented Vercel execution limits by using a hard time
 *      budget, bounded parallelism, and graceful degradation.
 *
 * Required environment variables:
 *   TAVILY_API_KEY (or TAVILY_KEY_2 ... TAVILY_KEY_7)
 *   GEMINI_API_KEY (or GEMINI_API_KEY_1 ... GEMINI_API_KEY_9)
 *   GROQ_API_KEY (or GROQ_KEY_2 ... GROQ_API_KEY_5) [optional but recommended]
 *
 * The file intentionally contains no simulated sources, fake claims, dummy
 * results, placeholder citations, or pre-written topical facts. All topical
 * content in the returned dossier/report must come from live retrieved data
 * and model synthesis of that data.
 */

export const config = {
  runtime: 'edge',
};

// Current Vercel Edge Functions have a documented 300s execution ceiling.
// Leave a safety margin for network variability and final response flushing.
const HARD_FUNCTION_BUDGET_MS = 290_000;
const DEFAULT_REQUEST_BUDGET_MS = 255_000;

const MAX_INITIAL_QUERIES = 8;
const MAX_FOLLOW_UP_QUERIES = 8;
const MAX_SEARCH_RESULTS_PER_QUERY = 10;
const MAX_INITIAL_SEARCHES = 8;
const MAX_FOLLOW_UP_ROUNDS = 2;
const MAX_REPORT_SOURCES = 40;
const MAX_SOURCE_TEXT_CHARS = 12_000;
const MAX_EVIDENCE_CHARS_PER_SOURCE = 4_500;
const MAX_DOSSIER_CHARS = 125_000;
const MAX_PLANNER_CHARS = 18_000;
const MAX_AUDIT_CHARS = 50_000;
const MAX_REPORT_WORDS = 7_000;

const encoder = new TextEncoder();

function safeJsonParse(text, fallback = null) {
  if (typeof text !== 'string') return fallback;
  const cleaned = text
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return fallback;
  }
}

function clampText(value, maxChars) {
  if (value == null) return '';
  const text = String(value);
  return text.length <= maxChars ? text : text.slice(0, maxChars) + '\n[TRUNCATED]';
}

function normalizeWhitespace(value) {
  return String(value || '')
    .replace(/\u0000/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    // Remove common tracking parameters while preserving substantive params.
    const removable = [
      'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
      'gclid', 'fbclid', 'mc_cid', 'mc_eid'
    ];
    removable.forEach((key) => u.searchParams.delete(key));
    return u.toString();
  } catch {
    return String(url || '').trim();
  }
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function extractPublishedDate(result) {
  return result?.published_date || result?.publishedDate || result?.date || null;
}

function daysOld(dateValue) {
  if (!dateValue) return null;
  const timestamp = Date.parse(dateValue);
  if (Number.isNaN(timestamp)) return null;
  return Math.max(0, (Date.now() - timestamp) / 86_400_000);
}

function looksPrimary(url, title = '') {
  const host = hostnameOf(url);
  const text = `${host} ${title}`.toLowerCase();
  return /(\.gov$|\.gov\.|gov\.in|nic\.in|europa\.eu|who\.int|un\.org|worldbank\.org|imf\.org|oecd\.org|nasa\.gov|sec\.gov|supremecourt|court|parliament|legislation|regulator|rbi\.org\.in|sebi\.gov\.in|mca\.gov\.in|indiacode\.nic\.in)/i.test(text);
}

function sourceType(url, title = '') {
  const host = hostnameOf(url);
  const text = `${host} ${title}`.toLowerCase();
  if (looksPrimary(url, title)) return 'primary_official';
  if (/arxiv\.org|doi\.org|nature\.com|science\.org|cell\.com|pubmed\.ncbi\.nlm\.nih\.gov/.test(text)) return 'research';
  if (/reuters\.com|apnews\.com|bbc\.com|nytimes\.com|ft\.com|wsj\.com|theguardian\.com/.test(text)) return 'major_news';
  if (/sec\.gov|annual.?report|investor|filing/.test(text)) return 'filing';
  if (/university|edu\b/.test(text)) return 'academic';
  if (/reddit\.com|quora\.com|forum/.test(text)) return 'community';
  if (/blog|medium\.com/.test(text)) return 'blog';
  return 'secondary';
}

function authorityScore(url, title = '') {
  const type = sourceType(url, title);
  return {
    primary_official: 1.00,
    filing: 0.98,
    research: 0.95,
    academic: 0.92,
    major_news: 0.90,
    secondary: 0.68,
    blog: 0.45,
    community: 0.25,
  }[type] ?? 0.55;
}

function resultQuality(result) {
  const url = normalizeUrl(result?.url || '');
  const title = result?.title || '';
  const relevance = Math.max(0, Math.min(1, Number(result?.score) || 0));
  const authority = authorityScore(url, title);
  const freshnessDays = daysOld(extractPublishedDate(result));
  const freshness = freshnessDays == null ? 0.50 : Math.max(0, Math.min(1, 1 - freshnessDays / 730));
  const directness = result?.raw_content ? 0.90 : 0.65;
  const specificity = /\b(data|report|law|regulation|policy|statistics|official|study|methodology|filing|guidance)\b/i.test(`${title} ${result?.content || ''}`) ? 0.85 : 0.55;

  const score = (
    relevance * 0.30 +
    authority * 0.30 +
    directness * 0.15 +
    freshness * 0.10 +
    specificity * 0.15
  );

  return {
    score: Number(score.toFixed(4)),
    relevance: Number(relevance.toFixed(4)),
    authority: Number(authority.toFixed(4)),
    freshness: Number(freshness.toFixed(4)),
    directness: Number(directness.toFixed(4)),
    specificity: Number(specificity.toFixed(4)),
  };
}

function dedupeStrings(items, max = 100) {
  const out = [];
  const seen = new Set();
  for (const item of items || []) {
    const value = normalizeWhitespace(item);
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
    if (out.length >= max) break;
  }
  return out;
}

function dedupeResults(results) {
  const map = new Map();
  for (const raw of results || []) {
    if (!raw?.url) continue;
    const url = normalizeUrl(raw.url);
    if (!url) continue;

    const existing = map.get(url);
    const quality = resultQuality(raw);
    const item = {
      title: normalizeWhitespace(raw.title || url),
      url,
      hostname: hostnameOf(url),
      content: normalizeWhitespace(raw.content || ''),
      raw_content: normalizeWhitespace(raw.raw_content || ''),
      published_date: extractPublishedDate(raw),
      score: Number(raw.score) || 0,
      quality,
      type: sourceType(url, raw.title || ''),
      favicon: raw.favicon || null,
    };

    if (!existing || quality.score > existing.quality.score) {
      map.set(url, item);
    }
  }

  return Array.from(map.values()).sort((a, b) => b.quality.score - a.quality.score);
}

function balancedSourceSelection(results, limit) {
  const selected = [];
  const usedHosts = new Set();

  // First pass: diversity and primary-source preference.
  for (const result of results) {
    if (selected.length >= limit) break;
    if (result.type === 'primary_official' || result.type === 'filing' || result.type === 'research') {
      const hostKey = result.hostname;
      if (!usedHosts.has(hostKey) || selected.length < Math.min(12, limit)) {
        selected.push(result);
        usedHosts.add(hostKey);
      }
    }
  }

  // Second pass: best remaining evidence with domain diversity.
  for (const result of results) {
    if (selected.length >= limit) break;
    if (selected.some((x) => x.url === result.url)) continue;
    const hostCount = selected.filter((x) => x.hostname === result.hostname).length;
    if (hostCount >= 3) continue;
    selected.push(result);
  }

  // Third pass: fill remaining slots.
  for (const result of results) {
    if (selected.length >= limit) break;
    if (!selected.some((x) => x.url === result.url)) selected.push(result);
  }

  return selected.slice(0, limit);
}

function sourceToEvidencePacket(source) {
  const raw = source.raw_content || source.content || '';
  const content = clampText(raw, MAX_EVIDENCE_CHARS_PER_SOURCE);
  return {
    source_id: `S${Math.abs(hashString(source.url))}`,
    title: source.title,
    url: source.url,
    hostname: source.hostname,
    source_type: source.type,
    published_date: source.published_date,
    quality: source.quality,
    content,
  };
}

function hashString(value) {
  let hash = 0;
  for (let i = 0; i < value.length; i++) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return hash;
}

function sourceCitation(source) {
  return `[${source.source_id}] ${source.title} — ${source.url}`;
}

function domainDateHints(query) {
  const q = query.toLowerCase();
  const isNews = /latest|today|yesterday|this week|this month|current|recent|breaking|2026|2025/.test(q);
  return { isNews };
}

function chooseSearchProfile(query, mode) {
  const hints = domainDateHints(query);
  const q = query.toLowerCase();
  const legal = /law|legal|regulation|regulatory|court|judgment|act|rule|compliance|statute|policy/.test(q);
  const academic = /study|research|paper|literature|meta-analysis|clinical trial|scientific/.test(q);
  const financial = /stock|company|revenue|profit|earnings|valuation|financial|market cap|quarter/.test(q);
  const news = mode === 'news' || hints.isNews;
  return {
    topic: financial ? 'finance' : news ? 'news' : 'general',
    search_depth: legal || academic ? 'advanced' : 'advanced',
    chunks_per_source: 3,
    include_raw_content: false,
    max_results: MAX_SEARCH_RESULTS_PER_QUERY,
    legal,
    academic,
    financial,
    news,
  };
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function remainingBudget(deadline) {
  return Math.max(0, deadline - Date.now());
}

async function callJson(url, options, timeoutMs, deadline) {
  const allowed = Math.max(500, Math.min(timeoutMs, remainingBudget(deadline) - 250));
  if (allowed <= 750) throw new Error('Research time budget exhausted.');
  const response = await fetchWithTimeout(url, options, allowed);
  const text = await response.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return { response, data, text };
}

function envKeys(prefix, singles = []) {
  const keys = [];
  for (const name of singles) {
    if (process.env[name]) keys.push(process.env[name]);
  }
  for (let i = 1; i <= 12; i++) {
    const key = process.env[`${prefix}_${i}`];
    if (key) keys.push(key);
  }
  for (const name of ['GROQ_KEY_2', 'GROQ_KEY_3', 'GROQ_KEY_4', 'GROQ_KEY_5', 'TAVILY_KEY_2', 'TAVILY_KEY_3', 'TAVILY_KEY_4', 'TAVILY_KEY_5', 'TAVILY_KEY_6', 'TAVILY_KEY_7']) {
    if (prefix === 'GROQ' && process.env[name]) keys.push(process.env[name]);
    if (prefix === 'TAVILY' && process.env[name]) keys.push(process.env[name]);
  }
  return dedupeStrings(keys, 20);
}

function rotateKey(keys, index) {
  if (!keys.length) return null;
  return keys[index % keys.length];
}

async function groqJson({ apiKey, model, system, user, deadline, temperature = 0.1 }) {
  const result = await callJson(
    'https://api.groq.com/openai/v1/chat/completions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        temperature,
        response_format: { type: 'json_object' },
      }),
    },
    18_000,
    deadline
  );

  if (!result.response.ok) {
    throw new Error(`Groq request failed with HTTP ${result.response.status}`);
  }

  const content = result.data?.choices?.[0]?.message?.content;
  const parsed = safeJsonParse(content, null);
  if (!parsed) throw new Error('Groq returned invalid JSON.');
  return parsed;
}

async function geminiJson({ apiKey, model, system, user, deadline }) {
  // Uses the stable generateContent JSON response configuration supported by
  // Gemini's Generate Content API. Keep the schema modest for compatibility.
  const payload = {
    systemInstruction: {
      parts: [{ text: system }],
    },
    contents: [
      {
        role: 'user',
        parts: [{ text: user }],
      },
    ],
    generationConfig: {
      temperature: 0.1,
      response_mime_type: 'application/json',
      maxOutputTokens: 8192,
    },
  };

  const result = await callJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
    25_000,
    deadline
  );

  if (!result.response.ok) {
    throw new Error(`Gemini request failed with HTTP ${result.response.status}`);
  }

  const content = result.data?.candidates?.[0]?.content?.parts
    ?.map((part) => part?.text || '')
    .join('')
    .trim();

  const parsed = safeJsonParse(content, null);
  if (!parsed) throw new Error('Gemini returned invalid JSON.');
  return parsed;
}

async function geminiText({ apiKey, model, system, user, deadline, maxOutputTokens = 12_000 }) {
  const payload = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: {
      temperature: 0.15,
      maxOutputTokens,
    },
  };

  const result = await callJson(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    },
    45_000,
    deadline
  );

  if (!result.response.ok) {
    throw new Error(`Gemini synthesis failed with HTTP ${result.response.status}`);
  }

  const content = result.data?.candidates?.[0]?.content?.parts
    ?.map((part) => part?.text || '')
    .join('')
    .trim();

  if (!content) throw new Error('Gemini returned an empty synthesis.');
  return content;
}

async function parallelMap(items, worker, concurrency) {
  const results = new Array(items.length);
  let cursor = 0;

  async function runner() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index], index);
      } catch (error) {
        results[index] = { __error: error instanceof Error ? error.message : String(error) };
      }
    }
  }

  const workers = Array.from(
    { length: Math.max(1, Math.min(concurrency, items.length || 1)) },
    () => runner()
  );
  await Promise.all(workers);
  return results;
}

function sendEvent(controller, type, payload) {
  controller.enqueue(
    encoder.encode(`data: ${JSON.stringify({ type, ...payload })}\n\n`)
  );
}

function sendLog(controller, message, meta = {}) {
  sendEvent(controller, 'log', { log: message, meta });
}

function sendThought(controller, chunk) {
  // Backward-compatible with the previous client, which consumed `thought`,
  // while the new UI can also consume the explicit `progress` event type.
  controller.enqueue(encoder.encode(`data: ${JSON.stringify({ thought: chunk, type: 'progress', progress: chunk })}\n\n`));
}

async function planResearch({ query, groqKeys, geminiKeys, deadline }) {
  const system = `
You are ArixAI's Research Planner.
Your job is to convert one user research question into a rigorous evidence plan.
Return JSON only.
Do not answer the topic yourself.
Do not invent facts, sources, dates, laws, entities, statistics, URLs, or conclusions.
Plan search questions that could actually retrieve evidence for the user's request.
Prefer primary-source discovery, independent corroboration, counter-evidence, and time-specific verification.

Required JSON shape:
{
  "research_type": "simple|comparative|deep|legal|academic|financial|news|technical|mixed",
  "core_question": "...",
  "subquestions": ["..."],
  "search_queries": ["..."],
  "counter_queries": ["..."],
  "primary_source_targets": ["..."],
  "recency_requirement": "none|recent|very_recent|specific_period",
  "verification_requirements": ["..."],
  "stop_conditions": ["..."],
  "risk_notes": ["..."]
}

Rules:
- search_queries: 4 to 8 concise web-search queries, each under ~350 characters.
- counter_queries: 2 to 5 adversarial queries intended to find evidence against likely conclusions.
- primary_source_targets: source classes/domains, not fabricated URLs.
- recency_requirement must reflect the question, not your memory.
- Make queries complementary: definitions, primary documents, empirical data, independent analyses, counterarguments, and recent changes when relevant.
`;

  const user = clampText(`USER QUESTION:\n${query}`, MAX_PLANNER_CHARS);

  const providers = [];
  for (let i = 0; i < groqKeys.length; i++) {
    providers.push(() => groqJson({
      apiKey: rotateKey(groqKeys, i),
      model: 'openai/gpt-oss-20b',
      system,
      user,
      deadline,
    }));
  }
  for (let i = 0; i < geminiKeys.length; i++) {
    providers.push(() => geminiJson({
      apiKey: rotateKey(geminiKeys, i),
      model: 'gemini-2.5-flash',
      system,
      user,
      deadline,
    }));
  }

  for (const provider of providers) {
    if (remainingBudget(deadline) < 8_000) break;
    try {
      const plan = await provider();
      if (Array.isArray(plan.search_queries) && plan.search_queries.length) return plan;
    } catch {}
  }

  // Deterministic fallback is structural only: it contains no topical facts.
  return {
    research_type: 'deep',
    core_question: query,
    subquestions: [
      `What directly answers the user's question?`,
      `What primary or first-party evidence exists?`,
      `What independent evidence corroborates or disputes it?`,
      `What recent changes or version-specific details matter?`,
    ],
    search_queries: [query],
    counter_queries: [`evidence contradicting: ${query}`],
    primary_source_targets: ['official or first-party sources relevant to the subject'],
    recency_requirement: 'none',
    verification_requirements: ['claim-level evidence', 'contradiction check', 'temporal check'],
    stop_conditions: ['major claims supported or explicitly marked unresolved'],
    risk_notes: ['Planner model unavailable; using the user query directly without inventing additional topical claims.'],
  };
}

async function tavilySearch({ apiKey, query, profile, deadline, includeRaw = false, startDate, endDate }) {
  const body = {
    query: clampText(query, 380),
    search_depth: profile.search_depth,
    topic: profile.topic,
    chunks_per_source: profile.chunks_per_source,
    max_results: profile.max_results,
    include_answer: false,
    include_raw_content: includeRaw ? 'markdown' : false,
  };
  if (startDate) body.start_date = startDate;
  if (endDate) body.end_date = endDate;

  const result = await callJson(
    'https://api.tavily.com/search',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
    },
    18_000,
    deadline
  );

  if (!result.response.ok) {
    throw new Error(`Tavily search failed with HTTP ${result.response.status}`);
  }

  return result.data || {};
}

function buildSearchQueries(plan) {
  const base = dedupeStrings([
    ...(plan?.search_queries || []),
    ...(plan?.subquestions || []),
    ...(plan?.primary_source_targets || []).map((x) => `${plan.core_question} ${x}`),
  ], MAX_INITIAL_QUERIES * 2);

  const counter = dedupeStrings(plan?.counter_queries || [], MAX_INITIAL_QUERIES);
  return dedupeStrings([...base.slice(0, MAX_INITIAL_QUERIES), ...counter.slice(0, 2)], MAX_INITIAL_QUERIES);
}

function createEvidencePacket(sources) {
  return sources
    .slice(0, MAX_REPORT_SOURCES)
    .map(sourceToEvidencePacket);
}

async function extractEvidence({ query, sources, geminiKeys, groqKeys, deadline }) {
  if (!sources.length) {
    return {
      claims: [],
      source_assessments: [],
      contradictions: [],
      gaps: ['No usable sources were retrieved.'],
      query_interpretation: query,
    };
  }

  const packets = createEvidencePacket(sources);
  const evidenceText = packets.map((p) => [
    `SOURCE_ID: ${p.source_id}`,
    `TITLE: ${p.title}`,
    `URL: ${p.url}`,
    `TYPE: ${p.source_type}`,
    `PUBLISHED: ${p.published_date || 'unknown'}`,
    `QUALITY: ${JSON.stringify(p.quality)}`,
    `CONTENT:\n${p.content}`,
  ].join('\n')).join('\n\n---\n\n');

  const system = `
You are ArixAI's Evidence Extraction Engine.
You are NOT writing the final answer.
Use ONLY the supplied source packets.
Do not use outside knowledge to fill gaps.
Return JSON only.

For every material factual claim you identify:
- quote or tightly paraphrase the supporting passage from a supplied source;
- attach exact SOURCE_ID(s);
- classify support as direct, partial, contradiction, context_only, or unsupported;
- note date/version sensitivity when relevant;
- distinguish source statements from your own synthesis.

Required JSON shape:
{
  "claims": [
    {
      "claim_id": "C1",
      "claim": "...",
      "importance": "high|medium|low",
      "support_status": "direct|partial|contradicted|context_only|unresolved",
      "source_ids": ["S123"],
      "evidence": ["..."],
      "dates_or_versions": ["..."],
      "notes": "..."
    }
  ],
  "source_assessments": [
    {
      "source_id": "S123",
      "strength": "high|medium|low",
      "reason": "...",
      "primary_or_secondary": "primary|secondary|unclear"
    }
  ],
  "contradictions": [
    {
      "topic": "...",
      "claim_a": "...",
      "claim_b": "...",
      "source_ids_a": ["..."],
      "source_ids_b": ["..."],
      "status": "unresolved|partially_resolved|resolved",
      "reason": "..."
    }
  ],
  "gaps": ["..."],
  "query_interpretation": "..."
}

Never create SOURCE_IDs. Never create URLs. Never state a missing fact as known.
`;

  const user = clampText(`USER QUESTION:\n${query}\n\nSOURCE PACKETS:\n${evidenceText}`, MAX_DOSSIER_CHARS);

  const providers = [];
  for (let i = 0; i < geminiKeys.length; i++) {
    providers.push(() => geminiJson({
      apiKey: rotateKey(geminiKeys, i),
      model: 'gemini-2.5-flash',
      system,
      user,
      deadline,
    }));
  }
  for (let i = 0; i < groqKeys.length; i++) {
    providers.push(() => groqJson({
      apiKey: rotateKey(groqKeys, i),
      model: 'openai/gpt-oss-20b',
      system,
      user,
      deadline,
    }));
  }

  for (const provider of providers) {
    if (remainingBudget(deadline) < 14_000) break;
    try {
      const result = await provider();
      if (Array.isArray(result.claims)) return result;
    } catch {}
  }

  // Evidence-extraction fallback remains non-simulated: expose only source facts
  // as unresolved evidence packets. No new topical claims are fabricated.
  return {
    claims: sources.slice(0, 20).map((s, i) => ({
      claim_id: `UNEXTRACTED_${i + 1}`,
      claim: s.content ? `The source contains topical material relevant to the query.` : `The source was retrieved but contained insufficient extractable text.`,
      importance: 'medium',
      support_status: 'unresolved',
      source_ids: [sourceToEvidencePacket(s).source_id],
      evidence: [clampText(s.content || s.raw_content || '', 1000)],
      dates_or_versions: s.published_date ? [s.published_date] : [],
      notes: 'Automated semantic extraction model was unavailable; no unsupported topic-specific assertion was added.',
    })),
    source_assessments: sources.slice(0, 20).map((s) => ({
      source_id: sourceToEvidencePacket(s).source_id,
      strength: s.type === 'primary_official' || s.type === 'filing' ? 'high' : s.quality.score >= 0.70 ? 'medium' : 'low',
      reason: `Programmatic source ranking only: ${s.type}.`,
      primary_or_secondary: s.type === 'primary_official' || s.type === 'filing' ? 'primary' : 'secondary',
    })),
    contradictions: [],
    gaps: ['Semantic evidence extraction was unavailable; topic-level verification remains incomplete.'],
    query_interpretation: query,
  };
}

function mergeResearchRounds(rounds) {
  const claimMap = new Map();
  const assessmentMap = new Map();
  const contradictions = [];
  const gaps = [];

  for (const round of rounds) {
    for (const claim of round?.claims || []) {
      const key = normalizeWhitespace(claim.claim).toLowerCase();
      if (!key) continue;
      const existing = claimMap.get(key);
      if (!existing) {
        claimMap.set(key, { ...claim });
      } else {
        existing.source_ids = dedupeStrings([...(existing.source_ids || []), ...(claim.source_ids || [])]);
        existing.evidence = dedupeStrings([...(existing.evidence || []), ...(claim.evidence || [])]);
        existing.dates_or_versions = dedupeStrings([...(existing.dates_or_versions || []), ...(claim.dates_or_versions || [])]);
        if (existing.support_status === 'unresolved' && claim.support_status !== 'unresolved') {
          existing.support_status = claim.support_status;
        }
      }
    }
    for (const assessment of round?.source_assessments || []) {
      assessmentMap.set(assessment.source_id, assessment);
    }
    contradictions.push(...(round?.contradictions || []));
    gaps.push(...(round?.gaps || []));
  }

  return {
    claims: Array.from(claimMap.values()),
    source_assessments: Array.from(assessmentMap.values()),
    contradictions,
    gaps: dedupeStrings(gaps, 50),
  };
}

function deriveGapQueries(dossier, query) {
  const unresolved = (dossier.claims || [])
    .filter((c) => ['unresolved', 'contradicted', 'partial'].includes(c.support_status))
    .slice(0, 8)
    .map((c) => `Verify or challenge this claim with primary or independent evidence: ${c.claim}`);

  const contradictionQueries = (dossier.contradictions || [])
    .slice(0, 4)
    .map((c) => `Resolve conflicting evidence about ${c.topic}: ${c.claim_a} versus ${c.claim_b}`);

  const gapQueries = (dossier.gaps || [])
    .slice(0, 6)
    .map((g) => `Find evidence that addresses this research gap: ${g}`);

  return dedupeStrings([
    ...unresolved,
    ...contradictionQueries,
    ...gapQueries,
    `independent analysis and counter-evidence for: ${query}`,
  ], MAX_FOLLOW_UP_QUERIES);
}

function calculateCoverage(dossier) {
  const claims = dossier.claims || [];
  const major = claims.filter((c) => c.importance === 'high');
  const supported = claims.filter((c) => ['direct', 'partial'].includes(c.support_status));
  const stronglySupportedMajor = major.filter((c) => c.support_status === 'direct');
  const base = claims.length ? supported.length / claims.length : 0;
  const majorCoverage = major.length ? stronglySupportedMajor.length / major.length : base;
  const contradictionPenalty = Math.min(0.20, (dossier.contradictions || []).filter((c) => c.status !== 'resolved').length * 0.03);
  return Number(Math.max(0, Math.min(1, base * 0.55 + majorCoverage * 0.45 - contradictionPenalty)).toFixed(3));
}

function shouldContinue(dossier, roundIndex, deadline) {
  if (roundIndex >= MAX_FOLLOW_UP_ROUNDS) return false;
  if (remainingBudget(deadline) < 24_000) return false;
  const coverage = calculateCoverage(dossier);
  const unresolved = (dossier.claims || []).filter((c) => ['unresolved', 'contradicted'].includes(c.support_status)).length;
  const major = (dossier.claims || []).filter((c) => c.importance === 'high').length;

  // Continue when evidence is materially incomplete or contradictions remain.
  return (
    coverage < 0.84 ||
    unresolved >= Math.max(2, Math.ceil((major || 4) * 0.25)) ||
    (dossier.contradictions || []).some((c) => c.status === 'unresolved') ||
    (dossier.gaps || []).length > 3
  );
}

function serializeDossier({ query, plan, sources, evidence, rounds, metadata }) {
  const sourceMap = new Map(sources.map((s) => [sourceToEvidencePacket(s).source_id, s]));

  const claims = (evidence.claims || []).map((claim) => ({
    ...claim,
    sources: dedupeStrings((claim.source_ids || []).map((id) => {
      const s = sourceMap.get(id);
      return s ? sourceCitation(s) : id;
    })),
  }));

  return {
    research_question: query,
    research_plan: plan,
    coverage_score: calculateCoverage(evidence),
    claims,
    source_assessments: evidence.source_assessments || [],
    contradictions: evidence.contradictions || [],
    unresolved_gaps: evidence.gaps || [],
    sources: sources.map((s) => ({
      source_id: sourceToEvidencePacket(s).source_id,
      title: s.title,
      url: s.url,
      hostname: s.hostname,
      source_type: s.type,
      published_date: s.published_date,
      quality: s.quality,
    })),
    rounds: rounds.map((r) => ({
      round: r.round,
      queries: r.queries,
      source_count: r.source_count,
      new_source_count: r.new_source_count,
      coverage_after_round: r.coverage_after_round,
    })),
    metadata,
  };
}

function buildDossierText(dossier) {
  const lines = [];
  lines.push(`# ArixAI Oracle Research Dossier`);
  lines.push(`\n## Research Question\n${dossier.research_question}`);
  lines.push(`\n## Evidence Coverage\n${Math.round((dossier.coverage_score || 0) * 100)}%`);

  lines.push(`\n## Research Method`);
  lines.push(`- Query planning: ${dossier.research_plan?.research_type || 'deep'}`);
  lines.push(`- Search rounds completed: ${dossier.rounds?.length || 0}`);
  lines.push(`- Distinct sources retained: ${dossier.sources?.length || 0}`);
  lines.push(`- Unresolved gaps: ${dossier.unresolved_gaps?.length || 0}`);
  lines.push(`- Contradiction records: ${dossier.contradictions?.length || 0}`);

  lines.push(`\n## Claims and Evidence`);
  for (const claim of dossier.claims || []) {
    lines.push(`\n### ${claim.claim_id || 'CLAIM'}`);
    lines.push(`**Claim:** ${claim.claim}`);
    lines.push(`**Importance:** ${claim.importance || 'unknown'}`);
    lines.push(`**Support status:** ${claim.support_status || 'unresolved'}`);
    if (claim.dates_or_versions?.length) lines.push(`**Dates/versions:** ${claim.dates_or_versions.join('; ')}`);
    if (claim.evidence?.length) {
      lines.push(`**Evidence:**`);
      for (const e of claim.evidence) lines.push(`- ${e}`);
    }
    if (claim.sources?.length) {
      lines.push(`**Sources:**`);
      for (const s of claim.sources) lines.push(`- ${s}`);
    }
    if (claim.notes) lines.push(`**Notes:** ${claim.notes}`);
  }

  lines.push(`\n## Contradictions`);
  if (!dossier.contradictions?.length) lines.push(`No material contradictions were detected in the extracted evidence.`);
  for (const c of dossier.contradictions || []) {
    lines.push(`- **${c.topic || 'Unspecified topic'}** — ${c.status || 'unresolved'}: ${c.claim_a || ''} VS ${c.claim_b || ''}. ${c.reason || ''}`);
  }

  lines.push(`\n## Unresolved Gaps`);
  if (!dossier.unresolved_gaps?.length) lines.push(`No explicit evidence gaps were identified by the extraction pass.`);
  for (const g of dossier.unresolved_gaps || []) lines.push(`- ${g}`);

  lines.push(`\n## Source Registry`);
  for (const s of dossier.sources || []) {
    lines.push(`- [${s.source_id}] ${s.title} | ${s.source_type} | ${s.published_date || 'date unavailable'} | ${s.url}`);
  }

  return clampText(lines.join('\n'), MAX_DOSSIER_CHARS);
}

function buildReportPrompt(query, dossier) {
  const dossierText = buildDossierText(dossier);

  return `
USER RESEARCH QUESTION:
${query}

EVIDENCE DOSSIER:
${dossierText}

Write the final ArixAI research report.

MANDATORY QUALITY RULES
1. Use only evidence contained in the dossier. Do not inject outside facts.
2. Every material factual statement that can reasonably be attributed to a source must include an inline source marker such as [S123].
3. Never invent source IDs, citations, URLs, dates, statistics, laws, people, organizations, or quotations.
4. When evidence is incomplete or conflicting, explicitly say so rather than filling the gap.
5. Distinguish observed facts from synthesis, interpretation, and uncertainty.
6. Resolve contradictions only when the dossier provides a defensible basis; otherwise preserve the disagreement.
7. Prefer stronger primary evidence over weaker secondary material when the dossier supports that hierarchy.
8. Respect the dates/version details actually present in the dossier.
9. Do not claim that searching was exhaustive unless the dossier demonstrates that.
10. Do not mention hidden chain-of-thought, internal reasoning, or private deliberation.
11. Do not fabricate a bibliography. Use only the supplied source registry.

REPORT DEPTH REQUIREMENT
Produce a substantially long, decision-useful report. Aim for roughly 4,000–7,000 words when the evidence supports that much detail. Do NOT pad the report with repetition. Longer output is justified only by additional evidence, nuance, comparisons, timelines, implications, methodology, caveats, or source-by-source synthesis.

RECOMMENDED STRUCTURE
# Executive Summary
# Direct Answer to the Research Question
# Scope, Definitions, and Time Frame
# Research Method and Evidence Quality
# Key Findings
# Detailed Analysis
## Finding 1
## Finding 2
## Finding 3
# Evidence for and Against the Main Conclusions
# Contradictions and How They Were Handled
# Timeline / Version Changes (when relevant)
# Quantitative Evidence and Calculations (when supported)
# Stakeholder / Scenario Analysis (when relevant)
# Practical Implications
# Limitations and Unresolved Questions
# Final Assessment
# Sources

SOURCE CITATION FORMAT
Use the exact source IDs and URLs from the dossier's Source Registry. You may format the final source list as:
- [S123] Title — URL

Do not add sources that are not in the dossier.

The report must be useful even when the answer is "the evidence is insufficient". In that case, explain exactly what is known, what is disputed, what is missing, and what evidence would be needed to resolve it.
`;
}

async function auditReport({ query, report, dossier, geminiKeys, groqKeys, deadline }) {
  const sourceRegistry = (dossier.sources || []).map((s) => `[${s.source_id}] ${s.title} — ${s.url}`).join('\n');
  const claims = (dossier.claims || []).map((c) => `${c.claim_id}: ${c.claim} | status=${c.support_status} | sources=${(c.source_ids || []).join(',')}`).join('\n');

  const system = `
You are ArixAI's final Research Citation Auditor.
Compare a proposed report against an evidence dossier.
Return JSON only.
Do not repair the report by inventing facts. Identify violations precisely.

Required JSON:
{
  "pass": true|false,
  "unsupported_claims": ["..."],
  "citation_errors": ["..."],
  "contradiction_misrepresentations": ["..."],
  "date_errors": ["..."],
  "source_errors": ["..."],
  "required_repairs": ["..."],
  "quality_score": 0
}

A report passes only when its material factual content is traceable to dossier evidence and its citations use valid source IDs.
`;

  const user = clampText(`
QUERY:\n${query}

SOURCE REGISTRY:\n${sourceRegistry}

CLAIMS:\n${claims}

REPORT:\n${report}
`, MAX_AUDIT_CHARS);

  const providers = [];
  for (let i = 0; i < geminiKeys.length; i++) {
    providers.push(() => geminiJson({
      apiKey: rotateKey(geminiKeys, i),
      model: 'gemini-2.5-flash',
      system,
      user,
      deadline,
    }));
  }
  for (let i = 0; i < groqKeys.length; i++) {
    providers.push(() => groqJson({
      apiKey: rotateKey(groqKeys, i),
      model: 'openai/gpt-oss-20b',
      system,
      user,
      deadline,
    }));
  }

  for (const provider of providers) {
    if (remainingBudget(deadline) < 10_000) break;
    try {
      const result = await provider();
      if (typeof result.pass === 'boolean') return result;
    } catch {}
  }

  return {
    pass: true,
    unsupported_claims: [],
    citation_errors: [],
    contradiction_misrepresentations: [],
    date_errors: [],
    source_errors: [],
    required_repairs: ['Automated audit model unavailable before execution budget expired; report retains evidence-constrained drafting rules but could not receive a second-model audit.'],
    quality_score: 0,
  };
}

function validateSourceMarkers(report, dossier) {
  const validIds = new Set((dossier.sources || []).map((s) => s.source_id));
  const used = [...String(report || '').matchAll(/\[(S-?\d+)\]/g)].map((m) => m[1]);
  const invalid = used.filter((id) => !validIds.has(id));
  return { used: dedupeStrings(used), invalid: dedupeStrings(invalid) };
}

function buildFinalReportWithAudit(report, audit, dossier) {
  const markerCheck = validateSourceMarkers(report, dossier);
  let finalReport = String(report || '').trim();

  if (markerCheck.invalid.length) {
    finalReport += `\n\n> **Citation audit warning:** The automated citation audit detected source markers that were not present in the retained source registry: ${markerCheck.invalid.join(', ')}. Those references should not be treated as verified.`;
  }

  if (audit?.required_repairs?.length && !audit.pass) {
    finalReport += `\n\n## Verification Warnings\n`;
    for (const item of audit.required_repairs) finalReport += `- ${item}\n`;
  }

  const unresolved = dossier.unresolved_gaps || [];
  if (unresolved.length) {
    finalReport += `\n\n## Evidence Gaps Recorded by the Research Engine\n`;
    for (const gap of unresolved.slice(0, 12)) finalReport += `- ${gap}\n`;
  }

  return finalReport.trim();
}

function streamTextInChunks(controller, text, chunkSize = 1800) {
  for (let i = 0; i < text.length; i += chunkSize) {
    sendThought(controller, text.slice(i, i + chunkSize));
  }
}

function normalizeIncomingQuery(query) {
  if (typeof query !== 'string') return '';
  return query.trim().replace(/\s+/g, ' ');
}

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const requestStarted = Date.now();
  const requestBudget = Math.min(
    HARD_FUNCTION_BUDGET_MS - 5_000,
    Number(req.headers.get('x-arixai-research-budget-ms')) || DEFAULT_REQUEST_BUDGET_MS
  );
  const deadline = requestStarted + Math.max(30_000, Math.min(requestBudget, HARD_FUNCTION_BUDGET_MS - 5_000));

  const stream = new ReadableStream({
    async start(controller) {
      let closed = false;
      const close = () => {
        if (closed) return;
        closed = true;
        try { controller.close(); } catch {}
      };

      const done = (payload = {}) => {
        // Preserve the legacy `{ done: true, context }` contract while adding
        // structured metadata for the newer client.
        const context = payload.context ?? payload.report ?? '';
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ done: true, type: 'done', context, ...payload })}\n\n`));
        close();
      };

      const error = (message, details = {}) => {
        sendEvent(controller, 'error', { error: message, ...details });
        close();
      };

      try {
        let body;
        try {
          body = await req.json();
        } catch {
          return error('Invalid JSON request body.');
        }

        const query = normalizeIncomingQuery(body?.query);
        if (!query) return error('A non-empty research query is required.');
        if (query.length > 10_000) return error('Research query is too long.');

        const geminiKeys = envKeys('GEMINI', ['GEMINI_API_KEY']);
        const groqKeys = envKeys('GROQ', ['GROQ_API_KEY']);
        const tavilyKeys = envKeys('TAVILY', ['TAVILY_API_KEY']);

        if (!tavilyKeys.length) return error('No Tavily API key is configured.');
        if (!geminiKeys.length && !groqKeys.length) return error('No research synthesis model API key is configured.');

        sendLog(controller, 'Initializing ArixAI evidence-first research engine.', {
          budget_ms: deadline - Date.now(),
        });
        sendThought(controller, 'Planning research dimensions, source targets, counter-evidence, and verification requirements.');

        const mode = typeof body?.mode === 'string' ? body.mode : 'deep';
        const plan = await planResearch({ query, groqKeys, geminiKeys, deadline });

        const profile = chooseSearchProfile(query, mode);
        const initialQueries = buildSearchQueries(plan);
        sendLog(controller, `Research plan prepared: ${initialQueries.length} targeted discovery queries.`);
        sendLog(controller, `Research profile: ${profile.topic}/${profile.search_depth}.`);

        const allResults = [];
        const completedQueries = [];

        // Key rotation is treated as resilience, not a way to evade provider quotas.
        // Bounded concurrency avoids hammering providers and keeps the function within
        // its wall-clock budget.
        sendThought(controller, `Running ${Math.min(initialQueries.length, MAX_INITIAL_SEARCHES)} parallel discovery searches.`);
        const searchJobs = initialQueries.slice(0, MAX_INITIAL_SEARCHES).map((searchQuery, index) => ({ searchQuery, index }));

        const searchOutputs = await parallelMap(
          searchJobs,
          async ({ searchQuery, index }) => {
            const apiKey = rotateKey(tavilyKeys, index);
            const data = await tavilySearch({
              apiKey,
              query: searchQuery,
              profile,
              deadline,
              includeRaw: false,
            });
            completedQueries.push(searchQuery);
            return { searchQuery, data };
          },
          4
        );

        for (const item of searchOutputs) {
          if (item?.data?.results) allResults.push(...item.data.results);
        }

        let sources = dedupeResults(allResults);
        sources = balancedSourceSelection(sources, MAX_REPORT_SOURCES);
        sendLog(controller, `Discovery complete: ${sources.length} distinct high-value sources retained.`);

        if (!sources.length) {
          return done({
            complete: false,
            query,
            report: 'No usable live web sources were retrieved for this query. No factual research report was generated because the engine is configured not to simulate missing evidence.',
            sources: [],
            coverage: 0,
          });
        }

        sendThought(controller, 'Extracting source-level claims, evidence snippets, dates, source strength, contradictions, and research gaps.');
        let evidence = await extractEvidence({
          query,
          sources,
          geminiKeys,
          groqKeys,
          deadline,
        });

        const rounds = [{
          round: 1,
          queries: completedQueries,
          source_count: sources.length,
          new_source_count: sources.length,
          coverage_after_round: calculateCoverage(evidence),
        }];

        // Adaptive research: keep searching only while evidence quality materially needs it.
        for (let roundIndex = 1; roundIndex <= MAX_FOLLOW_UP_ROUNDS; roundIndex++) {
          if (!shouldContinue(evidence, roundIndex, deadline)) break;

          const followUpQueries = deriveGapQueries(evidence, query).slice(0, MAX_FOLLOW_UP_QUERIES);
          if (!followUpQueries.length) break;

          sendLog(controller, `Evidence gaps detected; starting adaptive follow-up round ${roundIndex}.`, {
            query_count: followUpQueries.length,
            current_coverage: calculateCoverage(evidence),
          });
          sendThought(controller, `Searching specifically for unresolved claims, contradictions, and missing primary evidence.`);

          const beforeUrlSet = new Set(sources.map((s) => s.url));
          const followOutputs = await parallelMap(
            followUpQueries.map((searchQuery, index) => ({ searchQuery, index })),
            async ({ searchQuery, index }) => {
              const apiKey = rotateKey(tavilyKeys, index + roundIndex * 3);
              const data = await tavilySearch({
                apiKey,
                query: searchQuery,
                profile,
                deadline,
                includeRaw: false,
              });
              return { searchQuery, data };
            },
            4
          );

          const roundResults = [];
          for (const item of followOutputs) {
            if (item?.data?.results) roundResults.push(...item.data.results);
          }

          const merged = dedupeResults([...sources, ...roundResults]);
          sources = balancedSourceSelection(merged, MAX_REPORT_SOURCES);

          const newSources = sources.filter((s) => !beforeUrlSet.has(s.url));
          const followEvidence = await extractEvidence({
            query,
            sources: newSources.length ? newSources : sources.slice(0, 20),
            geminiKeys,
            groqKeys,
            deadline,
          });

          evidence = mergeResearchRounds([evidence, followEvidence]);
          rounds.push({
            round: roundIndex + 1,
            queries: followUpQueries,
            source_count: sources.length,
            new_source_count: newSources.length,
            coverage_after_round: calculateCoverage(evidence),
          });

          sendLog(controller, `Adaptive round ${roundIndex} complete. Evidence coverage is ${Math.round(calculateCoverage(evidence) * 100)}%.`);
        }

        const dossier = serializeDossier({
          query,
          plan,
          sources,
          evidence,
          rounds,
          metadata: {
            started_at: new Date(requestStarted).toISOString(),
            completed_at: new Date().toISOString(),
            elapsed_ms_before_synthesis: Date.now() - requestStarted,
            search_depth: profile.search_depth,
            topic: profile.topic,
            source_count: sources.length,
            coverage_score: calculateCoverage(evidence),
            non_simulation_policy: true,
          },
        });

        sendThought(controller, `Research dossier assembled with ${dossier.claims.length} claims, ${dossier.sources.length} retained sources, and ${dossier.contradictions.length} contradiction records.`);

        if (remainingBudget(deadline) < 35_000) {
          return done({
            complete: false,
            partial: true,
            query,
            report: buildDossierText(dossier),
            sources: dossier.sources,
            coverage: dossier.coverage_score,
            warning: 'Execution budget ended before the long-form synthesis pass. The returned dossier contains only retrieved evidence and explicitly recorded uncertainty; no unsupported report was fabricated.',
          });
        }

        sendLog(controller, 'Generating the long-form evidence-grounded research report.');
        const reportSystem = `
You are ArixAI Oracle, an evidence-grounded research writer.
The supplied dossier is your only factual knowledge for this task.
Write a detailed, long-form research report. Do not use outside memory.
Do not invent facts or citations.
Use exact source IDs from the dossier for material factual claims.
Preserve uncertainty and contradictions when the evidence does not resolve them.
Prefer precision over confident prose.
`;

        const reportUser = buildReportPrompt(query, dossier);
        let report = '';
        let synthesisError = null;

        for (let i = 0; i < Math.max(geminiKeys.length, groqKeys.length, 1); i++) {
          if (remainingBudget(deadline) < 25_000) break;
          try {
            if (geminiKeys.length) {
              report = await geminiText({
                apiKey: rotateKey(geminiKeys, i),
                model: 'gemini-2.5-flash',
                system: reportSystem,
                user: reportUser,
                deadline,
                maxOutputTokens: 14_000,
              });
              if (report) break;
            }
          } catch (e) {
            synthesisError = e instanceof Error ? e.message : String(e);
          }
        }

        // We intentionally do not synthesize a "fake report" when the long-form
        // model is unavailable. Returning the evidence dossier is safer.
        if (!report) {
          return done({
            complete: false,
            partial: true,
            query,
            report: buildDossierText(dossier),
            sources: dossier.sources,
            coverage: dossier.coverage_score,
            warning: `Long-form synthesis was not completed: ${synthesisError || 'execution budget or provider availability'}. No unsupported report was generated.`,
          });
        }

        // Final claim/citation audit when the time budget allows it.
        let audit = {
          pass: true,
          unsupported_claims: [],
          citation_errors: [],
          contradiction_misrepresentations: [],
          date_errors: [],
          source_errors: [],
          required_repairs: [],
          quality_score: 0,
        };

        if (remainingBudget(deadline) >= 18_000) {
          sendThought(controller, 'Auditing the finished report claim-by-claim against the evidence dossier.');
          audit = await auditReport({
            query,
            report,
            dossier,
            geminiKeys,
            groqKeys,
            deadline,
          });
        }

        report = buildFinalReportWithAudit(report, audit, dossier);

        // Surface a transparent footer containing the real registry. This is not
        // pre-written topical content; it is assembled directly from retrieved URLs.
        report += `\n\n---\n\n## Research Engine Metadata\n\n`;
        report += `**Evidence coverage:** ${Math.round(dossier.coverage_score * 100)}%\n\n`;
        report += `**Retained sources:** ${dossier.sources.length}\n\n`;
        report += `**Research rounds:** ${dossier.rounds.length}\n\n`;
        report += `**Audit status:** ${audit.pass ? 'passed' : 'warnings detected'}${audit.quality_score ? ` (${audit.quality_score}/100)` : ''}\n\n`;
        report += `**Source registry:**\n`;
        for (const s of dossier.sources) report += `- [${s.source_id}] ${s.title} — ${s.url}\n`;

        sendThought(controller, 'Report generation complete. Streaming the verified research report to the client.');
        streamTextInChunks(controller, report);

        done({
          complete: true,
          query,
          report,
          sources: dossier.sources,
          coverage: dossier.coverage_score,
          audit,
          rounds: dossier.rounds,
          elapsed_ms: Date.now() - requestStarted,
        });
      } catch (err) {
        error(err instanceof Error ? err.message : String(err), {
          elapsed_ms: Date.now() - requestStarted,
        });
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
