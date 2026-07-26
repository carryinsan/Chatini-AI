// ============================================================================
// [ SAAS GATEWAY ] UNIVERSAL RATE LIMITER & AUTHENTICATOR (ULTIMATE V3)
// 100% Fail-Safe Upstash REST parsing using Direct POST Array Commands
// ============================================================================

const UPSTASH_URL = "https://immortal-eagle-36171.upstash.io".replace(/\/$/, ''); // Strip trailing slashes
const UPSTASH_TOKEN = "AY1LAAIgcDE5MjFiMmNkNGQ4M2M0ODQ2YWNhYjU0YmFmMzlhNjliNw";

// Your personal apps that get unlimited, free usage without an API key
const ALLOWED_ORIGINS = ['chatini-ai.vercel.app', 'lexis-ai-chatini.vercel.app', 'localhost', '127.0.0.1'];

export async function verifyAndLimit(req, requestedModel, requestedFeature) {
    try {
        // --------------------------------------------------------------------
        // 0. PREFLIGHT CORS BYPASS
        // --------------------------------------------------------------------
        if (req.method === 'OPTIONS') {
            return { authorized: true, isCreator: false, isOptions: true };
        }

        // --------------------------------------------------------------------
        // 1. CREATOR BYPASS (Absolute Infinity Mode for Your Apps)
        // --------------------------------------------------------------------
        const origin = req.headers.get('origin') || req.headers.get('referer') || '';
        let isCreatorApp = false;
        
        for (let i = 0; i < ALLOWED_ORIGINS.length; i++) {
            if (origin.toLowerCase().includes(ALLOWED_ORIGINS[i].toLowerCase())) {
                isCreatorApp = true;
                break;
            }
        }

        if (isCreatorApp) {
            // Silently log creator success using POST command
            executeUpstashCommand(["INCR", "stats:total_success"]);
            return { authorized: true, isCreator: true };
        }

        // --------------------------------------------------------------------
        // 2. EXTERNAL DEVELOPER EXTRACTION & HYPER-SANITIZATION
        // --------------------------------------------------------------------
        const authHeader = req.headers.get('authorization');
        if (!authHeader) {
            await logError('missing_key');
            return { authorized: false, status: 401, error: "Authentication missing. Send 'Authorization: Bearer Lexis-...'" };
        }

        // Extremely aggressive regex to strip all invisible characters, tabs, newlines
        let rawKey = authHeader.replace(/^Bearer\s+/i, '').trim();
        let apiKey = rawKey.replace(/[^a-zA-Z0-9-]/g, ''); 

        // Auto-fix if they accidentally stripped the hyphen
        if (apiKey.startsWith('Lexis') && !apiKey.startsWith('Lexis-')) {
            apiKey = apiKey.replace('Lexis', 'Lexis-');
        }

        if (!apiKey.startsWith('Lexis-') || apiKey.length < 15) {
            await logError('invalid_format');
            return { authorized: false, status: 401, error: "Invalid Lexis API Key format." };
        }

        const endUserDeviceId = req.headers.get('x-end-user-device-id') || req.headers.get('user-agent') || 'anonymous_end_user';

        // --------------------------------------------------------------------
        // 3. FAIL-SAFE UPSTASH FETCH (Direct POST Array Command)
        // --------------------------------------------------------------------
        const keyData = await executeUpstashCommand(["GET", `apikey:${apiKey}`]);
        
        if (keyData === null || keyData === undefined || keyData === "") {
            await logError('invalid_key');
            // Detailed error so you know exactly what string was searched
            return { authorized: false, status: 401, error: `Key not found in database. Checked for: [${apiKey}]` };
        }

        // DOUBLE-DECODE FAILSAFE: Handles both raw JSON objects and double-stringified data
        let keyConfig;
        try {
            keyConfig = typeof keyData === 'string' ? JSON.parse(keyData) : keyData;
            if (typeof keyConfig === 'string') keyConfig = JSON.parse(keyConfig);
        } catch (e) {
            await logError('corrupt_key_data');
            return { authorized: false, status: 500, error: "API Key payload corrupted. Contact admin." };
        }

        // Validate structure
        if (!keyConfig || !keyConfig.limits) {
            return { authorized: false, status: 500, error: "API Key missing limits configuration." };
        }

        // --------------------------------------------------------------------
        // 4. ACCOUNT STATUS CHECK
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
        if (requestedModel && requestedModel !== 'none') {
            let modelLimit = 0;
            if (keyConfig.limits.models && keyConfig.limits.models[requestedModel] !== undefined) {
                modelLimit = parseInt(keyConfig.limits.models[requestedModel], 10);
            }

            const modelTrackerKey = `usage:${apiKey}:${today}:model:${requestedModel}`;
            const usageData = await executeUpstashCommand(["GET", modelTrackerKey]);
            const currentUsage = parseInt(usageData || "0", 10);

            if (currentUsage >= modelLimit) {
                await logError('rate_limit_model');
                return { authorized: false, status: 429, error: `[RATE LIMIT] Daily limit exceeded for model '${requestedModel}'. Limit: ${modelLimit}/day.` };
            }
            
            multiExec.push(["INCR", modelTrackerKey]);
            multiExec.push(["EXPIRE", modelTrackerKey, "86400"]);
            multiExec.push(["SADD", "stats:models_used", requestedModel]);
        }

        // --------------------------------------------------------------------
        // 6. VERIFY FEATURE LIMITS
        // --------------------------------------------------------------------
        if (requestedFeature && requestedFeature !== 'none') {
            let featureLimit = 0;
            if (keyConfig.limits.features && keyConfig.limits.features[requestedFeature] !== undefined) {
                featureLimit = parseInt(keyConfig.limits.features[requestedFeature], 10);
            }

            const featureTrackerKey = `usage:${apiKey}:${today}:feat:${requestedFeature}`;
            const usageData = await executeUpstashCommand(["GET", featureTrackerKey]);
            const currentUsage = parseInt(usageData || "0", 10);

            if (currentUsage >= featureLimit) {
                await logError('rate_limit_feature');
                return { authorized: false, status: 429, error: `[RATE LIMIT] Daily limit exceeded for feature '${requestedFeature}'. Limit: ${featureLimit}/day.` };
            }
            
            multiExec.push(["INCR", featureTrackerKey]);
            multiExec.push(["EXPIRE", featureTrackerKey, "86400"]);
            multiExec.push(["SADD", "stats:features_used", requestedFeature]);
        }

        // --------------------------------------------------------------------
        // 7. EXECUTE PIPELINE & TRACK END-USER TELEMETRY
        // --------------------------------------------------------------------
        multiExec.push(["INCR", "stats:total_requests"]);
        multiExec.push(["INCR", "stats:total_success"]);
        
        // This tracks the unique people using the external developer's app
        multiExec.push(["SADD", `dev_users:${apiKey}`, endUserDeviceId]);

        if (multiExec.length > 0) {
            executeUpstashPipeline(multiExec); // Fire and forget (don't await) to keep API fast
        }

        return { authorized: true, isCreator: false, accountData: keyConfig };

    } catch (e) {
        // Ultimate Failsafe: If Redis completely crashes, log locally and block
        console.error("Auth Exception:", e);
        return { authorized: false, status: 500, error: "Lexis Authentication Service Timed Out." };
    }
}

// ============================================================================
// [ CORE ] UPSTASH FAIL-SAFE COMMUNICATION HELPERS
// ============================================================================

async function executeUpstashCommand(commandArray) {
    try {
        const res = await fetch(UPSTASH_URL, {
            method: 'POST',
            headers: { "Authorization": `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "application/json" },
            body: JSON.stringify(commandArray)
        });
        if (!res.ok) return null;
        const data = await res.json();
        return data.result;
    } catch(e) {
        return null;
    }
}

async function executeUpstashPipeline(pipelineArray) {
    try {
        const res = await fetch(`${UPSTASH_URL}/pipeline`, {
            method: 'POST',
            headers: { "Authorization": `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "application/json" },
            body: JSON.stringify(pipelineArray)
        });
        if (!res.ok) return null;
        const data = await res.json();
        return data; // Array of results
    } catch(e) {
        return null;
    }
}

async function logError(type) {
    executeUpstashPipeline([
        ["INCR", "stats:total_requests"],
        ["INCR", "stats:total_errors"],
        ["INCR", `stats:errors:${type}`]
    ]);
}


