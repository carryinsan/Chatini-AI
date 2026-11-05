const ADMIN_PASSWORD = "Lexis-Admin-2026!";

// Upstash Redis Database Connection Credentials
const UPSTASH_URL = "https://immortal-eagle-36171.upstash.io".replace(/\/$/, '');
const UPSTASH_TOKEN = "AY1LAAIgcDE5MjFiMmNkNGQ4M2M0ODQ2YWNhYjU0YmFmMzlhNjliNw";
const REDIS_KEY = "arix_app_control_store";

const DEFAULT_FEATURE_CONFIG = {
    // Models
    spark: { visible: true, enabled: true, category: 'model', label: 'Spark Engine' },
    flux: { visible: true, enabled: true, category: 'model', label: 'Flux 1.5' },
    oracle: { visible: true, enabled: true, category: 'model', label: 'Oracle 2.0' },
    sparker: { visible: true, enabled: true, category: 'model', label: 'SPARKer (Offline)' },
    fluxero: { visible: true, enabled: true, category: 'model', label: 'FLiX / Fluxero (Offline)' },

    // Capabilities
    research: { visible: true, enabled: true, category: 'capability', label: 'Research (Deep AI)' },
    slides: { visible: true, enabled: true, category: 'capability', label: 'Slides (Presentation Deck)' },
    math: { visible: true, enabled: true, category: 'capability', label: 'Math (Cartesian Engine)' },
    audio: { visible: true, enabled: true, category: 'capability', label: 'Audio (Podcast Generator)' },
    image: { visible: true, enabled: true, category: 'capability', label: 'Image (Visual Engine)' },
    code: { visible: true, enabled: true, category: 'capability', label: 'Code (Web App Builder)' },
    study: { visible: true, enabled: true, category: 'capability', label: 'Study (Flashcard Deck)' },

    // Tools & Integrations
    attach_pdf: { visible: true, enabled: true, category: 'tool', label: 'Attach PDF / Files' },
    sentinel: { visible: true, enabled: true, category: 'tool', label: '24x7 Sentinel Agent' },
    drive: { visible: true, enabled: true, category: 'tool', label: 'Google Drive Sync' },
    download: { visible: true, enabled: true, category: 'tool', label: 'Download & Export PDF' },
    copy_text: { visible: true, enabled: true, category: 'tool', label: 'Copy Text Action' },
    your_tasks: { visible: true, enabled: true, category: 'tool', label: 'Your Tasks (Arix Pulse)' },
    invite_coop: { visible: true, enabled: true, category: 'tool', label: 'Invite Co-Op Friend' },
    manage_extensions: { visible: true, enabled: true, category: 'tool', label: 'Manage Knowledge Extensions' },
    constellation_map: { visible: true, enabled: true, category: 'tool', label: 'Constellation Brain Map' },
    share_chat: { visible: true, enabled: true, category: 'tool', label: 'Share Chat Link' },
    experimental: { visible: true, enabled: true, category: 'tool', label: 'Experimental Suite' },
    your_projects: { visible: true, enabled: true, category: 'tool', label: 'Your Projects' },

    // Settings
    use_memory: { visible: true, enabled: true, category: 'setting', label: 'Use Memory Toggle' },
    save_data: { visible: true, enabled: true, category: 'setting', label: 'Save Data Toggle' },
    recent_chats: { visible: true, enabled: true, category: 'setting', label: 'Recent Chats History' }
};

async function redisCommand(commandArray) {
    try {
        const response = await fetch(UPSTASH_URL, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${UPSTASH_TOKEN}`,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify(commandArray)
        });
        const data = await response.json();
        return data.result;
    } catch (err) {
        console.error("Upstash Redis REST Error:", err);
        return null;
    }
}

async function loadStore() {
    try {
        const raw = await redisCommand(["GET", REDIS_KEY]);
        if (raw) {
            const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
            return {
                globalDefaults: { ...DEFAULT_FEATURE_CONFIG, ...(parsed.globalDefaults || {}) },
                users: parsed.users || {},
                activityLogs: parsed.activityLogs || []
            };
        }
    } catch (e) {
        console.error("UserTracker: Error parsing Redis store", e.message);
    }
    return {
        globalDefaults: JSON.parse(JSON.stringify(DEFAULT_FEATURE_CONFIG)),
        users: {},
        activityLogs: []
    };
}

async function saveStore(store) {
    try {
        await redisCommand(["SET", REDIS_KEY, JSON.stringify(store)]);
    } catch (e) {
        console.error("UserTracker: Error saving Redis store", e.message);
    }
}

module.exports = async function handler(req, res) {
    // Enable Global CORS for client communication
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-password');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    let body = req.body || {};
    if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (e) {}
    }

    const urlParams = new URL(req.url, `http://${req.headers.host || 'localhost'}`).searchParams;
    const action = req.query?.action || urlParams.get('action') || body.action || (req.method === 'GET' ? 'get_my_permissions' : 'track');
    const adminAuthHeader = req.headers['x-admin-password'] || body.adminPassword || urlParams.get('adminPassword');
    const isAdmin = adminAuthHeader === ADMIN_PASSWORD;

    const store = await loadStore();

    try {
        switch (action) {
            // -----------------------------------------------------------------
            // PUBLIC ENDPOINTS (Used by app.html to fetch permissions & track)
            // -----------------------------------------------------------------

            case 'get_my_permissions':
            case 'get_user_config': {
                const deviceId = req.query?.deviceId || urlParams.get('deviceId') || body.deviceId || 'anonymous';
                const nickname = req.query?.nickname || urlParams.get('nickname') || body.nickname || 'Anonymous User';
                const deviceInfo = body.deviceInfo || 'Browser';

                // Auto-register device ID on visit
                if (!store.users[deviceId]) {
                    store.users[deviceId] = {
                        deviceId: deviceId,
                        nickname: nickname,
                        deviceInfo: deviceInfo,
                        firstSeen: Date.now(),
                        lastSeen: Date.now(),
                        customOverrides: {}
                    };
                } else {
                    store.users[deviceId].nickname = nickname !== 'Anonymous User' ? nickname : store.users[deviceId].nickname;
                    store.users[deviceId].lastSeen = Date.now();
                }

                // Append initial ping log
                store.activityLogs.unshift({
                    deviceId: deviceId,
                    nickname: store.users[deviceId].nickname,
                    action: 'App Session Check',
                    timestamp: Date.now()
                });
                if (store.activityLogs.length > 500) {
                    store.activityLogs = store.activityLogs.slice(0, 500);
                }

                await saveStore(store);

                const userObj = store.users[deviceId] || {};
                const userOverrides = userObj.customOverrides || {};

                // Compute merged permissions (Global Defaults + User Overrides)
                const finalConfig = {};
                const permissionsMap = {};

                Object.keys(store.globalDefaults).forEach(key => {
                    const globalItem = store.globalDefaults[key];
                    const userOverride = userOverrides[key] || {};

                    const visible = userOverride.visible !== undefined ? userOverride.visible : globalItem.visible;
                    const enabled = userOverride.enabled !== undefined ? userOverride.enabled : globalItem.enabled;

                    finalConfig[key] = {
                        visible,
                        enabled,
                        category: globalItem.category,
                        label: globalItem.label
                    };

                    permissionsMap[key] = visible && enabled;
                });

                return res.status(200).json({
                    success: true,
                    deviceId: deviceId,
                    config: finalConfig,
                    permissions: permissionsMap
                });
            }

            case 'track':
            case 'ping': {
                const deviceId = body.deviceId || req.query?.deviceId || 'anonymous';
                const nickname = body.nickname || 'Anonymous User';
                const deviceInfo = body.deviceInfo || 'Unknown Device';
                const currentAction = body.userAction || 'Active Session';

                if (!store.users[deviceId]) {
                    store.users[deviceId] = {
                        deviceId: deviceId,
                        nickname: nickname,
                        deviceInfo: deviceInfo,
                        firstSeen: Date.now(),
                        lastSeen: Date.now(),
                        customOverrides: {}
                    };
                } else {
                    store.users[deviceId].nickname = nickname || store.users[deviceId].nickname;
                    store.users[deviceId].deviceInfo = deviceInfo || store.users[deviceId].deviceInfo;
                    store.users[deviceId].lastSeen = Date.now();
                }

                store.activityLogs.unshift({
                    deviceId: deviceId,
                    nickname: store.users[deviceId].nickname,
                    action: currentAction,
                    timestamp: Date.now()
                });
                if (store.activityLogs.length > 500) {
                    store.activityLogs = store.activityLogs.slice(0, 500);
                }

                await saveStore(store);
                return res.status(200).json({ success: true, registered: true });
            }

            // -----------------------------------------------------------------
            // ADMIN ENDPOINTS (Protected by Lexis-Admin-2026!)
            // -----------------------------------------------------------------

            case 'admin_login': {
                if (!isAdmin) {
                    return res.status(401).json({ success: false, error: 'Invalid Admin Password' });
                }
                return res.status(200).json({
                    success: true,
                    message: 'Authenticated successfully',
                    token: ADMIN_PASSWORD
                });
            }

            case 'admin_get_state': {
                if (!isAdmin) {
                    return res.status(401).json({ success: false, error: 'Unauthorized Access' });
                }
                return res.status(200).json({
                    success: true,
                    globalDefaults: store.globalDefaults,
                    users: store.users,
                    activityLogs: store.activityLogs
                });
            }

            case 'admin_update_global_defaults': {
                if (!isAdmin) {
                    return res.status(401).json({ success: false, error: 'Unauthorized Access' });
                }
                const newDefaults = body.globalDefaults;
                if (!newDefaults || typeof newDefaults !== 'object') {
                    return res.status(400).json({ success: false, error: 'Invalid defaults payload' });
                }

                Object.keys(newDefaults).forEach(key => {
                    if (store.globalDefaults[key]) {
                        store.globalDefaults[key].visible = !!newDefaults[key].visible;
                        store.globalDefaults[key].enabled = !!newDefaults[key].enabled;
                    }
                });

                await saveStore(store);
                return res.status(200).json({
                    success: true,
                    message: 'Global default feature access updated',
                    globalDefaults: store.globalDefaults
                });
            }

            case 'admin_update_user_permissions': {
                if (!isAdmin) {
                    return res.status(401).json({ success: false, error: 'Unauthorized Access' });
                }
                const { targetDeviceId, customOverrides } = body;
                if (!targetDeviceId || !store.users[targetDeviceId]) {
                    return res.status(404).json({ success: false, error: 'User device ID not found' });
                }

                store.users[targetDeviceId].customOverrides = customOverrides || {};
                await saveStore(store);

                return res.status(200).json({
                    success: true,
                    message: `Permissions updated for user ${targetDeviceId}`,
                    user: store.users[targetDeviceId]
                });
            }

            case 'admin_reset_user_permissions': {
                if (!isAdmin) {
                    return res.status(401).json({ success: false, error: 'Unauthorized Access' });
                }
                const { targetDeviceId } = body;
                if (targetDeviceId && store.users[targetDeviceId]) {
                    store.users[targetDeviceId].customOverrides = {};
                    await saveStore(store);
                }
                return res.status(200).json({ success: true, message: 'User overrides reset to global defaults' });
            }

            default:
                return res.status(400).json({ success: false, error: `Unknown action: ${action}` });
        }
    } catch (err) {
        console.error("UserTracker Handler Exception:", err);
        return res.status(500).json({ success: false, error: err.message });
    }
};
