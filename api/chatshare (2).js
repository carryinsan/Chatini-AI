export const config = {
    runtime: 'edge',
};

// ============================================================
// ArixAI Shared Chat API
// Primary: Supabase
// Fallback: Upstash Redis
// ============================================================

// Supabase
const SUPABASE_URL =
    process.env.SUPABASE_URL ||
    "https://vvcpdfdofihdmzshglxr.supabase.co";

const SUPABASE_KEY =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ2Y3BmZG9maWhkbXpzaGRnbHhyIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NTA2NzQ5MCwiZXhwIjoyMTAwNjQzNDkwfQ.ACRUkwnNiVg-6ZNqSlKYYev0csd_cT6tgiL0T0fPKLQ";

// Upstash Redis
const UPSTASH_URL = (
    process.env.UPSTASH_REDIS_REST_URL ||
    "https://immortal-eagle-36171.upstash.io"
).replace(/[\r\n\s]/g, "");

const UPSTASH_TOKEN = (
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    "AY1LAAIgcDE5MjFiMmNkNGQ4M2M0ODQ2YWNhYjU0YmFmMzlhNjliNw"
).replace(/[\r\n\s]/g, "");

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
        "Content-Type, Authorization, x-requested-with, x-chat-password",
};

const JSON_HEADERS = {
    "Content-Type": "application/json; charset=utf-8",
    ...CORS_HEADERS,
};

const SHARE_TTL = 2592000; // 30 days

// ============================================================
// Helpers
// ============================================================

function json(data, status = 200) {
    return new Response(JSON.stringify(data), {
        status,
        headers: JSON_HEADERS,
    });
}

async function redisCommand(commandArray) {
    try {
        const res = await fetch(UPSTASH_URL, {
            method: "POST",
            headers: {
                Authorization: `Bearer ${UPSTASH_TOKEN}`,
                "Content-Type": "application/json",
            },
            body: JSON.stringify(commandArray),
        });

        if (!res.ok) return null;

        const data = await res.json();
        return data?.result ?? null;
    } catch {
        return null;
    }
}

async function hashPassword(str) {
    if (!str) return null;

    try {
        const encoder = new TextEncoder();
        const data = encoder.encode(str);
        const hashBuffer = await crypto.subtle.digest("SHA-256", data);
        const hashArray = Array.from(new Uint8Array(hashBuffer));

        return hashArray
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
    } catch {
        return btoa(unescape(encodeURIComponent(str)))
            .split("")
            .reverse()
            .join("");
    }
}

function sanitizeChatPayload(chatData, hidePrompts = false) {
    if (!chatData || !Array.isArray(chatData.messages)) {
        return null;
    }

    let filteredMessages = chatData.messages;

    if (hidePrompts) {
        filteredMessages = chatData.messages.filter(
            (msg) => msg && msg.role === "assistant"
        );

        if (
            filteredMessages.length === 0 &&
            chatData.messages.length > 0
        ) {
            filteredMessages = [
                {
                    role: "assistant",
                    content:
                        "*[Original user prompts hidden by chat owner]*",
                },
            ];
        }
    }

    const cleanMessages = filteredMessages
        .filter(Boolean)
        .map((msg) => {
            let cleanContent =
                typeof msg.content === "string"
                    ? msg.content
                    : JSON.stringify(msg.content ?? "");

            // Prevent huge inline base64 images from destroying the payload.
            if (
                cleanContent.length > 50000 &&
                cleanContent.includes("data:image")
            ) {
                cleanContent = cleanContent.replace(
                    /data:image\/[a-zA-Z0-9.+-]+;base64,[^"'\s>]+/g,
                    "[Shared Visual Asset]"
                );
            }

            return {
                id: msg.id || null,
                role: msg.role || "assistant",
                content: cleanContent,
                modelId: msg.modelId || "oracle",
                attachmentsMeta: Array.isArray(msg.attachmentsMeta)
                    ? msg.attachmentsMeta
                    : [],
            };
        });

    return {
        id: chatData.id || null,
        title: chatData.title || "Shared Chat",
        messages: cleanMessages,
        extId: chatData.extId || null,
        date: chatData.date || Date.now(),
        hidePrompts: Boolean(hidePrompts),
    };
}

function parseStoredPayload(value) {
    if (!value) return null;

    try {
        const parsed =
            typeof value === "string" ? JSON.parse(value) : value;

        if (!parsed) return null;

        // New format:
        // { title, messages, _password_hash, ... }
        if (Array.isArray(parsed.messages)) {
            return parsed;
        }

        // Older/alternate Redis format:
        // { chat_data: {...}, password_hash: "..." }
        if (parsed.chat_data) {
            const nested =
                typeof parsed.chat_data === "string"
                    ? JSON.parse(parsed.chat_data)
                    : parsed.chat_data;

            if (nested && typeof nested === "object") {
                return {
                    ...nested,
                    _password_hash:
                        parsed.password_hash ||
                        parsed._password_hash ||
                        nested._password_hash ||
                        null,
                };
            }
        }

        return null;
    } catch {
        return null;
    }
}

// ============================================================
// Handler
// ============================================================

export default async function handler(req) {
    if (req.method === "OPTIONS") {
        return new Response(null, {
            status: 204,
            headers: CORS_HEADERS,
        });
    }

    // ========================================================
    // GET — Load shared chat
    // ========================================================
    if (req.method === "GET") {
        try {
            const url = new URL(req.url);
            const chatId = (url.searchParams.get("id") || "").trim();

            const providedPassword =
                req.headers.get("x-chat-password") ||
                url.searchParams.get("pwd");

            if (!chatId) {
                return json(
                    {
                        success: false,
                        error: "Missing chat ID",
                    },
                    400
                );
            }

            let rawChat = null;

            // ------------------------------------------------
            // 1. Supabase
            // ------------------------------------------------
            try {
                const supabaseId = encodeURIComponent(chatId);

                const supaRes = await fetch(
                    `${SUPABASE_URL}/rest/v1/shared_chats?id=eq.${supabaseId}&select=id,chat_data`,
                    {
                        method: "GET",
                        headers: {
                            apikey: SUPABASE_KEY,
                            Authorization: `Bearer ${SUPABASE_KEY}`,
                        },
                    }
                );

                if (supaRes.ok) {
                    const rows = await supaRes.json();

                    if (Array.isArray(rows) && rows.length > 0) {
                        const row = rows[0];

                        rawChat =
                            typeof row.chat_data === "string"
                                ? JSON.parse(row.chat_data)
                                : row.chat_data;
                    }
                }
            } catch {
                // Continue to Redis fallback.
            }

            // ------------------------------------------------
            // 2. Upstash fallback
            // ------------------------------------------------
            if (!rawChat) {
                const redisValue = await redisCommand([
                    "GET",
                    `shared_chat:${chatId}`,
                ]);

                if (redisValue) {
                    rawChat = parseStoredPayload(redisValue);
                }
            }

            if (!rawChat || !Array.isArray(rawChat.messages)) {
                return json(
                    {
                        success: false,
                        error: "Chat link expired or not found",
                    },
                    404
                );
            }

            const storedHash = rawChat._password_hash || null;

            // ------------------------------------------------
            // Password protection
            // ------------------------------------------------
            if (storedHash) {
                if (!providedPassword) {
                    return json(
                        {
                            success: false,
                            isPasswordProtected: true,
                            error:
                                "This chat is password protected.",
                        },
                        401
                    );
                }

                const clientHash = await hashPassword(
                    providedPassword.trim()
                );

                if (clientHash !== storedHash) {
                    return json(
                        {
                            success: false,
                            isPasswordProtected: true,
                            error:
                                "Incorrect password. Access denied.",
                        },
                        403
                    );
                }
            }

            // Never expose password hash to browser.
            const finalChat = { ...rawChat };
            delete finalChat._password_hash;

            return json({
                success: true,
                chat: finalChat,
                id: chatId,
            });
        } catch (err) {
            return json(
                {
                    success: false,
                    error: "Failed to load shared chat",
                    details: err?.message || "Unknown error",
                },
                500
            );
        }
    }

    // ========================================================
    // POST — Create shared chat
    // ========================================================
    if (req.method === "POST") {
        try {
            const body = await req.json();

            // IMPORTANT:
            // Accept BOTH the current frontend format:
            // { chat: {...} }
            //
            // and the newer format:
            // { chatData: {...}, hidePrompts, password }
            const incomingChat =
                body?.chatData ||
                body?.chat ||
                null;

            const hidePrompts = Boolean(body?.hidePrompts);
            const password =
                typeof body?.password === "string"
                    ? body.password.trim()
                    : "";

            if (
                !incomingChat ||
                !Array.isArray(incomingChat.messages) ||
                incomingChat.messages.length === 0
            ) {
                return json(
                    {
                        success: false,
                        error: "Empty chat cannot be shared",
                    },
                    400
                );
            }

            const cleanChat = sanitizeChatPayload(
                incomingChat,
                hidePrompts
            );

            if (!cleanChat || cleanChat.messages.length === 0) {
                return json(
                    {
                        success: false,
                        error: "Chat contains no shareable messages",
                    },
                    400
                );
            }

            const pwdHash = password
                ? await hashPassword(password)
                : null;

            const payloadToStore = {
                ...cleanChat,
                _password_hash: pwdHash,
            };

            // Collision-resistant share ID.
            const shareId =
                "chat_" +
                crypto.randomUUID().replace(/-/g, "");

            let supabaseSaved = false;
            let redisSaved = false;

            // ------------------------------------------------
            // Supabase primary store
            // ------------------------------------------------
            try {
                const supaRes = await fetch(
                    `${SUPABASE_URL}/rest/v1/shared_chats`,
                    {
                        method: "POST",
                        headers: {
                            apikey: SUPABASE_KEY,
                            Authorization: `Bearer ${SUPABASE_KEY}`,
                            "Content-Type": "application/json",
                            Prefer: "return=minimal",
                        },
                        body: JSON.stringify({
                            id: shareId,
                            chat_data: payloadToStore,
                        }),
                    }
                );

                supabaseSaved = supaRes.ok;

                if (!supaRes.ok) {
                    const errorText = await supaRes
                        .text()
                        .catch(() => "");

                    console.error(
                        "Supabase share save failed:",
                        supaRes.status,
                        errorText
                    );
                }
            } catch (err) {
                console.error(
                    "Supabase share save exception:",
                    err?.message
                );
            }

            // ------------------------------------------------
            // Upstash backup
            // Store regardless so Redis can actually function
            // as a real fallback if Supabase becomes unavailable.
            // ------------------------------------------------
            try {
                const redisResult = await redisCommand([
                    "SET",
                    `shared_chat:${shareId}`,
                    JSON.stringify(payloadToStore),
                    "EX",
                    String(SHARE_TTL),
                ]);

                redisSaved = redisResult === "OK";

                if (!redisSaved) {
                    console.error(
                        "Upstash share save failed:",
                        redisResult
                    );
                }
            } catch (err) {
                console.error(
                    "Upstash share save exception:",
                    err?.message
                );
            }

            if (!supabaseSaved && !redisSaved) {
                return json(
                    {
                        success: false,
                        error:
                            "Unable to save share record to database",
                    },
                    500
                );
            }

            // IMPORTANT:
            // Return BOTH "id" and "shareId".
            // Your current frontend expects "id".
            return json({
                success: true,
                id: shareId,
                shareId: shareId,
                expiresIn: SHARE_TTL,
                storage: {
                    supabase: supabaseSaved,
                    redis: redisSaved,
                },
            });
        } catch (err) {
            return json(
                {
                    success: false,
                    error:
                        err?.message ||
                        "Failed to create shared chat",
                },
                500
            );
        }
    }

    return json(
        {
            success: false,
            error: "Method not allowed",
        },
        405
    );
}
