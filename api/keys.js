export const config = {
    runtime: 'edge',
};

// ============================================================================
// [ SAAS GATEWAY ] LEXIS ACCOUNT REGISTRY & ADMIN BRIDGE (V3)
// Massive, Error-Proof Upstash Handlers for Accounts & Telemetry
// ============================================================================

const UPSTASH_URL = "https://immortal-eagle-36171.upstash.io".replace(/\/$/, '');
const UPSTASH_TOKEN = "AY1LAAIgcDE5MjFiMmNkNGQ4M2M0ODQ2YWNhYjU0YmFmMzlhNjliNw";

// Helper for obfuscating passwords before saving to DB
const hashPwd = (pwd) => {
    if (!pwd) return "ERROR_NO_PWD";
    let hash = 0;
    const str = pwd + "LEXIS_SECURE_SALT_99";
    for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
    }
    return Math.abs(hash).toString(16);
};

export default async function handler(req) {
    // CORS Handling
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 200, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, Authorization' }});
    }
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    try {
        const body = await req.json();
        const { action, adminSecret } = body;

        // --------------------------------------------------------------------
        // ACTION 1: REGISTER NEW LEXIS ACCOUNT
        // --------------------------------------------------------------------
        if (action === 'register') {
            const { username, password, website, deviceId } = body;
            
            if (!username || username.length < 3) return new Response(JSON.stringify({ error: "Username too short." }), { status: 400 });
            if (!password || password.length < 5) return new Response(JSON.stringify({ error: "Password must be at least 5 characters." }), { status: 400 });
            
            // Format to standard @lexis.ai email
            let email = username.toLowerCase().replace(/[^a-z0-9_.-]/g, '');
            if (!email.includes('@')) email = `${email}@lexis.ai`;

            // Check if account already exists using POST Array syntax
            const checkData = await executeUpstashCommand(["GET", `account:${email}`]);
            if (checkData) {
                return new Response(JSON.stringify({ error: "That @lexis.ai account already exists. Please sign in." }), { status: 409 });
            }

            // Mint new API Key
            const uniqueUUID = crypto.randomUUID().replace(/-/g, '');
            const newApiKey = `Lexis-${uniqueUUID}`;

            // Define Account & Enterprise Limits
            const keyConfig = {
                email: email,
                website: website || "None Provided",
                device_id: deviceId || "Unknown",
                created_at: Date.now(),
                status: 'active',
                limits: {
                    models: { spark: 100, flux: 20, oracle: 5 },
                    features: { chat: 100, research: 1, slides: 3, maths: 10, app: 10, image: 5 }
                }
            };

            const accountConfig = {
                email: email,
                password_hash: hashPwd(password),
                api_key: newApiKey
            };

            // Save atomically to Upstash
            const multiExec = [
                ["SET", `account:${email}`, JSON.stringify(accountConfig)],
                ["SET", `apikey:${newApiKey}`, JSON.stringify(keyConfig)],
                ["SADD", "admin:all_keys", newApiKey],
                ["INCR", "stats:total_devices"]
            ];

            const saveRes = await executeUpstashPipeline(multiExec);
            if (!saveRes) throw new Error("Database save pipeline failed.");

            return new Response(JSON.stringify({ 
                success: true, message: "Account registered successfully!", apiKey: newApiKey, config: keyConfig 
            }), { status: 200, headers: corsHeaders() });
        }

        // --------------------------------------------------------------------
        // ACTION 2: LOGIN TO LEXIS ACCOUNT
        // --------------------------------------------------------------------
        if (action === 'login') {
            const { username, password } = body;
            if (!username || !password) return new Response(JSON.stringify({ error: "Credentials missing." }), { status: 400 });

            let email = username.toLowerCase().replace(/\s/g, '');
            if (!email.includes('@')) email = `${email}@lexis.ai`;

            const accDataRaw = await executeUpstashCommand(["GET", `account:${email}`]);
            if (!accDataRaw) return new Response(JSON.stringify({ error: "Account not found." }), { status: 404 });
            
            let acc;
            try { acc = typeof accDataRaw === 'string' ? JSON.parse(accDataRaw) : accDataRaw; } 
            catch(e) { return new Response(JSON.stringify({ error: "Account data corrupted." }), { status: 500 }); }
            
            if (acc.password_hash !== hashPwd(password)) {
                return new Response(JSON.stringify({ error: "Invalid password." }), { status: 401 });
            }

            // Fetch limits for UI display
            const keyDataRaw = await executeUpstashCommand(["GET", `apikey:${acc.api_key}`]);
            if (!keyDataRaw) return new Response(JSON.stringify({ error: "API Key missing from registry." }), { status: 500 });
            
            let keyConfig = typeof keyDataRaw === 'string' ? JSON.parse(keyDataRaw) : keyDataRaw;

            return new Response(JSON.stringify({ 
                success: true, message: "Logged in successfully!", apiKey: acc.api_key, config: keyConfig 
            }), { status: 200, headers: corsHeaders() });
        }

        // --------------------------------------------------------------------
        // ACTION 3: ADMIN - FETCH FULL DASHBOARD DATA
        // --------------------------------------------------------------------
        if (action === 'admin_stats') {
            if (adminSecret !== "Lexis-Admin-2026!") return new Response(JSON.stringify({ error: "Access Denied." }), { status: 401 });

            const statExec = [
                ["GET", "stats:total_requests"], ["GET", "stats:total_success"], ["GET", "stats:total_errors"], ["GET", "stats:total_devices"],
                ["GET", "stats:errors:missing_key"], ["GET", "stats:errors:invalid_key"], ["GET", "stats:errors:rate_limit_model"], ["GET", "stats:errors:rate_limit_feature"]
            ];
            const statsData = await executeUpstashPipeline(statExec);
            if (!statsData) throw new Error("Failed to fetch global stats.");

            // Fetch All Registered Users
            const allKeys = await executeUpstashCommand(["SMEMBERS", "admin:all_keys"]) || [];

            // Fetch Configs & End-User counts for every Key
            const userExec = [];
            for (let i = 0; i < allKeys.length; i++) {
                userExec.push(["GET", `apikey:${allKeys[i]}`]);
                userExec.push(["SCARD", `dev_users:${allKeys[i]}`]); 
            }

            let activeUsers = [];
            if (userExec.length > 0) {
                const userData = await executeUpstashPipeline(userExec);
                if (userData) {
                    for (let i = 0; i < allKeys.length; i++) {
                        const configRaw = userData[i*2].result;
                        const endUsersCount = userData[(i*2)+1].result;
                        
                        if (configRaw) {
                            let cfg;
                            try { cfg = typeof configRaw === 'string' ? JSON.parse(configRaw) : configRaw; } catch(e){ continue; }
                            
                            activeUsers.push({
                                apiKey: allKeys[i],
                                email: cfg.email || "Unknown",
                                website: cfg.website || "None",
                                status: cfg.status || "active",
                                limits: cfg.limits || {},
                                endUsersVisitingApp: parseInt(endUsersCount || "0", 10)
                            });
                        }
                    }
                }
            }

            return new Response(JSON.stringify({
                success: true,
                analytics: {
                    totalRequests: parseInt(statsData[0].result || "0", 10),
                    totalSuccess: parseInt(statsData[1].result || "0", 10),
                    totalErrors: parseInt(statsData[2].result || "0", 10),
                    totalDevices: parseInt(statsData[3].result || "0", 10),
                    errorAuth: parseInt(statsData[4].result || "0", 10) + parseInt(statsData[5].result || "0", 10),
                    errorModelQuota: parseInt(statsData[6].result || "0", 10),
                    errorFeatureQuota: parseInt(statsData[7].result || "0", 10)
                },
                users: activeUsers
            }), { status: 200, headers: corsHeaders() });
        }

        // --------------------------------------------------------------------
        // ACTION 4: ADMIN - MODIFY USER LIMITS OR BLOCK
        // --------------------------------------------------------------------
        if (action === 'admin_modify') {
            if (adminSecret !== "Lexis-Admin-2026!") return new Response(JSON.stringify({ error: "Access Denied." }), { status: 401 });
            
            const { targetKey, newStatus, newLimits } = body;
            if (!targetKey) return new Response(JSON.stringify({ error: "targetKey required." }), { status: 400 });

            const keyDataRaw = await executeUpstashCommand(["GET", `apikey:${targetKey}`]);
            if (!keyDataRaw) return new Response(JSON.stringify({ error: "Key not found in database." }), { status: 404 });
            
            let keyConfig;
            try { keyConfig = typeof keyDataRaw === 'string' ? JSON.parse(keyDataRaw) : keyDataRaw; }
            catch(e) { return new Response(JSON.stringify({ error: "Data corrupted." }), { status: 500 }); }
            
            if (newStatus) keyConfig.status = newStatus; 
            if (newLimits) keyConfig.limits = newLimits; 

            // Save modified config back
            await executeUpstashCommand(["SET", `apikey:${targetKey}`, JSON.stringify(keyConfig)]);

            return new Response(JSON.stringify({ success: true, message: `Account updated.`, newConfig: keyConfig }), { status: 200, headers: corsHeaders() });
        }

        return new Response(JSON.stringify({ error: "Invalid execution action." }), { status: 400 });

    } catch (error) {
        console.error("Gateway Error:", error);
        return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: corsHeaders() });
    }
}

// ============================================================================
// [ CORE ] UPSTASH COMMUNICATION & HEADERS
// ============================================================================

function corsHeaders() {
    return { 'Access-Control-Allow-Origin': '*', 'Content-Type': 'application/json' };
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


