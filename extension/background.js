/**
 * AI Browser Agent - Central Background Service Worker
 * Manifest V3 ES Module
 */

// Default configuration
const DEFAULT_CONFIG = {
  apiBaseUrl: "http://localhost:3000",
  maxStepsPerTask: 15,
  actionTimeoutMs: 15000,
  eventCooldownMs: 30000
};

// Runtime state with MV3 Service Worker wake-up recovery
let currentTask = null;
let pendingApproval = null;
const eventHistory = new Map(); // deduplication cache for proactive events

// Restore state if Service Worker was suspended
chrome.storage.local.get(['currentTask', 'pendingApproval']).then((res) => {
  if (res.currentTask) currentTask = res.currentTask;
  if (res.pendingApproval) pendingApproval = res.pendingApproval;
});

// Register side panel opening behavior on extension action click
chrome.runtime.onInstalled.addListener(() => {
  if (chrome.sidePanel && chrome.sidePanel.setPanelBehavior) {
    chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
  }
});

// Helper: Get stored configuration
async function getConfig() {
  const result = await chrome.storage.local.get("agent_config");
  return { ...DEFAULT_CONFIG, ...(result.agent_config || {}) };
}

// Helper: Broadcast state changes to sidepanel/UI and persist to storage
function broadcastState(eventType, payload) {
  chrome.storage.local.set({ currentTask, pendingApproval });
  chrome.runtime.sendMessage({ type: eventType, payload }).catch(() => {
    // Sidepanel might be closed, safely ignore
  });
}

// Helper: Safe URL parser
function safeParseUrl(urlString) {
  try {
    const parsed = new URL(urlString);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

// Helper: Get active tab in current window
async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs.length > 0 ? tabs[0] : null;
}

// Safe communication with active tab content script
async function sendTabMessage(tabId, message) {
  try {
    return await chrome.tabs.sendMessage(tabId, message);
  } catch (error) {
    // Inject content script if not ready or on dynamic navigation
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: true },
        files: ["content.js"]
      });
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (innerError) {
      return { ok: false, error: `Content script unreachable: ${innerError.message}` };
    }
  }
}

// Strict Action Allowlist Validation (Defense-in-depth)
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

function validateStructuredAction(action) {
  if (!action || typeof action !== "object") {
    return { valid: false, reason: "Action payload is not an object" };
  }
  if (!ALLOWED_ACTION_TYPES.has(action.type)) {
    return { valid: false, reason: `Disallowed action type: ${action.type}` };
  }

  switch (action.type) {
    case "navigate": {
      if (!action.url || typeof action.url !== "string") {
        return { valid: false, reason: "Navigate requires a valid string url" };
      }
      const parsed = safeParseUrl(action.url);
      if (!parsed) {
        return { valid: false, reason: "Dangerous or invalid URL scheme. Only HTTP/HTTPS allowed." };
      }
      break;
    }
    case "type": {
      if (typeof action.text !== "string") {
        return { valid: false, reason: "Type action requires text property" };
      }
      if (!action.target || typeof action.target !== "object") {
        return { valid: false, reason: "Type action requires a target specification" };
      }
      break;
    }
    case "click":
    case "select": {
      if (!action.target || typeof action.target !== "object") {
        return { valid: false, reason: `${action.type} requires a target specification` };
      }
      break;
    }
    case "scroll": {
      if (action.direction && !["up", "down", "top", "bottom"].includes(action.direction)) {
        return { valid: false, reason: "Invalid scroll direction" };
      }
      break;
    }
    case "wait": {
      const ms = Number(action.durationMs || 1000);
      if (isNaN(ms) || ms < 0 || ms > 10000) {
        return { valid: false, reason: "Wait duration must be between 0 and 10000 ms" };
      }
      break;
    }
  }

  return { valid: true };
}

// Check permission policy via Vercel /api/permissions
async function checkPermission(action, hostname) {
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
      // Conservative default: if policy server fails, require approval for non-read actions
      return action.type === "read_page" || action.type === "extract" ? "ALLOW" : "ASK";
    }

    const data = await res.json();
    return data.decision || "ASK"; // ALLOW | ASK | BLOCK
  } catch {
    return action.type === "read_page" || action.type === "extract" ? "ALLOW" : "ASK";
  }
}

// Execute Next Step in Task Loop
async function runTaskStep() {
  if (!currentTask || currentTask.status !== "running") return;

  const config = await getConfig();

  if (currentTask.steps.length >= config.maxStepsPerTask) {
    currentTask.status = "failed";
    currentTask.error = `Task exceeded maximum step limit (${config.maxStepsPerTask})`;
    broadcastState("TASK_UPDATED", currentTask);
    return;
  }

  const tab = await getActiveTab();
  if (!tab || !tab.id) {
    currentTask.status = "failed";
    currentTask.error = "No active browser tab found to interact with";
    broadcastState("TASK_UPDATED", currentTask);
    return;
  }

  const parsedUrl = safeParseUrl(tab.url || "");
  const hostname = parsedUrl ? parsedUrl.hostname : "unknown";

  // Step A: Read current page state
  const pageStateRes = await sendTabMessage(tab.id, { type: "EXTRACT_PAGE_STATE" });
  const pageState = pageStateRes && pageStateRes.ok ? pageStateRes.pageState : { title: tab.title, url: tab.url, visibleText: "" };

  // Step B: Ask Vercel Agent for next structured action
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
          url: tab.url,
          title: tab.title,
          hostname,
          extractedInfo: pageState
        }
      })
    });

    const agentData = await agentRes.json();
    if (!agentRes.ok || !agentData.ok) {
      throw new Error(agentData.error?.message || "Agent planning request failed");
    }

    nextAction = agentData.data.action;
  } catch (error) {
    currentTask.status = "failed";
    currentTask.error = `AI Agent error: ${error.message}`;
    broadcastState("TASK_UPDATED", currentTask);
    return;
  }

  // Step C: Validate action
  const valResult = validateStructuredAction(nextAction);
  if (!valResult.valid) {
    currentTask.status = "failed";
    currentTask.error = `Security rejection: ${valResult.reason}`;
    broadcastState("TASK_UPDATED", currentTask);
    return;
  }

  // Step D: Permission evaluation
  const policyDecision = await checkPermission(nextAction, hostname);

  if (policyDecision === "BLOCK") {
    currentTask.status = "failed";
    currentTask.error = `Action ${nextAction.type} is blocked on ${hostname} by security policy.`;
    broadcastState("TASK_UPDATED", currentTask);
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

  // Step E: Execute allowed action
  await executeValidatedAction(nextAction, tab.id);
}

// Execute Action on Tab and Record Result
async function executeValidatedAction(action, tabId) {
  if (action.type === "finish") {
    currentTask.status = "completed";
    currentTask.result = action.result || "Task completed successfully.";
    currentTask.steps.push({ action, result: { ok: true, finished: true } });
    broadcastState("TASK_UPDATED", currentTask);
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
          // Fallback to avoid hanging on infinite loaders
          setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(listener);
            resolve();
          }, 10000);
        });
      });

      currentTask.steps.push({ action, result: { ok: true, navigatedTo: action.url } });
      broadcastState("TASK_UPDATED", currentTask);
      setTimeout(runTaskStep, 500);
    } catch (err) {
      currentTask.status = "failed";
      currentTask.error = `Navigation failed: ${err.message}`;
      broadcastState("TASK_UPDATED", currentTask);
    }
    return;
  }

  if (action.type === "wait") {
    const duration = action.durationMs || 1000;
    await new Promise((resolve) => setTimeout(resolve, duration));
    currentTask.steps.push({ action, result: { ok: true, waitedMs: duration } });
    broadcastState("TASK_UPDATED", currentTask);
    setTimeout(runTaskStep, 200);
    return;
  }

  // Delegate DOM actions (click, type, select, scroll, extract, read_page) to content.js
  const execResult = await sendTabMessage(tabId, {
    type: "EXECUTE_ACTION",
    action
  });

  if (!execResult || !execResult.ok) {
    currentTask.status = "failed";
    currentTask.error = execResult?.error || `Failed executing ${action.type}`;
    broadcastState("TASK_UPDATED", currentTask);
    return;
  }

  currentTask.steps.push({ action, result: execResult.data || { ok: true } });
  broadcastState("TASK_UPDATED", currentTask);

  // Continue to next step
  setTimeout(runTaskStep, 600);
}

// Proactive Event Handler with Deduplication & Cooldown
async function handleProactiveEvent(eventData) {
  if (!eventData || !eventData.type) return;

  const eventKey = `${eventData.type}_${eventData.hostname || ""}_${eventData.identifier || ""}`;
  const now = Date.now();
  const config = await getConfig();

  if (eventHistory.has(eventKey)) {
    const lastTime = eventHistory.get(eventKey);
    if (now - lastTime < config.eventCooldownMs) {
      return; // Suppress duplicate events within cooldown window
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

// Central Message Routing
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !message.type) {
    sendResponse({ ok: false, error: "Invalid message shape" });
    return false;
  }

  switch (message.type) {
    case "GET_TASK_STATE": {
      sendResponse({ ok: true, task: currentTask, pendingApproval });
      return false;
    }

    case "START_TASK": {
      if (currentTask && currentTask.status === "running") {
        sendResponse({ ok: false, error: "A task is already running. Please wait or cancel it." });
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

      // Begin execution loop
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
      sendResponse({ ok: true });
      return false;
    }

    case "SUBMIT_APPROVAL": {
      if (!pendingApproval || pendingApproval.actionId !== message.actionId) {
        sendResponse({ ok: false, error: "No matching pending approval found." });
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
              executeValidatedAction(approvedAction, tab.id);
            }
          });
        }
      } else {
        if (currentTask) {
          currentTask.status = "failed";
          currentTask.error = "Action was rejected by user.";
          broadcastState("TASK_UPDATED", currentTask);
        }
      }

      sendResponse({ ok: true });
      return false;
    }

    case "DISPATCH_DOM_EVENT": {
      // Received from content.js for proactive detection
      handleProactiveEvent(message.event);
      sendResponse({ ok: true });
      return false;
    }

    case "GET_CONFIG": {
      getConfig().then((cfg) => sendResponse({ ok: true, config: cfg }));
      return true; // async sendResponse
    }

    case "SET_CONFIG": {
      if (message.config && typeof message.config === "object") {
        chrome.storage.local.set({ agent_config: message.config }).then(() => {
          sendResponse({ ok: true });
        });
        return true;
      }
      sendResponse({ ok: false, error: "Invalid config object" });
      return false;
    }

    default:
      sendResponse({ ok: false, error: `Unhandled message type: ${message.type}` });
      return false;
  }
});
