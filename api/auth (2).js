// ============================================================================
// [ SAAS GATEWAY ] UNIVERSAL RATE LIMITER & AUTHENTICATOR (ULTIMATE V4.1)
// Perfectly Synchronized with Admin Subscription Overrides
// ============================================================================

const UPSTASH_URL = "https://immortal-eagle-36171.upstash.io".replace(/\/$/, '');
const UPSTASH_TOKEN = "AY1LAAIgcDE5MjFiMmNkNGQ4M2M0ODQ2YWNhYjU0YmFmMzlhNjliNw";

// Origins that trigger the Web App (Modal) Quota System instead of requiring API Keys
const ALLOWED_ORIGINS = ['chatini-ai.vercel.app', 'lexis-ai-chatini.vercel.app', 'localhost', '127.0.0.1'];

export async function verifyAndLimit(req, requestedModel, requestedFeature) {
    try {
        if (req.method === 'OPTIONS') return { authorized: true, isCreator: false, isOptions: true };

        // 1. SPARK BYPASS (Always 100% Free & Unlimited for Everyone)
        if (requestedModel === 'spark') return { authorized: true, isCreator: false };

        const origin = req.headers.get('origin') || req.headers.get('referer') || '';
        let isWebAppOrigin = false;
        
        for (let i = 0; i < ALLOWED_ORIGINS.length; i++) {
            if (origin.toLowerCase().includes(ALLOWED_ORIGINS[i].toLowerCase())) {
                isWebAppOrigin = true;
                break;
            }
        }

        const today = new Date().toISOString().split('T')[0];
        const multiExec = [];

        // ====================================================================
        // PATH A: WEB APP USERS (Triggers the Pop-up Modal)
        // ====================================================================
        if (isWebAppOrigin) {
            // CORE FIX: Always track by true Network IP to match the Admin Dashboard.
            const clientIp = req.headers.get('x-forwarded-for') || req.headers.get('x-real-ip') || 'unknown_ip';
            const userId = clientIp.split(',')[0].trim();

            // 1. Check Admin Dashboard Overrides
            const overrideRaw = await executeUpstashCommand(["HGET", "lexis:quota_overrides", userId]);
            let multiplier = 1;
            
            if (overrideRaw) {
                try {
                    // Upstash REST sometimes double-encodes JSON in Hashes. This safely unwraps it.
                    let config = typeof overrideRaw === 'string' ? JSON.parse(overrideRaw) : overrideRaw;
                    if (typeof config === 'string') config = JSON.parse(config); 

                    // Check if temporary boost expired
                    if (config.expiresAt && Date.now() > config.expiresAt) {
                        executeUpstashCommand(["HDEL", "lexis:quota_overrides", userId]); // Auto-Cleanup
                    } else {
                        if (config.type === 'blocked') return { authorized: false, error: "QUOTA_EXCEEDED | Feature: Account Suspended | Contact: thestarsofstarsptpn@gmail.com" };
                        if (config.type === 'unlimited') {
                            executeUpstashCommand(["INCR", "stats:total_success"]);
                            return { authorized: true, isCreator: true };
                        }
                        if (config.type === 'premium_2x') multiplier = 2;
                        if (config.type === 'premium_10x') multiplier = 10;
                    }
                } catch(e) { console.error("Override Parse Error", e); }
            }

            // 2. Strict Usage Limits Matrix
            const targetFeature = (requestedFeature && requestedFeature !== 'none') ? requestedFeature : requestedModel;
            const LIMITS = {
                'oracle': 2 * multiplier,    // Strict 2 (Multiplied by admin dashboard)
                'flux': 5 * multiplier,      // Strict 5
                'image': 5 * multiplier,
                'presentation': 5 * multiplier,
                'research': 3 * multiplier,
                'podcast': 5 * multiplier,
                'app': 5 * multiplier,
                'study': 5 * multiplier
            };

            const maxLimit = LIMITS[targetFeature] || (5 * multiplier);
            const redisKey = `lexis:usage:${userId}:${today}:${targetFeature}`;
            
            const currentUsage = await executeUpstashCommand(["INCR", redisKey]);
            if (currentUsage === 1) await executeUpstashCommand(["EXPIRE", redisKey, 86400]);

            // 3. Trigger Modal if Limit Exceeded
            if (currentUsage > maxLimit) {
                const displayNames = {
                    'oracle': 'Oracle 2.0 Mode',
                    'flux': 'Flux 1.5 Mode',
                    'image': 'Visual Engine',
                    'presentation': 'Premium Slides',
                    'research': 'Deep Research',
                    'podcast': 'Audio Producer',
                    'app': 'App Builder',
                    'study': 'Study Deck Generator'
                };
                const fName = displayNames[targetFeature] || 'Premium Feature';
                
                return { 
                    authorized: false, 
                    isCreator: false,
                    error: `QUOTA_EXCEEDED | Feature: ${fName} | Contact: thestarsofstarsptpn@gmail.com`
                };
            }

            executeUpstashCommand(["INCR", "stats:total_success"]);
            return { authorized: true, isCreator: false };
        }

        // ====================================================================
        // PATH B: EXTERNAL DEVELOPERS (Requires 'Lexis-' API Key)
        // ====================================================================
        const authHeader = req.headers.get('authorization');
        if (!authHeader) {
            await logError('missing_key');
            return { authorized: false, status: 401, error: "Authentication missing. Send 'Authorization: Bearer Lexis-...'" };
        }

        let rawKey = authHeader.replace(/^Bearer\s+/i, '').trim();
        let apiKey = rawKey.replace(/[^a-zA-Z0-9-]/g, ''); 
        if (apiKey.startsWith('Lexis') && !apiKey.startsWith('Lexis-')) apiKey = apiKey.replace('Lexis', 'Lexis-');

        if (!apiKey.startsWith('Lexis-') || apiKey.length < 15) {
            await logError('invalid_format');
            return { authorized: false, status: 401, error: "Invalid Lexis API Key format." };
        }

        const keyData = await executeUpstashCommand(["GET", `apikey:${apiKey}`]);
        
        if (!keyData) {
            await logError('invalid_key');
            return { authorized: false, status: 401, error: `Key not found in database. Checked for: [${apiKey}]` };
        }

        let keyConfig;
        try {
            keyConfig = typeof keyData === 'string' ? JSON.parse(keyData) : keyData;
            if (typeof keyConfig === 'string') keyConfig = JSON.parse(keyConfig);
        } catch (e) {
            await logError('corrupt_key_data');
            return { authorized: false, status: 500, error: "API Key payload corrupted. Contact admin." };
        }

        if (!keyConfig || !keyConfig.limits) return { authorized: false, status: 500, error: "API Key missing limits configuration." };
        if (keyConfig.status === 'blocked') {
            await logError('blocked_account');
            return { authorized: false, status: 403, error: "This Lexis Account has been suspended by the Administrator." };
        }

        if (requestedModel && requestedModel !== 'none') {
            let modelLimit = keyConfig.limits.models?.[requestedModel] ? parseInt(keyConfig.limits.models[requestedModel], 10) : 0;
            const modelTrackerKey = `usage:${apiKey}:${today}:model:${requestedModel}`;
            const usageData = await executeUpstashCommand(["GET", modelTrackerKey]);
            const currentUsage = parseInt(usageData || "0", 10);

            if (currentUsage >= modelLimit) {
                await logError('rate_limit_model');
                return { authorized: false, status: 429, error: `[RATE LIMIT] Daily limit exceeded for model '${requestedModel}'. Limit: ${modelLimit}/day.` };
            }
            multiExec.push(["INCR", modelTrackerKey], ["EXPIRE", modelTrackerKey, "86400"], ["SADD", "stats:models_used", requestedModel]);
        }

        if (requestedFeature && requestedFeature !== 'none') {
            let featureLimit = keyConfig.limits.features?.[requestedFeature] ? parseInt(keyConfig.limits.features[requestedFeature], 10) : 0;
            const featureTrackerKey = `usage:${apiKey}:${today}:feat:${requestedFeature}`;
            const usageData = await executeUpstashCommand(["GET", featureTrackerKey]);
            const currentUsage = parseInt(usageData || "0", 10);

            if (currentUsage >= featureLimit) {
                await logError('rate_limit_feature');
                return { authorized: false, status: 429, error: `[RATE LIMIT] Daily limit exceeded for feature '${requestedFeature}'. Limit: ${featureLimit}/day.` };
            }
            multiExec.push(["INCR", featureTrackerKey], ["EXPIRE", featureTrackerKey, "86400"], ["SADD", "stats:features_used", requestedFeature]);
        }

        const endUserDeviceId = req.headers.get('x-end-user-device-id') || req.headers.get('user-agent') || 'anonymous_end_user';
        multiExec.push(["INCR", "stats:total_requests"], ["INCR", "stats:total_success"], ["SADD", `dev_users:${apiKey}`, endUserDeviceId]);

        if (multiExec.length > 0) executeUpstashPipeline(multiExec);

        return { authorized: true, isCreator: false, accountData: keyConfig };

    } catch (e) {
        console.error("Auth Exception:", e);
        return { authorized: false, status: 500, error: "Lexis Authentication Service Timed Out." };
    }
}

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
        return data; 
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
