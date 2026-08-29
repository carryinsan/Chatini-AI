/**
 * ArixLegal - Court Synchronization & Matter Management
 * Filename: js/courtSync.js
 * 
 * Purpose: Connects the frontend to the Supabase database for matter management
 * and triggers the resilient backend scraper (api/legalscrape) for real-time court data.
 */

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_CONFIG } from '../api/file.js';
import { getActiveSession } from './auth.js';

// 1. Fail-Safe Client Initialization
let supabase;
try {
    if (!SUPABASE_CONFIG || !SUPABASE_CONFIG.URL || !SUPABASE_CONFIG.KEY) {
        throw new Error("Missing Supabase configuration.");
    }
    supabase = createClient(SUPABASE_CONFIG.URL, SUPABASE_CONFIG.KEY);
    console.log("[CourtSync] Supabase client initialized.");
} catch (error) {
    console.error("[CourtSync Error] Database connection offline:", error.message);
    supabase = null;
}

// The route corresponding to your api/legalscrape.js backend endpoint
const SCRAPER_API_ENDPOINT = '/api/legalscrape';
const SCRAPER_TIMEOUT_MS = 60000; // 60 seconds max wait time for the headless browser

/**
 * Creates a new Legal Matter in the database and triggers an initial sync.
 * 
 * @param {Object} matterDetails - Details from the Create Workspace modal.
 * @returns {Promise<Object>} { success, matter, error }
 */
export async function createNewMatter(matterDetails) {
    if (!supabase) return { success: false, error: "Database offline.", matter: null };

    try {
        const session = await getActiveSession();
        if (!session) throw new Error("Unauthorized. Please log in.");

        console.log(`[CourtSync] Creating new workspace: ${matterDetails.displayName}`);

        // Insert basic matter details into Supabase
        const { data, error } = await supabase
            .from('matters')
            .insert([{
                user_id: session.user.id,
                display_name: matterDetails.displayName.trim(),
                case_number: matterDetails.caseNumber?.trim() || null,
                cnr_number: matterDetails.cnrNumber?.replace(/[^a-zA-Z0-9]/g, '') || null,
                court_forum: matterDetails.courtForum,
                client_name: matterDetails.clientName?.trim() || null,
                status: 'Initializing', // Initial status before scrape
                case_data: null
            }])
            .select()
            .single();

        if (error) throw error;

        console.log(`[CourtSync] Matter created with ID: ${data.id}. Triggering initial sync...`);
        
        // Trigger background sync without awaiting it to keep UI fast
        // The UI can show a "Syncing..." spinner while this runs
        triggerCourtSync(data.id, data.cnr_number, matterDetails.fallbackParams, true);

        return { success: true, matter: data, error: null };

    } catch (err) {
        console.error("[CourtSync Error] Failed to create matter:", err.message);
        return { success: false, error: err.message, matter: null };
    }
}

/**
 * Fetches all matters for the currently logged-in advocate.
 * 
 * @returns {Promise<Array>} List of matter objects
 */
export async function fetchUserMatters() {
    if (!supabase) return [];

    try {
        const session = await getActiveSession();
        if (!session) return [];

        console.log("[CourtSync] Fetching advocate matters from database...");
        const { data, error } = await supabase
            .from('matters')
            .select('*')
            .eq('user_id', session.user.id)
            .order('created_at', { ascending: false });

        if (error) throw error;
        
        return data || [];
    } catch (err) {
        console.error("[CourtSync Error] Failed to fetch matters:", err.message);
        return [];
    }
}

/**
 * Calls the backend headless scraper (api/legalscrape) to fetch the latest court data.
 * 
 * @param {string} matterId - The database ID of the matter.
 * @param {string} cnrNumber - The 16-digit CNR number (optional if fallbackParams provided).
 * @param {Object} fallbackParams - { stateCode, districtCode, courtComplexCode, caseTypeCode, caseNumber, year }
 * @param {boolean} forceRefresh - If true, bypasses the smart cache.
 * @returns {Promise<Object>} { success, source, data, error }
 */
export async function triggerCourtSync(matterId, cnrNumber, fallbackParams = null, forceRefresh = false) {
    try {
        const session = await getActiveSession();
        if (!session) throw new Error("Unauthorized.");

        console.log(`[CourtSync] Initiating scraper for Matter ID: ${matterId}`);

        // Setup AbortController for timeout protection
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), SCRAPER_TIMEOUT_MS);

        const response = await fetch(SCRAPER_API_ENDPOINT, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${session.access_token}` // Optional: for backend route protection
            },
            body: JSON.stringify({
                userId: session.user.id,
                matterId: matterId,
                cnrNumber: cnrNumber,
                fallbackParams: fallbackParams,
                forceRefresh: forceRefresh
            }),
            signal: controller.signal
        });

        clearTimeout(timeoutId);

        if (!response.ok) {
            const errData = await response.json();
            throw new Error(errData.error || `HTTP Error ${response.status}`);
        }

        const result = await response.json();
        console.log(`[CourtSync] Sync complete. Source: ${result.source}`);
        
        return { 
            success: true, 
            source: result.source, // 'cache' or 'live_scrape'
            data: result.data, 
            error: null 
        };

    } catch (err) {
        if (err.name === 'AbortError') {
            console.error("[CourtSync Error] Scraper timed out after 60 seconds.");
            return { success: false, error: "The court portal is taking too long to respond. Please try again later.", data: null };
        }
        
        console.error("[CourtSync Error] Sync failed:", err.message);
        return { success: false, error: err.message, data: null };
    }
}

/**
 * Utility: Checks if a matter's hearing date has passed and requires a background sync.
 * @param {Object} matter - The matter database object.
 * @returns {boolean} true if a sync should be triggered.
 */
export function isSyncOverdue(matter) {
    if (!matter.next_hearing_date) return true; // Never synced

    const hearingDate = new Date(matter.next_hearing_date);
    const today = new Date();
    
    // Reset times to midnight for accurate day comparison
    hearingDate.setHours(0, 0, 0, 0);
    today.setHours(0, 0, 0, 0);

    // If the hearing date was yesterday or earlier, we need to check for updates (like new orders/next date)
    return hearingDate < today;
}
