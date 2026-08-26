const fs = require('fs');
const path = require('path');

// Target password configured for Admin Access
const ADMIN_PASSWORD = "Lexis-Admin-2026!";

// Data Persistence Path (fallback to in-memory if disk write is restricted)
const DATA_DIR = path.join(process.cwd(), 'data');
const STORAGE_FILE = path.join(DATA_DIR, 'app_control.json');

// Default All Features Configuration (Admin can toggle visibility and usage per feature/model)
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
    experimental: { visible: true, enabled: true, category: 'tool', label: 'Experimental Suite (The Lab / Twin)' },
    your_projects: { visible: true, enabled: true, category: 'tool', label: 'Your Projects' },
    use_memory: { visible: true, enabled: true, category: 'setting', label: 'Use Memory Toggle' },
    save_data: { visible: true, enabled: true, category: 'setting', label: 'Save Data Toggle' },
    recent_chats: { visible: true, enabled: true, category: 'setting', label: 'Recent Chats History' }
};

// In-Memory Database Structure
let appStore = {
    globalDefaults: JSON.parse(JSON.stringify(DEFAULT_FEATURE_CONFIG)),
    users: {}, // deviceId -> { nickname, deviceInfo, lastSeen, customOverrides: {} }
    activityLogs: []
};

// Load data from disk if available
function loadStore() {
    try {
        if (fs.existsSync(STORAGE_FILE)) {
            const raw = fs.readFileSync(STORAGE_FILE, 'utf8');
            const parsed = JSON.parse(raw);
            appStore.globalDefaults = { ...DEFAULT_FEATURE_CONFIG, ...(parsed.globalDefaults || {}) };
            appStore.users = parsed.users || {};
            appStore.activityLogs = parsed.activityLogs || [];
        }
    } catch (e) {
        console.error("UserTracker: Error reading data store", e.message);
    }
}

// Persist data to disk
function saveStore() {
    try {
        if (!fs.existsSync(DATA_DIR)) {
            fs.mkdirSync(DATA_DIR, { recursive: true });
        }
        fs.writeFileSync(STORAGE_FILE, JSON.stringify(appStore, null, 2), 'utf8');
    } catch (e) {
        console.error("UserTracker: Error writing data store", e.message);
    }
}

// Initialize on module load
loadStore();

/**
 * Universal Serverless Endpoint Handler
 * Compatible with Express, Node http, Vercel Serverless Functions
 */
module.exports = async function handler(req, res) {
    // CORS Headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-password');

    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    // Parse Body
    let body = req.body || {};
    if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch (e) {}
    }

    const action = req.query.action || body.action || (req.method === 'GET' ? 'get_user_config' : 'track');
    const adminAuthHeader = req.headers['x-admin-password'] || body.adminPassword;
    const isAdmin = adminAuthHeader === ADMIN_PASSWORD;

    try {
        switch (action) {
            // -----------------------------------------------------------------
            // PUBLIC ENDPOINTS (Used by app.html to check permissions & track)
            // -----------------------------------------------------------------

            case 'get_user_config': {
                const deviceId = req.query.deviceId || body.deviceId || 'anonymous';
                const userObj = appStore.users[deviceId] || {};
                const userOverrides = userObj.customOverrides || {};

                // Merge Global Defaults with User-Specific Overrides
                const finalConfig = {};
                Object.keys(appStore.globalDefaults).forEach(key => {
                    const globalItem = appStore.globalDefaults[key];
                    const userOverride = userOverrides[key] || {};

                    finalConfig[key] = {
                        visible: userOverride.visible !== undefined ? userOverride.visible : globalItem.visible,
                        enabled: userOverride.enabled !== undefined ? userOverride.enabled : globalItem.enabled,
                        category: globalItem.category,
                        label: globalItem.label
                    };
                });

                return res.status(200).json({
                    success: true,
                    deviceId: deviceId,
                    config: finalConfig
                });
            }

            case 'track':
            case 'ping': {
                const deviceId = body.deviceId || 'anonymous';
                const nickname = body.nickname || 'Anonymous User';
                const deviceInfo = body.deviceInfo || 'Unknown Device';
                const currentAction = body.userAction || 'Active Session';

                if (!appStore.users[deviceId]) {
                    appStore.users[deviceId] = {
                        deviceId: deviceId,
                        nickname: nickname,
                        deviceInfo: deviceInfo,
                        firstSeen: Date.now(),
                        lastSeen: Date.now(),
                        customOverrides: {}
                    };
                } else {
                    appStore.users[deviceId].nickname = nickname || appStore.users[deviceId].nickname;
                    appStore.users[deviceId].deviceInfo = deviceInfo || appStore.users[deviceId].deviceInfo;
                    appStore.users[deviceId].lastSeen = Date.now();
                }

                // Append activity log (cap at last 500 actions)
                appStore.activityLogs.unshift({
                    deviceId: deviceId,
                    nickname: nickname,
                    action: currentAction,
                    timestamp: Date.now()
                });
                if (appStore.activityLogs.length > 500) {
                    appStore.activityLogs = appStore.activityLogs.slice(0, 500);
                }

                saveStore();
                return res.status(200).json({ success: true, registered: true });
            }

            // -----------------------------------------------------------------
            // ADMIN ENDPOINTS (Protected by password Lexis-Admin-2026!)
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
                    globalDefaults: appStore.globalDefaults,
                    users: appStore.users,
                    activityLogs: appStore.activityLogs.slice(0, 50)
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

                // Update settings
                Object.keys(newDefaults).forEach(key => {
                    if (appStore.globalDefaults[key]) {
                        appStore.globalDefaults[key].visible = !!newDefaults[key].visible;
                        appStore.globalDefaults[key].enabled = !!newDefaults[key].enabled;
                    }
                });

                saveStore();
                return res.status(200).json({
                    success: true,
                    message: 'Global default feature access updated',
                    globalDefaults: appStore.globalDefaults
                });
            }

            case 'admin_update_user_permissions': {
                if (!isAdmin) {
                    return res.status(401).json({ success: false, error: 'Unauthorized Access' });
                }
                const { targetDeviceId, customOverrides } = body;
                if (!targetDeviceId || !appStore.users[targetDeviceId]) {
                    return res.status(404).json({ success: false, error: 'User device ID not found' });
                }

                appStore.users[targetDeviceId].customOverrides = customOverrides || {};
                saveStore();

                return res.status(200).json({
                    success: true,
                    message: `Permissions updated for user ${targetDeviceId}`,
                    user: appStore.users[targetDeviceId]
                });
            }

            case 'admin_reset_user_permissions': {
                if (!isAdmin) {
                    return res.status(401).json({ success: false, error: 'Unauthorized Access' });
                }
                const { targetDeviceId } = body;
                if (targetDeviceId && appStore.users[targetDeviceId]) {
                    appStore.users[targetDeviceId].customOverrides = {};
                    saveStore();
                }
                return res.status(200).json({ success: true, message: 'User overrides reset to global defaults' });
            }

            default:
                return res.status(400).json({ success: false, error: `Unknown action: ${action}` });
        }
    } catch (err) {
        console.error("UserTracker Handler Error:", err);
        return res.status(500).json({ success: false, error: err.message });
    }
};
