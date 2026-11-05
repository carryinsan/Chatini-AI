export const config = {
    runtime: 'edge',
};

export default async function handler(req) {
    if (req.method !== 'POST') return new Response('OK', { status: 200 });

    try {
        const payload = await req.json();
        const { deviceId, nickname, deviceInfo, action, model, status, errorDetails } = payload;
        
        // ============================================================================
        // NEW UPSTASH CREDENTIALS (INJECTED)
        // ============================================================================
        const RAW_URL = "https://immortal-eagle-36171.upstash.io";
        const RAW_TOKEN = "AY1LAAIgcDE5MjFiMmNkNGQ4M2M0ODQ2YWNhYjU0YmFmMzlhNjliNw";

        const UPSTASH_URL = RAW_URL.trim().replace(/\/$/, '');
        const UPSTASH_TOKEN = RAW_TOKEN.trim();

        if (!UPSTASH_URL.startsWith('https://')) return new Response('Bad URL', { status: 200 });

        const country = req.headers.get('x-vercel-ip-country') || 'Unknown';
        const city = req.headers.get('x-vercel-ip-city') || 'Unknown';
        const timestamp = Date.now();
        const dateStr = new Date().toISOString();

        const commands = [
            ["INCR", "stats:total_events"],
            ["INCR", `stats:action_${action || 'unknown'}`],
            ["INCR", status === 'error' ? "stats:total_errors" : "stats:total_success"],
        ];

        if (model) commands.push(["INCR", `stats:model_${model}`]);

        commands.push(
            ["HSETNX", `user:${deviceId}`, "first_seen", dateStr],
            ["HSET", `user:${deviceId}`, "last_seen", dateStr, "nickname", nickname || "Anonymous", "device", deviceInfo || "Unknown", "location", `${city}, ${country}`],
            ["ZADD", "users:active", timestamp, deviceId]
        );

        const logEntry = JSON.stringify({ ts: dateStr, deviceId, nickname, action, model, status, errorDetails: errorDetails || '' });
        commands.push(
            ["LPUSH", "global:timeline", logEntry],
            ["LTRIM", "global:timeline", 0, 199] 
        );

        await fetch(`${UPSTASH_URL}/pipeline`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(commands)
        });

        return new Response(JSON.stringify({ success: true }), { status: 200 });

    } catch (error) {
        return new Response(JSON.stringify({ success: false }), { status: 200 });
    }
}


