/**
 * Vercel Serverless Function: /api/permissions
 * Security Firewall & Permission Policy Engine
 */

// Permitted authorization decisions
const VALID_DECISIONS = new Set(["ALLOW", "ASK", "BLOCK"]);

// High-risk semantic keywords that automatically escalate actions to ASK or BLOCK
const SENSITIVE_KEYWORDS = [
  "buy",
  "purchase",
  "pay",
  "payment",
  "order",
  "checkout",
  "credit card",
  "cvv",
  "password",
  "secret",
  "token",
  "delete",
  "remove",
  "erase",
  "transfer",
  "submit",
  "send message",
  "send email"
];

// Global baseline policy rules by action category
const DEFAULT_GLOBAL_POLICIES = {
  read_page: "ALLOW",
  extract: "ALLOW",
  scroll: "ALLOW",
  wait: "ALLOW",
  go_back: "ALLOW",
  finish: "ALLOW",
  navigate: "ALLOW",
  click: "ASK",
  type: "ASK",
  select: "ASK",
  request_approval: "ASK"
};

// Domain-specific conservative overrides
const DOMAIN_SPECIFIC_POLICIES = {
  "mail.google.com": {
    read_page: "ALLOW",
    extract: "ALLOW",
    type: "ALLOW",
    click: "ASK",
    send: "ASK",
    delete: "BLOCK"
  },
  "github.com": {
    read_page: "ALLOW",
    extract: "ALLOW",
    click: "ALLOW",
    type: "ALLOW",
    merge: "ASK",
    delete: "BLOCK"
  }
};

// Runtime in-memory policy registry for dynamic user overrides & remembered rules
const customPolicyStore = new Map();

// Helper: Standard CORS configuration
function setCorsHeaders(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

// Helper: Strict hostname normalization to prevent spoofing and domain confusion
function normalizeHostname(rawHostname) {
  if (!rawHostname || typeof rawHostname !== "string") return "unknown";
  
  let host = rawHostname.trim().toLowerCase();
  
  // Strip protocol if erroneously passed
  host = host.replace(/^https?:\/\//i, "");
  // Strip path or port
  host = host.split("/")[0].split(":")[0];
  
  // Remove leading www.
  if (host.startsWith("www.")) {
    host = host.slice(4);
  }

  return host || "unknown";
}

// Helper: Safe domain hierarchy matching
function matchDomainPolicy(hostname, policyMap) {
  if (policyMap[hostname]) {
    return policyMap[hostname];
  }

  // Check parent domains (e.g. sub.example.com -> example.com)
  const parts = hostname.split(".");
  for (let i = 1; i < parts.length - 1; i++) {
    const parentDomain = parts.slice(i).join(".");
    if (policyMap[parentDomain]) {
      return policyMap[parentDomain];
    }
  }

  return null;
}

// Helper: Check if action description or target contains high-risk triggers
function containsSensitiveKeywords(actionDetails) {
  if (!actionDetails || typeof actionDetails !== "object") return false;

  const corpus = [
    actionDetails.description || "",
    actionDetails.text || "",
    actionDetails.target?.description || "",
    actionDetails.target?.text || "",
    actionDetails.target?.selector || ""
  ].join(" ").toLowerCase();

  return SENSITIVE_KEYWORDS.some((kw) => corpus.includes(kw));
}

// Central Policy Evaluation Logic
function evaluateActionPolicy(actionType, hostname, actionDetails = {}) {
  const normHost = normalizeHostname(hostname);

  // 1. Mandatory override for explicitly requested approvals
  if (actionType === "request_approval") {
    return { decision: "ASK", reason: "Action explicitly marked for human approval." };
  }

  // 2. High-risk keyword escalation
  if (containsSensitiveKeywords(actionDetails)) {
    if (actionType === "click" || actionType === "type" || actionType === "navigate") {
      return { decision: "ASK", reason: "Action interacts with sensitive or financial operations." };
    }
  }

  // 3. Check dynamic remembered rules first
  const customKey = `${normHost}:${actionType}`;
  if (customPolicyStore.has(customKey)) {
    const customDecision = customPolicyStore.get(customKey);
    return { decision: customDecision, reason: "Evaluated against user-defined policy rule." };
  }

  // 4. Check domain-specific security rules
  const domainPolicy = matchDomainPolicy(normHost, DOMAIN_SPECIFIC_POLICIES);
  if (domainPolicy && domainPolicy[actionType]) {
    return { decision: domainPolicy[actionType], reason: `Evaluated against domain policy for ${normHost}.` };
  }

  // 5. Fallback to global baseline policy
  const defaultDecision = DEFAULT_GLOBAL_POLICIES[actionType] || "ASK";
  return { decision: defaultDecision, reason: "Evaluated against global default policy." };
}

// Vercel Serverless Function Handler
export default async function handler(req, res) {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  // GET: Retrieve all active permission policies and rule definitions
  if (req.method === "GET") {
    const activeCustomRules = [];
    customPolicyStore.forEach((decision, key) => {
      const [hostname, actionType] = key.split(":");
      activeCustomRules.push({ hostname, actionType, decision });
    });

    return res.status(200).json({
      ok: true,
      data: {
        globalDefaults: DEFAULT_GLOBAL_POLICIES,
        domainPolicies: DOMAIN_SPECIFIC_POLICIES,
        customRules: activeCustomRules
      }
    });
  }

  // POST: Evaluate permission or update policy rules
  if (req.method === "POST") {
    try {
      const body = req.body || {};
      const operation = body.operation || "EVALUATE";

      // Case A: Update / Save custom remembered policy rule
      if (operation === "SET_RULE" || body.action === "SAVE_POLICY") {
        const { hostname, actionType, decision } = body;

        if (!hostname || !actionType || !VALID_DECISIONS.has(decision)) {
          return res.status(400).json({
            ok: false,
            error: { code: "INVALID_RULE_PARAMETERS", message: "hostname, valid actionType, and decision (ALLOW/ASK/BLOCK) are required." }
          });
        }

        const normHost = normalizeHostname(hostname);
        const ruleKey = `${normHost}:${actionType}`;
        customPolicyStore.set(ruleKey, decision);

        return res.status(200).json({
          ok: true,
          data: {
            saved: true,
            rule: { hostname: normHost, actionType, decision }
          }
        });
      }

      // Case B: Evaluate action permission (default)
      const actionType = body.actionType || body.action?.type;
      const hostname = body.hostname || "unknown";
      const actionDetails = body.actionDetails || body.action || {};

      if (!actionType || typeof actionType !== "string") {
        return res.status(400).json({
          ok: false,
          error: { code: "MISSING_ACTION_TYPE", message: "actionType string is required for evaluation." }
        });
      }

      const { decision, reason } = evaluateActionPolicy(actionType, hostname, actionDetails);

      return res.status(200).json({
        ok: true,
        decision,
        reason,
        hostname: normalizeHostname(hostname),
        actionType
      });
    } catch (error) {
      // Conservative fail-safe: Default to ASK on unexpected failure
      return res.status(500).json({
        ok: false,
        decision: "ASK",
        error: {
          code: "PERMISSION_EVALUATION_ERROR",
          message: error.message || "Failed to evaluate permission policy safely. Defaulted to ASK."
        }
      });
    }
  }

  return res.status(405).json({
    ok: false,
    error: { code: "METHOD_NOT_ALLOWED", message: "Only GET, POST, and OPTIONS requests are supported." }
  });
}
