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
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-requested-with, x-chat-password',
};

// Helper: Upstash Redis Runner
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

// Helper: SHA-256 Cryptographic Hash for Fail-Safe Password Security
async function hashPassword(str) {
    if (!str) return null;
    const encoder = new TextEncoder();
    const data = encoder.encode(str);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Helper: Payload Sanitizer with Prompt Hiding & Base64 Cleanup
function sanitizeChatPayload(chatData, hidePrompts = false) {
    if (!chatData || !Array.isArray(chatData.messages)) return chatData;

    let filteredMessages = chatData.messages;

    // Option 1: Hide User Prompts (Only keep Assistant responses)
    if (hidePrompts) {
        filteredMessages = chatData.messages.filter(msg => msg.role === 'assistant');
    }

    const cleanMessages = filteredMessages.map(msg => {
        let cleanContent = msg.content || "";
        // Replace huge inline base64 images with lightweight placeholder to prevent payload crashes
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
        messages: cleanMessages,
        hidePrompts: hidePrompts
    };
}

export default async function handler(req) {
    // --------------------------------------------------------------------
    // 0. CORS PREFLIGHT HANDLER
    // --------------------------------------------------------------------
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // --------------------------------------------------------------------
    // 1. GET: Retrieve a Shared Chat (Supports Password Challenge)
    // --------------------------------------------------------------------
    if (req.method === 'GET') {
        try {
            const url = new URL(req.url);
            const chatId = url.searchParams.get('id');
            const providedPassword = req.headers.get('x-chat-password') || url.searchParams.get('pwd');

            if (!chatId) {
                return new Response(JSON.stringify({ success: false, error: "Missing chat ID" }), {
                    status: 400,
                    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
                });
            }

            let chatRecord = null;

            // Attempt 1: Fetch from Supabase
            try {
                const supaRes = await fetch(`${SUPABASE_URL}/rest/v1/shared_chats?id=eq.${chatId}`, {
                    method: 'GET',
                    headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
                });
                if (supaRes.ok) {
                    const rows = await supaRes.json();
                    if (rows && rows.length > 0) chatRecord = rows[0];
                }
            } catch (e) {}

            // Attempt 2: Fallback to Upstash Redis
            if (!chatRecord) {
                const rawRedis = await redisCommand(["GET", `shared_chat:${chatId}`]);
                if (rawRedis) {
                    try {
                        const parsedRedis = typeof rawRedis === 'string' ? JSON.parse(rawRedis) : rawRedis;
                        chatRecord = {
                            chat_data: parsedRedis.chat_data || parsedRedis,
                            password_hash: parsedRedis.password_hash || null
                        };
                    } catch (e) {}
                }
            }

            if (!chatRecord || !chatRecord.chat_data) {
                return new Response(JSON.stringify({ success: false, error: "Chat link expired or not found" }), {
                    status: 404,
                    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
                });
            }

            const storedHash = chatRecord.password_hash || (chatRecord.chat_data && chatRecord.chat_data._pwdHash);

            // Password Protection Check
            if (storedHash) {
                if (!providedPassword) {
                    return new Response(JSON.stringify({ 
                        success: false, 
                        isPasswordProtected: true, 
                        error: "This chat is password protected." 
                    }), {
                        status: 401,
                        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
                    });
                }

                const clientHash = await hashPassword(providedPassword.trim());
                if (clientHash !== storedHash) {
                    return new Response(JSON.stringify({ 
                        success: false, 
                        isPasswordProtected: true, 
                        error: "Incorrect password. Access denied." 
                    }), {
                        status: 403,
                        headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
                    });
                }
            }

            // Remove password metadata from output payload
            const finalChatData = { ...chatRecord.chat_data };
            delete finalChatData._pwdHash;

            return new Response(JSON.stringify({ success: true, chat: finalChatData }), {
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
    // 2. POST: Create & Store Shared Chat with Options
    // --------------------------------------------------------------------
    if (req.method === 'POST') {
        try {
            const body = await req.json();
            const { chatData, hidePrompts, password } = body;

            if (!chatData || !chatData.messages || chatData.messages.length === 0) {
                return new Response(JSON.stringify({ success: false, error: "Empty chat cannot be shared" }), {
                    status: 400,
                    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
                });
            }

            const cleanChat = sanitizeChatPayload(chatData, Boolean(hidePrompts));
            const pwdHash = password ? await hashPassword(password.trim()) : null;

            if (pwdHash) {
                cleanChat._pwdHash = pwdHash; // Backup inline hash
            }

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
                        chat_data: cleanChat,
                        password_hash: pwdHash
                    })
                });

                if (supaRes.ok || supaRes.status === 201) {
                    savedSuccessfully = true;
                }
            } catch (e) {}

            // Step B: Store in Upstash Redis (backup failover)
            const redisPayload = {
                chat_data: cleanChat,
                password_hash: pwdHash
            };
            const redisRes = await redisCommand(["SET", `shared_chat:${shareId}`, JSON.stringify(redisPayload), "EX", "2592000"]); // 30-day retention
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
