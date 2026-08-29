/**
 * ArixLegal - Advocate Authentication Module
 * Filename: js/auth.js
 * 
 * Purpose: Handles secure sign-up, login, session management, and route protection
 * using Supabase Auth. Designed to be fail-safe and error-resilient.
 */

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_CONFIG } from '../api/file.js';

// 1. Fail-Safe Client Initialization
let supabase;
try {
    if (!SUPABASE_CONFIG || !SUPABASE_CONFIG.URL || !SUPABASE_CONFIG.KEY) {
        throw new Error("Missing Supabase configuration in api/file.js");
    }
    // Initialize the Supabase client
    supabase = createClient(SUPABASE_CONFIG.URL, SUPABASE_CONFIG.KEY);
    console.log("[Auth] Supabase client initialized successfully.");
} catch (error) {
    console.error("[Auth Error] Failed to initialize Supabase:", error.message);
    // Prevents crashing the entire app if ad-blockers or network issues block initialization
    supabase = null; 
}

/**
 * Registers a new Advocate on ArixLegal.
 * @param {string} email - Advocate's professional email.
 * @param {string} password - Secure password.
 * @param {string} username - Unique username for the advocate.
 * @param {string} fullName - Full legal name of the advocate.
 * @returns {Promise<Object>} { success: boolean, data: object|null, error: string|null }
 */
export async function registerAdvocate(email, password, username, fullName) {
    if (!supabase) return { success: false, error: "Database connection offline.", data: null };

    // Input Validation
    if (!email || !password || !username || !fullName) {
        return { success: false, error: "All fields are required.", data: null };
    }
    if (password.length < 8) {
        return { success: false, error: "Password must be at least 8 characters long.", data: null };
    }

    try {
        console.log(`[Auth] Attempting to register advocate: ${username}...`);
        
        // Supabase Auth Signup
        // We store the username and fullName in raw_user_meta_data so it is tied to the auth session
        const { data, error } = await supabase.auth.signUp({
            email: email,
            password: password,
            options: {
                data: {
                    username: username.toLowerCase().trim(),
                    full_name: fullName.trim(),
                    role: 'advocate'
                }
            }
        });

        if (error) {
            throw error;
        }

        console.log("[Auth] Advocate registered successfully.");
        return { success: true, data: data.user, error: null };

    } catch (err) {
        console.error("[Auth Error] Registration failed:", err.message);
        return { success: false, error: err.message, data: null };
    }
}

/**
 * Authenticates an existing Advocate.
 * @param {string} email - Advocate's email.
 * @param {string} password - Advocate's password.
 * @returns {Promise<Object>} { success: boolean, session: object|null, error: string|null }
 */
export async function loginAdvocate(email, password) {
    if (!supabase) return { success: false, error: "Database connection offline.", session: null };

    if (!email || !password) {
        return { success: false, error: "Email and password are required.", session: null };
    }

    try {
        console.log(`[Auth] Authenticating advocate: ${email}...`);
        
        const { data, error } = await supabase.auth.signInWithPassword({
            email: email.trim(),
            password: password
        });

        if (error) {
            throw error;
        }

        console.log("[Auth] Authentication successful.");
        return { success: true, session: data.session, error: null };

    } catch (err) {
        console.error("[Auth Error] Login failed:", err.message);
        return { success: false, error: "Invalid login credentials. Please try again.", session: null };
    }
}

/**
 * Logs out the current Advocate and securely clears the session.
 * @returns {Promise<Object>} { success: boolean, error: string|null }
 */
export async function logoutAdvocate() {
    if (!supabase) return { success: false, error: "Database connection offline." };

    try {
        const { error } = await supabase.auth.signOut();
        if (error) throw error;
        
        console.log("[Auth] Advocate logged out successfully.");
        return { success: true, error: null };
    } catch (err) {
        console.error("[Auth Error] Logout failed:", err.message);
        return { success: false, error: err.message };
    }
}

/**
 * Retrieves the currently logged-in Advocate's active session.
 * @returns {Promise<Object|null>} The active session object or null if not logged in.
 */
export async function getActiveSession() {
    if (!supabase) return null;
    
    try {
        const { data: { session }, error } = await supabase.auth.getSession();
        if (error) throw error;
        return session;
    } catch (err) {
        console.warn("[Auth] Failed to retrieve session:", err.message);
        return null;
    }
}

/**
 * Route Protection: Checks if a user is logged in. 
 * If NOT logged in, automatically redirects them to the login page.
 * Call this function at the very top of protected pages (like dashboard.html).
 * 
 * @param {string} redirectUrl - The URL to redirect to if unauthorized.
 */
export async function requireAuth(redirectUrl = 'index.html') {
    console.log("[Auth] Verifying secure route access...");
    const session = await getActiveSession();
    
    if (!session) {
        console.warn("[Auth] Unauthorized access attempt. Redirecting to login...");
        window.location.replace(redirectUrl);
        return null;
    }
    
    console.log(`[Auth] Access granted to: ${session.user.user_metadata.full_name}`);
    return session.user;
}

/**
 * Route Protection: Checks if a user IS logged in.
 * If they are already logged in, redirect them to the dashboard (prevents seeing login screen again).
 * Call this function on public pages like index.html.
 * 
 * @param {string} dashboardUrl - The URL to redirect to if already authorized.
 */
export async function redirectIfAuthenticated(dashboardUrl = 'dashboard.html') {
    console.log("[Auth] Checking existing session for automatic login...");
    const session = await getActiveSession();
    
    if (session) {
        console.log("[Auth] Active session found. Redirecting to dashboard...");
        window.location.replace(dashboardUrl);
    }
}
