export const config = {
    runtime: 'edge',
};

// ============================================================================
// [ SAAS GATEWAY ] LEXIS ACCOUNT REGISTRY & ADMIN BRIDGE
// Handles Email Registration, Login, and Global Admin Controls
// ============================================================================

const UPSTASH_URL = "https://immortal-eagle-36171.upstash.io";
const UPSTASH_TOKEN = "AY1LAAIgcDE5MjFiMmNkNGQ4M2M0ODQ2YWNhYjU0YmFmMzlhNjliNw";

// Helper for obfuscating passwords before saving to DB
const hashPwd = (pwd) => btoa(pwd + "LEXIS_SECURE_SALT_99");

export default async function handler(req) {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    try {
        const body = await req.json();
        const { action, adminSecret } = body;

        // --------------------------------------------------------------------
        // ACTION 1: REGISTER NEW LEXIS ACCOUNT
        // --------------------------------------------------------------------
        if (action === 'register') {
            const { username, password, website, deviceId } = body;
            if (!username || !password) return new Response(JSON.stringify({ error: "Username and Password required." }), { status: 400 });
            
            // Auto-append domain if they just typed a name
            const email = username.includes('@') ? username.toLowerCase() : `${username.toLowerCase()}@lexis.ai`;

            // Check if account already exists
            const checkRes = await fetch(`${UPSTASH_URL}/get/account:${email}`, { headers: { "Authorization": `Bearer ${UPSTASH_TOKEN}` } });
            const checkData = await checkRes.json();
            if (checkData.result) return new Response(JSON.stringify({ error: "That @lexis.ai account already exists. Please login." }), { status: 409 });

            // Mint new API Key
            const newApiKey = `Lexis-${crypto.randomUUID().replace(/-/g, '')}`;

            // Define Account & Limits
            const keyConfig = {
                email: email,
                website: website || "Not Provided",
                device_id: deviceId || "Unknown",
                created_at: Date.now(),
                status: 'active', // 'active' or 'blocked'
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

            // Save everything atomically to Upstash
            const multiExec = [
                ["SET", `account:${email}`, JSON.stringify(accountConfig)],
                ["SET", `apikey:${newApiKey}`, JSON.stringify(keyConfig)],
                ["SADD", "admin:all_keys", newApiKey], // Global index for Admin tracking
                ["INCR", "stats:total_devices"]
            ];

            await fetch(`${UPSTASH_URL}/pipeline`, {
                method: 'POST',
                headers: { "Authorization": `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "application/json" },
                body: JSON.stringify(multiExec)
            });

            return new Response(JSON.stringify({ success: true, message: "Account created!", apiKey: newApiKey, config: keyConfig }), { status: 200 });
        }

        // --------------------------------------------------------------------
        // ACTION 2: LOGIN TO LEXIS ACCOUNT
        // --------------------------------------------------------------------
        if (action === 'login') {
            const { username, password } = body;
            const email = username.includes('@') ? username.toLowerCase() : `${username.toLowerCase()}@lexis.ai`;

            const accRes = await fetch(`${UPSTASH_URL}/get/account:${email}`, { headers: { "Authorization": `Bearer ${UPSTASH_TOKEN}` } });
            const accData = await accRes.json();
            
            if (!accData.result) return new Response(JSON.stringify({ error: "Account not found." }), { status: 404 });
            
            const acc = typeof accData.result === 'string' ? JSON.parse(accData.result) : accData.result;
            
            if (acc.password_hash !== hashPwd(password)) {
                return new Response(JSON.stringify({ error: "Invalid password." }), { status: 401 });
            }

            // Fetch current limits/status for this key
            const keyRes = await fetch(`${UPSTASH_URL}/get/apikey:${acc.api_key}`, { headers: { "Authorization": `Bearer ${UPSTASH_TOKEN}` } });
            const keyData = await keyRes.json();
            const keyConfig = typeof keyData.result === 'string' ? JSON.parse(keyData.result) : keyData.result;

            return new Response(JSON.stringify({ success: true, message: "Logged in!", apiKey: acc.api_key, config: keyConfig }), { status: 200 });
        }

        // --------------------------------------------------------------------
        // ACTION 3: ADMIN - FETCH FULL DASHBOARD DATA
        // --------------------------------------------------------------------
        if (action === 'admin_stats') {
            if (adminSecret !== "Lexis-Admin-2026!") return new Response(JSON.stringify({ error: "Unauthorized Admin" }), { status: 401 });

            // 1. Fetch Global Counters
            const statExec = [
                ["GET", "stats:total_requests"], ["GET", "stats:total_success"], ["GET", "stats:total_errors"], ["GET", "stats:total_devices"],
                ["GET", "stats:errors:missing_key"], ["GET", "stats:errors:invalid_key"], ["GET", "stats:errors:rate_limit_model"], ["GET", "stats:errors:rate_limit_feature"]
            ];
            const statsRes = await fetch(`${UPSTASH_URL}/pipeline`, { method: 'POST', headers: { "Authorization": `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(statExec) });
            const statsData = await statsRes.json();

            // 2. Fetch All Registered Users (Keys)
            const keysRes = await fetch(`${UPSTASH_URL}/SMEMBERS/admin:all_keys`, { headers: { "Authorization": `Bearer ${UPSTASH_TOKEN}` } });
            const keysData = await keysRes.json();
            const allKeys = keysData.result || [];

            // 3. Fetch Configs & End-User counts for every Key
            const userExec = [];
            allKeys.forEach(k => {
                userExec.push(["GET", `apikey:${k}`]);
                userExec.push(["SCARD", `dev_users:${k}`]); // Counts unique people visiting their app
            });

            let activeUsers = [];
            if (userExec.length > 0) {
                const userRes = await fetch(`${UPSTASH_URL}/pipeline`, { method: 'POST', headers: { "Authorization": `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(userExec) });
                const userData = await userRes.json();
                
                // Parse pipeline pairs
                for (let i = 0; i < allKeys.length; i++) {
                    const configRaw = userData[i*2].result;
                    const endUsersCount = userData[(i*2)+1].result;
                    if (configRaw) {
                        const cfg = typeof configRaw === 'string' ? JSON.parse(configRaw) : configRaw;
                        activeUsers.push({
                            apiKey: allKeys[i],
                            email: cfg.email,
                            website: cfg.website,
                            status: cfg.status,
                            limits: cfg.limits,
                            endUsersVisitingApp: parseInt(endUsersCount || "0", 10)
                        });
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
            }), { status: 200 });
        }

        // --------------------------------------------------------------------
        // ACTION 4: ADMIN - MODIFY USER LIMITS OR BLOCK THEM
        // --------------------------------------------------------------------
        if (action === 'admin_modify') {
            if (adminSecret !== "Lexis-Admin-2026!") return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
            
            const { targetKey, newStatus, newLimits } = body;
            if (!targetKey) return new Response(JSON.stringify({ error: "targetKey required" }), { status: 400 });

            // Fetch current config
            const keyRes = await fetch(`${UPSTASH_URL}/get/apikey:${targetKey}`, { headers: { "Authorization": `Bearer ${UPSTASH_TOKEN}` } });
            const keyData = await keyRes.json();
            if (!keyData.result) return new Response(JSON.stringify({ error: "Key not found" }), { status: 404 });
            
            const keyConfig = typeof keyData.result === 'string' ? JSON.parse(keyData.result) : keyData.result;
            
            // Apply Admin Overrides
            if (newStatus) keyConfig.status = newStatus; // 'active' or 'blocked'
            if (newLimits) keyConfig.limits = newLimits; // completely overwrite limits

            // Save back to Upstash
            await fetch(`${UPSTASH_URL}/SET/apikey:${targetKey}`, {
                method: 'POST', headers: { "Authorization": `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "application/json" },
                body: JSON.stringify(JSON.stringify(keyConfig)) // Double stringify to ensure safe storage
            });

            return new Response(JSON.stringify({ success: true, message: `Key ${targetKey} updated.`, newConfig: keyConfig }), { status: 200 });
        }

        return new Response(JSON.stringify({ error: "Invalid action" }), { status: 400 });

    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
}


