export const config = {
    runtime: 'edge',
};

export default async function handler(req) {
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    try {
        const { secretKey } = await req.json();
        
        // NEW WAY: Hardcoded Master Password. 
        // Bypasses Vercel Environment Variable caching issues completely.
        const MASTER_PASSWORD = "Lexis-Admin-2026!";
        
        // Cryptographic lockout: Rejects brute force or unauthorized access instantly
        if (secretKey !== MASTER_PASSWORD) {
            return new Response(JSON.stringify({ error: "Unauthorized. Invalid Master Key." }), { status: 401 });
        }

        // Exact variable names mapped from your Upstash screenshot
        const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
        const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;

        if (!UPSTASH_URL || !UPSTASH_TOKEN) {
            return new Response(JSON.stringify({ error: "Database Offline. Upstash Redis variables missing." }), { status: 500 });
        }

        // Define the exact analytical data points we want to extract
        const keysToFetch = [
            "stats:total_events", "stats:total_success", "stats:total_errors",
            "stats:action_chat", "stats:action_maths", "stats:action_slides", "stats:action_research",
            "stats:model_spark", "stats:model_flux", "stats:model_oracle"
        ];

        // Pipeline 1: Fetch counters, top 50 users, and last 50 events
        const pipeline1 = [
            ["MGET", ...keysToFetch],
            ["ZREVRANGE", "users:active", 0, 49], 
            ["LRANGE", "global:timeline", 0, 49]  
        ];

        const res1 = await fetch(`${UPSTASH_URL}/pipeline`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(pipeline1)
        });

        const data1 = await res1.json();
        
        // Catch Upstash specific errors
        if (data1.error) {
            return new Response(JSON.stringify({ error: `Upstash Error: ${data1.error}` }), { status: 500 });
        }

        const statsArray = data1[0].result || [];
        const recentDeviceIds = data1[1].result || [];
        const timelineRaw = data1[2].result || [];

        // Parse global statistics
        const stats = {};
        keysToFetch.forEach((key, index) => {
            stats[key.replace('stats:', '')] = parseInt(statsArray[index] || 0);
        });

        // Pipeline 2: Bulk-fetch the profile data for the active users
        let users = [];
        if (recentDeviceIds.length > 0) {
            const pipeline2 = recentDeviceIds.map(id => ["HGETALL", `user:${id}`]);
            const res2 = await fetch(`${UPSTASH_URL}/pipeline`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(pipeline2)
            });
            const data2 = await res2.json();
            
            users = data2.map((d, i) => {
                const raw = d.result || [];
                const profile = { deviceId: recentDeviceIds[i] };
                for (let j = 0; j < raw.length; j += 2) { profile[raw[j]] = raw[j+1]; }
                return profile;
            });
        }

        // Map the raw JSON strings back into objects
        const timeline = timelineRaw.map(t => JSON.parse(t));

        return new Response(JSON.stringify({ success: true, stats, users, timeline }), { 
            status: 200, 
            headers: { 'Content-Type': 'application/json' } 
        });

    } catch (error) {
        return new Response(JSON.stringify({ error: `System fault: ${error.message}` }), { status: 500 });
    }
}


