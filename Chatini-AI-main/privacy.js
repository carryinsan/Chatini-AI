/**
 * ARIXlegal Privacy Engine
 * Client-side pseudonymization and PII detection. 
 * Enforces Rule 70 (Pseudonymization) and Rule 72 (Leak Checks).
 */

const privacyConfig = {
    // Standardized placeholder prefixes
    PREFIXES: {
        AADHAAR: 'AADHAAR_',
        PAN: 'PAN_',
        PHONE: 'PHONE_',
        EMAIL: 'EMAIL_',
        CNR: 'CNR_',
        PARTY: 'PARTY_',
        CASE_NUM: 'CASE_NUM_'
    },
    
    // Strict Indian context regex patterns
    PATTERNS: {
        // Indian Aadhaar (12 digits, optional spaces)
        AADHAAR: /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g,
        // Indian PAN Card (5 chars, 4 digits, 1 char)
        PAN: /\b[A-Z]{5}\d{4}[A-Z]{1}\b/gi,
        // Indian Phone (10 digits, optional +91/0 prefix)
        PHONE: /\b(?:\+91[\-\s]?)?0?[6789]\d{9}\b/g,
        // Standard Email
        EMAIL: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/gi,
        // 16-digit CNR format (State + District + Estb + Case Type + Case No + Year)
        CNR: /\b[A-Z]{2}[A-Z0-9]{2}[0-9]{4}[0-9]{6}[0-9]{4}\b/gi
    }
};

/**
 * Secure Local Mapping Vault (Rule 71)
 * Holds the mapping of [PLACEHOLDER] -> Real Value.
 * This object is NEVER sent to the AI provider.
 */
const privacyVault = {
    forwardMap: new Map(), // Real -> Placeholder
    reverseMap: new Map(), // Placeholder -> Real
    counters: {
        AADHAAR: 1, PAN: 1, PHONE: 1, EMAIL: 1, CNR: 1, PARTY: 1, CASE_NUM: 1
    },

    clear() {
        this.forwardMap.clear();
        this.reverseMap.clear();
        Object.keys(this.counters).forEach(k => this.counters[k] = 1);
    },

    getOrCreatePlaceholder(type, realValue) {
        const normalized = realValue.trim().toUpperCase();
        if (this.forwardMap.has(normalized)) {
            return this.forwardMap.get(normalized);
        }

        const count = this.counters[type]++;
        const placeholder = `[${type}${count.toString().padStart(3, '0')}]`;
        
        this.forwardMap.set(normalized, placeholder);
        this.reverseMap.set(placeholder, realValue); // Preserve original casing for restoration
        
        return placeholder;
    },

    getRealValue(placeholder) {
        return this.reverseMap.get(placeholder) || placeholder;
    }
};

/**
 * Core text scanning and replacement logic
 */
const privacyScanner = {
    // Dynamic list of known case entities (e.g., plaintiff names) passed from case.js
    knownEntities: [],

    /**
     * Registers known case entities to be protected via exact string matching.
     * Since frontend regex can't accurately do full NER (Named Entity Recognition),
     * we rely on known structured data for names/companies.
     */
    registerKnownEntities(entities) {
        this.knownEntities = entities.map(e => ({
            real: e.value,
            type: e.type || 'PARTY' // e.g., PARTY, CASE_NUM
        })).sort((a, b) => b.real.length - a.real.length); // Longest first to avoid partial replacements
    },

    /**
     * Replaces all sensitive identifiers in a given text block with placeholders.
     */
    sanitizeText(text) {
        if (!text) return text;
        let sanitized = text;

        // 1. Sanitize standard regex patterns (Aadhaar, PAN, Phone, Email, CNR)
        Object.entries(privacyConfig.PATTERNS).forEach(([type, regex]) => {
            sanitized = sanitized.replace(regex, (match) => {
                return privacyVault.getOrCreatePlaceholder(privacyConfig.PREFIXES[type], match);
            });
        });

        // 2. Sanitize known structured entities (Names, exact case numbers)
        this.knownEntities.forEach(entity => {
            if (!entity.real) return;
            // Escape regex chars in entity name
            const escaped = entity.real.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            // Word boundary regex to avoid partial replacements (e.g. replacing "Ram" inside "Ramesh")
            const entityRegex = new RegExp(`\\b${escaped}\\b`, 'gi');
            
            sanitized = sanitized.replace(entityRegex, (match) => {
                return privacyVault.getOrCreatePlaceholder(privacyConfig.PREFIXES[entity.type], match);
            });
        });

        return sanitized;
    }
};

/**
 * Restores placeholders from AI output back to readable text (Rule 73)
 */
const privacyRestorer = {
    restore(sanitizedText) {
        if (!sanitizedText) return sanitizedText;
        
        let restored = sanitizedText;
        // Find all placeholders matching our format [PREFIX_001]
        const placeholderRegex = /\[[A-Z_]+\d{3}\]/g;
        
        restored = restored.replace(placeholderRegex, (match) => {
            return privacyVault.getRealValue(match);
        });
        
        return restored;
    }
};

/**
 * Pre-flight safety check to block leaks (Rule 72)
 */
const privacyValidator = {
    /**
     * Scans the outgoing payload. If raw PII is detected (meaning sanitization failed
     * or was bypassed), it blocks the request.
     */
    checkOutgoingPayload(payloadString) {
        for (const [type, regex] of Object.entries(privacyConfig.PATTERNS)) {
            // Reset regex state
            regex.lastIndex = 0; 
            if (regex.test(payloadString)) {
                console.error(`[Privacy Gateway] Blocked outbound request. Detected raw ${type}.`);
                return { 
                    safe: false, 
                    reason: `Unverified sensitive identifier (${type}) detected before transmission.` 
                };
            }
        }
        return { safe: true };
    }
};

// Expose modules to the global ARIXlegal application scope
window.privacyVault = privacyVault;
window.privacyScanner = privacyScanner;
window.privacyRestorer = privacyRestorer;
window.privacyValidator = privacyValidator;
