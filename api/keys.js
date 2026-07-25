export const config = {
    runtime: 'edge',
};

// ============================================================================
// [ SAAS GATEWAY ] LEXIS API KEY GENERATOR & ADMIN TELEMETRY
// Creates custom keys tied to Device IDs and serves real Admin analytics
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

            // 4. Save to Upstash Redis and track total unique device count
            const multiExec = [
                ["SET", `device:${deviceId}`, newApiKey],
                ["SET", `apikey:${newApiKey}`, JSON.stringify(keyConfig)],
                ["INCR", "stats:total_devices"]
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
        // ACTION: ADMIN TELEMETRY EXTRACTION (Real Data for Dashboard)
        // --------------------------------------------------------------------
        if (action === 'admin_stats') {
            if (adminSecret !== "Lexis-Admin-2026!") {
                return new Response(JSON.stringify({ error: "Unauthorized Admin" }), { status: 401 });
            }

            // Fetch all global counters simultaneously via Upstash pipeline
            const multiExec = [
                ["GET", "stats:total_requests"],
                ["GET", "stats:total_success"],
                ["GET", "stats:total_errors"],
                ["GET", "stats:total_devices"],
                ["GET", "stats:errors:missing_key"],
                ["GET", "stats:errors:invalid_key"],
                ["GET", "stats:errors:rate_limit_model"],
                ["GET", "stats:errors:rate_limit_feature"]
            ];

            const statsRes = await fetch(`${UPSTASH_URL}/pipeline`, {
                method: 'POST',
                headers: { "Authorization": `Bearer ${UPSTASH_TOKEN}`, "Content-Type": "application/json" },
                body: JSON.stringify(multiExec)
            });
            const statsData = await statsRes.json();

            const totalReq = parseInt(statsData[0].result || "0", 10);
            const totalSuccess = parseInt(statsData[1].result || "0", 10);
            const totalErrors = parseInt(statsData[2].result || "0", 10);
            const totalDevices = parseInt(statsData[3].result || "0", 10);
            
            const errMissing = parseInt(statsData[4].result || "0", 10);
            const errInvalid = parseInt(statsData[5].result || "0", 10);
            const errModel = parseInt(statsData[6].result || "0", 10);
            const errFeature = parseInt(statsData[7].result || "0", 10);

            return new Response(JSON.stringify({
                success: true,
                analytics: {
                    totalRequests: totalReq,
                    totalSuccess: totalSuccess,
                    totalErrors: totalErrors,
                    totalDevices: totalDevices,
                    errorAuth: errMissing + errInvalid,
                    errorModelQuota: errModel,
                    errorFeatureQuota: errFeature
                }
            }), { status: 200 });
        }

        return new Response(JSON.stringify({ error: "Invalid action" }), { status: 400 });

    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), { status: 500 });
    }
}

