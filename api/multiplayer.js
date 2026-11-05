export const config = {
    runtime: 'edge',
};

export default async function handler(req) {
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    try {
        const { roomId, action, message, nickname } = await req.json();
        
        const UPSTASH_URL = "https://immortal-eagle-36171.upstash.io";
        const UPSTASH_TOKEN = "AY1LAAIgcDE5MjFiMmNkNGQ4M2M0ODQ2YWNhYjU0YmFmMzlhNjliNw";

        if (!roomId || !action) return new Response(JSON.stringify({ error: 'Missing parameters' }), { status: 400 });

        // Database Keys
        const roomKey = `room:${roomId}`;
        
        // EX 43200 = 12 Hours in seconds. Automatically deletes the room if inactive.
        const TTL_SECONDS = 43200; 

        if (action === 'send') {
            const payload = JSON.stringify({ nickname: nickname || "Anonymous", message, ts: Date.now() });
            
            // Pipeline: Push message, Trim to last 100 to save space, Reset 12-hour death timer
            const pipeline = [
                ["RPUSH", roomKey, payload],
                ["LTRIM", roomKey, -100, -1],
                ["EXPIRE", roomKey, TTL_SECONDS]
            ];

            await fetch(`${UPSTASH_URL}/pipeline`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(pipeline)
            });

            return new Response(JSON.stringify({ success: true }), { status: 200 });
        }

        if (action === 'poll') {
            // Fetch messages and reset 12-hour death timer because someone is actively looking at it
            const pipeline = [
                ["LRANGE", roomKey, 0, -1],
                ["EXPIRE", roomKey, TTL_SECONDS]
            ];

            const res = await fetch(`${UPSTASH_URL}/pipeline`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
                body: JSON.stringify(pipeline)
            });

            const data = await res.json();
            const messages = (data[0].result || []).map(m => JSON.parse(m));
            
            return new Response(JSON.stringify({ success: true, messages }), { status: 200 });
        }

        return new Response(JSON.stringify({ error: 'Invalid Action' }), { status: 400 });

    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
}

