export const config = {
    runtime: 'edge',
};

export default async function handler(req) {
    // Hardcoded Upstash Credentials for absolute reliability
    const RAW_URL = "https://immortal-eagle-36171.upstash.io";
    const RAW_TOKEN = "AY1LAAIgcDE5MjFiMmNkNGQ4M2M0ODQ2YWNhYjU0YmFmMzlhNjliNw";

    const UPSTASH_URL = RAW_URL.trim().replace(/\/$/, '');
    const UPSTASH_TOKEN = RAW_TOKEN.trim();

    // GET METHOD: Fetch a shared artifact
    if (req.method === 'GET') {
        const url = new URL(req.url);
        const id = url.searchParams.get('id');
        
        if (!id) return new Response(JSON.stringify({ error: 'No ID provided' }), { status: 400 });

        try {
            const res = await fetch(`${UPSTASH_URL}/get/shared:${id}`, {
                headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}` }
            });
            const data = await res.json();
            
            if (data.result) {
                return new Response(JSON.stringify({ success: true, artifact: data.result }), { status: 200, headers: { 'Content-Type': 'application/json' } });
            } else {
                return new Response(JSON.stringify({ error: 'Artifact not found' }), { status: 404 });
            }
        } catch (e) {
            return new Response(JSON.stringify({ error: 'Database error' }), { status: 500 });
        }
    }

    // POST METHOD: Save a new shared artifact
    if (req.method === 'POST') {
        try {
            const { id, artifactData } = await req.json();
            
            if (!id || !artifactData) return new Response(JSON.stringify({ error: 'Missing payload' }), { status: 400 });

            // Store in Upstash, set to expire in 30 days (2592000 seconds) to save database space
            const res = await fetch(`${UPSTASH_URL}/set/shared:${id}?ex=2592000`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(artifactData)
            });

            const data = await res.json();
            return new Response(JSON.stringify({ success: data.result === 'OK' }), { status: 200 });
        } catch (e) {
            return new Response(JSON.stringify({ error: 'Database error' }), { status: 500 });
        }
    }

    return new Response('Method Not Allowed', { status: 405 });
}

