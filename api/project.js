export const config = {
    runtime: 'edge',
};

// ============================================================================
// LEXIS-AI PROJECT MANAGEMENT ENGINE (V2 BULLETPROOF)
// Handles Workspace Projects, Analytics, Syncing, Forking, and Security
// ============================================================================

const UPSTASH_URL = "https://immortal-eagle-36171.upstash.io".replace(/\/$/, '');
const UPSTASH_TOKEN = "AY1LAAIgcDE5MjFiMmNkNGQ4M2M0ODQ2YWNhYjU0YmFmMzlhNjliNw";

const CORS_HEADERS = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-project-password'
};

// Cryptographic hashing for password-protected projects
async function hashPassword(password) {
    const msgUint8 = new TextEncoder().encode(password);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Helper to interact cleanly with Upstash REST
async function redis(command, ...args) {
    try {
        const res = await fetch(`${UPSTASH_URL}/${command}/${args.map(encodeURIComponent).join('/')}`, {
            headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}` }
        });
        const data = await res.json();
        return data.result;
    } catch (e) { return null; }
}

// Helper for POST commands with body
async function redisPost(command, key, value, ...extraArgs) {
    try {
        let url = `${UPSTASH_URL}/${command}/${encodeURIComponent(key)}`;
        if (extraArgs.length > 0) url += `/${extraArgs.join('/')}`;
        
        const res = await fetch(url, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
            body: typeof value === 'string' ? value : JSON.stringify(value)
        });
        const data = await res.json();
        return data.result;
    } catch (e) { return null; }
}


export default async function handler(req) {
    // 0. CORS PREFLIGHT HANDLER
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
        // ============================================================================
        // 1. GET METHOD: FETCH PROJECT DATA OR ANALYTICS
        // ============================================================================
        if (req.method === 'GET') {
            const url = new URL(req.url);
            const action = url.searchParams.get('action') || 'get';
            const id = url.searchParams.get('id');
            const pwd = url.searchParams.get('pwd') || req.headers.get('x-project-password');

            if (!id) throw new Error("No Project ID provided");

            // --- FETCH PROJECT LOGIC ---
            if (action === 'get') {
                const dataStr = await redis("GET", `project:${id}`);
                if (!dataStr) return new Response(JSON.stringify({ success: false, error: "Project not found or expired" }), { status: 404, headers: CORS_HEADERS });

                const projectData = typeof dataStr === 'string' ? JSON.parse(dataStr) : dataStr;

                // Password Validation
                if (projectData.passwordHash) {
                    if (!pwd) return new Response(JSON.stringify({ success: false, isPasswordProtected: true, error: "Password required." }), { status: 401, headers: CORS_HEADERS });
                    const checkHash = await hashPassword(pwd.trim());
                    if (checkHash !== projectData.passwordHash) return new Response(JSON.stringify({ success: false, error: "Incorrect password" }), { status: 403, headers: CORS_HEADERS });
                }

                // Async Analytics: Increment View Count
                redis("INCR", `proj_views:${id}`).catch(() => {});

                // Strip hash before returning
                delete projectData.passwordHash;
                return new Response(JSON.stringify({ success: true, project: projectData }), { status: 200, headers: CORS_HEADERS });
            }

            // --- FETCH ANALYTICS LOGIC ---
            if (action === 'analytics') {
                const views = await redis("GET", `proj_views:${id}`) || 0;
                const clones = await redis("GET", `proj_clones:${id}`) || 0;
                return new Response(JSON.stringify({ success: true, analytics: { views: parseInt(views), clones: parseInt(clones) } }), { status: 200, headers: CORS_HEADERS });
            }

            // --- FETCH ALL PROJECTS FOR A USER ---
            if (action === 'list_user_projects') {
                const userProjects = await redis("SMEMBERS", `user_projects:${id}`) || [];
                return new Response(JSON.stringify({ success: true, projects: userProjects }), { status: 200, headers: CORS_HEADERS });
            }
        }

        // ============================================================================
        // 2. POST METHOD: CREATING, SYNCING, DELETING, OR FORKING
        // ============================================================================
        if (req.method === 'POST') {
            const body = await req.json();
            const { action, project, password, deviceId, ttlDays } = body;
            
            // Adaptive Payload Extraction: Finds the ID no matter how the frontend formats it
            const targetId = body.projectId || body.shareId || (project ? project.id : null);

            if (!action) throw new Error("Missing action parameter");

            // ------------------------------------------------------------------------
            // ACTION: SHARE / CREATE
            // ------------------------------------------------------------------------
            if (action === 'share' || action === 'create') {
                if (!project) throw new Error("Missing project payload");

                // Generate public share ID
                const shareId = 'proj_' + Math.random().toString(36).substr(2, 9) + Date.now().toString(36);
                project.shareId = shareId;
                project.createdAt = Date.now();
                project.ownerId = deviceId || 'anonymous';

                if (password && password.trim().length > 0) {
                    project.passwordHash = await hashPassword(password.trim());
                }

                // Save to Redis (with optional expiration)
                let extraArgs = [];
                if (ttlDays && parseInt(ttlDays) > 0) {
                    extraArgs = ["EX", parseInt(ttlDays) * 86400];
                }
                
                await redisPost("SET", `project:${shareId}`, project, ...extraArgs);

                // Register ownership for analytics dashboard
                if (deviceId) {
                    await redis("SADD", `user_projects:${deviceId}`, shareId);
                }

                return new Response(JSON.stringify({ success: true, shareId: shareId }), { status: 200, headers: CORS_HEADERS });
            }

            // ------------------------------------------------------------------------
            // ACTION: SYNC / UPDATE (Live Workspace Updates)
            // ------------------------------------------------------------------------
            if (action === 'sync' || action === 'update') {
                if (!targetId || !project) throw new Error("Missing ID or payload for sync");

                const existingStr = await redis("GET", `project:${targetId}`);
                if (!existingStr) throw new Error("Cannot sync: Project not found or expired on server");

                let existing = typeof existingStr === 'string' ? JSON.parse(existingStr) : existingStr;
                
                // Merge changes
                existing.chats = project.chats;
                existing.name = project.name;
                existing.updatedAt = Date.now();

                await redisPost("SET", `project:${targetId}`, existing);

                return new Response(JSON.stringify({ success: true, shareId: targetId }), { status: 200, headers: CORS_HEADERS });
            }

            // ------------------------------------------------------------------------
            // ACTION: DELETE / REVOKE
            // ------------------------------------------------------------------------
            if (action === 'delete') {
                if (!targetId) throw new Error("Missing Project ID");
                await redis("DEL", `project:${targetId}`);
                await redis("DEL", `proj_views:${targetId}`); // Cleanup analytics
                await redis("DEL", `proj_clones:${targetId}`);
                // If deviceId provided, remove from user's roster
                if (deviceId) await redis("SREM", `user_projects:${deviceId}`, targetId);
                
                return new Response(JSON.stringify({ success: true, message: "Project revoked" }), { status: 200, headers: CORS_HEADERS });
            }

            // ------------------------------------------------------------------------
            // ACTION: TRACK FORK / CLONE
            // ------------------------------------------------------------------------
            if (action === 'track_fork') {
                if (!targetId) throw new Error("Missing Project ID");
                await redis("INCR", `proj_clones:${targetId}`);
                return new Response(JSON.stringify({ success: true }), { status: 200, headers: CORS_HEADERS });
            }

            return new Response(JSON.stringify({ success: false, error: "Invalid action" }), { status: 400, headers: CORS_HEADERS });
        }

    } catch (error) {
        return new Response(JSON.stringify({ success: false, error: error.message }), { status: 500, headers: CORS_HEADERS });
    }

    return new Response('Method Not Allowed', { status: 405, headers: CORS_HEADERS });
}
