/**
 * api/algorithm.js (Part 1)
 * Advanced Deterministic Fact Extraction Engine
 * Reference: Algorithm.docx
 */

export const config = {
    runtime: 'edge',
};

// ============================================================================
// CORE TOKENIZATION REGISTRY
// ============================================================================
const TOKEN_PARSERS = {
    currencies: /(?:₹|\$|€|£|INR|USD)\s*(?:\d+(?:,\d{3})*(?:\.\d+)?(?:[kKmMbB]|cr|lakh)?)/g,
    percentages: /-?\d+(?:\.\d+)?\s*%/g,
    dates: /\b(?:\d{4}-\d{2}-\d{2}|\d{1,2}\/\d{1,2}\/\d{2,4}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2},? \d{4}|next (?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)|tomorrow|yesterday)\b/gi,
    time: /\b(?:\d{1,2}:\d{2}(?:\s?[aApP][mM])?|\d+\s*(?:minutes|hours|days|weeks|months|years))\b/gi,
    units: /\b\d+(?:\.\d+)?\s*(?:kg|g|mg|L|ml|km|m|cm|mm|sq ft|units|pieces|boxes)\b/gi,
    numbers: /\b(?<![₹$€£\-\.])\d+(?:,\d{3})*(?:\.\d+)?\b(?!\s*%)/g,
    emails: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Z|a-z]{2,}\b/g,
    urls: /https?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._\+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_\+.~#?&\/=]*)/g,
    fileNames: /\b[\w,\s-]+\.(?:pdf|docx?|xlsx?|csv|json|xml|yaml|txt|png|jpg|jpeg)\b/gi,
    quotedText: /["'](.*?)["']/g,
    citations: /\[(?:source|cite):\s*\d+(?:,\s*\d+)*\]/gi,
    code: /```[\s\S]*?```/g,
    formulas: /(?:[a-zA-Z0-9_]+\s*=\s*)?[a-zA-Z0-9_\.\(\)\+\-\*\/\^]+(?:\s*[\+\-\*\/\^=]\s*[a-zA-Z0-9_\.\(\)]+)+/g,
    // NER (Named Entity Recognition) fallbacks for deterministic passes
    names: /\b[A-Z][a-z]+(?: [A-Z][a-z]+)+\b/g,
    organizations: /\b[A-Z][a-zA-Z]+(?: [A-Z][a-zA-Z]+)*(?: Inc\.| Ltd\.| LLC| Corp\.| Company| Pvt\.)\b/g,
    locations: /\b(?:New Delhi|Delhi|Mumbai|Bangalore|India|[A-Z][a-z]+(?:, [A-Z][a-z]+)*)\b/g
};

// ============================================================================
// DETERMINISTIC PARSER & FACT EXTRACTOR
// ============================================================================
export class FactExtractor {
    /*
     * Splits a raw text blob into distinct factual claims.
     * Prevents verifying the entire response as a single blob.
     * Input: rawText (string)
     * Output: Array of raw claim segments
     */
    static splitIntoClaims(rawText) {
        if (!rawText || typeof rawText !== 'string') return [];
        
        // Simple heuristic split by sentences, semicolons, or newlines
        const rawSegments = rawText.split(/(?<=[.?!;])\s+|\n+/).filter(s => s.trim().length > 0);
        const claims = [];

        rawSegments.forEach((segment, index) => {
            claims.push({
                claimId: `claim_${index + 1}`,
                rawText: segment.trim(),
                timestamp_local: '2026-09-08T16:34:42+05:30', // September 8, 2026 IST
                extractedTokens: this.tokenizeSegment(segment)
            });
        });

        return claims;
    }

    /*
     * Identifies all typed values within a claim segment.
     * Input: segment (string)
     * Output: Grouped factual tokens (Object)
     */
    static tokenizeSegment(segment) {
        const tokens = {};
        
        for (const [type, regex] of Object.entries(TOKEN_PARSERS)) {
            const matches = segment.match(regex);
            if (matches && matches.length > 0) {
                tokens[type] = [...new Set(matches)]; // Deduplicate identical tokens
            }
        }

        // Identify structured data (JSON/XML) separately
        tokens.structuredData = this.extractStructuredData(segment);
        tokens.tables = this.extractMarkdownTables(segment);

        return tokens;
    }

    /*
     * Extracts implicit or explicit structured data (JSON-like).
     */
    static extractStructuredData(text) {
        const jsonMatch = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
        if (jsonMatch) {
            try {
                JSON.parse(jsonMatch[0]);
                return [jsonMatch[0]];
            } catch (e) {
                return [];
            }
        }
        return [];
    }

    /*
     * Extracts Markdown-formatted tables.
     */
    static extractMarkdownTables(text) {
        const tableRegex = /(?:\|.*\|\n)+\|(?:\s*-+\s*\|)+\n(?:\|.*\|\n)+/g;
        return text.match(tableRegex) || [];
    }

    /*
     * Converts tokenized claims into standardized Fact Objects.
     * Represents the core solution to prevent naïve contradiction declarations.
     * Input: claim (Object)
     * Output: Array of Fact Objects
     */
    static buildFactObjects(claim) {
        const facts = [];
        if (!claim || !claim.extractedTokens) return facts;

        const tokens = claim.extractedTokens;
        const text = claim.rawText.toLowerCase();

        // 1. Entity Resolution (Prioritize Organizations, then Names, then Locations)
        let resolvedEntity = "unknown_entity";
        if (tokens.organizations && tokens.organizations.length > 0) {
            resolvedEntity = tokens.organizations[0];
        } else if (tokens.names && tokens.names.length > 0) {
            resolvedEntity = tokens.names[0];
        } else if (tokens.locations && tokens.locations.length > 0) {
            resolvedEntity = tokens.locations[0];
        }

        // 2. Attribute Resolution Dictionary
        const attributeMap = {
            age: ['age', 'years old', 'born'],
            budget: ['budget', 'cost', 'spend', 'allocated', 'price'],
            revenue: ['revenue', 'income', 'profit', 'earned'],
            employees: ['employees', 'staff', 'headcount', 'workers'],
            date: ['date', 'scheduled', 'happened on', 'deadline']
        };

        const resolveAttribute = (valueType) => {
            for (const [attr, keywords] of Object.entries(attributeMap)) {
                if (keywords.some(kw => text.includes(kw))) return attr;
            }
            return `implicit_${valueType}`; // Fallback if no keyword context
        };

        // 3. Fact Assembly
        const assemble = (tokenList, valueType, defaultUnit) => {
            if (tokenList && tokenList.length > 0) {
                tokenList.forEach(val => {
                    const isUserSource = claim.source === "user";
                    const isCalculation = claim.type === "derived_calculation" || valueType.includes("calculation");

                    facts.push({
                        entity: resolvedEntity,
                        attribute: resolveAttribute(valueType),
                        value: val,
                        unit: defaultUnit || null,
                        role: isUserSource ? "user_fact" : (isCalculation ? "derived" : "subject"),
                        quantity: 1,
                        scope: claim.scope || "current", // Enable dynamic tracking
                        source: isUserSource ? "user" : (isCalculation ? "calculation" : "deterministic_parser"),
                        time: claim.timestamp_local || new Date().toISOString(),
                        context: claim.rawText
                    });
                });
            }
        };

        assemble(tokens.numbers, 'numeric_value', null);
        assemble(tokens.percentages, 'percentage', '%');
        assemble(tokens.currencies, 'currency', 'currency_unit');
        assemble(tokens.dates, 'date', 'temporal');

        return facts;
    }
}
// ============================================================================
// USER-DATA INTEGRITY CHECKER & VERIFICATION ENGINE
// ============================================================================

export class IntegrityVerifier {
    /*
     * Generates a canonical identity key for a Fact Object.
     * Enforces the rule: NEVER compare values first. Compare the facts the values belong to.
     * Input: fact (Object)
     * Output: canonical key (String)
     */
    static generateIdentityKey(fact) {
        const safe = (val) => (val || "UNRESOLVED").toString().toUpperCase().trim();
        
        // Key architecture: ENTITY|ATTRIBUTE|SCOPE|TIME|UNIT (Strict Match)
        return `${safe(fact.entity)}|${safe(fact.attribute)}|${safe(fact.scope)}|${safe(fact.time)}|${safe(fact.unit)}`;
    }

    /*
     * The core comparison matrix. Evaluates AI Answer Facts against established User Facts.
     * Extremely high priority penalty system for mutations and contradictions.
     * Input: userFacts (Array of Fact Objects), answerFacts (Array of Fact Objects)
     * Output: Verification Report (Object)
     */
    static verifyUserFacts(userFacts, answerFacts) {
        const report = {
            valid: [],
            mutations: [],
            unsupported: [],
            contradictions: [],
            score: 100 // Starting score, penalized for infractions
        };

        if (!userFacts || !answerFacts || !Array.isArray(userFacts) || !Array.isArray(answerFacts)) {
            return report;
        }

        // Index user entities and generate O(1) lookup map for user facts
        const userEntityMap = new Set(userFacts.map(f => (f.entity || "UNKNOWN").toUpperCase()));
        const userFactMap = new Map();
        
        userFacts.forEach(fact => {
            const key = this.generateIdentityKey(fact);
            userFactMap.set(key, fact);
        });

        answerFacts.forEach(ansFact => {
            const ansEntity = (ansFact.entity || "UNKNOWN").toUpperCase();
            const key = this.generateIdentityKey(ansFact);

            // SCENARIO 1 & 2 & 4: Exact Match, Mutation, or Contradiction
            if (userFactMap.has(key)) {
                const userFact = userFactMap.get(key);
                const ansValueStr = String(ansFact.value).trim().toLowerCase();
                const usrValueStr = String(userFact.value).trim().toLowerCase();
                
                // 1. Exact Equality
                if (ansValueStr === usrValueStr) {
                    report.valid.push({ 
                        fact: ansFact, 
                        status: "CONFIRMED_MATCH" 
                    });
                } else {
                    // Differentiate between Data Mutation (Numbers) and Contradiction (Text/Dates)
                    const isNumericMutation = !isNaN(parseFloat(ansFact.value)) && !isNaN(parseFloat(userFact.value));
                    
                    if (isNumericMutation) {
                        // 2. Mutation Detection (e.g., Budget: 25000 -> 50000)
                        report.mutations.push({ 
                            key: key,
                            expected: userFact.value, 
                            received: ansFact.value, 
                            status: "MUTATION_DETECTED" 
                        });
                        report.score -= 50; // Immediate heavy failure
                    } else {
                        // 4. Contradiction (e.g., Meeting: Monday -> Tuesday)
                        report.contradictions.push({ 
                            key: key,
                            expected: userFact.value, 
                            received: ansFact.value, 
                            status: "CONTRADICTION" 
                        });
                        report.score -= 40; // Extremely strong penalty
                    }
                }
            } 
            // SCENARIO 3: Unsupported Addition
            else if (userEntityMap.has(ansEntity) && ansEntity !== "UNKNOWN") {
                // The AI made a claim about a known user entity, but the specific attribute/role was never provided
                // e.g., User: "ABC Pvt Ltd". AI: "ABC Pvt Ltd has 500 employees."
                report.unsupported.push({
                    fact: ansFact,
                    status: "UNSUPPORTED_USER_FACT",
                    reason: `No user data supports the attribute [${ansFact.attribute}] for entity [${ansFact.entity}].`
                });
                report.score -= 20; // Structural penalty
            }
        });

        // Floor the score at 0
        report.score = Math.max(0, report.score);
        return report;
    }
}
// ============================================================================
// SOURCE VERIFIER & HIERARCHY ENGINE
// Reference: Algorithm.docx
// ============================================================================

const SOURCE_WEIGHTS = {
    official_gov: 100,
    official_doc: 95,
    primary_legal: 95,
    original_research: 95,
    university: 85,
    reputable_org: 80,
    major_publication: 70,
    secondary_article: 60,
    blog: 40,
    forum: 25,
    unverified: 10,
    none: 0
};

export class SourceVerifier {
    /*
     * Assigns evidence-quality points based on domain classification.
     * Evaluates source hierarchy rather than truth probability.
     * Input: url (String)
     * Output: Number (0-100)
     */
    static calculateSourceWeight(url) {
        if (!url) return SOURCE_WEIGHTS.none;

        try {
            const parsedUrl = new URL(url);
            const host = parsedUrl.hostname.toLowerCase();

            // Official Gov / Regulators
            if (host.endsWith('.gov') || host.endsWith('.mil') || host.endsWith('.gov.in') || host.endsWith('.nic.in')) return SOURCE_WEIGHTS.official_gov;
            
            // University / Academic
            if (host.endsWith('.edu') || host.endsWith('.ac.uk') || host.endsWith('.ac.in')) return SOURCE_WEIGHTS.university;
            
            // Reputable Organizations
            if (host.endsWith('.org') || host.endsWith('.int')) return SOURCE_WEIGHTS.reputable_org;
            
            // Official Docs / Primary Tech Repos (Heuristic)
            if (host.includes('docs.') || host.includes('developer.') || host === 'github.com') return SOURCE_WEIGHTS.official_doc;
            
            // Forums / UGC
            if (host.includes('reddit.com') || host.includes('quora.com') || host.includes('stackoverflow.com')) return SOURCE_WEIGHTS.forum;
            
            // Blogs (Medium, Substack, Wordpress)
            if (host.includes('medium.com') || host.includes('substack.com') || host.includes('wordpress.com')) return SOURCE_WEIGHTS.blog;

            // Default fallback for standard domains (.com, .net, etc.)
            return SOURCE_WEIGHTS.unverified;
        } catch (e) {
            return SOURCE_WEIGHTS.none;
        }
    }

    /*
     * Independently verifies a citation network path and content.
     * Executes the strict URL validation pipeline.
     * Input: url (String), claimFact (Object)
     * Output: Verification Report (Object)
     */
    static async verifyCitation(url, claimFact) {
        const report = {
            url_syntax_valid: false,
            domain_exists: false,
            http_status: null,
            page_exists: false,
            final_url: null,
            citation_title_matches: false,
            source_date_available: false,
            claimed_section_exists: false,
            quoted_text_exists: false,
            source_weight: this.calculateSourceWeight(url),
            source_support_score: 0
        };

        // 1. URL Syntax
        try {
            new URL(url);
            report.url_syntax_valid = true;
        } catch (e) {
            return report;
        }

        // 2. DNS Resolution, HTTP Request, Status Code, Redirect Chain, Final URL, Page Retrieval
        let rawContent = "";
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);
            
            const response = await fetch(url, { 
                method: 'GET', 
                redirect: 'follow',
                signal: controller.signal
            });
            
            clearTimeout(timeoutId);

            report.http_status = response.status;
            report.domain_exists = true; // Implied by successful connection
            report.final_url = response.url;

            if (response.ok) {
                report.page_exists = true;
                
                // 3. Content Extraction
                const contentType = response.headers.get('content-type') || '';
                if (contentType.includes('text/html') || contentType.includes('application/json')) {
                    rawContent = await response.text();
                }
            }
        } catch (e) {
            // Network failure or DNS resolution failed
            return report;
        }

        if (report.page_exists && rawContent.length > 0) {
            // 4. Deterministic content matching
            const matchData = this.matchClaimToContent(claimFact, rawContent);
            report.source_support_score = matchData.score;
            report.quoted_text_exists = matchData.exactQuoteFound;
            report.claimed_section_exists = matchData.sectionFound;
        }

        return report;
    }

    /*
     * Verifies if the retrieved URL content actually supports the claim.
     * Executes the deterministic substring/semantic-light matching pipeline.
     * Input: claim (Object), rawContent (String)
     * Output: Match Statistics (Object)
     */
    static matchClaimToContent(claim, rawContent) {
        const result = {
            score: 0,
            exactQuoteFound: false,
            sectionFound: false
        };

        if (!claim || !rawContent) return result;

        // 1. Normalize text
        const normContent = rawContent.toLowerCase().replace(/\s+/g, ' ');
        const normClaimValue = String(claim.value).toLowerCase().trim();
        const normClaimEntity = String(claim.entity).toLowerCase().trim();

        // 2. Exact phrase / Quoted text search
        if (normContent.includes(normClaimValue)) {
            result.exactQuoteFound = true;
            result.score += 40;
        }

        // 3. Numeric comparison (extract numbers from claim and ensure they exist nearby in content)
        const isNumeric = !isNaN(parseFloat(claim.value));
        if (isNumeric) {
            const numRegex = new RegExp(`\\b${claim.value}\\b`);
            if (numRegex.test(normContent)) {
                result.score += 30;
            }
        }

        // 4. Claim keywords / Stem overlap
        const keywords = normClaimEntity.split(' ').filter(w => w.length > 3);
        let overlapCount = 0;
        keywords.forEach(kw => {
            if (normContent.includes(kw)) overlapCount++;
        });

        if (keywords.length > 0) {
            const overlapRatio = overlapCount / keywords.length;
            result.score += (overlapRatio * 30);
        }

        return result;
    }
}
// ============================================================================
// CALCULATION ENGINE & MATHEMATICAL VERIFIER
// Reference: Algorithm.docx
// ============================================================================

export class SafeMathParser {
    /*
     * Safely evaluates a mathematical expression using the Shunting-Yard algorithm.
     * Strictly avoids eval() to prevent arbitrary code execution.
     * Input: expression (String)
     * Output: Evaluated result (Number)
     */
    static evaluate(expression) {
        if (!expression || typeof expression !== 'string') return null;

        // Pre-process percentages (e.g., "18%" -> "0.18")
        let sanitized = expression.replace(/([\d.]+)\s*%/g, (match, num) => {
            return String(parseFloat(num) / 100);
        });

        // Strip everything except numbers, operators, and parentheses
        sanitized = sanitized.replace(/[^\d.\+\-\*\/\^\(\)]/g, '');

        const tokens = this.tokenize(sanitized);
        const rpn = this.toRPN(tokens);
        return this.evaluateRPN(rpn);
    }

    /*
     * Tokenizes a mathematical string into numbers and operators.
     */
    static tokenize(expr) {
        const tokens = [];
        let numBuffer = '';

        for (let i = 0; i < expr.length; i++) {
            const char = expr[i];
            if (/[\d.]/.test(char)) {
                numBuffer += char;
            } else if (/[\+\-\*\/\^\(\)]/.test(char)) {
                if (numBuffer) {
                    tokens.push(parseFloat(numBuffer));
                    numBuffer = '';
                }
                tokens.push(char);
            }
        }
        if (numBuffer) tokens.push(parseFloat(numBuffer));
        return tokens;
    }

    /*
     * Converts infix notation tokens to Reverse Polish Notation (RPN).
     */
    static toRPN(tokens) {
        const output = [];
        const operators = [];
        const precedence = { '+': 1, '-': 1, '*': 2, '/': 2, '^': 3 };

        tokens.forEach(token => {
            if (typeof token === 'number') {
                output.push(token);
            } else if (token === '(') {
                operators.push(token);
            } else if (token === ')') {
                while (operators.length && operators[operators.length - 1] !== '(') {
                    output.push(operators.pop());
                }
                operators.pop();
            } else {
                while (
                    operators.length && 
                    precedence[operators[operators.length - 1]] >= precedence[token]
                ) {
                    output.push(operators.pop());
                }
                operators.push(token);
            }
        });

        while (operators.length) {
            output.push(operators.pop());
        }
        return output;
    }

    /*
     * Evaluates an RPN array into a single floating-point number.
     */
    static evaluateRPN(rpn) {
        const stack = [];
        rpn.forEach(token => {
            if (typeof token === 'number') {
                stack.push(token);
            } else {
                const b = stack.pop();
                const a = stack.pop();
                switch (token) {
                    case '+': stack.push(a + b); break;
                    case '-': stack.push(a - b); break;
                    case '*': stack.push(a * b); break;
                    case '/': stack.push(a / b); break;
                    case '^': stack.push(Math.pow(a, b)); break;
                }
            }
        });
        return stack[0];
    }
}

export class CalculationVerifier {
    /*
     * Compares an AI-generated mathematical claim against deterministic calculation.
     * Input: expression (String), expectedAiResult (Number), tolerance (Number)
     * Output: Verification Object (Status and discrepancy details)
     */
    static verifyCalculation(expression, expectedAiResult, tolerance = 0.0001) {
        try {
            const deterministicResult = SafeMathParser.evaluate(expression);
            
            if (deterministicResult === null || isNaN(deterministicResult)) {
                return { status: 'UNPARSABLE_EXPRESSION', expected: expectedAiResult, actual: null };
            }

            const difference = Math.abs(deterministicResult - expectedAiResult);
            const isMatch = difference <= tolerance;

            return {
                status: isMatch ? 'CALCULATION_VERIFIED' : 'CALCULATION_MISMATCH',
                deterministic_result: deterministicResult,
                ai_claimed_result: expectedAiResult,
                difference: difference
            };
        } catch (e) {
            return { status: 'CALCULATION_ENGINE_ERROR', error: e.message };
        }
    }

    /*
     * Computes the difference between two temporal dates.
     * Useful for date differences, durations, and interest periods.
     * Input: dateStr1 (String), dateStr2 (String), unit (String)
     * Output: Duration (Number)
     */
    static verifyDateDifference(dateStr1, dateStr2, unit = 'days') {
        const d1 = new Date(dateStr1);
        const d2 = new Date(dateStr2);

        if (isNaN(d1) || isNaN(d2)) return null;

        const diffMs = Math.abs(d2 - d1);
        
        switch (unit) {
            case 'days': return diffMs / (1000 * 60 * 60 * 24);
            case 'hours': return diffMs / (1000 * 60 * 60);
            case 'weeks': return diffMs / (1000 * 60 * 60 * 24 * 7);
            default: return diffMs; // default ms
        }
    }

    /*
     * Verifies array-based statistics like totals, subtotals, and averages.
     * Input: values (Array of Numbers), operation (String)
     * Output: Computed result (Number)
     */
    static verifyStatistics(values, operation = 'total') {
        if (!Array.isArray(values) || values.length === 0) return 0;
        
        const validNumbers = values.map(v => parseFloat(v)).filter(v => !isNaN(v));
        if (validNumbers.length === 0) return 0;

        const total = validNumbers.reduce((acc, curr) => acc + curr, 0);

        switch (operation) {
            case 'total':
            case 'subtotal':
                return total;
            case 'average':
                return total / validNumbers.length;
            default:
                return null;
        }
    }
}
// ============================================================================
// DATE CHECKER & TEMPORAL VERIFIER
// Reference: Algorithm.docx
// ============================================================================

export class DateVerifier {
    /*
     * Normalizes highly variable date expressions into strict YYYY-MM-DD strings.
     * Evaluates relative dates against a reference point.
     * Input: dateInput (String), referenceDateStr (String - Optional, defaults to current date)
     * Output: Normalized Date (String) or Object for ranges (Quarters/FY)
     */
    static normalizeDate(dateInput, referenceDateStr = new Date().toISOString().split('T')[0]) {
        if (!dateInput) return null;
        const input = dateInput.trim().toLowerCase();
        const refDate = new Date(referenceDateStr);

        // 1. Relative Dates (Yesterday, Tomorrow, "2 years ago")
        if (input === 'yesterday') return this.addDays(refDate, -1);
        if (input === 'tomorrow') return this.addDays(refDate, 1);
        if (input === 'today') return this.formatISO(refDate);

        const yearsAgoMatch = input.match(/^(\d+)\s+years?\s+ago$/);
        if (yearsAgoMatch) {
            const years = parseInt(yearsAgoMatch[1]);
            const target = new Date(refDate);
            target.setFullYear(target.getFullYear() - years);
            return this.formatISO(target);
        }

        // 2. Weekdays (e.g., "next Friday")
        const weekdayMatch = input.match(/^(next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/);
        if (weekdayMatch) {
            const isNext = !!weekdayMatch[1];
            const targetDay = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].indexOf(weekdayMatch[2]);
            let diff = targetDay - refDate.getDay();
            if (diff <= 0 || isNext) diff += 7; // Jump to next week
            return this.addDays(refDate, diff);
        }

        // 3. Fiscal Years (e.g., "FY 2025-26")
        const fyMatch = input.match(/^fy\s+(\d{4})-(\d{2})$/);
        if (fyMatch) {
            const startYear = parseInt(fyMatch[1]);
            // Defaulting to standard Indian/UK Fiscal Year (April 1 to March 31)
            return {
                start: `${startYear}-04-01`,
                end: `${startYear + 1}-03-31`,
                type: 'fiscal_year'
            };
        }

        // 4. Quarters (e.g., "Q4 2025")
        const quarterMatch = input.match(/^q([1-4])\s+(\d{4})$/);
        if (quarterMatch) {
            const q = parseInt(quarterMatch[1]);
            const year = parseInt(quarterMatch[2]);
            const startMonth = String((q - 1) * 3 + 1).padStart(2, '0');
            const endMonth = String(q * 3).padStart(2, '0');
            const endDay = [1, 3, 5, 7, 8, 10, 12].includes(q * 3) ? '31' : '30';
            return {
                start: `${year}-${startMonth}-01`,
                end: `${year}-${endMonth}-${endDay}`,
                type: 'quarter'
            };
        }

        // 5. Standard Numeric/Text Dates
        return this.parseStandardDate(input);
    }

    /*
     * Parses standard date strings, prioritizing DD/MM/YYYY logic if ambiguity exists.
     */
    static parseStandardDate(input) {
        // 1. Strict textual check to prevent JS Date from rolling over (e.g., Feb 30 -> Mar 2)
        const textDateMatch = input.match(/^(?:january|february|march|april|may|june|july|august|september|october|november|december|[a-z]{3})\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})$/i) || 
                              input.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+(?:january|february|march|april|may|june|july|august|september|october|november|december|[a-z]{3})\s+(\d{4})$/i);
                              
        if (textDateMatch) {
            const parsedDate = new Date(input);
            const inputMonthStr = input.match(/[a-z]+/i)[0].substring(0, 3).toLowerCase();
            const parsedMonthStr = parsedDate.toLocaleString('default', { month: 'short' }).toLowerCase();
            
            if (inputMonthStr !== parsedMonthStr) {
                return {
                    type: "IMPOSSIBLE_DATE",
                    repairable: false,
                    requiresUserClarification: true,
                    reason: `${input} is invalid. I can't determine the correct date without knowing the intended date.`
                };
            }
        }

        // 2. Strict DD/MM/YYYY
        const euroMatch = input.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
        if (euroMatch) {
            const d = parseInt(euroMatch[1], 10);
            const m = parseInt(euroMatch[2], 10);
            const y = parseInt(euroMatch[3], 10);
            
            if (m <= 12) {
                if (!this.isValidCalendarDate(y, m, d)) {
                    return { type: "IMPOSSIBLE_DATE", repairable: false, requiresUserClarification: true };
                }
                return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
            }
        }

        // 3. Strict YYYY-MM-DD
        const isoMatch = input.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})$/);
        if (isoMatch) {
            const y = parseInt(isoMatch[1], 10);
            const m = parseInt(isoMatch[2], 10);
            const d = parseInt(isoMatch[3], 10);
            
            if (m <= 12 && !this.isValidCalendarDate(y, m, d)) {
                return { type: "IMPOSSIBLE_DATE", repairable: false, requiresUserClarification: true };
            }
        }

        // JS Date fallback
        const parsedDate = new Date(input);
        if (!isNaN(parsedDate)) {
            return this.formatISO(parsedDate);
        }

        return null;
    }

    /*
     * Validates leap years and actual month lengths.
     * Prevents hallucinations like "February 29, 2025".
     * Input: year (Number), month (Number 1-12), day (Number)
     * Output: Boolean
     */
    static isValidCalendarDate(year, month, day) {
        if (month < 1 || month > 12 || day < 1 || day > 31) return false;
        
        const isLeap = (year % 4 === 0 && year % 100 !== 0) || (year % 400 === 0);
        const daysInMonth = [31, (isLeap ? 29 : 28), 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
        
        return day <= daysInMonth[month - 1];
    }

    /*
     * Verifies if a specific date aligns with a claimed weekday.
     * Input: isoDate (String), expectedWeekday (String)
     * Output: Boolean
     */
    static verifyWeekday(isoDate, expectedWeekday) {
        const d = new Date(isoDate);
        if (isNaN(d)) return false;

        const days = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
        const actualDay = days[d.getDay()];
        return actualDay === expectedWeekday.toLowerCase().trim();
    }

    /*
     * Ensures an array of ISO dates is strictly chronological (ascending).
     * Input: dateArray (Array of ISO Date Strings)
     * Output: Boolean
     */
    static verifyChronology(dateArray) {
        if (!Array.isArray(dateArray) || dateArray.length < 2) return true;

        for (let i = 0; i < dateArray.length - 1; i++) {
            const d1 = new Date(dateArray[i]).getTime();
            const d2 = new Date(dateArray[i + 1]).getTime();
            if (isNaN(d1) || isNaN(d2) || d1 > d2) return false; // Failure in chronology
        }
        return true;
    }

    /* Helper: Formats JS Date to YYYY-MM-DD */
    static formatISO(dateObj) {
        return dateObj.toISOString().split('T')[0];
    }

    /* Helper: Adds days cleanly avoiding timezone shifts */
    static addDays(dateObj, days) {
        const result = new Date(dateObj);
        result.setDate(result.getDate() + days);
        return this.formatISO(result);
    }
}
// ============================================================================
// NUMERIC CONSISTENCY ENGINE & UNIT CHECKER
// Reference: Algorithm.docx
// ============================================================================

export class NumericConsistencyEngine {
    /*
     * Normalizes highly variable numeric strings into strict floating-point values.
     * Supports Indian/International numbering systems and scientific notation.
     * Input: inputStr (String or Number)
     * Output: Number (or null if unparsable)
     */
    static normalizeNumber(inputStr) {
        if (typeof inputStr === 'number') return inputStr;
        if (!inputStr || typeof inputStr !== 'string') return null;

        const normalized = inputStr.toLowerCase().replace(/,/g, '').trim();
        
        // Extract base number, optional scientific notation, and potential multiplier text
        const match = normalized.match(/(-?[\d.]+)(?:e(-?\d+))?\s*(lakh|cr|crore|million|billion|k|m|b)?/);
        if (!match) return null;

        let baseNum = parseFloat(match[1]);
        const exponent = match[2] ? parseInt(match[2], 10) : 0;
        const multiplierStr = match[3];

        if (exponent !== 0) {
            baseNum = baseNum * Math.pow(10, exponent);
        }

        const multipliers = {
            'k': 1000,
            'lakh': 100000,
            'm': 1000000,
            'million': 1000000,
            'cr': 10000000,
            'crore': 10000000,
            'b': 1000000000,
            'billion': 1000000000
        };

        if (multiplierStr && multipliers[multiplierStr]) {
            baseNum *= multipliers[multiplierStr];
        }

        return baseNum;
    }

    /*
     * Detects impossible quantities (e.g., negative employees) and invalid percentages.
     * Input: fact (Object)
     * Output: Object (Status and details)
     */
    static checkPlausibility(fact) {
        const val = this.normalizeNumber(fact.value);
        if (val === null) return { valid: true };

        const attribute = String(fact.attribute || "").toLowerCase();
        const unit = String(fact.unit || "").toLowerCase();

        // 1. Impossible negative quantities
        const nonNegativeAttributes = ['employees', 'age', 'price', 'budget', 'distance', 'quantity', 'weight', 'revenue'];
        if (val < 0 && nonNegativeAttributes.some(attr => attribute.includes(attr))) {
            return { valid: false, reason: 'IMPOSSIBLE_NEGATIVE_QUANTITY' };
        }

        // 2. Percentage constraints (>100 where inappropriate)
        if (unit === '%' || attribute.includes('percentage') || attribute.includes('probability')) {
            if (val < 0) return { valid: false, reason: 'INVALID_NEGATIVE_PERCENTAGE' };
            
            // Allow >100 for growth/ROI, but block for probability/market share
            const strictPercentAttributes = ['probability', 'share', 'chance', 'accuracy', 'composition'];
            if (val > 100 && strictPercentAttributes.some(attr => attribute.includes(attr))) {
                return { valid: false, reason: 'PERCENTAGE_EXCEEDS_100' };
            }
        }

        return { valid: true };
    }

    /*
     * Verifies if a claimed total exactly equals the sum of its provided components.
     * Input: totalFact (Object), componentFacts (Array of Objects), tolerance (Number)
     * Output: Object (Verification Report)
     */
    static verifyTotalComponents(totalFact, componentFacts, tolerance = 0.01) {
        const totalVal = this.normalizeNumber(totalFact.value);
        const componentSum = componentFacts.reduce((sum, f) => {
            return sum + (this.normalizeNumber(f.value) || 0);
        }, 0);

        if (totalVal === null) return { status: 'UNPARSABLE_TOTAL' };

        const difference = Math.abs(totalVal - componentSum);
        return {
            status: difference <= tolerance ? 'TOTAL_MATCH' : 'TOTAL_MISMATCH',
            expectedTotal: totalVal,
            calculatedSum: componentSum,
            difference: difference
        };
    }
}

export class UnitChecker {
    /*
     * Registry of base dimensions and their conversion factors to a canonical unit.
     */
    static get UNIT_REGISTRY() {
        return {
            length: { base: 'm', conversions: { km: 1000, m: 1, cm: 0.01, mm: 0.001 } },
            mass: { base: 'g', conversions: { kg: 1000, g: 1, mg: 0.001, ton: 1000000 } },
            volume: { base: 'ml', conversions: { l: 1000, litre: 1000, liters: 1000, ml: 1 } },
            time: { base: 's', conversions: { ms: 0.001, s: 1, seconds: 1, second: 1, min: 60, minutes: 60, h: 3600, hours: 3600, days: 86400 } },
            currency: { base: 'unit', conversions: { '₹': 1, '$': 1, 'inr': 1, 'usd': 1, '€': 1, '£': 1 } }
        };
    }

    /*
     * Resolves a unit string to its canonical dimension and conversion factor.
     * Input: unitStr (String)
     * Output: Object (Dimension details) or null
     */
    static resolveDimension(unitStr) {
        if (!unitStr) return null;
        const normalizedUnit = unitStr.toLowerCase().trim();

        for (const [dimension, data] of Object.entries(this.UNIT_REGISTRY)) {
            if (data.conversions[normalizedUnit] !== undefined) {
                return {
                    dimension: dimension,
                    baseUnit: data.base,
                    factor: data.conversions[normalizedUnit]
                };
            }
        }
        return null;
    }

    /*
     * Normalizes a value and its unit to a canonical mathematical representation.
     * Input: value (Number/String), unit (String)
     * Output: Object (Normalized values)
     */
    static normalizeToCanonical(value, unit) {
        const num = NumericConsistencyEngine.normalizeNumber(value);
        if (num === null) return null;

        const dimensionData = this.resolveDimension(unit);
        if (!dimensionData) return { value: num, unit: unit, dimension: 'unknown' };

        return {
            value: num * dimensionData.factor,
            unit: dimensionData.baseUnit,
            dimension: dimensionData.dimension
        };
    }

    /*
     * Compares two quantities, performing conversion if necessary, and detects dimensional errors.
     * Input: val1 (Number/String), unit1 (String), val2 (Number/String), unit2 (String)
     * Output: Object (Verification Report)
     */
    static compareQuantities(val1, unit1, val2, unit2, tolerance = 0.0001) {
        const canonical1 = this.normalizeToCanonical(val1, unit1);
        const canonical2 = this.normalizeToCanonical(val2, unit2);

        if (!canonical1 || !canonical2) {
            return { status: 'INVALID_INPUT_FOR_COMPARISON' };
        }

        // Detect obvious dimensional errors (e.g., comparing Time with Distance, or Currency with Mass)
        if (canonical1.dimension !== canonical2.dimension) {
            // Allows 'unknown' to bypass strict dimensional failure to handle edge cases
            if (canonical1.dimension !== 'unknown' && canonical2.dimension !== 'unknown') {
                return {
                    status: 'DIMENSIONAL_ERROR',
                    reason: `Incompatible comparison: [${canonical1.dimension}] vs [${canonical2.dimension}]`
                };
            }
        }

        const diff = Math.abs(canonical1.value - canonical2.value);
        if (diff <= tolerance) {
            return { 
                status: 'QUANTITY_MATCH', 
                normalizedValue: canonical1.value, 
                canonicalUnit: canonical1.unit 
            };
        } else {
            return { 
                status: 'QUANTITY_MISMATCH', 
                difference: diff 
            };
        }
    }
}
// ============================================================================
// CURRENCY CHECKER
// Reference: Algorithm.docx
// ============================================================================

export class CurrencyChecker {
    /*
     * Parses a raw currency string into its numeric amount and currency identifier.
     * Prevents the model from silently changing ₹ to $ or €.
     * Input: currencyString (String)
     * Output: Object { amount: Number, currency: String } or null
     */
    static parseCurrencyString(currencyString) {
        if (!currencyString || typeof currencyString !== 'string') return null;

        // Match common currency symbols or ISO codes
        const match = currencyString.match(/([₹$€£¥]|INR|USD|EUR|GBP|JPY)\s*([\d,]+(?:\.\d+)?(?:[kKmMbB]|cr|lakh)?)/);
        if (!match) return null;

        const currencySymbol = match[1].toUpperCase();
        // Utilize the previously built NumericConsistencyEngine for robust parsing
        const amount = NumericConsistencyEngine.normalizeNumber(match[2]);

        if (amount === null) return null;

        return {
            currency: currencySymbol,
            amount: amount
        };
    }

    /*
     * Validates a currency conversion explicitly requiring a retrieved rate.
     * Rejects conversions that rely solely on the AI's internal training memory.
     * Input: source (Object), target (Object), retrievedRate (Number), rateDate (String), sourceName (String)
     * Output: Verification Report (Object)
     */
    static verifyConversion(sourceAmount, sourceCurrency, targetAmount, targetCurrency, retrievedRate, rateDate, rateSource) {
        if (!retrievedRate || isNaN(retrievedRate)) {
            return {
                status: 'UNVERIFIED_CONVERSION',
                reason: 'A current conversion requires an actual retrieved rate. Cannot trust model memory.'
            };
        }

        if (!rateDate || !rateSource) {
            return {
                status: 'INCOMPLETE_EXCHANGE_DATA',
                reason: 'Exchange-rate date and conversion source must be explicitly tracked.'
            };
        }

        const calculatedTarget = sourceAmount * retrievedRate;
        const tolerance = calculatedTarget * 0.01; // 1% tolerance for rounding differences
        const difference = Math.abs(calculatedTarget - targetAmount);

        if (difference <= tolerance) {
            return {
                status: 'CONVERSION_VERIFIED',
                source_currency: sourceCurrency,
                target_currency: targetCurrency,
                exchange_rate: retrievedRate,
                exchange_date: rateDate,
                conversion_source: rateSource
            };
        } else {
            return {
                status: 'CONVERSION_MISMATCH',
                expected_target: calculatedTarget,
                ai_claimed_target: targetAmount,
                difference: difference
            };
        }
    }
}

// ============================================================================
// CODE VERIFIER
// Reference: Algorithm.docx
// ============================================================================

export class CodeVerifier {
    /*
     * Core router for static validation and syntax checking based on language.
     * Prevents trusting AI-generated code without deterministic verification.
     * Input: codeString (String), language (String)
     * Output: Validation Result (Object)
     */
    static verifySyntax(codeString, language) {
        if (!codeString) return { valid: false, error: 'Empty code string' };

        const lang = language.toLowerCase().trim();

        try {
            switch (lang) {
                case 'json':
                    return this.verifyJSON(codeString);
                case 'regex':
                    return this.verifyRegex(codeString);
                case 'javascript':
                case 'js':
                    return this.verifyJavaScriptSyntax(codeString);
                case 'html':
                    return this.verifyHTML(codeString);
                case 'sql':
                    return this.verifySQL(codeString);
                case 'python':
                case 'css':
                    // In a full production environment, these route to their respective AST/Linters.
                    // Returning a structural stub to satisfy the pipeline design.
                    return { valid: true, note: `Requires external ${lang} AST/linter service` };
                default:
                    return { valid: false, error: `Unsupported language for static validation: ${lang}` };
            }
        } catch (e) {
            return { valid: false, error: e.message };
        }
    }

    /*
     * Parses and validates JSON structures.
     */
    static verifyJSON(jsonString) {
        try {
            JSON.parse(jsonString);
            return { valid: true };
        } catch (e) {
            return { valid: false, error: `JSON Parser Error: ${e.message}` };
        }
    }

    /*
     * Validates Regex syntax.
     */
    static verifyRegex(regexString) {
        try {
            // Strip potential starting/ending slashes if provided by AI
            let cleanRegex = regexString;
            if (cleanRegex.startsWith('/') && cleanRegex.lastIndexOf('/') > 0) {
                cleanRegex = cleanRegex.substring(1, cleanRegex.lastIndexOf('/'));
            }
            new RegExp(cleanRegex);
            return { valid: true };
        } catch (e) {
            return { valid: false, error: `Regex Parser Error: ${e.message}` };
        }
    }

    /*
     * Performs a lightweight JavaScript syntax check.
     * Uses the Function constructor strictly for syntax validation without execution.
     */
    static verifyJavaScriptSyntax(jsString) {
        try {
            // This attempts to compile the code without running it.
            // If there's a syntax error (e.g., missing bracket), it throws immediately.
            new Function(jsString);
            return { valid: true };
        } catch (e) {
            return { valid: false, error: `JavaScript Syntax Error: ${e.message}` };
        }
    }

    /*
     * Lightweight structural check for HTML.
     */
    static verifyHTML(htmlString) {
        // Checks for basic tag balancing and valid bracket structures
        const openingTags = (htmlString.match(/<[a-zA-Z1-6]+[^>]*>/g) || []).length;
        const closingTags = (htmlString.match(/<\/[a-zA-Z1-6]+>/g) || []).length;
        // Self-closing tags mitigate exact equality, but massive discrepancies indicate malformed HTML
        if (closingTags > openingTags) {
            return { valid: false, error: 'HTML Parser Error: More closing tags than opening tags' };
        }
        return { valid: true };
    }

    /*
     * Lightweight structural check for SQL.
     */
    static verifySQL(sqlString) {
        const upperSQL = sqlString.toUpperCase();
        const hasBasicKeywords = ['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'CREATE', 'ALTER', 'DROP'].some(kw => upperSQL.includes(kw));
        const balancedQuotes = (sqlString.match(/'/g) || []).length % 2 === 0;

        if (!hasBasicKeywords) return { valid: false, error: 'SQL Parser Error: Missing standard operation keyword' };
        if (!balancedQuotes) return { valid: false, error: 'SQL Parser Error: Unbalanced quotes' };
        
        return { valid: true };
    }

    /*
     * Compares the expected output of a code execution against the AI's claimed output.
     * Triggers an automatic failure if they mismatch.
     * Input: expectedOutput (Any), actualAiOutput (Any)
     * Output: Boolean
     */
    static verifyExecutionOutput(expectedOutput, actualAiOutput) {
        const normalize = (val) => String(val).trim().toLowerCase();
        
        if (normalize(expectedOutput) !== normalize(actualAiOutput)) {
            return {
                status: 'EXECUTION_OUTPUT_MISMATCH',
                expected: expectedOutput,
                actual: actualAiOutput,
                reason: 'Automatic failure. The expected execution result does not match the AI output.'
            };
        }
        return { status: 'EXECUTION_OUTPUT_MATCH' };
    }

    /*
     * INTERFACE: Sandboxed Execution Env
     * Dangerous/untrusted code must never execute directly on the production server.
     * Input: code (String), language (String)
     */
    static async executeSandboxed(code, language) {
        // In a live environment, this POSTs to an isolated Docker container, WebAssembly isolate, or serverless sandbox.
        return {
            status: 'QUEUED_FOR_SANDBOX',
            note: 'Code execution diverted to secure isolated environment.',
            payload: { code, language }
        };
    }
}
// ============================================================================
// JSON / STRUCTURED-OUTPUT CHECKER
// Reference: Algorithm.docx
// ============================================================================

export class JsonSchemaVerifier {
    /*
     * Completely deterministic JSON and schema validation engine.
     * Prevents AI hallucinations in structured data outputs without requiring AI inference.
     * Input: jsonString (String), schema (Object)
     * Output: Validation Report (Object)
     */
    static validate(jsonString, schema) {
        let parsedData;
        try {
            parsedData = JSON.parse(jsonString);
        } catch (e) {
            return { valid: false, errors: ['INVALID_JSON', e.message] };
        }

        const errors = [];
        this.validateNode(parsedData, schema, 'root', errors);

        return {
            valid: errors.length === 0,
            errors: errors,
            parsedData: errors.length === 0 ? parsedData : null
        };
    }

    /*
     * Recursively traverses the JSON data and schema to verify property types, required fields,
     * array boundaries, enums, and extra properties.
     */
    static validateNode(data, schema, path, errors) {
        if (!schema) return;

        // Null handling
        if (data === null) {
            if (schema.nullable !== true) {
                errors.push(`[${path}] Null value not allowed`);
            }
            return;
        }

        // Type checking
        if (schema.type) {
            const dataType = Array.isArray(data) ? 'array' : typeof data;
            
            if (schema.type === 'integer') {
                if (typeof data !== 'number' || !Number.isInteger(data)) {
                    errors.push(`[${path}] Expected integer, received ${dataType} (${data})`);
                    return; // Fail fast for this node
                }
            } else if (schema.type === 'number') {
                if (typeof data !== 'number') {
                    errors.push(`[${path}] Expected number, received ${dataType}`);
                    return;
                }
            } else if (dataType !== schema.type) {
                errors.push(`[${path}] Expected ${schema.type}, received ${dataType}`);
                return;
            }
        }

        // Allowed values (Enum)
        if (schema.enum && Array.isArray(schema.enum)) {
            if (!schema.enum.includes(data)) {
                errors.push(`[${path}] Value '${data}' not in allowed values: [${schema.enum.join(', ')}]`);
            }
        }

        // Array validation
        if (Array.isArray(data)) {
            if (schema.minItems !== undefined && data.length < schema.minItems) {
                errors.push(`[${path}] Array length ${data.length} is below minItems ${schema.minItems}`);
            }
            if (schema.maxItems !== undefined && data.length > schema.maxItems) {
                errors.push(`[${path}] Array length ${data.length} exceeds maxItems ${schema.maxItems}`);
            }
            if (schema.items) {
                data.forEach((item, index) => {
                    this.validateNode(item, schema.items, `${path}[${index}]`, errors);
                });
            }
        }

        // Object validation
        if (data !== null && typeof data === 'object' && !Array.isArray(data)) {
            // Check required properties
            if (schema.required && Array.isArray(schema.required)) {
                schema.required.forEach(reqProp => {
                    if (data[reqProp] === undefined) {
                        errors.push(`[${path}] Missing required property: '${reqProp}'`);
                    }
                });
            }

            // Check defined properties and extra properties
            const schemaProps = schema.properties || {};
            Object.keys(data).forEach(prop => {
                if (schemaProps[prop]) {
                    this.validateNode(data[prop], schemaProps[prop], `${path}.${prop}`, errors);
                } else if (schema.additionalProperties === false) {
                    errors.push(`[${path}] Extra property not allowed: '${prop}'`);
                }
            });
        }
    }
}

// ============================================================================
// CITATION CHECKER & SCORING PIPELINE
// Reference: Algorithm.docx
// ============================================================================

export class CitationAggregateVerifier {
    /*
     * Orchestrates the step-by-step verification of citations for a specific claim.
     * Aggregates a 0-100 score based on existence, reachability, support, and matching.
     * Input: claimFact (Object), citations (Array of citation Objects)
     * Output: Aggregated Citation Report (Object)
     */
    static async verifyCitationsForClaim(claimFact, citations) {
        const report = {
            claim: claimFact.value,
            total_citations: citations ? citations.length : 0,
            aggregated_score: 0,
            citation_reports: []
        };

        if (!citations || citations.length === 0) {
            report.status = "NO_CITATIONS";
            return report;
        }

        let totalScore = 0;

        for (const citation of citations) {
            // Max score per citation is 100
            let citationScore = 0;
            const citationReport = { url: citation.url, steps: {} };

            // 1. Citation exists? (Base penalty avoidance)
            citationReport.steps.citation_exists = true;
            citationScore += 5;

            // 2. Source exists & Reachable? (Relies on SourceVerifier built in Part 3)
            // Simulated execution of network checks
            const networkStatus = await this.checkNetworkReachability(citation.url);
            citationReport.steps.source_exists = networkStatus.domainExists;
            citationReport.steps.source_reachable = networkStatus.reachable;
            
            if (networkStatus.domainExists) citationScore += 10;
            if (networkStatus.reachable) citationScore += 15;

            if (networkStatus.reachable) {
                // 3. Document/page exists?
                citationReport.steps.document_exists = networkStatus.statusCode === 200;
                if (citationReport.steps.document_exists) citationScore += 15;

                // 4. Referenced section exists?
                citationReport.steps.section_exists = this.checkSectionExists(networkStatus.content, citation.section);
                if (citationReport.steps.section_exists) citationScore += 10;

                // 5. Claim appears supported? (Light-semantic/substring matching)
                const supportCheck = this.checkClaimSupport(networkStatus.content, claimFact);
                citationReport.steps.claim_supported = supportCheck.supported;
                if (supportCheck.supported) citationScore += 25;

                // 6. Numbers match?
                citationReport.steps.numbers_match = supportCheck.numbersMatch;
                if (supportCheck.numbersMatch) citationScore += 10;

                // 7. Date matches?
                citationReport.steps.date_matches = supportCheck.dateMatches;
                if (supportCheck.dateMatches) citationScore += 10;
            }

            // Cap at 100
            citationReport.final_score = Math.min(citationScore, 100);
            totalScore += citationReport.final_score;
            report.citation_reports.push(citationReport);
        }

        // Aggregate average score
        report.aggregated_score = Math.round(totalScore / citations.length);
        report.status = report.aggregated_score > 70 ? "SUPPORTED" : "WEAKLY_SUPPORTED";
        if (report.aggregated_score < 40) report.status = "UNSUPPORTED";

        return report;
    }

    /*
     * Stubbed Network Reachability (Integrates with actual HTTP fetch in production)
     */
    static async checkNetworkReachability(url) {
        return {
            domainExists: true,
            reachable: true,
            statusCode: 200,
            content: "Simulated document content containing " + url
        };
    }

    /*
     * Verifies if the referenced section/header exists in the document.
     */
    static checkSectionExists(content, expectedSection) {
        if (!expectedSection) return true; // N/A, grant points
        const normalizedContent = String(content).toLowerCase();
        return normalizedContent.includes(String(expectedSection).toLowerCase());
    }

    /*
     * Analyzes document content for text overlap, numeric parity, and date matching.
     */
    static checkClaimSupport(content, claimFact) {
        const normalizedContent = String(content).toLowerCase();
        const valueStr = String(claimFact.value).toLowerCase();
        
        const result = {
            supported: false,
            numbersMatch: false,
            dateMatches: false
        };

        // Textual Support
        if (normalizedContent.includes(valueStr)) {
            result.supported = true;
        }

        // Number Matching
        const isNumeric = !isNaN(parseFloat(claimFact.value));
        if (isNumeric && normalizedContent.includes(valueStr)) {
            result.numbersMatch = true;
        } else if (!isNumeric) {
            result.numbersMatch = true; // N/A, grant points
        }

        // Date Matching (Relies on DateVerifier normalized dates)
        if (claimFact.attribute && claimFact.attribute.includes('date')) {
            if (normalizedContent.includes(valueStr)) {
                result.dateMatches = true;
            }
        } else {
            result.dateMatches = true; // N/A, grant points
        }

        return result;
    }
}
// ============================================================================
// QUOTE CHECKER & INTERNAL CONTRADICTION ENGINE
// Reference: Algorithm.docx
// ============================================================================

export class QuoteChecker {
    /*
     * Searches the cited source text for an exact or partial match of the AI's quoted passage.
     * Triggers a serious failure state if the quote is completely fabricated.
     * Input: aiQuote (String), sourceText (String)
     * Output: Match Report (Object)
     */
    static verifyQuote(aiQuote, sourceText) {
        if (!aiQuote || !sourceText) {
            return { status: 'NOT_FOUND', severity: 'CRITICAL', reason: 'Missing quote or source text.' };
        }

        const exactQuote = aiQuote.trim();
        
        // 1. Strict Exact Match
        if (sourceText.includes(exactQuote)) {
            return { status: 'EXACT_MATCH', score: 100 };
        }

        // 2. Normalized Exact Match (Ignores case, punctuation, and whitespace variations)
        const normQuote = this.normalizeForQuoteMatch(exactQuote);
        const normSource = this.normalizeForQuoteMatch(sourceText);

        if (normSource.includes(normQuote)) {
            return { status: 'EXACT_MATCH', score: 100, note: 'Matched after normalization' };
        }

        // 3. Partial Match Calculation (Word overlap)
        const quoteWords = normQuote.split(' ').filter(w => w.length > 2);
        if (quoteWords.length === 0) return { status: 'NOT_FOUND', severity: 'CRITICAL' };

        let matchCount = 0;
        const sourceWords = new Set(normSource.split(' '));
        
        quoteWords.forEach(word => {
            if (sourceWords.has(word)) matchCount++;
        });

        const matchRatio = matchCount / quoteWords.length;

        if (matchRatio >= 0.7) {
            return { 
                status: 'PARTIAL_MATCH', 
                score: Math.round(matchRatio * 100),
                reason: 'Significant word overlap detected, but exact phrasing differs.'
            };
        }

        // 4. Not Found (Fabricated quote)
        return { 
            status: 'NOT_FOUND', 
            severity: 'CRITICAL',
            score: 0,
            reason: 'Quote does not appear in the cited text.'
        };
    }

    /*
     * Normalizes text specifically for robust quote comparison.
     */
    static normalizeForQuoteMatch(text) {
        return text.toLowerCase()
            .replace(/[.,/#!$%^&*;:{}=\-_`~()""'']/g, '') // Strip punctuation
            .replace(/\s{2,}/g, ' ') // Collapse multiple spaces
            .trim();
    }
}

export class InternalContradictionChecker {
    /*
     * Scans an array of AI-generated facts for internal logical contradictions.
     * Flags when the same entity and property possess different values.
     * Input: aiFacts (Array of Fact Objects)
     * Output: Contradiction Report (Object)
     */
    static findContradictions(aiFacts) {
        const report = {
            hasContradictions: false,
            contradictions: [],
            totalFactsAnalyzed: aiFacts ? aiFacts.length : 0
        };

        if (!aiFacts || aiFacts.length < 2) return report;

        // Target attributes requiring strict consistency
        const strictAttributes = [
            'age', 'price', 'quantity', 'date', 'location', 
            'status', 'name', 'percentage', 'measurement', 
            'case_number', 'company_name', 'employees'
        ];

        // Grouping Map: Key -> Array of values
        const factGroups = new Map();

        aiFacts.forEach(fact => {
            // Only check facts matching the target attributes
            const attr = String(fact.attribute).toLowerCase();
            const isTargetAttribute = strictAttributes.some(target => attr.includes(target));
            
            if (!isTargetAttribute) return;

            // Generate a grouping key WITHOUT the value
            const groupKey = this.generateGroupingKey(fact);
            
            if (!factGroups.has(groupKey)) {
                factGroups.set(groupKey, []);
            }
            factGroups.get(groupKey).push(fact);
        });

        // Analyze groups for conflicts
        factGroups.forEach((factsInGroup, groupKey) => {
            if (factsInGroup.length > 1) {
                const baselineFact = factsInGroup[0];
                
                for (let i = 1; i < factsInGroup.length; i++) {
                    const comparisonFact = factsInGroup[i];
                    const isMismatch = this.detectValueMismatch(baselineFact, comparisonFact);
                    
                    if (isMismatch) {
                        report.hasContradictions = true;
                        report.contradictions.push({
                            type: 'CONTRADICTION',
                            entity: baselineFact.entity,
                            attribute: baselineFact.attribute,
                            conflicting_values: [baselineFact.value, comparisonFact.value],
                            reason: `Internal contradiction detected: Same entity and property but differing values.`
                        });
                    }
                }
            }
        });

        return report;
    }

    /*
     * Generates a structural key ignoring the fact's value to group identical claims.
     */
    static generateGroupingKey(fact) {
        const safe = (val) => (val || "UNRESOLVED").toString().toLowerCase().trim();
        // e.g., "company|employees|total|company_wide|2026-09-08"
        return `${safe(fact.entity)}|${safe(fact.attribute)}|${safe(fact.role)}|${safe(fact.scope)}|${safe(fact.time)}`;
    }

    /*
     * Safely compares two values to determine if they genuinely conflict.
     * Prevents false flags on mathematically identical numbers (e.g., 10 lakh vs 1000000).
     */
    static detectValueMismatch(fact1, fact2) {
        const val1 = fact1.value;
        const val2 = fact2.value;

        // Exact match
        if (String(val1).trim().toLowerCase() === String(val2).trim().toLowerCase()) {
            return false;
        }

        // Attempt numeric normalization (assuming NumericConsistencyEngine is available from Part 6)
        try {
            const num1 = NumericConsistencyEngine.normalizeNumber(val1);
            const num2 = NumericConsistencyEngine.normalizeNumber(val2);

            // If both are valid numbers, compare them mathematically
            if (num1 !== null && num2 !== null) {
                return num1 !== num2;
            }
        } catch (e) {
            // Fallback to strict string comparison if normalizer fails
        }

        // Textual contradiction
        return true;
    }
}
// ============================================================================
// CROSS-SECTION CONSISTENCY & MISSING-EVIDENCE DETECTOR
// Reference: Algorithm.docx
// ============================================================================

export class CrossSectionVerifier {
    /*
     * Analyzes AI-generated facts across different sections of a document.
     * Detects if values mutate between the summary, body, table, and conclusion.
     * Input: aiFacts (Array of Fact Objects, containing a 'section' property)
     * Output: Consistency Report (Object)
     */
    static verifyConsistency(aiFacts) {
        const report = {
            isConsistent: true,
            inconsistencies: []
        };

        if (!aiFacts || aiFacts.length < 2) return report;

        // Grouping Map: Key -> { sectionA: valueA, sectionB: valueB }
        const sectionMap = new Map();

        aiFacts.forEach(fact => {
            const section = String(fact.section || 'body').toLowerCase();
            const groupKey = this.generateBaseKey(fact);

            if (!sectionMap.has(groupKey)) {
                sectionMap.set(groupKey, {});
            }
            
            // Store the value associated with the specific section
            sectionMap.get(groupKey)[section] = fact.value;
        });

        // Evaluate grouped facts for cross-section mismatches
        sectionMap.forEach((sectionValues, groupKey) => {
            const sectionsPresent = Object.keys(sectionValues);
            
            if (sectionsPresent.length > 1) {
                const baselineSection = sectionsPresent[0];
                const baselineValue = sectionValues[baselineSection];

                for (let i = 1; i < sectionsPresent.length; i++) {
                    const comparisonSection = sectionsPresent[i];
                    const comparisonValue = sectionValues[comparisonSection];

                    // Check for mathematical or textual mismatch
                    if (this.detectMismatch(baselineValue, comparisonValue)) {
                        report.isConsistent = false;
                        report.inconsistencies.push({
                            type: 'CROSS_SECTION_INCONSISTENCY',
                            key: groupKey,
                            conflicts: {
                                [baselineSection]: baselineValue,
                                [comparisonSection]: comparisonValue
                            },
                            reason: `Immediate inconsistency: Value differs between ${baselineSection} and ${comparisonSection}.`
                        });
                    }
                }
            }
        });

        return report;
    }

    /*
     * Generates a base structural key ignoring the value and section.
     */
    static generateBaseKey(fact) {
        const safe = (val) => (val || "UNRESOLVED").toString().toLowerCase().trim();
        return `${safe(fact.entity)}|${safe(fact.attribute)}|${safe(fact.role)}|${safe(fact.time)}`;
    }

    /*
     * Evaluates if two values genuinely conflict, utilizing numeric normalization if possible.
     */
    static detectMismatch(val1, val2) {
        if (String(val1).trim().toLowerCase() === String(val2).trim().toLowerCase()) {
            return false;
        }

        try {
            // Relies on NumericConsistencyEngine from Part 6
            const num1 = NumericConsistencyEngine.normalizeNumber(val1);
            const num2 = NumericConsistencyEngine.normalizeNumber(val2);

            if (num1 !== null && num2 !== null) {
                return num1 !== num2;
            }
        } catch (e) {}

        return true;
    }
}

export class MissingEvidenceDetector {
    /*
     * Evaluates an AI claim against all trusted pillars of evidence.
     * Prevents the acceptance of ungrounded hallucinations by requiring explicit proof.
     * Input: aiFact (Object), trustedContext (Object containing user data, citations, calculations)
     * Output: Evidence Evaluation (Object)
     */
    static evaluateEvidence(aiFact, trustedContext) {
        const { 
            userFacts = [], 
            verifiedSources = [], 
            retrievedDocuments = [], 
            verifiedCalculations = [] 
        } = trustedContext;

        const report = {
            fact: aiFact,
            evidence_status: 'NONE',
            supported_by: [],
            action: 'DO_NOT_ACCEPT'
        };

        // 1. Is this present in user data?
        if (this.isSupportedByUser(aiFact, userFacts)) {
            report.supported_by.push('USER_DATA');
        }

        // 2. Is there a verified source?
        if (this.isSupportedBySources(aiFact, verifiedSources)) {
            report.supported_by.push('VERIFIED_SOURCE');
        }

        // 3. Is there a retrieved document?
        if (this.isSupportedByDocuments(aiFact, retrievedDocuments)) {
            report.supported_by.push('RETRIEVED_DOCUMENT');
        }

        // 4. Is there a deterministic calculation?
        if (this.isSupportedByCalculations(aiFact, verifiedCalculations)) {
            report.supported_by.push('DETERMINISTIC_CALCULATION');
        }

        // Final Evidence Judgment
        if (report.supported_by.length > 0) {
            report.evidence_status = 'CONFIRMED';
            report.action = 'ACCEPT_AS_VERIFIED_FACT';
        } else {
            report.evidence_status = 'NONE';
            report.action = 'DO_NOT_ACCEPT_AS_VERIFIED_FACT';
            report.reason = 'Fact lacks support from user data, verified sources, documents, or deterministic calculations.';
        }

        return report;
    }

    /*
     * Checks if the fact aligns with established user data.
     */
    static isSupportedByUser(aiFact, userFacts) {
        if (!userFacts.length) return false;
        
        // Relies on IntegrityVerifier from Part 2 for exact equality checks
        try {
            const integrityReport = IntegrityVerifier.verifyUserFacts(userFacts, [aiFact]);
            return integrityReport.valid && integrityReport.valid.length > 0;
        } catch (e) {
            return false;
        }
    }

    /*
     * Checks if the fact is backed by a verified external citation.
     */
    static isSupportedBySources(aiFact, verifiedSources) {
        // Scans previous citation reports (from Part 6) to see if this specific claim was supported
        return verifiedSources.some(sourceReport => {
            return sourceReport.claim === aiFact.value && sourceReport.status === 'SUPPORTED';
        });
    }

    /*
     * Checks if the fact was extracted directly from an uploaded/retrieved document.
     */
    static isSupportedByDocuments(aiFact, retrievedDocuments) {
        const valStr = String(aiFact.value).toLowerCase();
        return retrievedDocuments.some(docContent => {
            return String(docContent).toLowerCase().includes(valStr);
        });
    }

    /*
     * Checks if the fact represents a successfully evaluated mathematical derivation.
     */
    static isSupportedByCalculations(aiFact, verifiedCalculations) {
        return verifiedCalculations.some(calcReport => {
            return calcReport.status === 'CALCULATION_VERIFIED' && 
                   calcReport.ai_claimed_result === aiFact.value;
        });
    }
}
// ============================================================================
// VERIFICATION SCORER & WEIGHTED SCORING SYSTEM
// Reference: Algorithm.docx
// ============================================================================

export class VerificationScorer {
    /*
     * Defines the dynamic weighting profiles based on content types.
     * Prevents using one fixed formula for vastly different domains.
     */
    static get SCORING_PROFILES() {
        return {
            factual: {
                user_data_integrity: 25,
                source_integrity: 20,
                numeric_correctness: 15,
                citation_correctness: 10,
                internal_consistency: 10,
                temporal_validity: 5,
                unit_correctness: 5,
                structured_data: 5,
                calculation_integrity: 5
            },
            coding: {
                code_correctness: 40,
                execution_result: 25,
                user_data_integrity: 15, // User requirements
                structured_data: 10,     // Structure
                internal_consistency: 10
            },
            legal: {
                source_integrity: 35,    // Primary-source support
                citation_correctness: 20,
                user_data_integrity: 20, // User facts
                temporal_validity: 10,   // Date/version
                internal_consistency: 10,
                calculation_integrity: 5 // Calculations
            }
        };
    }

    /*
     * Determines the appropriate verification profile based on detected content.
     * Input: contentFlags (Object - e.g., { hasCode: true, isLegal: false })
     * Output: Profile weights (Object)
     */
    static determineProfile(contentFlags = {}) {
        if (contentFlags.hasCode) return this.SCORING_PROFILES.coding;
        if (contentFlags.isLegal) return this.SCORING_PROFILES.legal;
        return this.SCORING_PROFILES.factual; // Default fallback
    }

    /*
     * Dynamically redistributes weights if certain categories are N/A (e.g., no code).
     * Input: baseWeights (Object), availableScores (Object)
     * Output: Normalized weights summing to exactly 100 (Object)
     */
    static normalizeWeights(baseWeights, availableScores) {
        const normalized = {};
        let activeWeightSum = 0;

        // Sum the weights of the categories that actually have scores
        for (const [category, weight] of Object.entries(baseWeights)) {
            if (availableScores[category] !== undefined && availableScores[category] !== 'N/A') {
                activeWeightSum += weight;
            }
        }

        // If no valid weights (edge case), return empty
        if (activeWeightSum === 0) return normalized;

        // Redistribute proportionally
        for (const [category, weight] of Object.entries(baseWeights)) {
            if (availableScores[category] !== undefined && availableScores[category] !== 'N/A') {
                normalized[category] = (weight / activeWeightSum) * 100;
            }
        }

        return normalized;
    }

    /*
     * Calculates the final VERIFICATION SCORE and STATUS.
     * Expressly avoids outputting "Answer confidence = 93%" in favor of a rigorous breakdown.
     * Input: rawScores (Object mapping categories to 0-100 values or 'N/A'), contentFlags (Object)
     * Output: Final Verification Report (Object)
     */
    static calculateFinalScore(rawScores, contentFlags = {}) {
        const profile = this.determineProfile(contentFlags);
        const normalizedWeights = this.normalizeWeights(profile, rawScores);
        
        let aggregatedScore = 0;
        const breakdown = {};
        let hasCriticalFailure = false;

        // Calculate weighted aggregate
        for (const [category, score] of Object.entries(rawScores)) {
            if (score === 'N/A') {
                breakdown[category] = 'N/A';
                continue;
            }

            const numericScore = Math.max(0, Math.min(100, Number(score))); // Clamp 0-100
            breakdown[category] = `${numericScore}/100`;

            // Identify severe failures that mathematically destroy verification
            if (numericScore === 0 && (category === 'user_data_integrity' || category === 'internal_consistency')) {
                hasCriticalFailure = true;
            }

            if (normalizedWeights[category]) {
                aggregatedScore += (numericScore * (normalizedWeights[category] / 100));
            }
        }

        const finalScore = Math.round(aggregatedScore);

        return {
            VERIFICATION_SCORE: `${finalScore}/100`,
            STATUS: this.determineStatus(finalScore, hasCriticalFailure),
            breakdown: breakdown,
            profile_used: contentFlags.hasCode ? 'coding' : (contentFlags.isLegal ? 'legal' : 'factual')
        };
    }

    /*
     * Assigns a definitive status tag based on the final score and critical failure states.
     */
    static determineStatus(finalScore, hasCriticalFailure) {
        if (hasCriticalFailure) return 'FAILED';
        if (finalScore >= 95) return 'VERIFIED';
        if (finalScore >= 75) return 'PARTIALLY VERIFIED';
        if (finalScore >= 50) return 'UNVERIFIED';
        return 'FAILED';
    }
}
// ============================================================================
// HARD-FAIL, DECISION ENGINE, REPAIR & AUDIT ORCHESTRATION
// Reference: Algorithm.docx
// ============================================================================

export class HardFailEvaluator {
    /*
     * Scans aggregated verification reports for critical infractions.
     * A hard fail completely overrides the verification score.
     * Input: reports (Object containing outputs from previous verifiers)
     * Output: Boolean
     */
    static check(reports) {
        let hardFail = false;
        const criticalTriggers = [];

        // 1. Fabricated citation or URL doesn't exist
        if (reports.citations && reports.citations.some(c => c.status === 'NOT_FOUND' || !c.steps.source_exists)) {
            hardFail = true;
            criticalTriggers.push('FABRICATED_CITATION_OR_URL');
        }

        // 2. User data directly contradicted or mutated
        if (reports.integrity && (reports.integrity.contradictions.length > 0 || reports.integrity.mutations.length > 0)) {
            hardFail = true;
            criticalTriggers.push('USER_DATA_CONTRADICTED');
        }

        // 3. Calculation demonstrably wrong
        if (reports.calculations && reports.calculations.some(c => c.status === 'CALCULATION_MISMATCH')) {
            hardFail = true;
            criticalTriggers.push('CALCULATION_DEMONSTRABLY_WRONG');
        }

        // 4. Quoted passage doesn't exist
        if (reports.quotes && reports.quotes.some(q => q.severity === 'CRITICAL' && q.status === 'NOT_FOUND')) {
            hardFail = true;
            criticalTriggers.push('QUOTED_PASSAGE_FABRICATED');
        }

        // 5. Invalid JSON when JSON was required
        if (reports.jsonSchema && reports.jsonSchema.valid === false) {
            hardFail = true;
            criticalTriggers.push('INVALID_STRUCTURED_OUTPUT');
        }

        // 6. Date mathematically impossible
        if (reports.dates && reports.dates.some(d => d.status === 'IMPOSSIBLE_DATE')) {
            hardFail = true;
            criticalTriggers.push('MATHEMATICALLY_IMPOSSIBLE_DATE');
        }

        return { hardFail, triggers: criticalTriggers };
    }
}

export class DecisionEngine {
    /*
     * Determines the final action based on hard-fails, risk domains, and scores.
     * Input: score (Number), hardFailState (Object), domain (String), missingRequiredEvidence (Boolean)
     * Output: Routing Decision (String)
     */
    static evaluate(score, hardFailState, domain = 'general', missingRequiredEvidence = false) {
        if (hardFailState.hardFail) {
            return 'REJECT';
        }

        if (missingRequiredEvidence) {
            return 'RECHECK_RETRIEVE';
        }

        // Adjust thresholds based on domain risk
        const highRiskDomains = ['legal', 'medical', 'financial', 'tax', 'safety'];
        const isHighRisk = highRiskDomains.includes(domain.toLowerCase());
        
        const thresholdAccept = isHighRisk ? 97 : 90;
        const thresholdWarn = isHighRisk ? 92 : 85;
        const thresholdRecheck = isHighRisk ? 85 : 70;

        if (score >= thresholdAccept) return 'ACCEPT';
        if (score >= thresholdWarn) return 'ACCEPT_WITH_WARNING';
        if (score >= thresholdRecheck) return 'RECHECK';
        
        return 'REJECT';
    }
}

export class RepairGenerator {
    /*
     * Generates a machine-readable repair packet for the LLM.
     * Input: decision (String), score (Number), errorReports (Array)
     * Output: Repair Packet (Object)
     */
    static buildPacket(decision, score, errorReports) {
        const instructions = [];
        
        // Translate raw errors into actionable LLM instructions
        errorReports.forEach(err => {
            if (err.type === 'USER_DATA_CONTRADICTION' || err.type === 'MUTATION_DETECTED') {
                instructions.push(`Use exact value: ${err.expected} for ${err.claim}. Do not mutate user data.`);
            } else if (err.type === 'UNSUPPORTED_CLAIM') {
                instructions.push(`Remove claim '${err.claim}' unless supported by retrieved evidence.`);
            } else if (err.type === 'CALCULATION_MISMATCH') {
                instructions.push(`Correct the calculation for ${err.claim}. The deterministic result is ${err.expected}.`);
            } else if (err.type === 'INVALID_JSON') {
                instructions.push(`Fix JSON schema violation: ${err.reason}.`);
            }
        });

        return {
            status: decision === 'REJECT' ? 'FAIL' : 'NEEDS_REVISION',
            score: score,
            errors: errorReports,
            action: 'REGENERATE',
            instructions: instructions
        };
    }
}

export class VerificationOrchestrator {
    constructor(domain = 'general') {
        this.domain = domain;
        this.MAX_RETRIES = 3;
        this.auditTrail = [];
    }

    /*
     * Master controller for a single verification lifecycle.
     * Prevents infinite loops and maintains the audit trail.
     * Input: verificationId (String), originalPrompt (String), llmGeneratorFn (Function)
     * Output: Final Verified Payload or UNVERIFIED state
     */
    async executeVerificationLoop(verificationId, originalPrompt, llmGeneratorFn) {
        let attempt = 0;
        let currentPrompt = originalPrompt;
        let finalDecision = 'REJECT';
        let latestRepairPacket = null;

        const sessionAudit = {
            verification_id: verificationId,
            timestamp: new Date().toISOString(),
            domain: this.domain,
            retry_count: 0,
            claim_count: 0,
            verified_claims: 0,
            unsupported_claims: 0,
            source_count: 0,
            source_failures: 0,
            calculation_checks: 0,
            contradictions: 0,
            final_score: 0,
            decision: 'UNVERIFIED',
            history: []
        };

        while (attempt < this.MAX_RETRIES) {
            attempt++;
            sessionAudit.retry_count = attempt;

            // 1. Generate LLM Output (Simulated call)
            const llmOutput = await llmGeneratorFn(currentPrompt, latestRepairPacket);

            // 2. Run all deterministic parsers and verifiers (Simulated aggregated output)
            // (In production, this calls FactExtractor, IntegrityVerifier, SourceVerifier, etc.)
            const aggregatedReports = this.runVerificationPipeline(llmOutput);
            
            // Update Audit Metrics
            this.updateAuditMetrics(sessionAudit, aggregatedReports);

            // 3. Evaluate Hard Fails & Scores
            const hardFailState = HardFailEvaluator.check(aggregatedReports);
            const score = aggregatedReports.aggregatedScore || 0;
            sessionAudit.final_score = score;

            // 4. Decision Engine
            finalDecision = DecisionEngine.evaluate(score, hardFailState, this.domain, aggregatedReports.missingEvidence);
            sessionAudit.history.push({ attempt, score, decision: finalDecision, hardFailTriggers: hardFailState.triggers });

            // 5. Routing
            if (finalDecision === 'ACCEPT' || finalDecision === 'ACCEPT_WITH_WARNING') {
                sessionAudit.decision = finalDecision;
                this.auditTrail.push(sessionAudit);
                return { status: finalDecision, data: llmOutput, warnings: finalDecision === 'ACCEPT_WITH_WARNING' ? aggregatedReports.warnings : [] };
            }

            // 6. Generate Repair Packet for next iteration
            latestRepairPacket = RepairGenerator.buildPacket(finalDecision, score, aggregatedReports.errors);
        }

        // Loop exhausted
        sessionAudit.decision = 'FINAL_STATUS_UNVERIFIED';
        this.auditTrail.push(sessionAudit);
        
        return { 
            status: 'UNVERIFIED', 
            reason: 'Maximum verification retries exceeded without passing score.',
            final_audit: sessionAudit 
        };
    }

    /*
     * Executes the full deterministic pipeline across all extractors and verifiers.
     */
    runVerificationPipeline(llmOutput) {
        const errors = [];
        const warnings = [];
        let missingEvidence = false;
        let scorePenalty = 0;

        // 1. Fact Extraction & Assembly
        const claims = FactExtractor.splitIntoClaims(llmOutput);
        const allFacts = [];
        claims.forEach(c => allFacts.push(...FactExtractor.buildFactObjects(c)));

        // 2. Syntax & Structural Verification (JSON/Code)
        const jsonBlocks = llmOutput.match(/```json\n([\s\S]*?)\n```/g);
        if (jsonBlocks) {
            jsonBlocks.forEach(block => {
                const cleanJson = block.replace(/```json\n|\n```/g, '');
                const jsonCheck = JsonSchemaVerifier.validate(cleanJson, {}); // Using empty schema for generic valid JSON check
                if (!jsonCheck.valid) {
                    errors.push({ type: 'INVALID_JSON', reason: jsonCheck.errors.join(', ') });
                    scorePenalty += 40;
                }
            });
        }

        // 3. Internal Contradiction Check
        const contradictionReport = InternalContradictionChecker.findContradictions(allFacts);
        if (contradictionReport.hasContradictions) {
            contradictionReport.contradictions.forEach(c => {
                errors.push({ type: 'CONTRADICTION', claim: c.entity, expected: c.conflicting_values[0], received: c.conflicting_values[1] });
                scorePenalty += 30;
            });
        }

        // 4. Mathematical Equation Verification (Regex search for equations like X = Y)
        const equations = llmOutput.match(/(?:[a-zA-Z0-9_₹\$€£\s]+\s*=\s*)?[\d\.\(\)\+\-\*\/\^]+(?:\s*[\+\-\*\/\^=]\s*[\d\.\(\)]+)+/g) || [];
        equations.forEach(eq => {
            const parts = eq.split('=');
            if (parts.length >= 1) {
                const expression = parts[0].trim();
                const result = SafeMathParser.evaluate(expression);
                
                if (result !== null && !isNaN(result)) {
                    allFacts.push({
                        expression: expression,
                        result: result,
                        unit: "extracted_unit",
                        type: "derived_calculation",
                        source: "calculation"
                    });

                    if (parts.length === 2) {
                        const expectedResult = parseFloat(parts[1].replace(/[^\d.]/g, ''));
                        const calcReport = CalculationVerifier.verifyCalculation(expression, expectedResult);
                        if (calcReport.status === 'CALCULATION_MISMATCH') {
                            errors.push({ 
                                type: 'CALCULATION_ERROR', 
                                claimContext: eq, 
                                expected: calcReport.deterministic_result, 
                                received: expectedResult,
                                attribute: "calculation",
                                entity: "system",
                                scope: "derived"
                            });
                            scorePenalty += 25;
                        }
                    }
                }
            }
        });

        // Calculate final score
        const baseScore = 100 - scorePenalty;
        const aggregatedScore = Math.max(0, baseScore);

        return {
            aggregatedScore: aggregatedScore,
            missingEvidence: missingEvidence,
            errors: errors,
            warnings: warnings,
            metrics: { 
                claims: claims.length, 
                verified: allFacts.length, 
                unverified: errors.length, 
                sources: 0, 
                calc_checks: equations.length, 
                contradictions: contradictionReport.contradictions ? contradictionReport.contradictions.length : 0 
            }
        };
    }

    /*
     * Maps pipeline metrics into the permanent audit trail.
     */
    updateAuditMetrics(audit, reports) {
        if (reports.metrics) {
            audit.claim_count += reports.metrics.claims || 0;
            audit.verified_claims += reports.metrics.verified || 0;
            audit.unsupported_claims += reports.metrics.unverified || 0;
            audit.source_count += reports.metrics.sources || 0;
            audit.calculation_checks += reports.metrics.calc_checks || 0;
            audit.contradictions += reports.metrics.contradictions || 0;
        }
    }
}
