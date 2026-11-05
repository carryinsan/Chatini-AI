export const config = {
    runtime: 'edge',
};

export default async function handler(req) {
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    try {
        const { secretKey } = await req.json();
        
        // Hardcoded Master Password
        const MASTER_PASSWORD = "Lexis-Admin-2026!";
        
        if (secretKey !== MASTER_PASSWORD) {
            return new Response(JSON.stringify({ error: "Unauthorized. Invalid Master Key." }), { status: 401 });
        }

        // ============================================================================
        // NEW UPSTASH CREDENTIALS (INJECTED)
        // Auto-Sanitizing mathematically destroys invisible spaces/newlines
        // ============================================================================
        const RAW_URL = "https://immortal-eagle-36171.upstash.io";
        const RAW_TOKEN = "AY1LAAIgcDE5MjFiMmNkNGQ4M2M0ODQ2YWNhYjU0YmFmMzlhNjliNw";

        const UPSTASH_URL = RAW_URL.trim().replace(/\/$/, '');
        const UPSTASH_TOKEN = RAW_TOKEN.trim();

        if (!UPSTASH_URL.startsWith('https://')) {
            return new Response(JSON.stringify({ error: "Critical Error: Upstash URL must start with https://" }), { status: 500 });
        }

        const keysToFetch = [
            "stats:total_events", "stats:total_success", "stats:total_errors",
            "stats:action_chat", "stats:action_maths", "stats:action_slides", "stats:action_research",
            "stats:model_spark", "stats:model_flux", "stats:model_oracle"
        ];

        const pipeline1 = [
            ["MGET", ...keysToFetch],
            ["ZREVRANGE", "users:active", 0, 49], 
            ["LRANGE", "global:timeline", 0, 49]  
        ];

        // DIAGNOSTIC FETCH
        let res1;
        try {
            res1 = await fetch(`${UPSTASH_URL}/pipeline`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(pipeline1)
            });
        } catch (fetchErr) {
            return new Response(JSON.stringify({ error: `Upstash Network Failed: ${fetchErr.message}. The URL may be incorrect.` }), { status: 500 });
        }

        let data1;
        try {
            data1 = await res1.json();
        } catch (parseErr) {
            const rawText = await res1.text();
            return new Response(JSON.stringify({ error: `Upstash returned invalid data (Status ${res1.status}). Expected JSON. Raw: ${rawText.substring(0, 100)}` }), { status: 500 });
        }
        
        if (data1.error) {
            return new Response(JSON.stringify({ error: `Upstash Access Denied: ${data1.error}. Your Token is incorrect or expired.` }), { status: 500 });
        }

        const statsArray = data1[0].result || [];
        const recentDeviceIds = data1[1].result || [];
        const timelineRaw = data1[2].result || [];

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

        const timeline = timelineRaw.map(t => {
            try { return JSON.parse(t); } 
            catch(e) { return { ts: new Date().toISOString(), action: 'unknown', nickname: 'System', model: 'N/A' }; }
        });

        return new Response(JSON.stringify({ success: true, stats, users, timeline }), { 
            status: 200, 
            headers: { 'Content-Type': 'application/json' } 
        });

    } catch (error) {
        return new Response(JSON.stringify({ error: `Core System Fault: ${error.message}` }), { status: 500 });
    }
}


