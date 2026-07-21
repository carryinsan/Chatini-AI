export const config = {
    runtime: 'edge',
};

export default async function handler(req) {
    if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405 });

    try {
        const payload = await req.json();
        const { deviceId, action, token, query, fileId } = payload;
        
        // Hardcoded Upstash Credentials
        const UPSTASH_URL = "https://immortal-eagle-36171.upstash.io";
        const UPSTASH_TOKEN = "AY1LAAIgcDE5MjFiMmNkNGQ4M2M0ODQ2YWNhYjU0YmFmMzlhNjliNw";

        if (!deviceId || !action) return new Response(JSON.stringify({ error: 'Missing parameters' }), { status: 400 });

        // ACTION 1: Save OAuth Token
        if (action === 'save_token') {
            await fetch(`${UPSTASH_URL}/set/drive_token:${deviceId}`, {
                method: 'POST',
                headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}` },
                body: JSON.stringify(token)
            });
            return new Response(JSON.stringify({ success: true }), { status: 200 });
        }

        // Fetch User's Token from DB
        const tokenRes = await fetch(`${UPSTASH_URL}/get/drive_token:${deviceId}`, {
            headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}` }
        });
        const tokenData = await tokenRes.json();
        const accessToken = tokenData.result;

        if (!accessToken) return new Response(JSON.stringify({ error: 'Not authenticated with Google Drive' }), { status: 401 });

        // ACTION 2: Native File Search (Costs 0 AI Tokens)
        if (action === 'search') {
            const driveUrl = `https://www.googleapis.com/drive/v3/files?q=name contains '${query}' and trashed = false&fields=files(id,name,mimeType)&pageSize=10`;
            const searchRes = await fetch(driveUrl, {
                headers: { 'Authorization': `Bearer ${accessToken}` }
            });
            const searchData = await searchRes.json();
            
            if (searchData.error) return new Response(JSON.stringify({ error: searchData.error.message }), { status: 500 });
            return new Response(JSON.stringify({ success: true, files: searchData.files }), { status: 200 });
        }

        // ACTION 3: Fetch File Content
        if (action === 'get_file' && fileId) {
            const driveUrl = `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`;
            const fileRes = await fetch(driveUrl, {
                headers: { 'Authorization': `Bearer ${accessToken}` }
            });
            
            if (!fileRes.ok) return new Response(JSON.stringify({ error: 'Failed to fetch file content' }), { status: 500 });
            
            const textContent = await fileRes.text();
            // Truncate to save payload limits
            return new Response(JSON.stringify({ success: true, content: textContent.substring(0, 50000) }), { status: 200 });
        }

        return new Response(JSON.stringify({ error: 'Invalid Action' }), { status: 400 });

    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
}

