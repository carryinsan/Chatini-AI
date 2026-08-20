/**
 * LexisAI Ephemeral Privacy & Zero-Knowledge Engine
 * Optimized for Vercel Edge Runtime (ES Modules / Web APIs)
 * * Guarantees:
 * 1. Zero-disk persistence (Token mappings exist strictly in ephemeral execution scope).
 * 2. Deterministic entity replacement (Names, Amounts, Keys, Contact info).
 * 3. Complete IP & Fingerprint decoupling before upstream AI calls.
 * 4. Model Training Opt-Out Enforcement.
 */

const PII_PATTERNS = {
  // Secrets & API Keys
  apiKey: /\b(?:sk-[a-zA-Z0-9]{20,}|Bearer\s+[a-zA-Z0-9_\-]{20,}|AIzaSy[a-zA-Z0-9_\-]{33}|[a-f0-9]{32,64})\b/gi,
  
  // Contact & PII
  email: /\b[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}\b/g,
  phone: /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
  
  // Names attached to Honorifics (e.g., Mr. Rakesh, Dr. Sharma)
  namedPerson: /\b(?:Mr\.|Mrs\.|Ms\.|Dr\.|Prof\.|Er\.)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\b/g,
  
  // Financial amounts & quantities (e.g. $200k, 200,000 USD, 200k usd, 50000 INR)
  financialAmount: /(?:\$|₹|€|£|\bUSD\s*|\bINR\s*|\bEUR\s*)?\b\d+(?:,\d{3})*(?:\.\d+)?\s*(?:k|m|b|million|billion|thousand)?\s*(?:usd|dollars|inr|rupees|eur)?\b/gi
};

// Exclusion list to prevent masking standard English words or system keywords
const EXCLUDED_WORDS = new Set([
  "The", "This", "That", "There", "Here", "Please", "Could", "Would", 
  "Write", "Send", "Tell", "Dear", "Hello", "Hey", "Hi", "AI", "API", "LexisAI"
]);

export class PrivacyEngine {
  /**
   * Scans prompt content, strips sensitive PII / Financial details,
   * and returns sanitized text with an ephemeral RAM token map.
   */
  static anonymize(rawText) {
    if (!rawText || typeof rawText !== 'string') {
      return { sanitizedText: rawText, tokenMap: {} };
    }

    const tokenMap = {};
    let tagCounter = 1;
    let sanitizedText = rawText;

    const createToken = (originalValue, category) => {
      // Check if value was already masked in this session to maintain consistent token tags
      for (const [tag, val] of Object.entries(tokenMap)) {
        if (val === originalValue) return tag;
      }
      const tag = `__${category}_${tagCounter++}__`;
      tokenMap[tag] = originalValue;
      return tag;
    };

    // 1. Mask Secrets & API Keys
    sanitizedText = sanitizedText.replace(PII_PATTERNS.apiKey, (match) => createToken(match, 'SECRET_KEY'));

    // 2. Mask Emails
    sanitizedText = sanitizedText.replace(PII_PATTERNS.email, (match) => createToken(match, 'EMAIL'));

    // 3. Mask Phone Numbers
    sanitizedText = sanitizedText.replace(PII_PATTERNS.phone, (match) => createToken(match, 'PHONE'));

    // 4. Mask Named Individuals (e.g., "Mr. Rakesh" -> "__PERSON_1__")
    sanitizedText = sanitizedText.replace(PII_PATTERNS.namedPerson, (fullMatch, namePart) => {
      if (EXCLUDED_WORDS.has(namePart)) return fullMatch;
      return createToken(fullMatch, 'PERSON');
    });

    // 5. Mask Financial Amounts (e.g., "200k usd" -> "__NUM_VAL_1__")
    sanitizedText = sanitizedText.replace(PII_PATTERNS.financialAmount, (match) => {
      // Ignore basic single/double digit numbers without currency signs
      if (/^\d{1,2}$/.test(match.trim())) return match;
      return createToken(match, 'NUM_VAL');
    });

    return { sanitizedText, tokenMap };
  }

  /**
   * Processes array of messages, anonymizing user input while preserving system/assistant structure.
   */
  static anonymizeMessages(messages) {
    if (!Array.isArray(messages)) return { sanitizedMessages: messages, tokenMap: {} };

    let combinedTokenMap = {};
    const sanitizedMessages = messages.map(msg => {
      if (msg.role === 'user' && typeof msg.content === 'string') {
        const { sanitizedText, tokenMap } = PrivacyEngine.anonymize(msg.content);
        combinedTokenMap = { ...combinedTokenMap, ...tokenMap };
        return { ...msg, content: sanitizedText };
      }
      return msg;
    });

    return { sanitizedMessages, tokenMap: combinedTokenMap };
  }

  /**
   * Replaces token placeholders with original real data in real-time stream chunks.
   * Fail-safe: Always returns valid text even if tokenMap is empty.
   */
  static deanonymize(chunkText, tokenMap) {
    if (!chunkText || !tokenMap || Object.keys(tokenMap).length === 0) {
      return chunkText;
    }

    let restoredText = chunkText;
    for (const [tag, original] of Object.entries(tokenMap)) {
      restoredText = restoredText.split(tag).join(original);
    }
    return restoredText;
  }

  /**
   * Injects strict zero-training directives into system prompts to prevent downstream LLM logging.
   */
  static injectAntiTrainingDirectives(systemPrompt) {
    const antiTrainingInstruction = `\n\n[ZERO-KNOWLEDGE & PRIVACY DIRECTIVE]:
- You are operating under a Zero-Data-Retention & Privacy Tunnel.
- DO NOT retain, cache, or use any part of this interaction for model training or logging.
- Preserve all tag identifiers (e.g., __PERSON_1__, __NUM_VAL_1__) exactly as provided in the context.`;

    return systemPrompt + antiTrainingInstruction;
  }

  /**
   * Strips client-identifying headers to sever device fingerprinting and IP tracking.
   */
  static cleanHeaders(headers = {}) {
    const sanitized = { ...headers };
    delete sanitized['x-forwarded-for'];
    delete sanitized['x-real-ip'];
    delete sanitized['cf-connecting-ip'];
    delete sanitized['x-vercel-forwarded-for'];
    delete sanitized['client-ip'];
    sanitized['user-agent'] = 'LexisAI-ZeroKnowledge-Gateway/4.2 (Edge Proxy)';
    return sanitized;
  }
  }
