/**
 * AI Browser Agent - Sidepanel Controller
 * Manages sidepanel UI state, user commands, approvals, and communication with background.js
 */

// DOM Elements
const statusBadge = document.getElementById("status-badge");
const notificationCard = document.getElementById("notification-card");
const notificationTitle = document.getElementById("notification-title");
const notificationMessage = document.getElementById("notification-message");
const dismissNotificationBtn = document.getElementById("dismiss-notification-btn");
const actNotificationBtn = document.getElementById("act-notification-btn");

const approvalCard = document.getElementById("approval-card");
const approvalSite = document.getElementById("approval-site");
const approvalAction = document.getElementById("approval-action");
const approvalDesc = document.getElementById("approval-desc");
const approvalReversibleBadge = document.getElementById("approval-reversible-badge");
const approveBtn = document.getElementById("approve-btn");
const rejectBtn = document.getElementById("reject-btn");

const goalForm = document.getElementById("goal-form");
const goalInput = document.getElementById("goal-input");
const startBtn = document.getElementById("start-btn");
const cancelBtn = document.getElementById("cancel-btn");

const taskSection = document.getElementById("task-section");
const taskStepCount = document.getElementById("task-step-count");
const taskGoalDisplay = document.getElementById("task-goal-display");
const taskError = document.getElementById("task-error");
const taskResult = document.getElementById("task-result");
const stepList = document.getElementById("step-list");

const configApiUrl = document.getElementById("config-api-url");
const saveConfigBtn = document.getElementById("save-config-btn");
const configStatus = document.getElementById("config-status");

// Local UI state
let currentPendingApproval = null;
let currentSuggestedGoal = null;

/**
 * Status Badge Styler
 */
function updateStatusBadge(status) {
  statusBadge.textContent = (status || "IDLE").toUpperCase();

  const styles = {
    idle: { bg: "#e5e7eb", color: "#4b5563" },
    running: { bg: "#dbeafe", color: "#1d4ed8" },
    waiting_for_approval: { bg: "#fef3c7", color: "#b45309" },
    completed: { bg: "#dcfce7", color: "#15803d" },
    failed: { bg: "#fee2e2", color: "#b91c1c" },
    cancelled: { bg: "#f3f4f6", color: "#6b7280" }
  };

  const currentStyle = styles[status] || styles.idle;
  statusBadge.style.backgroundColor = currentStyle.bg;
  statusBadge.style.color = currentStyle.color;
}

/**
 * Render Action Step Timeline
 */
function renderSteps(steps) {
  stepList.innerHTML = "";
  if (!Array.isArray(steps) || steps.length === 0) {
    const li = document.createElement("li");
    li.style.color = "#9ca3af";
    li.textContent = "No actions executed yet.";
    stepList.appendChild(li);
    return;
  }

  steps.forEach((step, idx) => {
    const li = document.createElement("li");
    li.style.padding = "2px 0";

    const typeSpan = document.createElement("strong");
    typeSpan.textContent = `[${step.action.type}] `;
    typeSpan.style.color = "#374151";

    const descSpan = document.createElement("span");
    descSpan.textContent = step.action.description || JSON.stringify(step.action.target || step.action.url || "");

    li.appendChild(typeSpan);
    li.appendChild(descSpan);
    stepList.appendChild(li);
  });
}

/**
 * Render Complete Task UI State
 */
function renderTaskState(task) {
  if (!task) {
    taskSection.style.display = "none";
    updateStatusBadge("idle");
    startBtn.disabled = false;
    startBtn.style.opacity = "1";
    startBtn.style.cursor = "pointer";
    cancelBtn.disabled = true;
    cancelBtn.style.cursor = "not-allowed";
    cancelBtn.style.backgroundColor = "#f3f4f6";
    cancelBtn.style.color = "#9ca3af";
    return;
  }

  taskSection.style.display = "block";
  taskGoalDisplay.textContent = `Goal: "${task.goal}"`;
  taskStepCount.textContent = `Step ${task.steps ? task.steps.length : 0}`;
  updateStatusBadge(task.status);

  // Button states
  const isRunning = task.status === "running" || task.status === "waiting_for_approval";
  startBtn.disabled = isRunning;
  startBtn.style.opacity = isRunning ? "0.6" : "1";
  startBtn.style.cursor = isRunning ? "not-allowed" : "pointer";

  cancelBtn.disabled = !isRunning;
  cancelBtn.style.cursor = isRunning ? "pointer" : "not-allowed";
  cancelBtn.style.backgroundColor = isRunning ? "#fee2e2" : "#f3f4f6";
  cancelBtn.style.color = isRunning ? "#dc2626" : "#9ca3af";
  cancelBtn.style.borderColor = isRunning ? "#fca5a5" : "#d1d5db";

  // Error display
  if (task.error) {
    taskError.style.display = "block";
    taskError.textContent = `Error: ${task.error}`;
  } else {
    taskError.style.display = "none";
  }

  // Result display
  if (task.result) {
    taskResult.style.display = "block";
    taskResult.textContent = `Completed: ${task.result}`;
  } else {
    taskResult.style.display = "none";
  }

  renderSteps(task.steps);
}

/**
 * Render Approval Request Card
 */
function renderApproval(approval) {
  currentPendingApproval = approval;

  if (!approval) {
    approvalCard.style.display = "none";
    return;
  }

  approvalCard.style.display = "block";
  approvalSite.textContent = approval.hostname || "unknown";
  approvalAction.textContent = approval.action?.type || "action";
  approvalDesc.textContent = approval.description || "The AI is requesting permission to perform an action.";
  
  if (approval.reversible) {
    approvalReversibleBadge.textContent = "✓ Reversible action (Low risk)";
    approvalReversibleBadge.style.color = "#15803d";
  } else {
    approvalReversibleBadge.textContent = "⚠ Potentially irreversible action (High risk)";
    approvalReversibleBadge.style.color = "#b45309";
  }
}

/**
 * Render Proactive Notification Banner
 */
function renderNotification(notif) {
  if (!notif) {
    notificationCard.style.display = "none";
    return;
  }

  notificationTitle.textContent = notif.title || "Proactive Notice";
  notificationMessage.textContent = notif.message;
  currentSuggestedGoal = notif.suggestedGoal || null;

  if (currentSuggestedGoal) {
    actNotificationBtn.style.display = "block";
    actNotificationBtn.textContent = `Run: "${currentSuggestedGoal.slice(0, 35)}..."`;
  } else {
    actNotificationBtn.style.display = "none";
  }

  notificationCard.style.display = "block";
}

/**
 * Event Handlers
 */

// Start Task
goalForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const goal = goalInput.value.trim();
  if (!goal) return;

  chrome.runtime.sendMessage({ type: "START_TASK", goal }, (res) => {
    if (res && res.ok) {
      renderTaskState(res.task);
      goalInput.value = "";
    } else {
      alert(res?.error || "Failed to start task");
    }
  });
});

// Cancel Task
cancelBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "CANCEL_TASK" }, () => {
    updateStatusBadge("cancelled");
  });
});

// Approve Action
approveBtn.addEventListener("click", () => {
  if (!currentPendingApproval) return;
  chrome.runtime.sendMessage({
    type: "SUBMIT_APPROVAL",
    actionId: currentPendingApproval.actionId,
    approved: true
  }, () => {
    renderApproval(null);
  });
});

// Reject Action
rejectBtn.addEventListener("click", () => {
  if (!currentPendingApproval) return;
  chrome.runtime.sendMessage({
    type: "SUBMIT_APPROVAL",
    actionId: currentPendingApproval.actionId,
    approved: false
  }, () => {
    renderApproval(null);
  });
});

// Dismiss Notification
dismissNotificationBtn.addEventListener("click", () => {
  renderNotification(null);
});

// Act on Notification Suggestion
actNotificationBtn.addEventListener("click", () => {
  if (!currentSuggestedGoal) return;
  goalInput.value = currentSuggestedGoal;
  renderNotification(null);
  goalForm.dispatchEvent(new Event("submit"));
});

// Save Backend Config
saveConfigBtn.addEventListener("click", () => {
  const url = configApiUrl.value.trim().replace(/\/+$/, "");
  if (!url) return;

  chrome.runtime.sendMessage({
    type: "SET_CONFIG",
    config: { apiBaseUrl: url }
  }, (res) => {
    if (res && res.ok) {
      configStatus.textContent = "Saved!";
      setTimeout(() => { configStatus.textContent = ""; }, 2500);
    }
  });
});

/**
 * Message Listener for Live Updates from background.js
 */
chrome.runtime.onMessage.addListener((message) => {
  if (!message || !message.type) return;

  switch (message.type) {
    case "TASK_UPDATED":
      renderTaskState(message.payload);
      break;

    case "APPROVAL_REQUESTED":
      renderApproval(message.payload);
      break;

    case "PROACTIVE_NOTIFICATION":
      renderNotification(message.payload);
      break;
  }
});

/**
 * Initial Sync on Sidepanel Open
 */
function initialize() {
  // Sync config
  chrome.runtime.sendMessage({ type: "GET_CONFIG" }, (res) => {
    if (res && res.ok && res.config) {
      configApiUrl.value = res.config.apiBaseUrl || "http://localhost:3000";
    }
  });

  // Sync active task & approval state
  chrome.runtime.sendMessage({ type: "GET_TASK_STATE" }, (res) => {
    if (res && res.ok) {
      renderTaskState(res.task);
      renderApproval(res.pendingApproval);
    }
  });
}

document.addEventListener("DOMContentLoaded", initialize);
