// ============================================================================
// [ SAAS GATEWAY ] FAIL-SAFE UNIVERSAL RATE LIMITER & AUTHENTICATOR
// Intercepts requests, validates Lexis keys, and handles quotas safely.
// ============================================================================

export const config = {
    runtime: 'edge',
};

const UPSTASH_URL = "https://immortal-eagle-36171.upstash.io";
const UPSTASH_TOKEN = "AY1LAAIgcDE5MjFiMmNkNGQ4M2M0ODQ2YWNhYjU0YmFmMzlhNjliNw";

// Your personal apps that get unlimited, free usage without an API key
const ALLOWED_ORIGINS = ['chatini-ai.vercel.app', 'lexis-ai-chatini.vercel.app', 'localhost', '127.0.0.1'];

export async function verifyAndLimit(req, requestedModel, requestedFeature) {
    try {
        const origin = req.headers.get('origin') || req.headers.get('referer') || '';
        const isCreatorApp = ALLOWED_ORIGINS.some(allowed => origin.includes(allowed));

        // 1. CREATOR BYPASS: If the request comes from YOUR apps, allow infinite usage
        if (isCreatorApp) {
            try {
                await fetch(`${UPSTASH_URL}/INCR/stats:total_success`, { 
                    method: 'POST',
                    headers: { "Authorization": `Bearer ${UPSTASH_TOKEN}` } 
                });
            } catch(e) {}
            return { authorized: true, isCreator: true };
        }

        // 2. EXTERNAL DEVELOPER KEY EXTRACTION
        const authHeader = req.headers.get('authorization') || '';
        let apiKey = "";

        if (authHeader.startsWith('Bearer ')) {
            apiKey = authHeader.split(' ')[1].trim();
        } else if (authHeader.startsWith('Lexis-')) {
            apiKey = authHeader.trim();
        }

        if (!apiKey || !apiKey.startsWith('Lexis-')) {
            await logError('missing_key');
            return { 
                authorized: false, 
                status: 401, 
                error: "Missing or Invalid Lexis API Key. Pass 'Authorization: Bearer Lexis-...'" 
            };
        }

        const endUserDeviceId = req.headers.get('x-end-user-device-id') || 'anonymous_end_user';

        // 3. FAIL-SAFE FETCH KEY CONFIG FROM UPSTASH
        let keyConfig = null;
        try {
            const keyRes = await fetch(`${UPSTASH_URL}/get/apikey:${apiKey}`, {
                headers: { "Authorization": `Bearer ${UPSTASH_TOKEN}` }
            });
            const keyData = await keyRes.json();
            
            if (keyData && keyData.result) {
                if (typeof keyData.result === 'object') {
                    keyConfig = keyData.result;
                } else {
                    keyConfig = JSON.parse(keyData.result);
                }
            }
        } catch (redisErr) {
            // Fail-safe: If Upstash has a blip, let the user through to prevent blocking valid users
            return { authorized: true, isCreator: false };
        }

        // If the key is genuinely missing from Upstash Redis, reject it
        if (!keyConfig) {
            await logError('invalid_key');
            return { 
                authorized: false, 
                status: 401, 
                error: "Lexis API Key revoked or invalid." 
            };
        }

        const today = new Date().toISOString().split('T')[0];
        const multiExec = [];
        const limits = keyConfig.limits || {
            models: { spark: 100, flux: 20, oracle: 5 },
            features: { research: 1, slides: 3, maths: 10, app: 10, image: 5 }
        };

        // 4. VERIFY MODEL LIMITS
        if (requestedModel && limits.models && limits.models[requestedModel] !== undefined) {
            const modelLimit = limits.models[requestedModel];
            const modelTrackerKey = `usage:${apiKey}:${today}:model:${requestedModel}`;

            try {
                const usageRes = await fetch(`${UPSTASH_URL}/get/${modelTrackerKey}`, { headers: { "Authorization": `Bearer ${UPSTASH_TOKEN}` } });
                const usageData = await usageRes.json();
                const currentUsage = parseInt(usageData.result || "0", 10);

                if (currentUsage >= modelLimit) {
                    await logError('rate_limit_model');
                    return { 
                        authorized: false, 
                        status: 429, 
                        error: `[RATE LIMIT] Daily limit exceeded for model '${requestedModel}'. Limit is ${modelLimit}/day.` 
                    };
                }
            } catch(e) {}

            multiExec.push(["INCR", modelTrackerKey]);
            multiExec.push(["EXPIRE", modelTrackerKey, 86400]);
        }

        // 5. VERIFY FEATURE LIMITS
        if (requestedFeature && requestedFeature !== 'none' && limits.features && limits.features[requestedFeature] !== undefined) {
            const featureLimit = limits.features[requestedFeature];
            const featureTrackerKey = `usage:${apiKey}:${today}:feat:${requestedFeature}`;

            try {
                const usageRes = await fetch(`${UPSTASH_URL}/get/${featureTrackerKey}`, { headers: { "Authorization": `Bearer ${UPSTASH_TOKEN}` } });
                const usageData = await usageRes.json();
                const currentUsage = parseInt(usageData.result || "0", 10);

                if (currentUsage >= featureLimit) {
                    await logError('rate_limit_feature');
                    return { 
                        authorized: false, 
                        status: 429, 
                        error: `[RATE LIMIT] Daily limit exceeded for feature '${requestedFeature}'. Limit is ${featureLimit}/day.` 
                    };
                }
            } catch(e) {}

            multiExec.push(["INCR", featureTrackerKey]);
            multiExec.push(["EXPIRE", featureTrackerKey, 86400]);
        }

        // 6. EXECUTE PIPELINE & TRACK END-USER METRICS
        multiExec.push(["INCR", "stats:total_requests"]);
        multiExec.push(["INCR", "stats:total_success"]);
        multiExec.push(["SADD", `dev_users:${apiKey}`, endUserDeviceId]);

        if (multiExec.length > 0) {
            try {
                await fetch(`${UPSTASH_URL}/pipeline`, {
                    method: 'POST',
                    headers: { "Authorization": `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "application/json" },
                    body: JSON.stringify(multiExec)
                });
            } catch(e) {}
        }

        return { authorized: true, isCreator: false };

    } catch (error) {
        // Ultimate Fail-Safe: Never crash an external app due to an authentication middleware glitch
        return { authorized: true, isCreator: false };
    }
}

async function logError(type) {
    try {
        await fetch(`${UPSTASH_URL}/pipeline`, {
            method: 'POST',
            headers: { "Authorization": `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "application/json" },
            body: JSON.stringify([
                ["INCR", "stats:total_requests"],
                ["INCR", "stats:total_errors"],
                ["INCR", `stats:errors:${type}`]
            ])
        });
    } catch(e) {}
}

