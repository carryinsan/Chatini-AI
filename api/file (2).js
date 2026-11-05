/**
 * ArixLegal - Centralized API Key & Configuration Manager
 * Filename: api/file.js
 * 
 * Purpose: Securely manage, rotate, and export API keys for the ArixLegal backend.
 * Provides fail-safe mechanisms for AI model rate limits using key rotation arrays.
 */

// 1. Supabase (Database & Authentication)
export const SUPABASE_CONFIG = {
    URL: "https://vvcpdfdofihdmzshglxr.supabase.co",
    // In a true production environment, this Service Role key should ONLY be used on the backend/serverless functions.
    // Client-side should use the Anon Public key. 
    KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ2Y3BmZG9maWhkbXpzaGRnbHhyIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NTA2NzQ5MCwiZXhwIjoyMTAwNjQzNDkwfQ.ACRUkwnNiVg-6ZNqSlKYYev0csd_cT6tgiL0T0fPKLQ"
};

// 2. Upstash Redis (Caching & Rate Limiting)
export const UPSTASH_CONFIG = {
    // Strip trailing slash if present to avoid connection string errors
    URL: "https://immortal-eagle-36171.upstash.io".replace(/\/$/, ''),
    TOKEN: "AY1LAAIgcDE5MjFiMmNkNGQ4M2M0ODQ2YWNhYjU0YmFmMzlhNjliNw"
};

// 3. Google Gemini (Legal AI Assistant & Summarization)
// Using an array to allow for intelligent round-robin rotation if a rate limit (429) is hit.
const GEMINI_KEYS = [
    process.env.GEMINI_API_KEY_1 || "",
    process.env.GEMINI_API_KEY_2 || "",
    process.env.GEMINI_API_KEY_3 || "",
    process.env.GEMINI_API_KEY_4 || "",
    process.env.GEMINI_API_KEY_5 || "",
    process.env.GEMINI_API_KEY_6 || "",
    process.env.GEMINI_API_KEY_7 || "",
    process.env.GEMINI_API_KEY_8 || "",
    process.env.GEMINI_API_KEY_9 || "",
    process.env.GEMINI_API_KEY || "" 
].filter(key => key !== ""); // Remove empty strings

// 4. Groq (High-Speed Inference & PII De-identification)
const GROQ_KEYS = [
    process.env.GROQ_API_KEY || "",
    process.env.GROQ_KEY_2 || "",
    process.env.GROQ_API_KEY_2 || "",
    process.env.GROQ_KEY_3 || "",
    process.env.GROQ_API_KEY_3 || "",
    process.env.GROQ_KEY_4 || "",
    process.env.GROQ_API_KEY_4 || "",
    process.env.GROQ_KEY_5 || "",
    process.env.GROQ_API_KEY_5 || ""
].filter(key => key !== "");

// 5. Tavily (Real-time Legal Search & Context)
const TAVILY_KEYS = [
    process.env.TAVILY_API_KEY || "",
    process.env.TAVILY_KEY_2 || "",
    process.env.TAVILY_KEY_3 || "",
    process.env.TAVILY_KEY_4 || "",
    process.env.TAVILY_KEY_5 || "",
    process.env.TAVILY_KEY_6 || "",
    process.env.TAVILY_KEY_7 || ""
].filter(key => key !== "");


/**
 * Fail-Safe Key Rotator Class
 * Maintains the current index of the working API key. If a key fails (e.g., rate limit),
 * calling `rotate()` shifts to the next available key in the pool.
 */
class KeyRotator {
    constructor(keysArray, serviceName) {
        this.keys = keysArray;
        this.currentIndex = 0;
        this.serviceName = serviceName;
        
        if (this.keys.length === 0) {
            console.warn(`[WARNING] No API keys found for ${this.serviceName}. Ensure environment variables are set.`);
        }
    }

    /**
     * Retrieves the currently active API key.
     */
    getCurrentKey() {
        if (this.keys.length === 0) return null;
        return this.keys[this.currentIndex];
    }

    /**
     * Shifts to the next API key in the array. 
     * Call this when a 429 Too Many Requests error occurs.
     */
    rotate() {
        if (this.keys.length <= 1) {
            console.warn(`[${this.serviceName}] Cannot rotate key; only 1 or 0 keys available.`);
            return this.getCurrentKey();
        }
        
        this.currentIndex = (this.currentIndex + 1) % this.keys.length;
        console.log(`[${this.serviceName}] API Key rotated. Now using key index: ${this.currentIndex}`);
        return this.getCurrentKey();
    }
    
    /**
     * Returns the total number of valid keys available.
     */
    getPoolSize() {
        return this.keys.length;
    }
}

// Initialize rotators
export const GeminiKeys = new KeyRotator(GEMINI_KEYS, 'Gemini');
export const GroqKeys = new KeyRotator(GROQ_KEYS, 'Groq');
export const TavilyKeys = new KeyRotator(TAVILY_KEYS, 'Tavily');

/**
 * Utility function to validate core configuration before app startup.
 * Throws a soft error to the console if critical DB/Cache keys are missing.
 */
export function validateConfig() {
    let isValid = true;
    if (!SUPABASE_CONFIG.URL || !SUPABASE_CONFIG.KEY) {
        console.error("[Config Error] Supabase URL or Key is missing.");
        isValid = false;
    }
    if (!UPSTASH_CONFIG.URL || !UPSTASH_CONFIG.TOKEN) {
        console.error("[Config Error] Upstash Redis URL or Token is missing.");
        isValid = false;
    }
    return isValid;
}

// Run validation on import
validateConfig();
