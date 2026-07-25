// ============================================================================
// [ SAAS GATEWAY ] UNIVERSAL RATE LIMITER & AUTHENTICATOR
// Intercepts requests, validates Lexis keys, and logs deep analytics
// ============================================================================

const UPSTASH_URL = "https://immortal-eagle-36171.upstash.io";
const UPSTASH_TOKEN = "AY1LAAIgcDE5MjFiMmNkNGQ4M2M0ODQ2YWNhYjU0YmFmMzlhNjliNw";

// Your personal apps get infinite, free usage. No limits.
const ALLOWED_ORIGINS = ['chatini-ai.vercel.app', 'lexis-ai-chatini.vercel.app', 'localhost'];

export async function verifyAndLimit(req, requestedModel, requestedFeature) {
    try {
        const originRaw = req.headers.get('origin') || req.headers.get('referer') || 'Unknown Origin';
        const origin = originRaw.replace(/^https?:\/\//, '').split('/')[0]; // Clean domain name
        const isCreatorApp = ALLOWED_ORIGINS.some(allowed => origin.includes(allowed));

        // 1. CREATOR BYPASS
        if (isCreatorApp) return { authorized: true, isCreator: true };

        // 2. EXTERNAL DEVELOPER CHECK
        const authHeader = req.headers.get('authorization');
        if (!authHeader || !authHeader.startsWith('Bearer Lexis-')) {
            await logGlobalError();
            return { authorized: false, status: 401, error: "Missing or Invalid Lexis API Key. Format: 'Bearer Lexis-...'" };
        }

        const apiKey = authHeader.split(' ')[1].trim();
        const endUserDeviceId = req.headers.get('x-end-user-device-id') || 'anonymous_user';

        // 3. FETCH KEY CONFIG
        const keyRes = await fetch(`${UPSTASH_URL}/get/apikey:${apiKey}`, { headers: { "Authorization": `Bearer ${UPSTASH_TOKEN}` }});
        const keyData = await keyRes.json();
        
        if (!keyData.result) {
            await logGlobalError();
            return { authorized: false, status: 401, error: "Lexis API Key revoked or invalid." };
        }

        const keyConfig = JSON.parse(keyData.result);
        const today = new Date().toISOString().split('T')[0];
        const multiExec = [];

        // 4. LIMIT CHECK: MODELS
        if (requestedModel && keyConfig.limits.models && keyConfig.limits.models[requestedModel] !== undefined) {
            const limit = keyConfig.limits.models[requestedModel];
            const tracker = `usage:${apiKey}:${today}:model:${requestedModel}`;
            const current = await getUsage(tracker);
            
            if (current >= limit) return { authorized: false, status: 429, error: `Daily limit exceeded for model '${requestedModel}'. Limit: ${limit}/day.` };
            multiExec.push(["INCR", tracker], ["EXPIRE", tracker, 86400]);
        }

        // 5. LIMIT CHECK: FEATURES
        if (requestedFeature && requestedFeature !== 'none' && keyConfig.limits.features && keyConfig.limits.features[requestedFeature] !== undefined) {
            const limit = keyConfig.limits.features[requestedFeature];
            const tracker = `usage:${apiKey}:${today}:feat:${requestedFeature}`;
            const current = await getUsage(tracker);

            if (current >= limit) return { authorized: false, status: 429, error: `Daily limit exceeded for feature '${requestedFeature}'. Limit: ${limit}/day.` };
            multiExec.push(["INCR", tracker], ["EXPIRE", tracker, 86400]);
        }

        // 6. DEEP ANALYTICS LOGGING (For Admin Panel)
        multiExec.push(["INCR", "stats:total_requests"]);
        multiExec.push(["INCR", `stats:key_usage:${apiKey}`]);
        multiExec.push(["SADD", `stats:key_origins:${apiKey}`, origin]);
        multiExec.push(["SADD", `stats:key_endusers:${apiKey}`, endUserDeviceId]);

        if (multiExec.length > 0) {
            await fetch(`${UPSTASH_URL}/pipeline`, {
                method: 'POST',
                headers: { "Authorization": `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "application/json" },
                body: JSON.stringify(multiExec)
            });
        }

        return { authorized: true, isCreator: false };

    } catch (e) {
        return { authorized: false, status: 500, error: "Auth Service Offline." };
    }
}

async function getUsage(key) {
    const res = await fetch(`${UPSTASH_URL}/get/${key}`, { headers: { "Authorization": `Bearer ${UPSTASH_TOKEN}` }});
    const data = await res.json();
    return parseInt(data.result || "0", 10);
}
async function logGlobalError() {
    await fetch(`${UPSTASH_URL}/INCR/stats:total_errors`, { headers: { "Authorization": `Bearer ${UPSTASH_TOKEN}` }});
}

