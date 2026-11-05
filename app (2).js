/**
 * AI Browser Agent - Web Dashboard Controller
 * Connects command center UI with Vercel API endpoints (/api/agent, /api/permissions, /api/events)
 */

// DOM Elements - Status & Badges
const systemStatusBadge = document.getElementById("system-status-badge");
const taskStatusTag = document.getElementById("dashboard-task-status-tag");

// DOM Elements - Proactive Notification Banner
const notifBanner = document.getElementById("dashboard-notification-banner");
const notifTitle = document.getElementById("dashboard-notif-title");
const notifMessage = document.getElementById("dashboard-notif-message");
const dismissNotifBtn = document.getElementById("dismiss-dashboard-notif-btn");
const runSuggestedBtn = document.getElementById("run-dashboard-suggested-btn");

// DOM Elements - Approval Card
const approvalCard = document.getElementById("dashboard-approval-card");
const approvalHost = document.getElementById("dash-approval-host");
const approvalAction = document.getElementById("dash-approval-action");
const approvalDesc = document.getElementById("dash-approval-desc");
const approvalRisk = document.getElementById("dash-approval-risk");
const approveBtn = document.getElementById("dash-approve-btn");
const rejectBtn = document.getElementById("dash-reject-btn");

// DOM Elements - Task Execution Form
const taskForm = document.getElementById("dashboard-task-form");
const goalInput = document.getElementById("dashboard-goal-input");
const startBtn = document.getElementById("dashboard-start-btn");
const cancelBtn = document.getElementById("dashboard-cancel-btn");
const goalPreview = document.getElementById("dashboard-goal-preview");
const errorBanner = document.getElementById("dashboard-error-banner");
const resultBanner = document.getElementById("dashboard-result-banner");
const stepsList = document.getElementById("dashboard-steps-list");

// DOM Elements - Permission Firewall
const permForm = document.getElementById("permission-rule-form");
const permHostname = document.getElementById("perm-hostname");
const permActionType = document.getElementById("perm-action-type");
const permDecision = document.getElementById("perm-decision");
const permissionsTableBody = document.getElementById("permissions-table-body");

// Runtime State
let activeTask = null;
let pendingApproval = null;
let currentSuggestedGoal = null;
const MAX_STEPS = 12;

/**
 * Update UI Status Indicators
 */
function updateStatusBadge(status) {
  const normalized = (status || "IDLE").toUpperCase();
  taskStatusTag.textContent = normalized;

  const styles = {
    IDLE: { bg: "#e5e7eb", color: "#4b5563" },
    RUNNING: { bg: "#dbeafe", color: "#1d4ed8" },
    WAITING_FOR_APPROVAL: { bg: "#fef3c7", color: "#b45309" },
    COMPLETED: { bg: "#dcfce7", color: "#15803d" },
    FAILED: { bg: "#fee2e2", color: "#b91c1c" },
    CANCELLED: { bg: "#f3f4f6", color: "#6b7280" }
  };

  const current = styles[normalized] || styles.IDLE;
  taskStatusTag.style.backgroundColor = current.bg;
  taskStatusTag.style.color = current.color;
}

/**
 * Render Action Step History
 */
function renderSteps(steps) {
  stepsList.innerHTML = "";
  if (!Array.isArray(steps) || steps.length === 0) {
    const li = document.createElement("li");
    li.style.color = "#9ca3af";
    li.textContent = "Awaiting execution steps...";
    stepsList.appendChild(li);
    return;
  }

  steps.forEach((step, idx) => {
    const li = document.createElement("li");
    li.style.padding = "3px 0";

    const tag = document.createElement("strong");
    tag.textContent = `[Step ${idx + 1} - ${step.action?.type || "action"}]: `;
    tag.style.color = "#1f2937";

    const desc = document.createElement("span");
    desc.textContent = step.action?.description || JSON.stringify(step.action?.target || step.action?.url || "");

    li.appendChild(tag);
    li.appendChild(desc);
    stepsList.appendChild(li);
  });
}

/**
 * Render Complete Task View
 */
function renderTask() {
  if (!activeTask) {
    updateStatusBadge("NO ACTIVE TASK");
    startBtn.disabled = false;
    cancelBtn.disabled = true;
    cancelBtn.style.cursor = "not-allowed";
    cancelBtn.style.backgroundColor = "#f3f4f6";
    cancelBtn.style.color = "#9ca3af";
    errorBanner.style.display = "none";
    resultBanner.style.display = "none";
    goalPreview.textContent = "Submit a goal above or launch a task from the browser extension side panel.";
    renderSteps([]);
    return;
  }

  updateStatusBadge(activeTask.status);
  goalPreview.textContent = `Active Goal: "${activeTask.goal}"`;

  const isRunning = activeTask.status === "running" || activeTask.status === "waiting_for_approval";
  startBtn.disabled = isRunning;
  cancelBtn.disabled = !isRunning;
  cancelBtn.style.cursor = isRunning ? "pointer" : "not-allowed";
  cancelBtn.style.backgroundColor = isRunning ? "#fee2e2" : "#f3f4f6";
  cancelBtn.style.color = isRunning ? "#dc2626" : "#9ca3af";

  if (activeTask.error) {
    errorBanner.style.display = "block";
    errorBanner.textContent = `Error: ${activeTask.error}`;
  } else {
    errorBanner.style.display = "none";
  }

  if (activeTask.result) {
    resultBanner.style.display = "block";
    resultBanner.textContent = `Outcome: ${activeTask.result}`;
  } else {
    resultBanner.style.display = "none";
  }

  renderSteps(activeTask.steps);
}

/**
 * Render Approval Card
 */
function renderApproval(approval) {
  pendingApproval = approval;
  if (!approval) {
    approvalCard.style.display = "none";
    return;
  }

  approvalHost.textContent = approval.hostname || "unknown";
  approvalAction.textContent = approval.action?.type || "action";
  approvalDesc.textContent = approval.description || "The AI agent requests confirmation before executing.";
  approvalRisk.textContent = approval.reversible ? "Risk: Low (Reversible action)" : "Risk: High (Requires confirmation)";
  approvalRisk.style.color = approval.reversible ? "#15803d" : "#b45309";
  approvalCard.style.display = "block";
}

/**
 * Render Proactive Banner
 */
function renderNotification(notif) {
  if (!notif) {
    notifBanner.style.display = "none";
    return;
  }

  notifTitle.textContent = notif.title || "Proactive Alert";
  notifMessage.textContent = notif.message || "";
  currentSuggestedGoal = notif.suggestedGoal || null;

  if (currentSuggestedGoal) {
    runSuggestedBtn.style.display = "inline-block";
    runSuggestedBtn.textContent = `Run Suggested: "${currentSuggestedGoal.slice(0, 30)}..."`;
  } else {
    runSuggestedBtn.style.display = "none";
  }

  notifBanner.style.display = "block";
}

/**
 * Fetch and Render Permissions Table
 */
async function loadPermissions() {
  try {
    const res = await fetch("/api/permissions");
    if (!res.ok) return;
    const data = await res.json();
    if (!data.ok || !data.data) return;

    permissionsTableBody.innerHTML = "";

    // 1. Global Defaults
    Object.entries(data.data.globalDefaults || {}).forEach(([action, decision]) => {
      appendPermissionRow("* (Global Default)", action, decision);
    });

    // 2. Custom Active Rules
    (data.data.customRules || []).forEach((rule) => {
      appendPermissionRow(rule.hostname, rule.actionType, rule.decision);
    });
  } catch {
    // Non-blocking dashboard initialization failure
  }
}

function appendPermissionRow(host, action, decision) {
  const tr = document.createElement("tr");
  tr.style.borderBottom = "1px solid #f3f4f6";

  const colorMap = { ALLOW: "#16a34a", ASK: "#d97706", BLOCK: "#dc2626" };

  tr.innerHTML = `
    <td style="padding: 8px; font-weight: 500;">${host}</td>
    <td style="padding: 8px;"><code>${action}</code></td>
    <td style="padding: 8px;"><strong style="color: ${colorMap[decision] || '#4b5563'};">${decision}</strong></td>
  `;
  permissionsTableBody.appendChild(tr);
}

/**
 * Task Execution Step Loop (Dashboard Runner)
 */
async function executeDashboardTaskLoop() {
  if (!activeTask || activeTask.status !== "running") return;

  if (activeTask.steps.length >= MAX_STEPS) {
    activeTask.status = "failed";
    activeTask.error = `Step limit of ${MAX_STEPS} reached.`;
    renderTask();
    return;
  }

  try {
    // Request next step from AI agent endpoint
    const res = await fetch("/api/agent", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        taskId: activeTask.id,
        goal: activeTask.goal,
        stepIndex: activeTask.steps.length,
        history: activeTask.steps,
        pageContext: {
          url: "https://web-command-center.local",
          title: "Dashboard Session",
          hostname: "dashboard"
        }
      })
    });

    const result = await res.json();
    if (!res.ok || !result.ok) {
      throw new Error(result.error?.message || "Agent planning request failed.");
    }

    const nextAction = result.data.action;

    // Check policy against /api/permissions
    const permRes = await fetch("/api/permissions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        actionType: nextAction.type,
        hostname: "dashboard",
        actionDetails: nextAction
      })
    });

    const permData = await permRes.json();
    const decision = permData.decision || "ASK";

    if (decision === "BLOCK") {
      activeTask.status = "failed";
      activeTask.error = `Action ${nextAction.type} is blocked by security policy.`;
      renderTask();
      return;
    }

    if (decision === "ASK" || nextAction.type === "request_approval") {
      activeTask.status = "waiting_for_approval";
      renderTask();
      renderApproval({
        actionId: `act_${Date.now()}`,
        action: nextAction,
        hostname: "dashboard",
        description: nextAction.description || `Execute ${nextAction.type}`,
        reversible: ["read_page", "scroll", "extract", "wait"].includes(nextAction.type)
      });
      return;
    }

    // Step Execution
    handleActionExecution(nextAction);
  } catch (err) {
    if (activeTask && activeTask.status === "running") {
      activeTask.status = "failed";
      activeTask.error = err.message;
      renderTask();
    }
  }
}

function handleActionExecution(action) {
  if (!activeTask) return;

  if (action.type === "finish") {
    activeTask.status = "completed";
    activeTask.result = action.result || "Goal achieved successfully.";
    activeTask.steps.push({ action, result: { ok: true, finished: true } });
    renderTask();
    return;
  }

  // Record successful action step
  activeTask.steps.push({ action, result: { ok: true, simulated: true } });
  renderTask();

  // Continue to next step
  setTimeout(executeDashboardTaskLoop, 800);
}

/**
 * Event Handlers
 */

// Start Task
taskForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const goal = goalInput.value.trim();
  if (!goal) return;

  activeTask = {
    id: `task_${Date.now()}`,
    goal,
    status: "running",
    steps: [],
    error: null,
    result: null
  };

  renderApproval(null);
  renderTask();
  goalInput.value = "";

  setTimeout(executeDashboardTaskLoop, 100);
});

// Cancel Task
cancelBtn.addEventListener("click", () => {
  if (activeTask) {
    activeTask.status = "cancelled";
    activeTask.error = "Cancelled by user.";
    renderApproval(null);
    renderTask();
  }
});

// Approve Action
approveBtn.addEventListener("click", () => {
  if (!pendingApproval || !activeTask) return;
  const action = pendingApproval.action;
  renderApproval(null);

  activeTask.status = "running";
  renderTask();
  handleActionExecution(action);
});

// Reject Action
rejectBtn.addEventListener("click", () => {
  if (!activeTask) return;
  renderApproval(null);
  activeTask.status = "failed";
  activeTask.error = "Action rejected by user.";
  renderTask();
});

// Dismiss Notification Banner
dismissNotifBtn.addEventListener("click", () => {
  renderNotification(null);
});

// Launch Suggested Task
runSuggestedBtn.addEventListener("click", () => {
  if (!currentSuggestedGoal) return;
  goalInput.value = currentSuggestedGoal;
  renderNotification(null);
  taskForm.dispatchEvent(new Event("submit"));
});

// Save Custom Permission Rule
permForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const hostname = permHostname.value.trim();
  const actionType = permActionType.value;
  const decision = permDecision.value;

  if (!hostname) return;

  try {
    const res = await fetch("/api/permissions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        operation: "SET_RULE",
        hostname,
        actionType,
        decision
      })
    });

    if (res.ok) {
      permHostname.value = "";
      loadPermissions();
    }
  } catch {
    // Non-blocking save failure
  }
});

// Initialize on DOM load
document.addEventListener("DOMContentLoaded", () => {
  loadPermissions();
  renderTask();
});
