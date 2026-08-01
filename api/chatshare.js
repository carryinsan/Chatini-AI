export const config = {
    runtime: 'edge',
};

// Supabase Credentials (Using your provided keys)
const SUPABASE_URL = process.env.SUPABASE_URL || "https://vvcpdfdofihdmzshglxr.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ2Y3BmZG9maWhkbXpzaGRnbHhyIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NTA2NzQ5MCwiZXhwIjoyMTAwNjQzNDkwfQ.ACRUkwnNiVg-6ZNqSlKYYev0csd_cT6tgiL0T0fPKLQ";

export default async function handler(req) {
    // ========================================================================
    // GET: Retrieve a Shared Chat (For the person opening the link)
    // ========================================================================
    if (req.method === 'GET') {
        try {
            const url = new URL(req.url);
            const chatId = url.searchParams.get('id');

            if (!chatId) return new Response(JSON.stringify({ success: false, error: "No chat ID provided" }), { status: 400 });

            const res = await fetch(`${SUPABASE_URL}/rest/v1/shared_chats?id=eq.${chatId}`, {
                method: 'GET',
                headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
            });

            if (!res.ok) throw new Error("Failed to fetch from Supabase");
            const data = await res.json();

            if (!data || data.length === 0) {
                return new Response(JSON.stringify({ success: false, error: "Chat not found or expired" }), { status: 404 });
            }

            return new Response(JSON.stringify({ success: true, chat: data[0].chat_data }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });

        } catch (err) {
            return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 });
        }
    }

    // ========================================================================
    // POST: Upload & Share a Chat (For the original creator)
    // ========================================================================
    if (req.method === 'POST') {
        try {
            const body = await req.json();
            const { chatData } = body;

            if (!chatData || !chatData.messages || chatData.messages.length === 0) {
                return new Response(JSON.stringify({ success: false, error: "Cannot share an empty chat" }), { status: 400 });
            }

            // Generate a unique, unguessable share ID
            const shareId = 'chat_' + Math.random().toString(36).substring(2, 10) + Date.now().toString(36);

            const res = await fetch(`${SUPABASE_URL}/rest/v1/shared_chats`, {
                method: 'POST',
                headers: { 
                    'apikey': SUPABASE_KEY, 
                    'Authorization': `Bearer ${SUPABASE_KEY}`, 
                    'Content-Type': 'application/json',
                    'Prefer': 'return=representation'
                },
                body: JSON.stringify({
                    id: shareId,
                    chat_data: chatData
                })
            });

            if (!res.ok) throw new Error("Failed to save to Supabase");

            return new Response(JSON.stringify({ success: true, shareId: shareId }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            });

        } catch (err) {
            return new Response(JSON.stringify({ success: false, error: err.message }), { status: 500 });
        }
    }

    return new Response('Method not allowed', { status: 405 });
}
