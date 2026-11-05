/**
 * AI Browser Agent - Central Background Service Worker
 * Manifest V3 ES Module Engine
 * 
 * Includes:
 * - FULLY AUTONOMOUS MODE (Human-in-the-loop bypassed)
 * - Defensive API detection (handles missing chrome.scripting gracefully)
 * - Restricted URL filter (prevents injection errors on chrome://)
 * - Exponential backoff content script communication & auto-injection retry loop
 * - Persistent Service Worker state & keep-alive ping engine
 */

// --- 1. CONFIGURATION & CONSTANTS ---

const DEFAULT_CONFIG = {
  apiBaseUrl: "http://localhost:3000",
  maxStepsPerTask: 25, // Increased for fully autonomous runs
  actionTimeoutMs: 20000,
  eventCooldownMs: 30000,
  maxRetryAttempts: 3,
  retryDelayBaseMs: 400
};

const RESTRICTED_SCHEMES = [
  "chrome:", "chrome-extension:", "chrome-search:", "edge:", 
  "about:", "data:", "view-source:", "devtools:"
];

const RESTRICTED_HOSTS = [
  "chromewebstore.google.com", "chrome.google.com", "microsoftedge.microsoft.com"
];

const ALLOWED_ACTION_TYPES = new Set([
  "read_page", "navigate", "click", "type", "select", 
  "scroll", "wait", "go_back", "extract", "request_approval", "finish"
]);

// --- 2. RUNTIME STATE MANAGEMENT ---

let currentTask = null;
let pendingApproval = null; // Kept to prevent UI crashes, but will remain null
let keepAliveTimer = null;
const eventHistory = new Map();

async function restoreRuntimeState() {
  try {
    const data = await chrome.storage.local.get(["currentTask"]);
    if (data.currentTask) currentTask = data.currentTask;
  } catch (err) {
    console.warn("[Agent Engine] Failed to restore state:", err);
  }
}
restoreRuntimeState();

function broadcastState(eventType, payload) {
  chrome.storage.local.set({ currentTask }).catch(() => {});
  chrome.runtime.sendMessage({ type: eventType, payload }).catch(() => {});
}

function startKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    chrome.runtime.getPlatformInfo().catch(() => {});
  }, 15000);
}

function stopKeepAlive() {
  if (keepAliveTimer) {
    clearInterval(keepAliveTimer);
    keepAliveTimer = null;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
});

// --- 3. URL & ENVIRONMENT VALIDATION ENGINE ---

function safeParseUrl(urlString) {
  if (!urlString || typeof urlString !== "string") return null;
  try { return new URL(urlString); } catch { return null; }
}

function isRestrictedUrl(urlString) {
  const parsed = safeParseUrl(urlString);
  if (!parsed) return true;
  if (RESTRICTED_SCHEMES.includes(parsed.protocol)) return true;
  if (RESTRICTED_HOSTS.some(host => parsed.hostname.toLowerCase().includes(host))) return true;
  return false;
}

async function getActiveTab() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs.length > 0 ? tabs[0] : null;
  } catch {
    return null;
  }
}

async function getConfig() {
  try {
    const result = await chrome.storage.local.get("agent_config");
    return { ...DEFAULT_CONFIG, ...(result.agent_config || {}) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

// --- 4. RESILIENT CONTENT SCRIPT COMMUNICATOR ---

async function ensureContentScriptInjected(tabId, url) {
  if (isRestrictedUrl(url)) {
    return { ok: false, error: `Cannot automate restricted browser page (${url}).` };
  }
  if (typeof chrome.scripting === "undefined" || !chrome.scripting.executeScript) {
    return { ok: false, error: "chrome.scripting API is unavailable." };
  }
  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["content.js"]
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: `Script injection failed: ${err.message}` };
  }
}

async function sendTabMessageWithRetry(tabId, url, message, maxRetries = 2) {
  if (isRestrictedUrl(url)) return { ok: false, error: "Cannot communicate on restricted tab." };

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, message);
      if (response) return response;
    } catch (err) {
      if (attempt < maxRetries) {
        const injectResult = await ensureContentScriptInjected(tabId, url);
        if (!injectResult.ok) return injectResult;
        await new Promise(r => setTimeout(r, 200 * Math.pow(2, attempt)));
      } else {
        return { ok: false, error: `Content script timeout: ${err.message}` };
      }
    }
  }
  return { ok: false, error: "Tab communication failed unexpectedly." };
}

// --- 5. ACTION VALIDATOR & SECURITY OVERRIDE ---

function validateStructuredAction(action) {
  if (!action || typeof action !== "object") return { valid: false, reason: "Invalid JSON object" };
  if (!ALLOWED_ACTION_TYPES.has(action.type)) return { valid: false, reason: `Action '${action.type}' not supported` };

  if (action.type === "navigate" && (!action.url || !safeParseUrl(action.url))) {
    return { valid: false, reason: "Invalid navigation URL" };
  }
  return { valid: true };
}

async function evaluateSecurityPolicy(action, hostname) {
  try {
    const config = await getConfig();
    const res = await fetch(`${config.apiBaseUrl}/api/permissions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ actionType: action.type, hostname: hostname || "unknown", actionDetails: action })
    });
    
    if (!res.ok) return "ALLOW";
    
    const data = await res.json();
    // AUTONOMY OVERRIDE: Treat "ASK" as "ALLOW"
    return data.decision === "BLOCK" ? "BLOCK" : "ALLOW"; 
  } catch {
    return "ALLOW";
  }
}

// --- 6. CORE AUTONOMOUS TASK RUNNER ---

async function runTaskStep() {
  if (!currentTask || currentTask.status !== "running") {
    stopKeepAlive();
    return;
  }

  startKeepAlive();
  const config = await getConfig();

  if (currentTask.steps.length >= config.maxStepsPerTask) {
    currentTask.status = "failed";
    currentTask.error = `Task exceeded maximum step limit of ${config.maxStepsPerTask}`;
    broadcastState("TASK_UPDATED", currentTask);
    stopKeepAlive();
    return;
  }

  const tab = await getActiveTab();
  if (!tab || !tab.id) {
    currentTask.status = "failed";
    currentTask.error = "No active browser tab detected.";
    broadcastState("TASK_UPDATED", currentTask);
    stopKeepAlive();
    return;
  }

  const tabUrl = tab.url || "";
  if (isRestrictedUrl(tabUrl)) {
    currentTask.status = "failed";
    currentTask.error = `Cannot execute tasks on restricted browser pages (${tabUrl}).`;
    broadcastState("TASK_UPDATED", currentTask);
    stopKeepAlive();
    return;
  }

  const hostname = safeParseUrl(tabUrl)?.hostname || "unknown";

  // Step A: Extract DOM Page State
  const pageStateRes = await sendTabMessageWithRetry(tab.id, tabUrl, { type: "EXTRACT_PAGE_STATE" });
  let pageState = pageStateRes?.ok ? pageStateRes.pageState : { title: tab.title || "", url: tabUrl, visibleText: "", interactiveElements: [] };

  // Step B: Query Backend
  let nextAction = null;
  try {
    const agentRes = await fetch(`${config.apiBaseUrl}/api/agent`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId: currentTask.id,
        goal: currentTask.goal,
        stepIndex: currentTask.steps.length,
        history: currentTask.steps,
        pageContext: { url: tabUrl, title: tab.title || "", hostname, extractedInfo: pageState }
      })
    });

    const agentData = await agentRes.json();
    if (!agentRes.ok || !agentData.ok) throw new Error(agentData.error?.message || `Status ${agentRes.status}`);
    nextAction = agentData.data?.action;
  } catch (err) {
    currentTask.status = "failed";
    currentTask.error = `Agent error: ${err.message}`;
    broadcastState("TASK_UPDATED", currentTask);
    stopKeepAlive();
    return;
  }

  const validation = validateStructuredAction(nextAction);
  if (!validation.valid) {
    currentTask.status = "failed";
    currentTask.error = `Invalid action: ${validation.reason}`;
    broadcastState("TASK_UPDATED", currentTask);
    stopKeepAlive();
    return;
  }

  const policyDecision = await evaluateSecurityPolicy(nextAction, hostname);
  if (policyDecision === "BLOCK") {
    currentTask.status = "failed";
    currentTask.error = `Action '${nextAction.type}' is blocked by strict security policies.`;
    broadcastState("TASK_UPDATED", currentTask);
    stopKeepAlive();
    return;
  }

  // AUTONOMY OVERRIDE: Auto-Approve request_approval signals
  if (nextAction.type === "request_approval") {
    currentTask.steps.push({ action: nextAction, result: { ok: true, autoApproved: true, message: "Approval bypassed in autonomous mode" } });
    broadcastState("TASK_UPDATED", currentTask);
    setTimeout(runTaskStep, 200);
    return;
  }

  await executeValidatedAction(nextAction, tab.id, tabUrl);
}

// --- 7. ACTION EXECUTOR ---

async function executeValidatedAction(action, tabId, tabUrl) {
  if (action.type === "finish") {
    currentTask.status = "completed";
    currentTask.result = action.result || "Task completed successfully.";
    currentTask.steps.push({ action, result: { ok: true, finished: true } });
    broadcastState("TASK_UPDATED", currentTask);
    stopKeepAlive();
    return;
  }

  if (action.type === "navigate") {
    try {
      await new Promise((resolve, reject) => {
        chrome.tabs.update(tabId, { url: action.url }, () => {
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          const listener = (updatedTabId, changeInfo) => {
            if (updatedTabId === tabId && changeInfo.status === "complete") {
              chrome.tabs.onUpdated.removeListener(listener);
              resolve();
            }
          };
          chrome.tabs.onUpdated.addListener(listener);
          setTimeout(() => { chrome.tabs.onUpdated.removeListener(listener); resolve(); }, 12000);
        });
      });

      currentTask.steps.push({ action, result: { ok: true, navigatedTo: action.url } });
      broadcastState("TASK_UPDATED", currentTask);
      setTimeout(runTaskStep, 600);
    } catch (err) {
      currentTask.status = "failed";
      currentTask.error = `Navigation failed: ${err.message}`;
      broadcastState("TASK_UPDATED", currentTask);
      stopKeepAlive();
    }
    return;
  }

  if (action.type === "wait") {
    const duration = Math.min(action.durationMs || 1000, 15000);
    await new Promise(r => setTimeout(r, duration));
    currentTask.steps.push({ action, result: { ok: true, waitedMs: duration } });
    broadcastState("TASK_UPDATED", currentTask);
    setTimeout(runTaskStep, 200);
    return;
  }

  const execResult = await sendTabMessageWithRetry(tabId, tabUrl, { type: "EXECUTE_ACTION", action });

  if (!execResult || !execResult.ok) {
    currentTask.status = "failed";
    currentTask.error = execResult?.error || `Execution failed for action ${action.type}`;
    broadcastState("TASK_UPDATED", currentTask);
    stopKeepAlive();
    return;
  }

  currentTask.steps.push({ action, result: execResult.data || { ok: true } });
  broadcastState("TASK_UPDATED", currentTask);
  setTimeout(runTaskStep, 500);
}

// --- 8. PROACTIVE EVENT MONITORING ---

async function handleProactiveEvent(eventData) {
  if (!eventData || !eventData.type) return;
  const eventKey = `${eventData.type}_${eventData.hostname || ""}_${eventData.identifier || ""}`;
  const now = Date.now();
  const config = await getConfig();

  if (eventHistory.has(eventKey) && (now - eventHistory.get(eventKey) < config.eventCooldownMs)) return;
  eventHistory.set(eventKey, now);

  try {
    const res = await fetch(`${config.apiBaseUrl}/api/events`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ event: eventData, timestamp: now })
    });
    if (!res.ok) return;
    const data = await res.json();
    if (data.ok && data.data?.shouldNotify) {
      broadcastState("PROACTIVE_NOTIFICATION", {
        id: `notif_${now}`, title: data.data.title || "Alert",
        message: data.data.message, suggestedGoal: data.data.suggestedGoal || null, timestamp: now
      });
    }
  } catch {}
}

// --- 9. CENTRAL MESSAGE ROUTER ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) {
    sendResponse({ ok: false, error: "Invalid payload" });
    return false;
  }

  switch (message.type) {
    case "GET_TASK_STATE":
      sendResponse({ ok: true, task: currentTask, pendingApproval: null });
      return false;

    case "START_TASK":
      if (currentTask && currentTask.status === "running") {
        sendResponse({ ok: false, error: "A task is already actively running." });
        return false;
      }
      currentTask = {
        id: `task_${Date.now()}`, goal: message.goal, status: "running",
        createdAt: new Date().toISOString(), steps: [], error: null, result: null
      };
      broadcastState("TASK_UPDATED", currentTask);
      sendResponse({ ok: true, task: currentTask });
      setTimeout(runTaskStep, 100);
      return false;

    case "CANCEL_TASK":
      if (currentTask) {
        currentTask.status = "cancelled";
        currentTask.error = "Task cancelled by user.";
        broadcastState("TASK_UPDATED", currentTask);
      }
      stopKeepAlive();
      sendResponse({ ok: true });
      return false;

    case "DISPATCH_DOM_EVENT":
      handleProactiveEvent(message.event);
      sendResponse({ ok: true });
      return false;

    case "GET_CONFIG":
      getConfig().then((cfg) => sendResponse({ ok: true, config: cfg }));
      return true;

    case "SET_CONFIG":
      if (message.config && typeof message.config === "object") {
        chrome.storage.local.set({ agent_config: message.config }).then(() => sendResponse({ ok: true }));
        return true;
      }
      sendResponse({ ok: false, error: "Invalid config object" });
      return false;

    default:
      sendResponse({ ok: false, error: `Unhandled action: ${message.type}` });
      return false;
  }
});
