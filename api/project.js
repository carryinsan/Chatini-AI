export const config = {
    runtime: 'edge',
};

// ============================================================================
// LEXIS-AI PROJECT MANAGEMENT ENGINE
// Handles Workspace Projects, Chat Importing, Sharing, Forking, and Security
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

export default async function handler(req) {
    // 0. CORS PREFLIGHT HANDLER
    if (req.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // ============================================================================
    // 1. GET METHOD: FETCH OR VIEW A PROJECT
    // ============================================================================
    if (req.method === 'GET') {
        try {
            const url = new URL(req.url);
            const projectId = url.searchParams.get('id');
            const providedPassword = req.headers.get('x-project-password');

            if (!projectId) {
                return new Response(JSON.stringify({ success: false, error: "No Project ID provided" }), { 
                    status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } 
                });
            }

            // Fetch project data from Redis
            const res = await fetch(`${UPSTASH_URL}/get/project:${projectId}`, {
                headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}` }
            });
            const data = await res.json();

            if (!data.result) {
                return new Response(JSON.stringify({ success: false, error: "Project not found or expired" }), { 
                    status: 404, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } 
                });
            }

            const projectData = typeof data.result === 'string' ? JSON.parse(data.result) : data.result;

            // Password Protection Verification
            if (projectData.passwordHash) {
                if (!providedPassword) {
                    return new Response(JSON.stringify({ 
                        success: false, 
                        isPasswordProtected: true, 
                        error: "This project is password protected." 
                    }), { status: 401, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } });
                }

                const checkHash = await hashPassword(providedPassword.trim());
                if (checkHash !== projectData.passwordHash) {
                    return new Response(JSON.stringify({ success: false, error: "Incorrect password" }), { 
                        status: 403, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } 
                    });
                }
            }

            // Async Analytics: Increment View Count without blocking the response
            fetch(`${UPSTASH_URL}/incr/project_views:${projectId}`, {
                headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}` }
            }).catch(() => {}); // Fire and forget

            // Strip sensitive data before sending to client
            delete projectData.passwordHash;

            return new Response(JSON.stringify({ success: true, project: projectData }), {
                status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
            });

        } catch (error) {
            return new Response(JSON.stringify({ success: false, error: error.message }), { 
                status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } 
            });
        }
    }

    // ============================================================================
    // 2. POST METHOD: CREATE, UPDATE, DELETE, OR FORK PROJECTS
    // ============================================================================
    if (req.method === 'POST') {
        try {
            const body = await req.json();
            const { action, projectId, projectData, password, expiresInDays } = body;

            if (!action || !projectId) {
                return new Response(JSON.stringify({ success: false, error: "Missing required parameters (action, projectId)" }), { 
                    status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } 
                });
            }

            // ------------------------------------------------------------------------
            // ACTION: SAVE / UPDATE
            // ------------------------------------------------------------------------
            if (action === 'save' || action === 'update') {
                if (!projectData) throw new Error("Missing project payload");

                // Security: Hash password if provided
                if (password && password.trim().length > 0) {
                    projectData.passwordHash = await hashPassword(password.trim());
                }

                // Add Metadata
                projectData.updatedAt = Date.now();
                if (action === 'save') projectData.createdAt = projectData.createdAt || Date.now();

                // Build Upstash URL (with optional TTL for ephemeral projects)
                let redisUrl = `${UPSTASH_URL}/set/project:${projectId}`;
                if (expiresInDays && parseInt(expiresInDays) > 0) {
                    const seconds = parseInt(expiresInDays) * 86400;
                    redisUrl += `?ex=${seconds}`;
                }

                const res = await fetch(redisUrl, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify(projectData)
                });

                const dbRes = await res.json();
                if (dbRes.result !== 'OK') throw new Error("Database failed to save project");

                return new Response(JSON.stringify({ success: true, id: projectId }), {
                    status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
                });
            }

            // ------------------------------------------------------------------------
            // ACTION: DELETE
            // ------------------------------------------------------------------------
            if (action === 'delete') {
                await fetch(`${UPSTASH_URL}/del/project:${projectId}`, {
                    headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}` }
                });
                return new Response(JSON.stringify({ success: true, message: "Project deleted" }), {
                    status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
                });
            }

            // ------------------------------------------------------------------------
            // ACTION: FORK (Clone an existing project)
            // ------------------------------------------------------------------------
            if (action === 'fork') {
                const { newProjectId } = body;
                if (!newProjectId) throw new Error("Missing newProjectId for forking");

                // Get Original
                const getOriginal = await fetch(`${UPSTASH_URL}/get/project:${projectId}`, {
                    headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}` }
                });
                const originalDataRaw = await getOriginal.json();
                
                if (!originalDataRaw.result) throw new Error("Original project not found");
                
                let forkedData = typeof originalDataRaw.result === 'string' ? JSON.parse(originalDataRaw.result) : originalDataRaw.result;
                
                // Update metadata for the fork
                forkedData.isForked = true;
                forkedData.parentProjectId = projectId;
                forkedData.createdAt = Date.now();
                forkedData.updatedAt = Date.now();
                // Optionally strip password from fork so the new owner can set their own
                delete forkedData.passwordHash; 

                // Save Fork
                await fetch(`${UPSTASH_URL}/set/project:${newProjectId}`, {
                    method: 'POST',
                    headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
                    body: JSON.stringify(forkedData)
                });

                return new Response(JSON.stringify({ success: true, id: newProjectId, message: "Project forked successfully" }), {
                    status: 200, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
                });
            }

            return new Response(JSON.stringify({ success: false, error: "Invalid action" }), { 
                status: 400, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } 
            });

        } catch (error) {
            return new Response(JSON.stringify({ success: false, error: error.message }), { 
                status: 500, headers: { 'Content-Type': 'application/json', ...CORS_HEADERS } 
            });
        }
    }

    return new Response('Method Not Allowed', { status: 405, headers: CORS_HEADERS });
}
