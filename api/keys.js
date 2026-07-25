export const config = {
    runtime: 'edge',
};

// ============================================================================
// [ SAAS GATEWAY ] LEXIS API KEY GENERATOR & ADMIN BRIDGE
// Creates custom keys tied to Device IDs and serves Admin telemetry
// ============================================================================

const UPSTASH_URL = "https://immortal-eagle-36171.upstash.io";
const UPSTASH_TOKEN = "AY1LAAIgcDE5MjFiMmNkNGQ4M2M0ODQ2YWNhYjU0YmFmMzlhNjliNw";

export default async function handler(req) {
    if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 });

    try {
        const body = await req.json();
        const { action, deviceId, adminSecret } = body;

        // --------------------------------------------------------------------
        // ACTION: GENERATE OR RETRIEVE API KEY FOR A DEVICE
        // --------------------------------------------------------------------
        if (action === 'generate') {
            if (!deviceId) return new Response(JSON.stringify({ error: "Device ID required" }), { status: 400 });

            // 1. Check if this device already has a key
            const checkRes = await fetch(`${UPSTASH_URL}/get/device:${deviceId}`, {
                headers: { "Authorization": `Bearer ${UPSTASH_TOKEN}` }
            });
            const checkData = await checkRes.json();

            if (checkData.result) {
                // Device already has a key, return the existing one
                return new Response(JSON.stringify({ success: true, apiKey: checkData.result, isNew: false }), { status: 200 });
            }

            // 2. Generate a new secure Lexis API Key
            const uniqueId = crypto.randomUUID().replace(/-/g, '');
            const newApiKey = `Lexis-${uniqueId}`;

            // 3. Define the strict mathematical limits for this key
            const keyConfig = {
                plan: "Developer Free Tier",
                created_at: Date.now(),
                owner_device: deviceId,
                limits: {
                    models: { spark: 100, flux: 20, oracle: 5 },
                    features: { research: 1, slides: 3, maths: 10, app: 10, image: 5 }
                }
            };

            // 4. Save to Upstash Redis (Pipeline to ensure both records save together)
            const multiExec = [
                ["SET", `device:${deviceId}`, newApiKey],
                ["SET", `apikey:${newApiKey}`, JSON.stringify(keyConfig)]
            ];

            await fetch(`${UPSTASH_URL}/pipeline`, {
                method: 'POST',
                headers: { "Authorization": `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "application/json" },
                body: JSON.stringify(multiExec)
            });

            return new Response(JSON.stringify({
                success: true,
                message: "API Key Minted Successfully",
                apiKey: newApiKey,
                configuration: keyConfig,
                isNew: true
            }), { status: 200 });
        }

        // --------------------------------------------------------------------
        // ACTION: ADMIN TELEMETRY EXTRACTION
        // --------------------------------------------------------------------
        if (action === 'admin_stats') {
            if (adminSecret !== "Lexis-Admin-2026!") {
                return new Response(JSON.stringify({ error: "Unauthorized Admin" }), { status: 401 });
            }

            // Fetch high-level statistics from the database
            // Note: In a full enterprise app, you'd use SCAN, but for edge speed we pull aggregated keys
            const multiExec = [
                ["GET", "stats:total_requests"],
                ["GET", "stats:total_errors"],
                ["GET", "stats:total_success"]
            ];

            const statsRes = await fetch(`${UPSTASH_URL}/pipeline`, {
                method: 'POST',
                headers: { "Authorization": `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "application/json" },
                body: JSON.stringify(multiExec)
            });
            const statsData = await statsRes.json();

            return new Response(JSON.stringify({
                success: true,
                analytics: {
                    totalRequests: statsData[0].result || 0,
                    totalErrors: statsData[1].result || 0,
                    totalSuccess: statsData[2].result || 0,
                }
            }), { status: 200 });
        }

        return new Response(JSON.stringify({ error: "Invalid action" }), { status: 400 });

    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
}


