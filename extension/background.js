/**
 * AI Browser Agent - Central Background Service Worker
 * Manifest V3 ES Module Engine
 * 
 * Includes:
 * - Defensive API detection (handles missing chrome.scripting gracefully)
 * - Restricted URL filter (prevents injection errors on chrome://, webstore, etc.)
 * - Exponential backoff content script communication & auto-injection retry loop
 * - Persistent Service Worker state & keep-alive ping engine
 * - Heuristic content parsing & sanitized DOM context summarizer
 * - Human-in-the-loop permission firewall
 */

// --- 1. CONFIGURATION & CONSTANTS ---

const DEFAULT_CONFIG = {
  apiBaseUrl: "http://localhost:3000",
  maxStepsPerTask: 20,
  actionTimeoutMs: 20000,
  eventCooldownMs: 30000,
  maxRetryAttempts: 3,
  retryDelayBaseMs: 400
};

const RESTRICTED_SCHEMES = [
  "chrome:",
  "chrome-extension:",
  "chrome-search:",
  "edge:",
  "about:",
  "data:",
  "view-source:",
  "devtools:"
];

const RESTRICTED_HOSTS = [
  "chromewebstore.google.com",
  "chrome.google.com",
  "microsoftedge.microsoft.com"
];

const ALLOWED_ACTION_TYPES = new Set([
  "read_page",
  "navigate",
  "click",
  "type",
  "select",
  "scroll",
  "wait",
  "go_back",
  "extract",
  "request_approval",
  "finish"
]);

// --- 2. RUNTIME STATE MANAGEMENT ---

let currentTask = null;
let pendingApproval = null;
let keepAliveTimer = null;
const eventHistory = new Map();

/**
 * Restores state from chrome.storage.local on Service Worker spin-up
 */
async function restoreRuntimeState() {
  try {
    const data = await chrome.storage.local.get(["currentTask", "pendingApproval"]);
    if (data.currentTask) currentTask = data.currentTask;
    if (data.pendingApproval) pendingApproval = data.pendingApproval;
  } catch (err) {
    console.warn("[Agent Engine] Failed to restore state from local storage:", err);
  }
}
restoreRuntimeState();

/**
 * Persists runtime state and broadcasts changes to active sidepanel UI
 */
function broadcastState(eventType, payload) {
  chrome.storage.local.set({ currentTask, pendingApproval }).catch(() => {});
  chrome.runtime.sendMessage({ type: eventType, payload }).catch(() => {
    // Expected when sidepanel is not open
  });
}

/**
 * MV3 Service Worker Keep-Alive Heartbeat
 */
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

// Register side panel opening on extension icon click
chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
});

// --- 3. URL & ENVIRONMENT VALIDATION ENGINE ---

/**
 * Safe URL parsing with scheme normalization
 */
function safeParseUrl(urlString) {
  if (!urlString || typeof urlString !== "string") return null;
  try {
    const parsed = new URL(urlString);
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Evaluates whether a tab is restricted by Chrome security policies
 */
function isRestrictedUrl(urlString) {
  const parsed = safeParseUrl(urlString);
  if (!parsed) return true;

  if (RESTRICTED_SCHEMES.includes(parsed.protocol)) {
    return true;
  }

  if (RESTRICTED_HOSTS.some(host => parsed.hostname.toLowerCase().includes(host))) {
    return true;
  }

  return false;
}

/**
 * Queries the active tab in the current focused window
 */
async function getActiveTab() {
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    return tabs && tabs.length > 0 ? tabs[0] : null;
  } catch (err) {
    console.error("[Agent Engine] Failed to query active tab:", err);
    return null;
  }
}

/**
 * Retrieves agent settings with runtime fallback defaults
 */
async function getConfig() {
  try {
    const result = await chrome.storage.local.get("agent_config");
    return { ...DEFAULT_CONFIG, ...(result.agent_config || {}) };
  } catch {
    return DEFAULT_CONFIG;
  }
}

// --- 4. RESILIENT CONTENT SCRIPT COMMUNICATOR & INJECTOR ---

/**
 * Injects content.js defensively checking API availability and URL restrictions
 */
async function ensureContentScriptInjected(tabId, url) {
  if (isRestrictedUrl(url)) {
    return { 
      ok: false, 
      error: `Cannot automate restricted browser page (${url || "browser settings/new tab"}). Please navigate to a standard website.` 
    };
  }

  // Check if chrome.scripting API is available in current context
  if (typeof chrome.scripting === "undefined" || !chrome.scripting.executeScript) {
    return {
      ok: false,
      error: "The chrome.scripting API is unavailable. Ensure the 'scripting' permission is declared in manifest.json and reload the extension at chrome://extensions."
    };
  }

  try {
    await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      files: ["content.js"]
    });
    return { ok: true };
  } catch (err) {
    return { 
      ok: false, 
      error: `Script injection failed on ${url}: ${err.message}` 
    };
  }
}

/**
 * Dispatches a message to a tab with automated retries and injection fallbacks
 */
async function sendTabMessageWithRetry(tabId, url, message, maxRetries = 2) {
  if (isRestrictedUrl(url)) {
    return { 
      ok: false, 
      error: `Cannot communicate on restricted tab (${url || "internal page"}). Please navigate to a standard webpage.` 
    };
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, message);
      if (response) return response;
    } catch (err) {
      // Content script is likely unmounted or not yet injected
      if (attempt < maxRetries) {
        const injectResult = await ensureContentScriptInjected(tabId, url);
        if (!injectResult.ok) {
          return injectResult;
        }
        // Small exponential delay for content script listener registration
        await new Promise(r => setTimeout(r, 200 * Math.pow(2, attempt)));
      } else {
        return { 
          ok: false, 
          error: `Content script connection timeout after ${maxRetries + 1} attempts: ${err.message}` 
        };
      }
    }
  }

  return { ok: false, error: "Tab communication failed unexpectedly." };
}

// --- 5. ACTION VALIDATOR & SECURITY FIREWALL ---

function validateStructuredAction(action) {
  if (!action || typeof action !== "object") {
    return { valid: false, reason: "Action payload must be a JSON object" };
  }
  if (!ALLOWED_ACTION_TYPES.has(action.type)) {
    return { valid: false, reason: `Action type '${action.type}' is not supported` };
  }

  switch (action.type) {
    case "navigate": {
      if (!action.url || typeof action.url !== "string") {
        return { valid: false, reason: "Action 'navigate' requires a valid string URL" };
      }
      const parsed = safeParseUrl(action.url);
      if (!parsed || !["http:", "https:"].includes(parsed.protocol)) {
        return { valid: false, reason: "Only standard HTTP/HTTPS navigation is permitted" };
      }
      break;
    }
    case "type": {
      if (typeof action.text !== "string") {
        return { valid: false, reason: "Action 'type' requires text property" };
      }
      if (!action.target || typeof action.target !== "object") {
        return { valid: false, reason: "Action 'type' requires a target descriptor" };
      }
      break;
    }
    case "click":
    case "select": {
      if (!action.target || typeof action.target !== "object") {
        return { valid: false, reason: `Action '${action.type}' requires a target descriptor` };
      }
      break;
    }
    case "scroll": {
      if (action.direction && !["up", "down", "top", "bottom"].includes(action.direction)) {
        return { valid: false, reason: "Invalid scroll direction. Allowed: up, down, top, bottom" };
      }
      break;
    }
    case "wait": {
      const ms = Number(action.durationMs || 1000);
      if (isNaN(ms) || ms < 0 || ms > 15000) {
        return { valid: false, reason: "Wait duration must be a number between 0 and 15000 ms" };
      }
      break;
    }
  }

  return { valid: true };
}

async function evaluateSecurityPolicy(action, hostname) {
  try {
    const config = await getConfig();
    const res = await fetch(`${config.apiBaseUrl}/api/permissions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        actionType: action.type,
        hostname: hostname || "unknown",
        actionDetails: action
      })
    });

    if (!res.ok) {
      // Passive read actions allowed if policy server is offline
      return ["read_page", "extract", "scroll", "wait"].includes(action.type) ? "ALLOW" : "ASK";
    }

    const data = await res.json();
    return data.decision || "ASK";
  } catch {
    return ["read_page", "extract", "scroll", "wait"].includes(action.type) ? "ALLOW" : "ASK";
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

  // Guard: Max step limit
  if (currentTask.steps.length >= config.maxStepsPerTask) {
    currentTask.status = "failed";
    currentTask.error = `Task exceeded maximum step limit of ${config.maxStepsPerTask}`;
    broadcastState("TASK_UPDATED", currentTask);
    stopKeepAlive();
    return;
  }

  // Guard: Tab context
  const tab = await getActiveTab();
  if (!tab || !tab.id) {
    currentTask.status = "failed";
    currentTask.error = "No active browser tab detected. Please focus an open tab.";
    broadcastState("TASK_UPDATED", currentTask);
    stopKeepAlive();
    return;
  }

  const tabUrl = tab.url || "";
  if (isRestrictedUrl(tabUrl)) {
    currentTask.status = "failed";
    currentTask.error = `Cannot execute tasks on restricted browser pages (${tabUrl}). Please open a standard web page.`;
    broadcastState("TASK_UPDATED", currentTask);
    stopKeepAlive();
    return;
  }

  const parsedUrl = safeParseUrl(tabUrl);
  const hostname = parsedUrl ? parsedUrl.hostname : "unknown";

  // Step A: Extract DOM Page State with fallback
  const pageStateRes = await sendTabMessageWithRetry(tab.id, tabUrl, { type: "EXTRACT_PAGE_STATE" });
  let pageState = { title: tab.title || "", url: tabUrl, visibleText: "", headings: [], interactiveElements: [] };

  if (pageStateRes && pageStateRes.ok && pageStateRes.pageState) {
    pageState = pageStateRes.pageState;
  }

  // Step B: Query Backend Agent Planner
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
        pageContext: {
          url: tabUrl,
          title: tab.title || "",
          hostname,
          extractedInfo: pageState
        }
      })
    });

    const agentData = await agentRes.json();
    if (!agentRes.ok || !agentData.ok) {
      throw new Error(agentData.error?.message || `Backend Agent returned status ${agentRes.status}`);
    }

    nextAction = agentData.data?.action;
  } catch (err) {
    currentTask.status = "failed";
    currentTask.error = `Agent planning error: ${err.message}`;
    broadcastState("TASK_UPDATED", currentTask);
    stopKeepAlive();
    return;
  }

  // Step C: Validate Action Syntax & Allowlist
  const validation = validateStructuredAction(nextAction);
  if (!validation.valid) {
    currentTask.status = "failed";
    currentTask.error = `Security rejection: ${validation.reason}`;
    broadcastState("TASK_UPDATED", currentTask);
    stopKeepAlive();
    return;
  }

  // Step D: Permission & Human-In-The-Loop Verification
  const policyDecision = await evaluateSecurityPolicy(nextAction, hostname);

  if (policyDecision === "BLOCK") {
    currentTask.status = "failed";
    currentTask.error = `Action '${nextAction.type}' on ${hostname} is blocked by your security policies.`;
    broadcastState("TASK_UPDATED", currentTask);
    stopKeepAlive();
    return;
  }

  if (policyDecision === "ASK" || nextAction.type === "request_approval") {
    currentTask.status = "waiting_for_approval";
    pendingApproval = {
      actionId: `act_${Date.now()}`,
      taskId: currentTask.id,
      action: nextAction,
      hostname,
      description: nextAction.description || `Execute ${nextAction.type} on ${hostname}`,
      reversible: ["read_page", "scroll", "extract", "wait"].includes(nextAction.type)
    };
    broadcastState("TASK_UPDATED", currentTask);
    broadcastState("APPROVAL_REQUESTED", pendingApproval);
    return;
  }

  // Step E: Execute the validated action
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
        chrome.tabs.update(tabId, { url: action.url }, (tab) => {
          if (chrome.runtime.lastError) {
            return reject(new Error(chrome.runtime.lastError.message));
          }

          const listener = (updatedTabId, changeInfo) => {
            if (updatedTabId === tabId && changeInfo.status === "complete") {
              chrome.tabs.onUpdated.removeListener(listener);
              resolve();
            }
          };

          chrome.tabs.onUpdated.addListener(listener);

          // 12-second safety timeout in case page load events stall
          setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }, 12000);
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

  // Dispatch DOM actions (click, type, select, scroll, extract) to content.js
  const execResult = await sendTabMessageWithRetry(tabId, tabUrl, {
    type: "EXECUTE_ACTION",
    action
  });

  if (!execResult || !execResult.ok) {
    currentTask.status = "failed";
    currentTask.error = execResult?.error || `Execution failed for action ${action.type}`;
    broadcastState("TASK_UPDATED", currentTask);
    stopKeepAlive();
    return;
  }

  currentTask.steps.push({ action, result: execResult.data || { ok: true } });
  broadcastState("TASK_UPDATED", currentTask);

  // Advance loop
  setTimeout(runTaskStep, 500);
}

// --- 8. PROACTIVE EVENT MONITORING ---

async function handleProactiveEvent(eventData) {
  if (!eventData || !eventData.type) return;

  const eventKey = `${eventData.type}_${eventData.hostname || ""}_${eventData.identifier || ""}`;
  const now = Date.now();
  const config = await getConfig();

  if (eventHistory.has(eventKey)) {
    const lastTime = eventHistory.get(eventKey);
    if (now - lastTime < config.eventCooldownMs) {
      return;
    }
  }
  eventHistory.set(eventKey, now);

  try {
    const res = await fetch(`${config.apiBaseUrl}/api/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: eventData,
        timestamp: now
      })
    });

    if (!res.ok) return;
    const data = await res.json();

    if (data.ok && data.data && data.data.shouldNotify) {
      broadcastState("PROACTIVE_NOTIFICATION", {
        id: `notif_${now}`,
        title: data.data.title || "AI Assistant Alert",
        message: data.data.message,
        suggestedGoal: data.data.suggestedGoal || null,
        timestamp: now
      });
    }
  } catch {
    // Non-blocking proactive event failure
  }
}

// --- 9. CENTRAL MESSAGE ROUTER ---

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) {
    sendResponse({ ok: false, error: "Invalid message payload" });
    return false;
  }

  switch (message.type) {
    case "GET_TASK_STATE": {
      sendResponse({ ok: true, task: currentTask, pendingApproval });
      return false;
    }

    case "START_TASK": {
      if (currentTask && currentTask.status === "running") {
        sendResponse({ ok: false, error: "A task is already actively running. Please wait or cancel it." });
        return false;
      }

      currentTask = {
        id: `task_${Date.now()}`,
        goal: message.goal,
        status: "running",
        createdAt: new Date().toISOString(),
        steps: [],
        error: null,
        result: null
      };
      pendingApproval = null;

      broadcastState("TASK_UPDATED", currentTask);
      sendResponse({ ok: true, task: currentTask });

      // Start execution loop
      setTimeout(runTaskStep, 100);
      return false;
    }

    case "CANCEL_TASK": {
      if (currentTask) {
        currentTask.status = "cancelled";
        currentTask.error = "Task cancelled by user.";
        broadcastState("TASK_UPDATED", currentTask);
      }
      pendingApproval = null;
      stopKeepAlive();
      sendResponse({ ok: true });
      return false;
    }

    case "SUBMIT_APPROVAL": {
      if (!pendingApproval || pendingApproval.actionId !== message.actionId) {
        sendResponse({ ok: false, error: "No matching pending approval request found." });
        return false;
      }

      const approvedAction = pendingApproval.action;
      pendingApproval = null;

      if (message.approved) {
        if (currentTask && currentTask.status === "waiting_for_approval") {
          currentTask.status = "running";
          broadcastState("TASK_UPDATED", currentTask);
          getActiveTab().then((tab) => {
            if (tab && tab.id) {
              executeValidatedAction(approvedAction, tab.id, tab.url || "");
            }
          });
        }
      } else {
        if (currentTask) {
          currentTask.status = "failed";
          currentTask.error = "Action was rejected by user.";
          broadcastState("TASK_UPDATED", currentTask);
          stopKeepAlive();
        }
      }

      sendResponse({ ok: true });
      return false;
    }

    case "DISPATCH_DOM_EVENT": {
      handleProactiveEvent(message.event);
      sendResponse({ ok: true });
      return false;
    }

    case "GET_CONFIG": {
      getConfig().then((cfg) => sendResponse({ ok: true, config: cfg }));
      return true; // async
    }

    case "SET_CONFIG": {
      if (message.config && typeof message.config === "object") {
        chrome.storage.local.set({ agent_config: message.config }).then(() => {
          sendResponse({ ok: true });
        });
        return true;
      }
      sendResponse({ ok: false, error: "Invalid config object supplied" });
      return false;
    }

    default:
      sendResponse({ ok: false, error: `Unhandled message action: ${message.type}` });
      return false;
  }
});
