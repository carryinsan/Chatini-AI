export const config = {
    runtime: 'edge',
};

// Supabase Credentials
const SUPABASE_URL = process.env.SUPABASE_URL || "https://vvcpdfdofihdmzshglxr.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ2Y3BmZG9maWhkbXpzaGRnbHhyIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NTA2NzQ5MCwiZXhwIjoyMTAwNjQzNDkwfQ.ACRUkwnNiVg-6ZNqSlKYYev0csd_cT6tgiL0T0fPKLQ";

// Upstash Redis Fallback Credentials
const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || "https://immortal-eagle-36171.upstash.io").replace(/[\r\n\s]/g, '');
const UPSTASH_TOKEN = (process.env.UPSTASH_REDIS_REST_TOKEN || "AY1LAAIgcDE5MjFiMmNkNGQ4M2M0ODQ2YWNhYjU0YmFmMzlhNjliNw").replace(/[\r\n\s]/g, '');

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-requested-with',
};

// Helper: Upstash Redis Backup Runner
async function redisCommand(commandArray) {
    try {
        const res = await fetch(UPSTASH_URL, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
            body: JSON.stringify(commandArray)
        });
        if (!res.ok) return null;
        const data = await res.json();
        return data.result;
    } catch (e) {
        return null;
    }
}

// Helper: Strips massive Base64 strings to prevent database payload limits
function sanitizeChatPayload(chatData) {
    if (!chatData || !Array.isArray(chatData.messages)) return chatData;
    
    const cleanMessages = chatData.messages.map(msg => {
        let cleanContent = msg.content || "";
        // Replace huge inline base64 images/data URLs with a lightweight placeholder
        if (cleanContent.length > 50000 && cleanContent.includes('data:image')) {
            cleanContent = cleanContent.replace(/data:image\/[a-zA-Z]+;base64,[^"'\s>]+/g, '[Shared Visual Asset]');
        }
        
        return {
            role: msg.role,
            content: cleanContent,
            modelId: msg.modelId || 'oracle',
            attachmentsMeta: msg.attachmentsMeta || []
        };
    });

    return {
        title: chatData.title || "Shared Chat",
        messages: cleanMessages
    };
}

export default async function handler(req) {
    // --------------------------------------------------------------------
    // 0. CORS PREFLIGHT HANDLER (Fixes the "App not trying" bug)
    // --------------------------------------------------------------------
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // --------------------------------------------------------------------
    // 1. GET: Retrieve a Shared Chat
    // --------------------------------------------------------------------
    if (req.method === 'GET') {
        try {
            const url = new URL(req.url);
            const chatId = url.searchParams.get('id');

            if (!chatId) {
                return new Response(JSON.stringify({ success: false, error: "Missing chat ID" }), {
                    status: 400,
                    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
                });
            }

            let chatData = null;

            // Attempt 1: Fetch from Supabase
            try {
                const supaRes = await fetch(`${SUPABASE_URL}/rest/v1/shared_chats?id=eq.${chatId}`, {
                    method: 'GET',
                    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
                });
                if (supaRes.ok) {
                    const rows = await supaRes.json();
                    if (rows && rows.length > 0) chatData = rows[0].chat_data;
                }
            } catch (e) {}

            // Attempt 2: Fallback to Upstash Redis if Supabase didn't have it
            if (!chatData) {
                const rawRedis = await redisCommand(["GET", `shared_chat:${chatId}`]);
                if (rawRedis) {
                    try {
                        chatData = typeof rawRedis === 'string' ? JSON.parse(rawRedis) : rawRedis;
                    } catch (e) {}
                }
            }

            if (!chatData) {
                return new Response(JSON.stringify({ success: false, error: "Chat link expired or not found" }), {
                    status: 404,
                    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
                });
            }

            return new Response(JSON.stringify({ success: true, chat: chatData }), {
                status: 200,
                headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
            });

        } catch (err) {
            return new Response(JSON.stringify({ success: false, error: err.message }), {
                status: 500,
                headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
            });
        }
    }

    // --------------------------------------------------------------------
    // 2. POST: Create & Store Shared Chat
    // --------------------------------------------------------------------
    if (req.method === 'POST') {
        try {
            const body = await req.json();
            const { chatData } = body;

            if (!chatData || !chatData.messages || chatData.messages.length === 0) {
                return new Response(JSON.stringify({ success: false, error: "Empty chat cannot be shared" }), {
                    status: 400,
                    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
                });
            }

            const cleanChat = sanitizeChatPayload(chatData);
            const shareId = 'chat_' + Math.random().toString(36).substring(2, 9) + Date.now().toString(36);
            let savedSuccessfully = false;

            // Step A: Store in Supabase
            try {
                const supaRes = await fetch(`${SUPABASE_URL}/rest/v1/shared_chats`, {
                    method: 'POST',
                    headers: {
                        'apikey': SUPABASE_KEY,
                        'Authorization': `Bearer ${SUPABASE_KEY}`,
                        'Content-Type': 'application/json',
                        'Prefer': 'return=minimal'
                    },
                    body: JSON.stringify({
                        id: shareId,
                        chat_data: cleanChat
                    })
                });

                if (supaRes.ok || supaRes.status === 201) {
                    savedSuccessfully = true;
                }
            } catch (e) {}

            // Step B: Store in Upstash Redis (as backup / primary failover)
            const redisRes = await redisCommand(["SET", `shared_chat:${shareId}`, JSON.stringify(cleanChat), "EX", "2592000"]); // Auto-expire after 30 days
            if (redisRes) {
                savedSuccessfully = true;
            }

            if (!savedSuccessfully) {
                throw new Error("Unable to persist share record to database.");
            }

            return new Response(JSON.stringify({ success: true, shareId: shareId }), {
                status: 200,
                headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
            });

        } catch (err) {
            return new Response(JSON.stringify({ success: false, error: err.message }), {
                status: 500,
                headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
            });
        }
    }

    return new Response(JSON.stringify({ success: false, error: "Method not allowed" }), {
        status: 405,
        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
    });
}
