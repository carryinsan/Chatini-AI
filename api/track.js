export const config = {
    runtime: 'edge',
};

export default async function handler(req) {
    // Silently accept POST requests. Drop anything else.
    if (req.method !== 'POST') return new Response('OK', { status: 200 });

    try {
        const payload = await req.json();
        const { deviceId, nickname, deviceInfo, action, model, status, errorDetails } = payload;
        
        const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
        const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
        
        // If the database isn't hooked up yet, fail silently so the user UI never crashes
        if (!UPSTASH_URL || !UPSTASH_TOKEN) return new Response('No DB', { status: 200 });

        // Extract high-level, non-PII location data safely provided by Vercel's edge network
        const country = req.headers.get('x-vercel-ip-country') || 'Unknown';
        const city = req.headers.get('x-vercel-ip-city') || 'Unknown';
        const timestamp = Date.now();
        const dateStr = new Date().toISOString();

        // Build a massive, high-speed Pipeline to write all data in a single network request
        const commands = [
            // Global Application Counters
            ["INCR", "stats:total_events"],
            ["INCR", `stats:action_${action || 'unknown'}`],
            ["INCR", status === 'error' ? "stats:total_errors" : "stats:total_success"],
        ];

        if (model) commands.push(["INCR", `stats:model_${model}`]);

        // Device/User Registry 
        commands.push(
            // Set first_seen only if it doesn't already exist
            ["HSETNX", `user:${deviceId}`, "first_seen", dateStr],
            // Overwrite latest data
            ["HSET", `user:${deviceId}`, "last_seen", dateStr, "nickname", nickname || "Anonymous", "device", deviceInfo || "Unknown", "location", `${city}, ${country}`],
            // Update "Active Users" leaderboard
            ["ZADD", "users:active", timestamp, deviceId]
        );

        // Global Event Timeline (Keep latest 200 events to prevent DB bloating)
        const logEntry = JSON.stringify({ ts: dateStr, deviceId, nickname, action, model, status, errorDetails: errorDetails || '' });
        commands.push(
            ["LPUSH", "global:timeline", logEntry],
            ["LTRIM", "global:timeline", 0, 199] 
        );

        // Fire the pipeline directly to Upstash via REST
        await fetch(`${UPSTASH_URL}/pipeline`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(commands)
        });

        return new Response(JSON.stringify({ success: true }), { status: 200 });

    } catch (error) {
        // Zero-interference architecture: If tracking fails, the user never knows.
        return new Response(JSON.stringify({ success: false }), { status: 200 });
    }
}

