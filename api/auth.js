// ============================================================================
// [ SAAS GATEWAY ] UNIVERSAL RATE LIMITER & AUTHENTICATOR (FAIL-SAFE V2)
// Intercepts requests, aggressively sanitizes keys, checks account status
// ============================================================================

const UPSTASH_URL = "https://immortal-eagle-36171.upstash.io";
const UPSTASH_TOKEN = "AY1LAAIgcDE5MjFiMmNkNGQ4M2M0ODQ2YWNhYjU0YmFmMzlhNjliNw";

// Your personal apps that get unlimited, free usage without an API key
const ALLOWED_ORIGINS = ['chatini-ai.vercel.app', 'lexis-ai-chatini.vercel.app', 'localhost', '127.0.0.1'];

export async function verifyAndLimit(req, requestedModel, requestedFeature) {
    try {
        const origin = req.headers.get('origin') || req.headers.get('referer') || '';
        const isCreatorApp = ALLOWED_ORIGINS.some(allowed => origin.includes(allowed));

        // --------------------------------------------------------------------
        // 1. CREATOR BYPASS (Absolute Infinity Mode)
        // --------------------------------------------------------------------
        if (isCreatorApp) {
            // Silently log creator success without awaiting to keep it blazing fast
            fetch(`${UPSTASH_URL}/INCR/stats:total_success`, { headers: { "Authorization": `Bearer ${UPSTASH_TOKEN}` } }).catch(()=>{});
            return { authorized: true, isCreator: true };
        }

        // --------------------------------------------------------------------
        // 2. EXTERNAL DEVELOPER EXTRACTION & AGGRESSIVE SANITIZATION
        // --------------------------------------------------------------------
        const authHeader = req.headers.get('authorization');
        if (!authHeader) {
            await logError('missing_key');
            return { authorized: false, status: 401, error: "Missing Authorization header. Use 'Bearer Lexis-...'" };
        }

        // AGGRESSIVE SANITIZER: Removes spaces, line breaks, and extracts purely the key
        // This permanently fixes the "Revoked or Invalid" copy-paste bug
        const rawKey = authHeader.replace(/^Bearer\s+/i, '').trim();
        const apiKey = rawKey.replace(/[^a-zA-Z0-9-]/g, ''); 

        if (!apiKey.startsWith('Lexis-')) {
            await logError('invalid_format');
            return { authorized: false, status: 401, error: "Invalid Key Format. Must start with 'Lexis-'" };
        }

        const endUserDeviceId = req.headers.get('x-end-user-device-id') || req.headers.get('user-agent') || 'anonymous_end_user';

        // --------------------------------------------------------------------
        // 3. FETCH KEY CONFIG FROM UPSTASH (WITH FAIL-SAFE PARSING)
        // --------------------------------------------------------------------
        const keyRes = await fetch(`${UPSTASH_URL}/get/apikey:${apiKey}`, {
            headers: { "Authorization": `Bearer ${UPSTASH_TOKEN}` }
        });
        
        if (!keyRes.ok) throw new Error("Upstash Connection Timeout");
        const keyData = await keyRes.json();
        
        if (!keyData.result) {
            await logError('invalid_key');
            return { authorized: false, status: 401, error: "Lexis API Key does not exist or has been revoked." };
        }

        // DOUBLE-DECODE FAILSAFE: Handles both raw JSON and stringified JSON dynamically
        let keyConfig;
        try {
            keyConfig = typeof keyData.result === 'string' ? JSON.parse(keyData.result) : keyData.result;
            if (typeof keyConfig === 'string') keyConfig = JSON.parse(keyConfig); // Catch double-encoding
        } catch (e) {
            await logError('corrupt_key_data');
            return { authorized: false, status: 500, error: "API Key data corrupted in registry." };
        }

        // --------------------------------------------------------------------
        // 4. ACCOUNT STATUS CHECK (Admin Blocking)
        // --------------------------------------------------------------------
        if (keyConfig.status === 'blocked') {
            await logError('blocked_account');
            return { authorized: false, status: 403, error: "This Lexis Account has been suspended by the Administrator." };
        }

        const today = new Date().toISOString().split('T')[0];
        const multiExec = [];

        // --------------------------------------------------------------------
        // 5. VERIFY MODEL LIMITS
        // --------------------------------------------------------------------
        if (requestedModel && requestedModel !== 'none' && keyConfig.limits.models && keyConfig.limits.models[requestedModel] !== undefined) {
            const modelLimit = keyConfig.limits.models[requestedModel];
            const modelTrackerKey = `usage:${apiKey}:${today}:model:${requestedModel}`;

            const usageRes = await fetch(`${UPSTASH_URL}/get/${modelTrackerKey}`, { headers: { "Authorization": `Bearer ${UPSTASH_TOKEN}` } });
            const usageData = await usageRes.json();
            const currentUsage = parseInt(usageData.result || "0", 10);

            if (currentUsage >= modelLimit) {
                await logError('rate_limit_model');
                return { authorized: false, status: 429, error: `[RATE LIMIT] Daily limit exceeded for model '${requestedModel}'. Limit is ${modelLimit}/day.` };
            }
            multiExec.push(["INCR", modelTrackerKey]);
            multiExec.push(["EXPIRE", modelTrackerKey, 86400]);
            multiExec.push(["SADD", "stats:models_used", requestedModel]);
        }

        // --------------------------------------------------------------------
        // 6. VERIFY FEATURE LIMITS
        // --------------------------------------------------------------------
        if (requestedFeature && requestedFeature !== 'none' && keyConfig.limits.features && keyConfig.limits.features[requestedFeature] !== undefined) {
            const featureLimit = keyConfig.limits.features[requestedFeature];
            const featureTrackerKey = `usage:${apiKey}:${today}:feat:${requestedFeature}`;

            const usageRes = await fetch(`${UPSTASH_URL}/get/${featureTrackerKey}`, { headers: { "Authorization": `Bearer ${UPSTASH_TOKEN}` } });
            const usageData = await usageRes.json();
            const currentUsage = parseInt(usageData.result || "0", 10);

            if (currentUsage >= featureLimit) {
                await logError('rate_limit_feature');
                return { authorized: false, status: 429, error: `[RATE LIMIT] Daily limit exceeded for feature '${requestedFeature}'. Limit is ${featureLimit}/day.` };
            }
            multiExec.push(["INCR", featureTrackerKey]);
            multiExec.push(["EXPIRE", featureTrackerKey, 86400]);
            multiExec.push(["SADD", "stats:features_used", requestedFeature]);
        }

        // --------------------------------------------------------------------
        // 7. EXECUTE PIPELINE & TRACK END-USER TELEMETRY
        // --------------------------------------------------------------------
        multiExec.push(["INCR", "stats:total_requests"]);
        multiExec.push(["INCR", "stats:total_success"]);
        
        // This tracks the unique people using the external developer's app
        const devUserKey = `dev_users:${apiKey}`;
        multiExec.push(["SADD", devUserKey, endUserDeviceId]);

        if (multiExec.length > 0) {
            await fetch(`${UPSTASH_URL}/pipeline`, {
                method: 'POST',
                headers: { "Authorization": `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "application/json" },
                body: JSON.stringify(multiExec)
            });
        }

        return { authorized: true, isCreator: false, accountData: keyConfig };

    } catch (e) {
        // Ultimate Failsafe: If Redis crashes, fail gracefully
        return { authorized: false, status: 500, error: "Authentication Service Offline or Timed Out." };
    }
}

// Helper to asynchronously log errors to Upstash without blocking the user
async function logError(type) {
    try {
        fetch(`${UPSTASH_URL}/pipeline`, {
            method: 'POST',
            headers: { "Authorization": `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "application/json" },
            body: JSON.stringify([
                ["INCR", "stats:total_requests"],
                ["INCR", "stats:total_errors"],
                ["INCR", `stats:errors:${type}`]
            ])
        }).catch(()=>{});
    } catch(e) {}
}


