export const config = {
    runtime: 'edge',
};

// Upstash Redis Credentials
const DEFAULT_UPSTASH_URL = "https://immortal-eagle-36171.upstash.io";
const DEFAULT_UPSTASH_TOKEN = "AY1LAAIgcDE5MjFiMmNkNGQ4M2M0ODQ2YWNhYjU0YmFmMzlhNjliNw";

function getRedisCredentials() {
    const url = (process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL || DEFAULT_UPSTASH_URL).replace(/[\r\n\s]/g, '');
    const token = (process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN || DEFAULT_UPSTASH_TOKEN).replace(/[\r\n\s]/g, '');
    return { url, token };
}

async function redisCommand(commandArray) {
    const { url, token } = getRedisCredentials();
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(commandArray)
    });
    if (!res.ok) throw new Error(`Redis Error: ${res.status}`);
    const data = await res.json();
    return data.result;
}

export default async function handler(req) {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    try {
        const body = await req.json();
        const { action, password, userId, message, overrideType, expirationHours } = body;
        const ADMIN_PASS = "Lexis-Admin-2026!";

        // ========================================================================
        // PUBLIC ACTION: User requests more limits directly from App Modal
        // ========================================================================
        if (action === 'request_limit') {
            if (!userId) throw new Error("Missing user identification");
            const requestPayload = {
                id: 'req_' + Math.random().toString(36).substring(2, 9),
                userId: userId,
                message: message || "Standard limit increase request",
                timestamp: Date.now(),
                status: 'pending'
            };
            // Push to Upstash Redis list
            await redisCommand(["LPUSH", "lexis:subscription_requests", JSON.stringify(requestPayload)]);
            return new Response(JSON.stringify({ success: true, message: "Request sent to admin queue." }), { status: 200 });
        }

        // ========================================================================
        // ADMIN ACTIONS: Require Master Password
        // ========================================================================
        if (password !== ADMIN_PASS) {
            return new Response(JSON.stringify({ success: false, error: "Unauthorized. Invalid Admin Password." }), { status: 401 });
        }

        // 1. Fetch Pending Requests
        if (action === 'get_requests') {
            const rawData = await redisCommand(["LRANGE", "lexis:subscription_requests", "0", "-1"]);
            const requests = rawData ? rawData.map(r => JSON.parse(r)) : [];
            
            // Fetch all current active overrides to display in dashboard
            const overridesRaw = await redisCommand(["HGETALL", "lexis:quota_overrides"]);
            let activeOverrides = {};
            if (overridesRaw && overridesRaw.length > 0) {
                for (let i = 0; i < overridesRaw.length; i += 2) {
                    activeOverrides[overridesRaw[i]] = JSON.parse(overridesRaw[i+1]);
                }
            }

            return new Response(JSON.stringify({ success: true, requests, activeOverrides }), { status: 200 });
        }

        // 2. Set User Override (Block, Increase, Decrease)
        if (action === 'set_override') {
            if (!userId || !overrideType) throw new Error("Missing userId or overrideType");
            
            if (overrideType === 'reset') {
                // Remove override, back to normal free tier
                await redisCommand(["HDEL", "lexis:quota_overrides", userId]);
                return new Response(JSON.stringify({ success: true, message: "User reset to default limits." }), { status: 200 });
            }

            const overridePayload = {
                type: overrideType, // 'blocked', 'premium_2x', 'premium_10x', 'unlimited'
                timestamp: Date.now(),
                expiresAt: expirationHours ? Date.now() + (expirationHours * 3600000) : null // null = permanent
            };

            await redisCommand(["HSET", "lexis:quota_overrides", userId, JSON.stringify(overridePayload)]);
            return new Response(JSON.stringify({ success: true, message: `User ${userId} set to ${overrideType}.` }), { status: 200 });
        }

        // 3. Dismiss/Delete Request
        if (action === 'delete_request') {
            if (!message) throw new Error("Missing exact request string to delete");
            // Delete exact JSON string match from list
            await redisCommand(["LREM", "lexis:subscription_requests", "0", message]);
            return new Response(JSON.stringify({ success: true }), { status: 200 });
        }

        return new Response(JSON.stringify({ success: false, error: "Invalid Action" }), { status: 400 });

    } catch (err) {
        return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 });
    }
                                            }
