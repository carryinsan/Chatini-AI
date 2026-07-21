export const config = {
    runtime: 'edge',
};

export default async function handler(req) {
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    try {
        const { deviceId, taskPrompt, subscription } = await req.json();
        
        const UPSTASH_URL = "https://immortal-eagle-36171.upstash.io";
        const UPSTASH_TOKEN = "AY1LAAIgcDE5MjFiMmNkNGQ4M2M0ODQ2YWNhYjU0YmFmMzlhNjliNw";

        if (!deviceId || !taskPrompt || !subscription) {
            return new Response(JSON.stringify({ error: 'Missing parameters' }), { status: 400 });
        }

        const taskId = `task_${Math.random().toString(36).substr(2, 9)}`;
        const taskData = JSON.stringify({ deviceId, taskPrompt, subscription, ts: Date.now() });

        // Save the task to a global active set and store the detailed payload
        const pipeline = [
            ["HSET", `sentinel:${taskId}`, "data", taskData],
            ["SADD", "sentinels:active", taskId]
        ];

        await fetch(`${UPSTASH_URL}/pipeline`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(pipeline)
        });

        return new Response(JSON.stringify({ success: true, taskId }), { status: 200 });

    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
}

