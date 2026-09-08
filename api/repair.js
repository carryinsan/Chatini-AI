import { VerificationOrchestrator, HardFailEvaluator } from './algorithm.js';
/**
 * api/repair.js (Part 1)
 * Autonomous Deterministic Repair Engine
 * Linked to: api/algorithm.js
 */

export const config = {
    runtime: 'edge',
};

// ============================================================================
// 1. REPAIR CLASSIFICATION REGISTRY
// ============================================================================

export const REPAIR_TYPES = Object.freeze({
    USER_DATA_MISMATCH: 'USER_DATA_MISMATCH',
    NUMERIC_ERROR: 'NUMERIC_ERROR',
    CALCULATION_ERROR: 'CALCULATION_ERROR',
    DATE_ERROR: 'DATE_ERROR',
    UNIT_ERROR: 'UNIT_ERROR',
    CURRENCY_ERROR: 'CURRENCY_ERROR',
    URL_ERROR: 'URL_ERROR',
    BROKEN_CITATION: 'BROKEN_CITATION',
    WRONG_CITATION: 'WRONG_CITATION',
    FABRICATED_QUOTE: 'FABRICATED_QUOTE',
    INVALID_JSON: 'INVALID_JSON',
    INVALID_CODE: 'INVALID_CODE',
    INTERNAL_CONTRADICTION: 'INTERNAL_CONTRADICTION',
    MISSING_REQUIRED_FIELD: 'MISSING_REQUIRED_FIELD',
    OUTDATED_SOURCE: 'OUTDATED_SOURCE',
    UNSUPPORTED_CLAIM: 'UNSUPPORTED_CLAIM',
    MISSING_EVIDENCE: 'MISSING_EVIDENCE',
    BAD_FORMAT: 'BAD_FORMAT',
    DUPLICATE_CONTENT: 'DUPLICATE_CONTENT',
    EXCESSIVE_LENGTH: 'EXCESSIVE_LENGTH',
    INSTRUCTION_VIOLATION: 'INSTRUCTION_VIOLATION',
    SEMANTIC_ERROR: 'SEMANTIC_ERROR',
    UNKNOWN: 'UNKNOWN'
});

export class ProblemClassifier {
    /*
     * Maps raw verification statuses from algorithm.js to actionable repair types.
     */
    static classify(verificationError) {
        if (!verificationError || !verificationError.type) return REPAIR_TYPES.UNKNOWN;

        const typeMap = {
            'MUTATION_DETECTED': REPAIR_TYPES.USER_DATA_MISMATCH,
            'CONTRADICTION': REPAIR_TYPES.INTERNAL_CONTRADICTION,
            'UNSUPPORTED_USER_FACT': REPAIR_TYPES.UNSUPPORTED_CLAIM,
            'CALCULATION_MISMATCH': REPAIR_TYPES.CALCULATION_ERROR,
            'NOT_FOUND': REPAIR_TYPES.FABRICATED_QUOTE,
            'INVALID_JSON': REPAIR_TYPES.INVALID_JSON,
            'IMPOSSIBLE_DATE': REPAIR_TYPES.DATE_ERROR,
            'DIMENSIONAL_ERROR': REPAIR_TYPES.UNIT_ERROR,
            'CONVERSION_MISMATCH': REPAIR_TYPES.CURRENCY_ERROR
        };

        return typeMap[verificationError.type] || REPAIR_TYPES.UNKNOWN;
    }
}

// ============================================================================
// 2. DIRECT REPLACEMENT ENGINE (LOCAL REPAIR)
// ============================================================================

export class DirectReplacer {
    /*
     * Executes the highest-quality local repair: direct string/value replacement.
     * Bypasses AI regeneration by swapping the hallucinated value with the authoritative one.
     */
    static attemptRepair(rawAiText, errorContext) {
        if (!rawAiText || !errorContext) return { success: false, text: rawAiText };

        // 1. Strict Identity Check: Do not guess. Do not repair without exact knowledge.
        if (!errorContext.attribute || !errorContext.entity || !errorContext.scope || errorContext.expected === undefined) {
            return { success: false, text: rawAiText, reason: 'Missing canonical identity or expected value' };
        }

        const { expected, received, claimContext } = errorContext;

        if (received === undefined) {
            return { success: false, text: rawAiText, reason: 'Missing received value' };
        }

        // Convert values to strings for regex operations
        const expectedStr = String(expected);
        const receivedStr = String(received);

        // Escape received string for safe RegEx compilation
        const escapeRegEx = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        
        // 2. Strict Contextual Replacement ONLY. Disable global numeric replacement.
        if (claimContext && rawAiText.includes(claimContext)) {
            const repairedClaim = claimContext.replace(new RegExp(escapeRegEx(receivedStr), 'g'), expectedStr);
            const repairedText = rawAiText.replace(claimContext, repairedClaim);
            
            return {
                success: repairedText !== rawAiText,
                text: repairedText,
                method: 'CONTEXTUAL_REPLACEMENT'
            };
        }

        // If exact context isn't found, DO NOT fall back to global replacement.
        return {
            success: false,
            text: rawAiText,
            reason: 'Claim context not found; global replacement disabled for safety'
        };
    }

        // Fallback: Global exact match replacement
        // Note: Uses word boundaries to prevent replacing '50000' inside '1500000'
        const globalRegex = new RegExp(`\\b${escapeRegEx(receivedStr)}\\b`, 'g');
        const repairedText = rawAiText.replace(globalRegex, expectedStr);

        return {
            success: repairedText !== rawAiText,
            text: repairedText,
            method: 'GLOBAL_REPLACEMENT'
        };
    }

    /*
     * Processes a batch of errors that qualify for direct deterministic replacement.
     */
    static processBatch(rawAiText, errors) {
        let currentText = rawAiText;
        let successfulRepairs = 0;

        const replaceableErrors = errors.filter(e => 
            this.isReplaceable(ProblemClassifier.classify(e))
        );

        for (const err of replaceableErrors) {
            const repairAttempt = this.attemptRepair(currentText, err);
            if (repairAttempt.success) {
                currentText = repairAttempt.text;
                successfulRepairs++;
            }
        }

        return {
            text: currentText,
            repairsMade: successfulRepairs,
            fullyRepaired: successfulRepairs === replaceableErrors.length
        };
    }

    /*
     * Determines if an error type is safe for direct string replacement.
     */
    static isReplaceable(repairType) {
        const safeTypes = new Set([
            REPAIR_TYPES.USER_DATA_MISMATCH,
            REPAIR_TYPES.NUMERIC_ERROR,
            REPAIR_TYPES.CALCULATION_ERROR,
            REPAIR_TYPES.DATE_ERROR
        ]);
        return safeTypes.has(repairType);
    }
}
// ============================================================================
// 3. CALCULATION REPAIR ENGINE
// ============================================================================

export class CalculationRepairer {
    /*
     * Completely deterministic repair for math operations.
     * Replaces incorrect AI calculations (taxes, totals, conversions) with 
     * the authoritative result from the SafeMathParser/CalculationVerifier.
     * Input: rawAiText (String), calcError (Object containing expected and received)
     * Output: Object { success: Boolean, text: String }
     */
    static repairCalculation(rawAiText, calcError) {
        if (!rawAiText || !calcError) return { success: false, text: rawAiText };

        const { expected, received, claimContext } = calcError;

        if (expected === undefined || received === undefined) {
            return { success: false, text: rawAiText, reason: 'Missing calculation values' };
        }

        // Format the expected deterministic number to match the AI's formatting style
        const formattedExpected = this.matchFormatting(expected, String(received));
        const receivedStr = String(received);

        const escapeRegEx = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        
        // If we have the exact equation string (e.g., "₹50,000 × 18% = ₹8,000")
        if (claimContext && rawAiText.includes(claimContext)) {
            const repairedClaim = claimContext.replace(new RegExp(escapeRegEx(receivedStr), 'g'), formattedExpected);
            const repairedText = rawAiText.replace(claimContext, repairedClaim);
            
            return {
                success: repairedText !== rawAiText,
                text: repairedText
            };
        }

        // Global fallback replacement with strict word boundaries
        const globalRegex = new RegExp(`\\b${escapeRegEx(receivedStr)}\\b`, 'g');
        const repairedText = rawAiText.replace(globalRegex, formattedExpected);

        return {
            success: repairedText !== rawAiText,
            text: repairedText
        };
    }

    /*
     * Helper to mirror the AI's numeric formatting (e.g., inserting commas).
     * If the AI wrote "8,000", the expected "9000" becomes "9,000".
     */
    static matchFormatting(expectedValue, receivedString) {
        const hasCommas = receivedString.includes(',');
        
        let formatted = String(expectedValue);
        if (hasCommas) {
            // Apply standard grouping (e.g., 9000 -> 9,000)
            const parts = formatted.split('.');
            parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
            formatted = parts.join('.');
        }
        
        return formatted;
    }
}

// ============================================================================
// 4. DATE AUTO-CORRECTOR
// ============================================================================

export class DateRepairer {
    /*
     * Auto-corrects hallucinated weekdays attached to specific dates.
     * Determines the chronological truth and performs a local string replacement.
     * Input: rawAiText (String), dateError (Object containing targetDate and claimedWeekday)
     * Output: Object { success: Boolean, text: String }
     */
    static repairWeekday(rawAiText, dateError) {
        if (!rawAiText || !dateError) return { success: false, text: rawAiText };

        const { targetDateIso, claimedWeekday } = dateError;

        if (!targetDateIso || !claimedWeekday) {
            return { success: false, text: rawAiText, reason: 'Missing date parameters' };
        }

        // Calculate the actual chronological weekday
        const actualDate = new Date(targetDateIso);
        if (isNaN(actualDate)) {
            return { success: false, text: rawAiText, reason: 'Invalid ISO date provided' };
        }

        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const correctWeekday = days[actualDate.getDay()];

        // If the AI actually got it right but was flagged by mistake, abort repair
        if (correctWeekday.toLowerCase() === claimedWeekday.toLowerCase()) {
            return { success: false, text: rawAiText, reason: 'Weekday is already correct' };
        }

        // Case-sensitive replacement matching the AI's casing
        const casedCorrectWeekday = this.matchCasing(correctWeekday, claimedWeekday);
        
        const escapeRegEx = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const weekdayRegex = new RegExp(`\\b${escapeRegEx(claimedWeekday)}\\b`, 'gi');

        // Replace the bad weekday with the actual calculated weekday
        const repairedText = rawAiText.replace(weekdayRegex, (match) => {
            return this.matchCasing(correctWeekday, match);
        });

        return {
            success: repairedText !== rawAiText,
            text: repairedText,
            correctedFrom: claimedWeekday,
            correctedTo: casedCorrectWeekday
        };
    }

    /*
     * Helper to match the casing of the original hallucinated string.
     * Preserves capitalization (e.g., "monday" -> "thursday", "Monday" -> "Thursday").
     */
    static matchCasing(correctString, originalString) {
        if (!originalString || originalString.length === 0) return correctString;

        const isAllUpper = originalString === originalString.toUpperCase();
        const isAllLower = originalString === originalString.toLowerCase();
        const isCapitalized = originalString[0] === originalString[0].toUpperCase() && originalString.slice(1) === originalString.slice(1).toLowerCase();

        if (isAllUpper) return correctString.toUpperCase();
        if (isAllLower) return correctString.toLowerCase();
        if (isCapitalized) return correctString.charAt(0).toUpperCase() + correctString.slice(1).toLowerCase();

        return correctString; // Default fallback
    }
}
// ============================================================================
// 5. UNIT REPAIR ENGINE
// ============================================================================

export class UnitRepairer {
    /*
     * Deterministically auto-corrects hallucinated unit conversions.
     * Replaces the mathematically incorrect AI value with the engine's calculated value.
     * Input: rawAiText (String), unitError (Object containing expected and received values)
     * Output: Object { success: Boolean, text: String }
     */
    static repairUnitConversion(rawAiText, unitError) {
        if (!rawAiText || !unitError) return { success: false, text: rawAiText };

        const { expectedValue, receivedValue, claimContext } = unitError;

        if (expectedValue === undefined || receivedValue === undefined) {
            return { success: false, text: rawAiText, reason: 'Missing unit conversion values' };
        }

        // Format the expected number to mirror the AI's string formatting (e.g., adding commas)
        const formattedExpected = this.matchFormatting(expectedValue, String(receivedValue));
        const receivedStr = String(receivedValue);

        const escapeRegEx = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        
        // Scope the replacement to the specific conversion claim to avoid global mutation
        if (claimContext && rawAiText.includes(claimContext)) {
            const repairedClaim = claimContext.replace(new RegExp(escapeRegEx(receivedStr), 'g'), formattedExpected);
            const repairedText = rawAiText.replace(claimContext, repairedClaim);
            
            return {
                success: repairedText !== rawAiText,
                text: repairedText
            };
        }

        // Fallback: Global exact match replacement using word boundaries
        const globalRegex = new RegExp(`\\b${escapeRegEx(receivedStr)}\\b`, 'g');
        const repairedText = rawAiText.replace(globalRegex, formattedExpected);

        return {
            success: repairedText !== rawAiText,
            text: repairedText
        };
    }

    /*
     * Mirrors the AI's numerical formatting to ensure a seamless string replacement.
     */
    static matchFormatting(expectedValue, receivedString) {
        const hasCommas = receivedString.includes(',');
        
        let formatted = String(expectedValue);
        if (hasCommas) {
            const parts = formatted.split('.');
            parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
            formatted = parts.join('.');
        }
        
        return formatted;
    }
}

// ============================================================================
// 6. CURRENCY CONVERSION REPAIR
// ============================================================================

export class CurrencyRepairer {
    /*
     * Repairs hallucinatory exchange rates by fetching external trusted data,
     * calculating locally, and overwriting the output. No AI required.
     * Flow: Claim -> Retrieve Rate -> Calculate Locally -> Replace.
     * Input: rawAiText (String), conversionData (Object), rateFetcher (Async Function)
     * Output: Object { success: Boolean, text: String }
     */
    static async repairCurrencyConversion(rawAiText, conversionData, rateFetcher) {
        if (!rawAiText || !conversionData || typeof rateFetcher !== 'function') {
            return { success: false, text: rawAiText, reason: 'Missing required conversion parameters or fetcher' };
        }

        const { sourceAmount, sourceCurrency, targetCurrency, claimedTargetAmount, claimContext } = conversionData;

        try {
            // 1. Retrieve trusted external rate
            const currentRate = await rateFetcher(sourceCurrency, targetCurrency);
            
            if (!currentRate || isNaN(currentRate)) {
                return { success: false, text: rawAiText, reason: 'Failed to retrieve trusted exchange rate' };
            }

            // 2. Calculate locally
            const deterministicTarget = sourceAmount * currentRate;

            // Optional: Round to 2 decimal places for standard currency representation
            const roundedTarget = Math.round(deterministicTarget * 100) / 100;

            // 3. Format and Replace
            const formattedTarget = UnitRepairer.matchFormatting(roundedTarget, String(claimedTargetAmount));
            const claimedTargetStr = String(claimedTargetAmount);
            
            const escapeRegEx = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

            if (claimContext && rawAiText.includes(claimContext)) {
                const repairedClaim = claimContext.replace(new RegExp(escapeRegEx(claimedTargetStr), 'g'), formattedTarget);
                const repairedText = rawAiText.replace(claimContext, repairedClaim);

                return {
                    success: repairedText !== rawAiText,
                    text: repairedText,
                    appliedRate: currentRate
                };
            }

            // Global fallback
            const globalRegex = new RegExp(`\\b${escapeRegEx(claimedTargetStr)}\\b`, 'g');
            const repairedText = rawAiText.replace(globalRegex, formattedTarget);

            return {
                success: repairedText !== rawAiText,
                text: repairedText,
                appliedRate: currentRate
            };

        } catch (e) {
            return { success: false, text: rawAiText, reason: `Currency repair failed: ${e.message}` };
        }
    }
}
// ============================================================================
// 7. BROKEN URL REPAIR ENGINE
// ============================================================================

export class UrlRepairer {
    /*
     * Attempts to locally repair broken 404 URLs generated by the AI.
     * Evaluates redirects, canonicals, and sitemaps to find unambiguous replacements.
     * Input: rawAiText (String), urlError (Object containing the brokenUrl)
     * Output: Object { success: Boolean, text: String, status: String }
     */
    static async repairBrokenUrl(rawAiText, urlError) {
        if (!rawAiText || !urlError || !urlError.brokenUrl) {
            return { success: false, text: rawAiText, status: 'INVALID_PARAMETERS' };
        }

        const brokenUrl = urlError.brokenUrl;

        try {
            // 1. Evaluate possible replacements (Redirects, Canonicals, Sitemaps, Title matching)
            const replacementUrl = await this.findUnambiguousReplacement(brokenUrl);

            if (replacementUrl) {
                // If a reliable replacement exists, replace it automatically
                const escapeRegEx = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                const urlRegex = new RegExp(escapeRegEx(brokenUrl), 'g');
                
                const repairedText = rawAiText.replace(urlRegex, replacementUrl);

                return {
                    success: repairedText !== rawAiText,
                    text: repairedText,
                    status: 'URL_REPAIRED',
                    original: brokenUrl,
                    replacement: replacementUrl
                };
            } else {
                // Do not invent another URL if no reliable replacement exists
                return {
                    success: false,
                    text: rawAiText,
                    status: 'CANNOT_REPAIR'
                };
            }
        } catch (e) {
            return { success: false, text: rawAiText, status: 'CANNOT_REPAIR' };
        }
    }

    /*
     * Simulates the deterministic network pipeline required to resolve a broken URL.
     * Checks redirects, canonical tags, same-domain matches, and sitemap/indexes.
     */
    static async findUnambiguousReplacement(brokenUrl) {
        // In a live environment, this executes actual HTTP HEAD/GET requests and DOM parsing.
        // It checks if the server returns a 301/302, looks for <link rel="canonical">, 
        // or searches the domain's /sitemap.xml for the closest matching slug.
        
        // Stub: Simulating an unambiguous sitemap resolution
        if (brokenUrl.endsWith('/abc')) {
            return brokenUrl.replace('/abc', '/abc-2026');
        }

        return null; // Return null if ambiguous or unresolvable
    }
}

// ============================================================================
// 8. WRONG CITATION REPAIR ENGINE
// ============================================================================

export class CitationRepairer {
    /*
     * Auto-corrects numeric or factual values where the AI misquoted a source.
     * If the source lacks the info entirely, it flags it as UNSUPPORTED_CLAIM.
     * Input: rawAiText (String), citationError (Object containing claim, sourceValue)
     * Output: Object { success: Boolean, text: String, status: String }
     */
    static repairCitation(rawAiText, citationError) {
        if (!rawAiText || !citationError) return { success: false, text: rawAiText };

        const { claimValue, sourceValue, claimContext } = citationError;

        // If the source doesn't contain the required information at all, don't guess.
        if (sourceValue === undefined || sourceValue === null) {
            return {
                success: false,
                text: rawAiText,
                status: 'UNSUPPORTED_CLAIM',
                reason: 'Source does not contain the required information.'
            };
        }

        // If we know the authoritative source value, perform a direct replacement
        const expectedStr = String(sourceValue);
        const receivedStr = String(claimValue);
        const escapeRegEx = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        let repairedText = rawAiText;

        if (claimContext && rawAiText.includes(claimContext)) {
            const repairedClaim = claimContext.replace(new RegExp(escapeRegEx(receivedStr), 'g'), expectedStr);
            repairedText = rawAiText.replace(claimContext, repairedClaim);
        } else {
            const globalRegex = new RegExp(`\\b${escapeRegEx(receivedStr)}\\b`, 'g');
            repairedText = rawAiText.replace(globalRegex, expectedStr);
        }

        return {
            success: repairedText !== rawAiText,
            text: repairedText,
            status: 'CITATION_REPAIRED'
        };
    }
}

// ============================================================================
// 9. QUOTE AUTO-CORRECTION ENGINE
// ============================================================================

export class QuoteRepairer {
    /*
     * Resolves QUOTE_MISMATCH errors deterministically.
     * Case A: Replaces with exact source wording if found.
     * Case B: Deletes quotation and marks unsupported if completely fabricated.
     * Input: rawAiText (String), quoteError (Object containing aiQuote and sourceText)
     * Output: Object { success: Boolean, text: String, status: String }
     */
    static repairQuote(rawAiText, quoteError) {
        if (!rawAiText || !quoteError) return { success: false, text: rawAiText };

        const { aiQuote, exactSourcePassage } = quoteError;

        if (!aiQuote) return { success: false, text: rawAiText };

        // Ensure we are targeting the actual quote marks used by the AI
        const escapeRegEx = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        
        // Regex to find the quote, accounting for standard and smart quotes
        const quoteRegex = new RegExp(`["“”']${escapeRegEx(aiQuote)}["“”']`, 'g');

        // Case A: Exact intended statement exists elsewhere in the source
        if (exactSourcePassage) {
            const replacement = `"${exactSourcePassage}"`;
            const repairedText = rawAiText.replace(quoteRegex, replacement);

            return {
                success: repairedText !== rawAiText,
                text: repairedText,
                status: 'QUOTE_REPLACED'
            };
        } 
        
        // Case B: No supporting passage exists (completely fabricated)
        // Delete the quotation and the sentence it belongs to if possible, 
        // and mark the claim as unsupported.
        else {
            // A more aggressive regex to strip the surrounding sentence/claim
            const sentenceRegex = new RegExp(`[^.?!]*["“”']${escapeRegEx(aiQuote)}["“”'][^.?!]*[.?!]`, 'g');
            let repairedText = rawAiText.replace(sentenceRegex, '').trim();

            // If the sentence regex failed, just strip the quote itself
            if (repairedText === rawAiText) {
                repairedText = rawAiText.replace(quoteRegex, '').trim();
            }

            return {
                success: repairedText !== rawAiText,
                text: repairedText,
                status: 'QUOTE_DELETED_UNSUPPORTED_CLAIM'
            };
        }
    }
}
// ============================================================================
// 10. CONTRADICTION REPAIR BY AUTHORITY RANKING
// ============================================================================

export class AuthorityRepairer {
    /*
     * Defines the strict hierarchy of truth for conflict resolution.
     * Higher numeric values represent higher authority.
     */
    static get AUTHORITY_HIERARCHY() {
        return {
            'USER_EXPLICIT_DATA': 50,
            'CURRENT_VERIFIED_PRIMARY_SOURCE': 40,
            'VERIFIED_SECONDARY_SOURCE': 30,
            'DERIVED_CALCULATION': 20,
            'MODEL_GENERATED_CLAIM': 10
        };
    }

    /*
     * Evaluates two contradicting facts and returns the one with higher authority.
     * Input: factA (Object), factB (Object)
     * Output: Object (The winning fact)
     */
    static resolveAuthority(factA, factB) {
        const authA = this.AUTHORITY_HIERARCHY[factA.source_type] || 0;
        const authB = this.AUTHORITY_HIERARCHY[factB.source_type] || 0;

        // If authorities are strictly equal, we cannot deterministically repair without human intervention
        if (authA === authB) return null;

        return authA > authB ? factA : factB;
    }

    /*
     * Repairs an internal contradiction by overwriting the lower-authority claim
     * with the unambiguous higher-authority value.
     * Input: rawAiText (String), contradictionError (Object)
     * Output: Object { success: Boolean, text: String, status: String }
     */
    static repairContradiction(rawAiText, contradictionError) {
        if (!rawAiText || !contradictionError) return { success: false, text: rawAiText };

        const { factA, factB } = contradictionError;
        
        const winningFact = this.resolveAuthority(factA, factB);
        if (!winningFact) {
            return { 
                success: false, 
                text: rawAiText, 
                status: 'AMBIGUOUS_AUTHORITY',
                reason: 'Cannot resolve contradiction automatically; authorities are equal or unknown.' 
            };
        }

        const losingFact = winningFact === factA ? factB : factA;

        const expectedStr = String(winningFact.value);
        const receivedStr = String(losingFact.value);
        const escapeRegEx = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        // Scope the replacement to the specific hallucinated statement if context is available
        let repairedText = rawAiText;
        if (losingFact.context && rawAiText.includes(losingFact.context)) {
            const repairedClaim = losingFact.context.replace(new RegExp(escapeRegEx(receivedStr), 'g'), expectedStr);
            repairedText = rawAiText.replace(losingFact.context, repairedClaim);
        } else {
            // Global fallback
            const globalRegex = new RegExp(`\\b${escapeRegEx(receivedStr)}\\b`, 'g');
            repairedText = rawAiText.replace(globalRegex, expectedStr);
        }

        return {
            success: repairedText !== rawAiText,
            text: repairedText,
            status: 'CONTRADICTION_REPAIRED_BY_AUTHORITY'
        };
    }
}

// ============================================================================
// 11. STRUCTURED DATA AUTO-REPAIR ENGINE
// ============================================================================

export class StructuredDataRepairer {
    /*
     * Attempts to repair broken JSON strings (missing commas, trailing commas, wrong quotes)
     * before coercing types to match the expected schema. No AI required.
     * Input: rawJsonString (String), expectedSchema (Object)
     * Output: Object { success: Boolean, data: Object/String, status: String }
     */
    static repairJSON(rawJsonString, expectedSchema) {
        if (!rawJsonString) return { success: false, data: null };

        let parsedData = null;

        // 1. Syntax Level Repair (Trailing commas, unquoted keys, single quotes)
        let cleanedString = rawJsonString
            .replace(/,\s*([}\]])/g, '$1') // Remove trailing commas
            .replace(/([{,]\s*)([A-Za-z0-9_]+)\s*:/g, '$1"$2":') // Quote unquoted keys
            .replace(/'([^']*)'/g, '"$1"'); // Replace single quotes with double quotes

        try {
            parsedData = JSON.parse(cleanedString);
        } catch (e) {
            return { 
                success: false, 
                data: rawJsonString, 
                status: 'UNRECOVERABLE_SYNTAX_ERROR' 
            };
        }

        // 2. Schema Level Repair (Type coercion, missing/extra fields)
        if (expectedSchema) {
            parsedData = this.enforceSchema(parsedData, expectedSchema);
        }

        return {
            success: true,
            data: parsedData,
            status: 'STRUCTURED_DATA_REPAIRED',
            repairedString: JSON.stringify(parsedData, null, 2)
        };
    }

    /*
     * Recursively traverses a JSON object and coerces values to match the schema.
     * Example: "19" -> 19 if schema specifies integer.
     */
    static enforceSchema(data, schema) {
        if (data === null || data === undefined) return data;

        // Type Coercion
        if (schema.type) {
            if (schema.type === 'integer' || schema.type === 'number') {
                if (typeof data === 'string') {
                    const parsedNum = schema.type === 'integer' ? parseInt(data, 10) : parseFloat(data);
                    if (!isNaN(parsedNum)) {
                        data = parsedNum;
                    }
                }
            } else if (schema.type === 'string' && typeof data !== 'string') {
                data = String(data);
            } else if (schema.type === 'boolean' && typeof data === 'string') {
                const lower = data.trim().toLowerCase();
                if (lower === 'true') data = true;
                if (lower === 'false') data = false;
            }
        }

        // Object property enforcement
        if (typeof data === 'object' && !Array.isArray(data)) {
            // Remove extra properties if strict schema
            if (schema.additionalProperties === false) {
                Object.keys(data).forEach(key => {
                    if (!schema.properties || !schema.properties[key]) {
                        delete data[key];
                    }
                });
            }

            // Recurse into defined properties
            if (schema.properties) {
                Object.keys(schema.properties).forEach(key => {
                    if (data[key] !== undefined) {
                        data[key] = this.enforceSchema(data[key], schema.properties[key]);
                    } 
                    // Optional: Inject missing required fields with safe defaults if unambiguous
                    else if (schema.required && schema.required.includes(key)) {
                        const propSchema = schema.properties[key];
                        if (propSchema.type === 'string') data[key] = "";
                        if (propSchema.type === 'array') data[key] = [];
                        if (propSchema.type === 'boolean') data[key] = false;
                    }
                });
            }
        }

        // Array items enforcement
        if (Array.isArray(data) && schema.items) {
            data = data.map(item => this.enforceSchema(item, schema.items));
        }

        return data;
    }
}
// ============================================================================
// 12. CODE REPAIR ENGINE
// Reference: Algorithm.docx
// ============================================================================

export class CodeRepairer {
    /*
     * Attempts mechanical repairs on AI-generated code before falling back to an LLM retry.
     * Fixes missing brackets, wrong quotes, and obvious delimiter mismatches deterministically.
     * Input: codeString (String), language (String)
     * Output: Object { success: Boolean, repairedCode: String, status: String }
     */
    static attemptMechanicalRepair(codeString, language) {
        if (!codeString) return { success: false, repairedCode: codeString, status: 'EMPTY_CODE' };

        let repaired = codeString;

        // 1. Replace typographic "smart quotes" with valid string literal quotes
        repaired = repaired.replace(/[“”]/g, '"').replace(/[‘’]/g, "'");

        // 2. Balance missing braces/brackets (often caused by LLM output truncation)
        const openBraces = (repaired.match(/\{/g) || []).length;
        const closeBraces = (repaired.match(/\}/g) || []).length;
        if (openBraces > closeBraces) {
            repaired += '\n' + '}'.repeat(openBraces - closeBraces);
        }

        const openBrackets = (repaired.match(/\[/g) || []).length;
        const closeBrackets = (repaired.match(/\]/g) || []).length;
        if (openBrackets > closeBrackets) {
            repaired += ']'.repeat(openBrackets - closeBrackets);
        }

        const openParens = (repaired.match(/\(/g) || []).length;
        const closeParens = (repaired.match(/\)/g) || []).length;
        if (openParens > closeParens) {
            repaired += ')'.repeat(openParens - closeParens);
        }

        // 3. Fix missing commas in object/array literals (heuristic for JS/JSON/Python)
        if (['javascript', 'json', 'python', 'js'].includes((language || '').toLowerCase())) {
            // Adds a comma to lines ending with a string or number immediately followed by a new line with another key/value
            repaired = repaired.replace(/(["'\d])\s*\n\s*(["'{[a-zA-Z_]+)/g, '$1,\n$2');
        }

        const isModified = repaired !== codeString;

        return {
            success: isModified,
            repairedCode: repaired,
            status: isModified ? 'MECHANICAL_REPAIR_APPLIED' : 'NO_REPAIR_NEEDED',
            instruction: isModified ? 'Execute in sandbox to verify repair, else RETRY AI.' : 'RETRY AI.'
        };
    }
}

// ============================================================================
// 13. FORMATTING REPAIR ENGINE
// Reference: Algorithm.docx
// ============================================================================

export class FormattingRepairer {
    /*
     * Orchestrates a complete suite of formatting repairs locally.
     * Prevents triggering the AI for cosmetic or structural text flaws.
     * Input: rawAiText (String)
     * Output: Object { success: Boolean, text: String, status: String }
     */
    static repairFormatting(rawAiText) {
        if (!rawAiText) return { success: false, text: rawAiText };

        let repaired = rawAiText;

        repaired = this.repairWhitespace(repaired);
        repaired = this.repairDuplicateHeadings(repaired);
        repaired = this.repairListNumbering(repaired);
        repaired = this.repairJsonIndentation(repaired);
        
        // Basic invalid HTML tag closure heuristic
        repaired = this.repairUnclosedHtmlTags(repaired);

        return {
            success: repaired !== rawAiText,
            text: repaired,
            status: repaired !== rawAiText ? 'FORMATTING_REPAIRED' : 'NO_FORMATTING_ERRORS'
        };
    }

    /*
     * Removes excessive whitespace and multiple blank lines.
     */
    static repairWhitespace(text) {
        return text
            .replace(/\n{3,}/g, '\n\n') // Collapse 3+ newlines into 2
            .replace(/ {3,}/g, ' ')     // Collapse 3+ spaces into 1 (preserves normal indentation)
            .trim();
    }

    /*
     * Removes immediately consecutive duplicate markdown headings.
     */
    static repairDuplicateHeadings(text) {
        // Looks for identical headings separated only by whitespace/newlines
        const duplicateHeadingRegex = /^(#{1,6})\s+(.+)(?:\n\s*)+\1\s+\2$/gm;
        return text.replace(duplicateHeadingRegex, '$1 $2');
    }

    /*
     * Fixes broken or repeating ordered list numbering (e.g., 1. 1. 1. -> 1. 2. 3.)
     */
    static repairListNumbering(text) {
        const lines = text.split('\n');
        let inList = false;
        let counter = 1;

        for (let i = 0; i < lines.length; i++) {
            const listMatch = lines[i].match(/^(\s*)\d+\.\s+(.*)/);
            if (listMatch) {
                if (!inList) {
                    inList = true;
                    counter = 1; // reset on new list
                }
                lines[i] = `${listMatch[1]}${counter}.${listMatch[2]}`;
                counter++;
            } else if (lines[i].trim() !== '') {
                inList = false; // break list if non-empty, non-list line encountered
            }
        }

        return lines.join('\n');
    }

    /*
     * Extracts JSON blocks from markdown and forcefully applies consistent 2-space indentation.
     */
    static repairJsonIndentation(text) {
        const jsonBlockRegex = /```json\s+([\s\S]+?)\s+```/g;
        
        return text.replace(jsonBlockRegex, (match, jsonContent) => {
            try {
                // Attempt to parse and stringify with proper formatting
                const parsed = JSON.parse(jsonContent);
                const formatted = JSON.stringify(parsed, null, 2);
                return '```json\n' + formatted + '\n```';
            } catch (e) {
                // If it fails to parse, return the original string to avoid data loss
                return match;
            }
        });
    }

    /*
     * Fixes common unclosed HTML tags (like <b>, <i>, <strong>, <em>).
     */
    static repairUnclosedHtmlTags(text) {
        const tagsToBalance = ['b', 'i', 'strong', 'em', 'code'];
        let repaired = text;

        tagsToBalance.forEach(tag => {
            const openRegex = new RegExp(`<${tag}>`, 'gi');
            const closeRegex = new RegExp(`</${tag}>`, 'gi');
            
            const openCount = (repaired.match(openRegex) || []).length;
            const closeCount = (repaired.match(closeRegex) || []).length;

            if (openCount > closeCount) {
                repaired += `</${tag}>`.repeat(openCount - closeCount);
            }
        });

        return repaired;
    }
}
// ============================================================================
// 14. UNSUPPORTED CLAIM REPAIR ENGINE
// Reference: Algorithm.docx
// ============================================================================

export class UnsupportedClaimRepairer {
    /*
     * Safely removes or obfuscates claims that completely lack authoritative evidence.
     * Prevents the AI from guessing or inventing a second hallucination.
     * Input: rawAiText (String), errorReport (Object containing the unsupported claim)
     * Output: Object { success: Boolean, text: String, status: String }
     */
    static handleUnsupported(rawAiText, errorReport) {
        if (!rawAiText || !errorReport) return { success: false, text: rawAiText };

        const { claim, claimContext, strategy = 'REMOVE_SENTENCE' } = errorReport;

        if (!claim) return { success: false, text: rawAiText, reason: 'Missing claim string' };

        const escapeRegEx = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        let repairedText = rawAiText;

        if (strategy === 'REMOVE_SENTENCE') {
            // Locates the entire sentence containing the unsupported claim and removes it.
            // Matches from the preceding sentence boundary to the closing punctuation.
            const sentenceRegex = new RegExp(`[^.?!]*\\b${escapeRegEx(claim)}\\b[^.?!]*[.?!]`, 'g');
            repairedText = rawAiText.replace(sentenceRegex, '').replace(/\s{2,}/g, ' ').trim();
            
            // Fallback: If sentence removal failed (e.g., bullet point without punctuation), strip the exact context
            if (repairedText === rawAiText && claimContext) {
                repairedText = rawAiText.replace(new RegExp(escapeRegEx(claimContext), 'g'), '').trim();
            }
        } 
        else if (strategy === 'OBFUSCATE_VALUE') {
            // Replaces the specific hallucinated number/value with a safe disclaimer
            const disclaimer = "[Data could not be verified]";
            const valueRegex = new RegExp(`\\b${escapeRegEx(claim)}\\b`, 'g');
            repairedText = rawAiText.replace(valueRegex, disclaimer);
        }

        return {
            success: repairedText !== rawAiText,
            text: repairedText,
            status: 'UNSUPPORTED_CLAIM_REMOVED'
        };
    }
}

// ============================================================================
// 15. EVIDENCE REPLACEMENT & CASCADING CALCULATION ENGINE
// Reference: Algorithm.docx
// ============================================================================

export class CascadeRepairEngine {
    /*
     * Executes a cascading repair when an authoritative value replaces an incorrect one.
     * Recalculates all dependent formulas and replaces their outputs in the text.
     * Input: rawAiText (String), primaryCorrection (Object), dependentCalcs (Array of Objects)
     * Output: Object { success: Boolean, text: String, status: String }
     */
    static executeCascade(rawAiText, primaryCorrection, dependentCalcs = []) {
        if (!rawAiText || !primaryCorrection) return { success: false, text: rawAiText };

        const { oldPrimaryValue, newPrimaryValue } = primaryCorrection;
        let currentText = rawAiText;
        let repairsMade = 0;

        const escapeRegEx = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

        // Step 1: Replace the primary authoritative value (e.g., 18% -> 12%)
        const primaryRegex = new RegExp(`\\b${escapeRegEx(String(oldPrimaryValue))}\\b`, 'g');
        if (primaryRegex.test(currentText)) {
            currentText = currentText.replace(primaryRegex, String(newPrimaryValue));
            repairsMade++;
        }

        // Step 2: Iterate through dependent calculations and repair them locally
        for (const calc of dependentCalcs) {
            // calc requires: equationTemplate, oldResult, newResult
            // e.g., { equationTemplate: "₹10,000 × {tax_rate}", oldResult: "1,800", newResult: "1,200" }
            
            if (calc.oldResult !== undefined && calc.newResult !== undefined) {
                const oldResultStr = String(calc.oldResult);
                const newResultStr = String(calc.newResult);
                
                // Formats the new result to match the AI's presentation style (e.g., comma insertion)
                const formattedNewResult = this.matchFormatting(newResultStr, oldResultStr);

                // Replaces the dependent result
                const calcRegex = new RegExp(`\\b${escapeRegEx(oldResultStr)}\\b`, 'g');
                
                // If context is provided, scope the replacement
                if (calc.claimContext && currentText.includes(calc.claimContext)) {
                    const scopedClaim = calc.claimContext
                        .replace(primaryRegex, String(newPrimaryValue)) // Ensure primary is swapped in context
                        .replace(calcRegex, formattedNewResult);
                    
                    currentText = currentText.replace(calc.claimContext, scopedClaim);
                    repairsMade++;
                } else {
                    currentText = currentText.replace(calcRegex, formattedNewResult);
                    repairsMade++;
                }
            }
        }

        return {
            success: repairsMade > 0,
            text: currentText,
            status: 'CASCADING_REPAIR_COMPLETE',
            repairs_executed: repairsMade
        };
    }

    /*
     * Helper to mirror numerical formatting during cascading replacements.
     */
    static matchFormatting(expectedValue, receivedString) {
        const hasCommas = receivedString.includes(',');
        
        let formatted = String(expectedValue);
        if (hasCommas) {
            const parts = formatted.split('.');
            parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
            formatted = parts.join('.');
        }
        
        return formatted;
    }
}
// ============================================================================
// 16. DEPENDENCY GRAPH ENGINE
// Reference: Algorithm.docx
// ============================================================================

export class DependencyGraph {
    constructor() {
        this.nodes = new Map(); // Stores values: { id: 'GST_RATE', value: 0.12 }
        this.edges = new Map(); // Stores dependencies: { id: 'GST_AMOUNT', formula: (nodes) => nodes.get('PRICE') * nodes.get('GST_RATE'), dependencies: ['PRICE', 'GST_RATE'] }
    }

    /*
     * Registers a static fact or a derived calculation in the graph.
     * Input: id (String), valueOrFormula (Number or Function), dependencies (Array of Strings)
     */
    registerNode(id, valueOrFormula, dependencies = []) {
        if (typeof valueOrFormula === 'function') {
            this.edges.set(id, { formula: valueOrFormula, dependencies });
            this.recalculateNode(id);
        } else {
            this.nodes.set(id, valueOrFormula);
        }
    }

    /*
     * Updates a root fact and automatically triggers a cascading recalculation of all dependent nodes.
     * Input: id (String), newValue (Number)
     */
    updateFact(id, newValue) {
        if (!this.nodes.has(id) && !this.edges.has(id)) return false;
        
        this.nodes.set(id, newValue);
        
        // Find and update all dependent nodes recursively
        this.edges.forEach((edgeData, edgeId) => {
            if (edgeData.dependencies.includes(id)) {
                this.recalculateNode(edgeId);
            }
        });
        return true;
    }

    /*
     * Resolves a formula based on current graph state.
     */
    recalculateNode(id) {
        const edge = this.edges.get(id);
        if (!edge) return;

        // Ensure all dependencies exist before calculating
        const allDepsResolved = edge.dependencies.every(dep => this.nodes.has(dep));
        if (allDepsResolved) {
            const calculatedValue = edge.formula(this.nodes);
            this.nodes.set(id, calculatedValue);
            
            // Cascade to subsequent dependents
            this.edges.forEach((childEdgeData, childEdgeId) => {
                if (childEdgeData.dependencies.includes(id)) {
                    this.recalculateNode(childEdgeId);
                }
            });
        }
    }

    getFact(id) {
        return this.nodes.get(id);
    }
}

// ============================================================================
// 17-21. ACTION MATRIX, QUALITY VECTOR & ROUTING ENGINE
// Reference: Algorithm.docx
// ============================================================================

export const ACTION_MATRIX = Object.freeze({
    NUMERIC_ERROR:           { autoRepair: true,  externalSource: false, retryAi: false },
    CALCULATION_ERROR:       { autoRepair: true,  externalSource: false, retryAi: false },
    DATE_ERROR:              { autoRepair: true,  externalSource: false, retryAi: false },
    UNIT_ERROR:              { autoRepair: true,  externalSource: false, retryAi: false },
    USER_DATA_MISMATCH:      { autoRepair: true,  externalSource: false, retryAi: false },
    BROKEN_URL:              { autoRepair: true,  externalSource: true,  retryAi: false },
    CITATION_MISMATCH:       { autoRepair: true,  externalSource: true,  retryAi: false },
    FABRICATED_QUOTE:        { autoRepair: true,  externalSource: true,  retryAi: false },
    INVALID_JSON:            { autoRepair: true,  externalSource: false, retryAi: false },
    FORMATTING_ERROR:        { autoRepair: true,  externalSource: false, retryAi: false },
    CODE_SYNTAX_ERROR:       { autoRepair: true,  externalSource: false, retryAi: true },
    UNSUPPORTED_CLAIM:       { autoRepair: true,  externalSource: true,  retryAi: false }, // Remove/replace
    MISSING_EVIDENCE:        { autoRepair: false, externalSource: true,  retryAi: true },  // Requires retrieve
    SEMANTIC_ERROR:          { autoRepair: false, externalSource: false, retryAi: true },
    AMBIGUOUS_INTERPRETATION:{ autoRepair: false, externalSource: false, retryAi: true },
    FUNDAMENTALLY_BAD_ANSWER:{ autoRepair: false, externalSource: false, retryAi: true }
});

export class RoutingEngine {
    /*
     * The final deterministic decision engine. Evaluates the multi-dimensional 
     * quality vector and hard fail states to route the system output.
     * Input: resultState (Object containing quality vector, errors, hardFails)
     * Output: String (Routing Decision)
     */
    static decide(resultState) {
        if (resultState.hardFail) {
            return "RETRY_AI";
        }

        if (resultState.repairableErrors > 0) {
            return "LOCAL_REPAIR";
        }

        if (resultState.needsFreshEvidence) {
            return "RETRIEVE_AND_REPAIR";
        }

        // Aggregate quality score from the Quality Vector (User Adherence, Facts, Cits, Consistency, etc.)
        if (resultState.qualityScore >= 90) {
            return "ACCEPT";
        }

        if (resultState.semanticErrors > 0) {
            return "RETRY_AI";
        }

        if (resultState.qualityScore < 70) {
            return "RETRY_AI";
        }

        return "ACCEPT_WITH_WARNING";
    }
}

// ============================================================================
// 22. MASTER REPAIR PIPELINE (SAFETY RULE ENFORCEMENT)
// Reference: Algorithm.docx
// ============================================================================

export class MasterRepairPipeline {
    /*
     * Executes the "Repair Budget before AI Budget" loop.
     * Ensures safety by only applying deterministic, authoritative corrections.
     * Input: aiResponse (String), verifierPayload (Object)
     * Output: Processed Response (Object)
     */
    static async execute(aiResponse, verifierPayload) {
        let currentText = aiResponse;
        let attemptState = { text: currentText, status: 'UNVERIFIED' };

        // ATTEMPT 0: Verify original AI answer
        let verificationResult = this.runVerificationStub(currentText, verifierPayload);
        let decision = RoutingEngine.decide(verificationResult);

        if (decision === 'ACCEPT' || decision === 'ACCEPT_WITH_WARNING') {
            return { text: currentText, status: decision, passes: 0 };
        }

        // REPAIR PASS 1: Fix obvious deterministic errors (Math, JSON, Dates, Units)
        if (decision === 'LOCAL_REPAIR' || decision === 'RETRIEVE_AND_REPAIR') {
            currentText = this.applyDeterministicRepairs(currentText, verificationResult.errors);
            
            // REVERIFY
            verificationResult = this.runVerificationStub(currentText, verifierPayload);
            decision = RoutingEngine.decide(verificationResult);
            
            if (decision === 'ACCEPT' || decision === 'ACCEPT_WITH_WARNING') {
                return { text: currentText, status: decision, passes: 1 };
            }
        }

        // REPAIR PASS 2: Fix evidence-derived errors (Citations, URLs, Quotes, Missing Evidence)
        if (decision === 'RETRIEVE_AND_REPAIR' || decision === 'LOCAL_REPAIR') {
            currentText = await this.applyEvidenceRepairs(currentText, verificationResult.errors);
            
            // REVERIFY
            verificationResult = this.runVerificationStub(currentText, verifierPayload);
            decision = RoutingEngine.decide(verificationResult);
            
            if (decision === 'ACCEPT' || decision === 'ACCEPT_WITH_WARNING') {
                return { text: currentText, status: decision, passes: 2 };
            }
        }

        // ONLY THEN: AI RETRY
        // If local repair budget is exhausted and quality is still too low, defer to algorithm.js VerificationOrchestrator
        return { 
            text: currentText, 
            status: 'REQUIRES_AI_RETRY', 
            repairableErrorsRemaining: verificationResult.errors.length,
            qualityScore: verificationResult.qualityScore 
        };
    }

    /*
     * Safety Rule Enforcement Wrapper
     * Evaluates if a repair is 100% deterministic and authoritative before applying it.
     */
    static isSafeToRepair(errorContext) {
        // Hard protection: Never mutate canonical user facts
        if (errorContext.source === "user") {
            return false; 
        }

        const matrixDef = ACTION_MATRIX[errorContext.type];
        if (!matrixDef || !matrixDef.autoRepair) return false;
        
        // Ensure authoritative replacement value is present
        if (errorContext.expected === undefined && errorContext.expectedValue === undefined) return false;
        
        return true;
    }

    /* Integrates with DirectReplacer, CalculationRepairer, UnitRepairer, etc. */
    static applyDeterministicRepairs(text, errors) {
        let repaired = text;
        errors.forEach(err => {
            if (this.isSafeToRepair(err)) {
                switch (err.type) {
                    case REPAIR_TYPES.NUMERIC_ERROR:
                    case REPAIR_TYPES.USER_DATA_MISMATCH:
                        repaired = DirectReplacer.attemptRepair(repaired, err).text;
                        break;
                    case REPAIR_TYPES.CALCULATION_ERROR:
                        repaired = CalculationRepairer.repairCalculation(repaired, err).text;
                        break;
                    case REPAIR_TYPES.DATE_ERROR:
                        repaired = DateRepairer.repairWeekday(repaired, err).text;
                        break;
                    case REPAIR_TYPES.UNIT_ERROR:
                        repaired = UnitRepairer.repairUnitConversion(repaired, err).text;
                        break;
                    case REPAIR_TYPES.INVALID_JSON:
                        const jsonFix = StructuredDataRepairer.repairJSON(repaired, null);
                        if (jsonFix.success) repaired = jsonFix.repairedString;
                        break;
                }
            }
        });
        return repaired;
    }

    /* Integrates with CitationRepairer, QuoteRepairer, UrlRepairer, etc. */
    static async applyEvidenceRepairs(text, errors) {
        let repaired = text;
        for (const err of errors) {
            if (err.type === REPAIR_TYPES.UNSUPPORTED_CLAIM) {
                repaired = UnsupportedClaimRepairer.handleUnsupported(repaired, err).text;
            } else if (this.isSafeToRepair(err) && ACTION_MATRIX[err.type] && ACTION_MATRIX[err.type].externalSource) {
                if (err.type === REPAIR_TYPES.BROKEN_CITATION || err.type === REPAIR_TYPES.WRONG_CITATION) {
                    repaired = CitationRepairer.repairCitation(repaired, err).text;
                } else if (err.type === REPAIR_TYPES.FABRICATED_QUOTE) {
                    repaired = QuoteRepairer.repairQuote(repaired, err).text;
                } else if (err.type === REPAIR_TYPES.URL_ERROR) {
                    const urlFix = await UrlRepairer.repairBrokenUrl(repaired, err);
                    repaired = urlFix.text;
                }
            }
        }
        return repaired;
    }

    /* Interface to algorithm.js verification output */
    static runVerificationStub(text, payload) {
        const orchestrator = new VerificationOrchestrator(payload?.domain || 'general');
        const report = orchestrator.runVerificationPipeline(text);
        
        const hardFailState = HardFailEvaluator.check(report);

        return {
            qualityScore: report.aggregatedScore || 0,
            hardFail: hardFailState.hardFail,
            repairableErrors: (report.errors || []).filter(e => ACTION_MATRIX[e.type]?.autoRepair).length,
            needsFreshEvidence: report.missingEvidence || false,
            semanticErrors: (report.warnings || []).length,
            errors: report.errors || []
        };
    }
}
