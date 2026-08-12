export const config = {
    runtime: 'edge',
};

// --------------------------------------------------------------------
// CREDENTIALS & SERVICE ACCOUNT DATA
// --------------------------------------------------------------------
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

// --------------------------------------------------------------------
// REDIS RUNNER
// --------------------------------------------------------------------
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

// --------------------------------------------------------------------
// GOOGLE JWT GENERATOR (RS256 Edge Cryptography)
// --------------------------------------------------------------------
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

        if (!tokenRes.ok) {
            const errText = await tokenRes.text();
            throw new Error(`OAuth Token Error: ${errText}`);
        }

        const tokenData = await tokenRes.json();
        return tokenData.access_token;
    } catch (e) {
        return null;
    }
}

// --------------------------------------------------------------------
// GROQ ASSET & SEO GENERATOR
// --------------------------------------------------------------------
async function generateMarketingCopy(targetUrl) {
    const GROQ_KEYS = [
        process.env.GROQ_API_KEY,
        process.env.GROQ_KEY_2,
        process.env.GROQ_KEY_3
    ].filter(Boolean).map(k => k.replace(/[\r\n\s]/g, ''));

    if (GROQ_KEYS.length === 0) {
        return {
            title: "LexisAI — Ultimate Cognitive Workspace",
            description: "Next-generation AI chat platform with 4M+ context virtualization, deep research, and real-time collaboration.",
            keywords: ["LexisAI", "AI Workspace", "Gemini 2.5", "Groq AI", "Multiplayer AI"],
            socialPost: "Discover LexisAI: Next-level cognitive workspace powered by Gemini & Groq. Try it live at " + targetUrl
        };
    }

    for (const gKey of GROQ_KEYS) {
        try {
            const groqRes = await fetch("https://api.groq.com/openai/v1/chat/completions", {
                method: "POST",
                headers: { "Authorization": `Bearer ${gKey}`, "Content-Type": "application/json" },
                body: JSON.stringify({
                    model: "llama-3.1-8b-instant",
                    response_format: { type: "json_object" },
                    temperature: 0.3,
                    messages: [
                        {
                            role: "system",
                            content: `You are an elite marketing strategist and SEO specialist. Generate dynamic, high-conversion promotional metadata for an AI web app URL.
Output JSON strictly with keys: "title", "description", "keywords" (array of 5 strings), "socialPost".`
                        },
                        { role: "user", content: `Target Web App: ${targetUrl}` }
                    ]
                })
            });

            if (groqRes.ok) {
                const data = await groqRes.json();
                return JSON.parse(data.choices[0].message.content);
            }
        } catch (e) {}
    }

    return {
        title: "LexisAI — Ultimate Cognitive Workspace",
        description: "Next-generation AI chat platform with 4M+ context virtualization, deep research, and real-time collaboration.",
        keywords: ["LexisAI", "AI Workspace", "Gemini 2.5", "Groq AI", "Multiplayer AI"],
        socialPost: "Discover LexisAI: Next-level cognitive workspace powered by Gemini & Groq. Try it live at " + targetUrl
    };
}

// --------------------------------------------------------------------
// MAIN HANDLER
// --------------------------------------------------------------------
export default async function handler(req) {
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    const url = new URL(req.url);
    const action = url.searchParams.get('action');

    // ----------------------------------------------------------------
    // 1. VISITOR TELEMETRY & TRACKING (Public / Open)
    // ----------------------------------------------------------------
    if (req.method === 'POST' && action === 'ping') {
        try {
            const { userId, userAgent, pageUrl } = await req.json();
            const clientIp = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'anonymous';
            const id = userId || clientIp;
            const now = Date.now();

            const isGoogleBot = /googlebot|google-inspectiontool|bingbot|crawler|spider/i.test(userAgent || '');

            // Log Session Ping into Redis
            await redisCommand(["SET", `active_user:${id}`, now, "EX", "300"]); // 5 min TTL
            await redisCommand(["INCR", "metric:total_visits"]);
            await redisCommand(["SADD", "metric:unique_visitors", id]);

            if (isGoogleBot) {
                await redisCommand(["INCR", "metric:google_bot_hits"]);
                await redisCommand(["SET", "metric:last_bot_visit", now]);
            }

            return new Response(JSON.stringify({ success: true }), {
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
    // 2. ADMIN AUTHENTICATION GUARD (Required for administrative functions)
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
        return new Response(JSON.stringify({ success: false, error: "Access Denied. Invalid Key." }), {
            status: 401,
            headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        });
    }

    // ----------------------------------------------------------------
    // 3. FETCH HONEST ANALYTICS & TELEMETRY
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

            return new Response(JSON.stringify({
                success: true,
                analytics: {
                    activeLiveUsers: activeCount,
                    totalVisits: totalVisits,
                    uniqueVisitors: uniqueVisitorsCount,
                    googleBotHits: googleBotHits,
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
    // 4. EXECUTE FULL ORGANIC LAUNCH
    // ----------------------------------------------------------------
    if (req.method === 'POST' && (action === 'launch' || requestBody.action === 'launch')) {
        try {
            const targetDomain = requestBody.targetUrl || "https://lexis-ai-chatini.vercel.app";
            const logs = [];

            const logStep = (msg) => logs.push(`[${new Date().toLocaleTimeString()}] ${msg}`);

            logStep("Authenticating Admin Access... Authorized.");

            // Step A: Generate Copy
            logStep("Calling Groq Llama-3.1 engine to synthesize dynamic marketing assets...");
            const copy = await generateMarketingCopy(targetDomain);
            logStep(`Assets Ready: "${copy.title}"`);

            // Step B: Request Google Indexing
            logStep("Constructing RS256 JWT assertion for Google Indexing API...");
            const googleToken = await getGoogleAuthToken();

            let indexingSuccess = false;
            if (googleToken) {
                logStep("Google Access Token acquired. Dispatching URL_UPDATED request to Googlebot...");
                
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
                    const indexData = await indexRes.json();
                    indexingSuccess = true;
                    logStep("Google Indexing API Response: SUCCESS! Googlebot queued for immediate crawl.");
                } else {
                    const indexErr = await indexRes.text();
                    logStep(`Google Indexing Warning: ${indexErr}`);
                }
            } else {
                logStep("Google Indexing Warning: Failed to generate RS256 token.");
            }

            // Step C: Syndication Broadcasts
            logStep("Broadcasting syndication webhooks across public distribution nodes...");
            
            const syndicationEndpoints = [
                requestBody.webhookUrl,
                process.env.DISCORD_WEBHOOK_URL,
                process.env.TELEGRAM_WEBHOOK_URL
            ].filter(Boolean);

            let webhooksDispatched = 0;
            for (const endpoint of syndicationEndpoints) {
                try {
                    const syncRes = await fetch(endpoint, {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                            content: `🚀 **LexisAI Organic Launch**\n\n**${copy.title}**\n${copy.description}\n\n👉 Experience it live: ${targetDomain}`,
                            username: "LexisAI Launch Bot"
                        })
                    });
                    if (syncRes.ok) webhooksDispatched++;
                } catch (e) {}
            }

            logStep(`Syndication Complete. Dispatched ${webhooksDispatched} external broadcasts.`);

            // Step D: Update Telemetry Metrics
            const now = Date.now();
            await redisCommand(["SET", "metric:last_index_blast", now]);
            await redisCommand(["INCR", "metric:total_blasts"]);

            logStep("Launch Engine Executed Successfully. Real-time telemetry listening for incoming traffic.");

            return new Response(JSON.stringify({
                success: true,
                googleIndexed: indexingSuccess,
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
