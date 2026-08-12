export const config = {
    runtime: 'edge',
};

// ====================================================================
// CONSTANTS & CONFIGURATION
// ====================================================================
const MASTER_PASS = "Lexis-Admin-2026";

const SERVICE_ACCOUNT = {
    project_id: "poetic-sentinel-483214-v0",
    private_key_id: "11b5721a5469114fed81d0e197895ed2a6e2d718",
    client_email: "poetic-sentinel-483214-v0@poetic-sentinel-483214-v0.iam.gserviceaccount.com"
};

const PRIVATE_KEY_PEM = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC9kSQ/DbI6y7mD
VEVyNXS4XeEKGQ7DHk1CJeqcpDZTd97G/Pnr+MrNfAOXw8AWxn/q+TId17/skqRj
UDZOi2/BoQRWbbxClrt7wj4nexWoJ9vOz/Qbs+aax+m9FvNNlXJ/Qr6jLc1IlZUs
G24ejJXOsVaFmteC3kpIRS9a/bprbnOuoA4I9gVeC8RPWpoqoVrd6kHmvhxpZ+K+
nUdWvkFmo2qNXXS6O3qXKkE2VtHkTgcTSG1aC3Tbad92262jRHf26Pg7auVqQHYS
reOwiqjBVI9urvrmKhUzj7PKiviWStvrllXPz0RhTJjGdoB4VjjCFj9wf+qDrCbW
bPZDuLpRAgMBAAECggEBAKpxfH1xU78/W580G822kptkV+5TiyfhWEajupiqPkZ0
YHuWoHzXA4AhDJyzhiL5gl5NPXAz288efU7BArjVVf3sPg+K8QKBgQD3iWoeQM6F
VRtnUIVSluV5s/6VM0KDLRDGN7v2FP8jXvHdA+tXvXAe35XxcfwWuZQ+k0Cm0QW3
skmn+J7D0HPm7UFETDsvAMQv04xPF/KL2OnQ4JInxGJc5yC0GNurXGppeuwklMUu
A89Cr0Ly06jwVzOzx0N8Obt3IP8jS6DIeQKBgQDEDFdzBQi6Mz2zXQJXEjma2pk8
CmkjZQquv6rB2WoJKueXkOK0AwmxcGXGZqoYaxKag+Vtu7RG3IRwKrSGYvc279YX
xVcH/6DmdBaUHkDS3cLS+XavK9lilWSTQ68HtUU4fxO7iN/vdsRs/OUc2O1KMajX
2+eMsudrFPc9ioG6mQKBgChtAa6lKNUv+hZ6WPuu9xUUJzyYnYEsx/OHQKQks7JE
HD3bGQFAR+JS43sGAYR4lFRP2hwkQMnKTSsoeE1EatlI4AL
-----END PRIVATE KEY-----`;

const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || "https://immortal-eagle-36171.upstash.io").replace(/[\r\n\s]/g, '');
const UPSTASH_TOKEN = (process.env.UPSTASH_REDIS_REST_TOKEN || "AY1LAAIgcDE5MjFiMmNkNGQ4M2M0ODQ2YWNhYjU0YmFmMzlhNjliNw").replace(/[\r\n\s]/g, '');

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-admin-pass, x-user-id',
};

// ====================================================================
// REDIS RUNNER (Upstash REST API)
// ====================================================================
async function redisCommand(commandArray) {
    try {
        const res = await fetch(UPSTASH_URL, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(commandArray)
        });
        if (!res.ok) return null;
        const data = await res.json();
        return data.result;
    } catch (e) {
        return null;
    }
}

// ====================================================================
// GOOGLE JWT GENERATOR (RS256 Edge Cryptography)
// ====================================================================
function base64UrlEncode(str) {
    return btoa(str).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function arrayBufferToBase64Url(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function pemToArrayBuffer(pem) {
    const cleanPem = pem
        .replace(/-----BEGIN PRIVATE KEY-----/, '')
        .replace(/-----END PRIVATE KEY-----/, '')
        .replace(/\s+/g, '');
    const binary = atob(cleanPem);
    const buffer = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        buffer[i] = binary.charCodeAt(i);
    }
    return buffer.buffer;
}

async function getGoogleAuthToken() {
    try {
        if (!PRIVATE_KEY_PEM.includes("BEGIN PRIVATE KEY")) return null;
        const header = { alg: "RS256", typ: "JWT", kid: SERVICE_ACCOUNT.private_key_id };
        const now = Math.floor(Date.now() / 1000);
        const claimSet = {
            iss: SERVICE_ACCOUNT.client_email,
            scope: "https://www.googleapis.com/auth/indexing",
            aud: "https://oauth2.googleapis.com/token",
            exp: now + 3600,
            iat: now
        };

        const encodedHeader = base64UrlEncode(JSON.stringify(header));
        const encodedClaimSet = base64UrlEncode(JSON.stringify(claimSet));
        const signingInput = `${encodedHeader}.${encodedClaimSet}`;

        const keyBuffer = pemToArrayBuffer(PRIVATE_KEY_PEM);
        const cryptoKey = await crypto.subtle.importKey(
            "pkcs8",
            keyBuffer,
            { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
            false,
            ["sign"]
        );

        const signatureBuffer = await crypto.subtle.sign(
            "RSASSA-PKCS1-v1_5",
            cryptoKey,
            new TextEncoder().encode(signingInput)
        );

        const encodedSignature = arrayBufferToBase64Url(signatureBuffer);
        const jwt = `${signingInput}.${encodedSignature}`;

        const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({
                grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
                assertion: jwt
            })
        });

        if (!tokenRes.ok) return null;
        const tokenData = await tokenRes.json();
        return tokenData.access_token;
    } catch (e) {
        return null;
    }
}

// ====================================================================
// GEMINI MARKETING & SEO COPY GENERATOR
// ====================================================================
async function generateGeminiMarketingCopy(targetUrl) {
    const GEMINI_KEYS = [
        process.env.GEMINI_API_KEY_1,
        process.env.GEMINI_API_KEY_2,
        process.env.GEMINI_API_KEY_3,
        process.env.GEMINI_API_KEY
    ].filter(Boolean).map(k => k.replace(/[\r\n\s]/g, ''));

    const fallbackCopy = {
        title: "LexisAI — Ultimate Cognitive Workspace",
        description: "Next-generation AI chat platform with 4M+ context virtualization, deep research, and real-time collaboration.",
        keywords: ["LexisAI", "AI Workspace", "Gemini 2.5", "Multiplayer AI"],
        socialPost: "Discover LexisAI: Next-level cognitive workspace powered by Gemini. Try it live at " + targetUrl
    };

    if (GEMINI_KEYS.length === 0) return fallbackCopy;

    for (const gKey of GEMINI_KEYS) {
        try {
            const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${gKey}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    contents: [{
                        role: "user",
                        parts: [{ text: `Generate dynamic, high-conversion promotional metadata for an AI web app URL: ${targetUrl}. Output STRICT JSON format with keys: "title", "description", "keywords" (array of 4 strings), "socialPost".` }]
                    }],
                    generationConfig: { responseMimeType: "application/json", temperature: 0.2 }
                })
            });

            if (geminiRes.ok) {
                const data = await geminiRes.json();
                const textResult = data.candidates?.[0]?.content?.parts?.[0]?.text;
                if (textResult) {
                    return JSON.parse(textResult);
                }
            }
        } catch (e) {}
    }

    return fallbackCopy;
}

// ====================================================================
// EDGE HANDLER
// ====================================================================
export default async function handler(req) {
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(req.url);
    const action = url.searchParams.get('action');

    // ----------------------------------------------------------------
    // 1. GRANULAR UNIVERSAL PATH TELEMETRY & CAPTURE
    // Automatically captures any visitor hitting the domain via any entry point
    // and categorizes them into exact unique paths without duplication:
    // - lexis-ai-chatini.vercel.app (root)
    // - lexis-ai-chatini.vercel.app/app.html
    // - lexis-ai-chatini.vercel.app/apikeys.html
    // ----------------------------------------------------------------
    if (req.method === 'POST' && action === 'ping') {
        try {
            const { userId, userAgent, path } = await req.json();
            const clientIp = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'anonymous';
            const id = userId || clientIp;
            const now = Date.now();

            const isGoogleBot = /googlebot|google-inspectiontool|bingbot|crawler|spider/i.test(userAgent || '');
            const rawPath = (path || '/').toLowerCase().trim();

            // Strict URL path classification
            let targetCategory = 'root';
            if (rawPath.includes('app.html')) {
                targetCategory = 'appHtml';
            } else if (rawPath.includes('apikeys.html')) {
                targetCategory = 'apikeysHtml';
            } else if (rawPath === '/' || rawPath === '') {
                targetCategory = 'root';
            } else if (rawPath.includes('app')) {
                targetCategory = 'appHtml';
            } else if (rawPath.includes('apikey')) {
                targetCategory = 'apikeysHtml';
            }

            // Global active session ping (active now within 5 mins)
            await redisCommand(["SET", `active_user:${id}`, now, "EX", "300"]);
            await redisCommand(["INCR", "metric:total_visits"]);
            await redisCommand(["SADD", "metric:unique_visitors", id]);

            // Unique visitor deduplication per page category using Redis Sets
            const visitorKey = `visited_page:${targetCategory}:${id}`;
            const alreadyVisited = await redisCommand(["GET", visitorKey]);
            
            if (!alreadyVisited) {
                await redisCommand(["SET", visitorKey, "1", "EX", "86400"]); // 24-hr session unique lock
                await redisCommand(["INCR", `metric:path_${targetCategory}_unique`]);
            }
            await redisCommand(["INCR", `metric:path_${targetCategory}_hits`]);

            if (isGoogleBot) {
                await redisCommand(["INCR", "metric:google_bot_hits"]);
                await redisCommand(["SET", "metric:last_bot_visit", now]);
            }

            return new Response(JSON.stringify({ success: true, trackedPath: targetCategory }), {
                status: 200,
                headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
            });
        } catch (e) {
            return new Response(JSON.stringify({ success: false, error: e.message }), {
                status: 500,
                headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
            });
        }
    }

    // ----------------------------------------------------------------
    // 2. ADMIN AUTHENTICATION GUARD
    // ----------------------------------------------------------------
    const adminPassHeader = req.headers.get('x-admin-pass');
    let requestBody = {};
    
    if (req.method === 'POST') {
        try {
            const clone = req.clone();
            requestBody = await clone.json();
        } catch (e) {}
    }

    const providedPass = adminPassHeader || requestBody.password || url.searchParams.get('pass');

    if (providedPass !== MASTER_PASS) {
        return new Response(JSON.stringify({ success: false, error: "Access Denied. Invalid Master Key." }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        });
    }

    // ----------------------------------------------------------------
    // 3. SEGREGATED PATH ANALYTICS & METRICS
    // ----------------------------------------------------------------
    if (action === 'metrics' || (req.method === 'POST' && requestBody.action === 'metrics')) {
        try {
            const keys = await redisCommand(["KEYS", "active_user:*"]);
            const activeCount = Array.isArray(keys) ? keys.length : 0;

            const totalVisits = parseInt(await redisCommand(["GET", "metric:total_visits"]) || "0");
            const uniqueVisitorsCount = await redisCommand(["SCARD", "metric:unique_visitors"]) || 0;
            const googleBotHits = parseInt(await redisCommand(["GET", "metric:google_bot_hits"]) || "0");
            const lastBotVisit = parseInt(await redisCommand(["GET", "metric:last_bot_visit"]) || "0");
            const lastIndexBlast = parseInt(await redisCommand(["GET", "metric:last_index_blast"]) || "0");
            const totalBlasts = parseInt(await redisCommand(["GET", "metric:total_blasts"]) || "0");

            // Strictly differentiated path metrics without duplication
            const pathMetrics = {
                root: {
                    url: "lexis-ai-chatini.vercel.app",
                    hits: parseInt(await redisCommand(["GET", "metric:path_root_hits"]) || "0"),
                    unique: parseInt(await redisCommand(["GET", "metric:path_root_unique"]) || "0")
                },
                appHtml: {
                    url: "lexis-ai-chatini.vercel.app/app.html",
                    hits: parseInt(await redisCommand(["GET", "metric:path_appHtml_hits"]) || "0"),
                    unique: parseInt(await redisCommand(["GET", "metric:path_appHtml_unique"]) || "0")
                },
                apikeysHtml: {
                    url: "lexis-ai-chatini.vercel.app/apikeys.html",
                    hits: parseInt(await redisCommand(["GET", "metric:path_apikeysHtml_hits"]) || "0"),
                    unique: parseInt(await redisCommand(["GET", "metric:path_apikeysHtml_unique"]) || "0")
                }
            };

            return new Response(JSON.stringify({
                success: true,
                analytics: {
                    activeLiveUsers: activeCount,
                    totalVisits: totalVisits,
                    uniqueVisitors: uniqueVisitorsCount,
                    googleBotHits: googleBotHits,
                    pathSegmentation: pathMetrics,
                    lastBotVisit: lastBotVisit ? new Date(lastBotVisit).toISOString() : "Never",
                    lastIndexBlast: lastIndexBlast ? new Date(lastIndexBlast).toISOString() : "Never",
                    totalBlasts: totalBlasts
                }
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
            });
        } catch (e) {
            return new Response(JSON.stringify({ success: false, error: e.message }), {
                status: 500,
                headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
            });
        }
    }

    // ----------------------------------------------------------------
    // 4. DEFENSIVE ORGANIC LAUNCH & INDEXING ELIGIBILITY CHECK
    // ----------------------------------------------------------------
    if (req.method === 'POST' && (action === 'launch' || requestBody.action === 'launch')) {
        try {
            const targetDomain = requestBody.targetUrl || "https://lexis-ai-chatini.vercel.app";
            const logs = [];
            const logStep = (msg) => logs.push(`[${new Date().toLocaleTimeString()}] ${msg}`);

            logStep("Admin session verified. Initializing Maximum Free Reach Engine.");

            // Step A: Gemini SEO Asset Generation
            logStep("Consulting Gemini 2.5 Flash to synthesize high-conversion organic metadata...");
            const copy = await generateGeminiMarketingCopy(targetDomain);
            logStep(`SEO Asset Ready: "${copy.title}"`);

            // Step B: Defensive Google Indexing Eligibility Check
            logStep("Evaluating Google Indexing API eligibility and service account credentials...");
            
            let indexingStatus = "SKIPPED — Google Indexing API not applicable to this URL";
            let indexingSuccess = false;

            const isEligibleForIndexingAPI = targetDomain.includes('/job') || targetDomain.includes('/event') || targetDomain.includes('/broadcast');

            if (!isEligibleForIndexingAPI) {
                logStep(`Notice: Target URL "${targetDomain}" is a standard web application root or static page. Google Indexing API strictly restricts eligibility (requires JobPosting/BroadcastEvent schema). Skipping Indexing API request to prevent 403 Forbidden errors.`);
            } else if (!PRIVATE_KEY_PEM.includes("BEGIN PRIVATE KEY")) {
                indexingStatus = "AUTH_ERROR — Service account private key is missing or malformed.";
                logStep(`Error: ${indexingStatus}`);
            } else {
                logStep("Credentials validated. Generating RS256 JWT assertion for Googlebot...");
                const googleToken = await getGoogleAuthToken();

                if (!googleToken) {
                    indexingStatus = "AUTH_ERROR — OAuth token acquisition failed.";
                    logStep(`Error: ${indexingStatus}`);
                } else {
                    logStep("OAuth token acquired successfully. Dispatching URL_UPDATED request...");
                    const indexRes = await fetch("https://indexing.googleapis.com/v1/urlNotifications:publish", {
                        method: "POST",
                        headers: {
                            "Authorization": `Bearer ${googleToken}`,
                            "Content-Type": "application/json"
                        },
                        body: JSON.stringify({
                            url: targetDomain,
                            type: "URL_UPDATED"
                        })
                    });

                    if (indexRes.ok) {
                        indexingSuccess = true;
                        indexingStatus = "SUCCESS — Googlebot notified for immediate re-crawl.";
                        logStep(`Google Indexing Response: ${indexingStatus}`);
                    } else {
                        const errText = await indexRes.text();
                        if (indexRes.status === 403) {
                            indexingStatus = "AUTH_ERROR — Google service account lacks Search Console verification for this domain.";
                        } else if (indexRes.status === 429) {
                            indexingStatus = "RATE_LIMITED — Google quota exceeded.";
                        } else {
                            indexingStatus = `API_ERROR — HTTP ${indexRes.status}: ${errText}`;
                        }
                        logStep(`Google Indexing Notice: ${indexingStatus}`);
                    }
                }
            }

            // Step C: Verified Syndication Webhooks
            logStep("Inspecting external syndication channels...");
            const syndicationEndpoints = [
                requestBody.webhookUrl,
                process.env.DISCORD_WEBHOOK_URL,
                process.env.TELEGRAM_WEBHOOK_URL
            ].filter(Boolean);

            let webhooksDispatched = 0;
            if (syndicationEndpoints.length === 0) {
                logStep("Zero external webhook endpoints configured. Skipping broadcast.");
            } else {
                for (const endpoint of syndicationEndpoints) {
                    try {
                        const syncRes = await fetch(endpoint, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                content: `🚀 **LexisAI Organic Discovery Update**\n\n**${copy.title}**\n${copy.description}\n\n👉 Access Platform: ${targetDomain}`,
                                username: "LexisAI Growth Agent"
                            })
                        });
                        if (syncRes.ok) webhooksDispatched++;
                    } catch (e) {}
                }
                logStep(`Syndication Broadcast Complete: Dispatched ${webhooksDispatched} verified webhook deliveries.`);
            }

            // Step D: Record Campaign Metrics
            const now = Date.now();
            await redisCommand(["SET", "metric:last_index_blast", now]);
            await redisCommand(["INCR", "metric:total_blasts"]);

            logStep("Campaign execution completed successfully.");

            return new Response(JSON.stringify({
                success: true,
                campaignStatus: indexingSuccess ? "SUCCESS" : "PARTIAL_SUCCESS",
                googleIndexingOutcome: indexingStatus,
                webhooksDispatched: webhooksDispatched,
                marketingCopy: copy,
                logs: logs
            }), {
                status: 200,
                headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
            });

        } catch (e) {
            return new Response(JSON.stringify({ success: false, error: e.message }), {
                status: 500,
                headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
            });
        }
    }

    return new Response(JSON.stringify({ success: false, error: "Invalid Action or Method" }), {
        status: 400,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
    });
    }
