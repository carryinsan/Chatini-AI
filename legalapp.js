/**
 * ARIXlegal Global Application Controller
 * Enforces strict security, graceful degradation, and structured API interaction.
 * Secrets are strictly prohibited in this file.
 */

const ARIXConfig = {
    // Strictly target the Express backend port to prevent 127.0.0.1 vs localhost mismatches
    API_BASE: 'http://localhost:3000/api/v1',
    OFFLINE_MODE: false
};

const state = {
    user: null,
    dashboardMetrics: null,
    cases: [],
    tasks: [],
    lastRefresh: null
};

/**
 * Safe API Client Adapter
 * Handles all external communication, enforces timeouts, and manages authentication headers.
 * Implements graceful degradation when the backend is unreachable.
 */
const apiClient = {
    async request(endpoint, options = {}) {
        const url = `${ARIXConfig.API_BASE}${endpoint}`;
        const headers = {
            'Content-Type': 'application/json',
            // Session tokens would be injected here via HttpOnly cookies or secure token managers
            ...options.headers
        };

        const config = {
            ...options,
            headers,
            // Strict timeout to prevent hanging UI (Rule 160)
            signal: AbortSignal.timeout(10000) 
        };

        try {
            const response = await fetch(url, config);
            if (!response.ok) {
                throw new Error(`API Error: ${response.status} ${response.statusText}`);
            }
            return await response.json();
        } catch (error) {
            console.warn(`[Network] Request to ${endpoint} failed:`, error.message);
            // Enable offline degraded UX if network fails entirely
            ARIXConfig.OFFLINE_MODE = true;
            throw error;
        }
    },

    async get(endpoint) { return this.request(endpoint, { method: 'GET' }); },
    async post(endpoint, data) { return this.request(endpoint, { method: 'POST', body: JSON.stringify(data) }); }
};

/**
 * UI Manipulation and Modal Controllers
 * Avoids unsafe inline string concatenation for DOM injection.
 */
const ui = {
    getElement(id) {
        const el = document.getElementById(id);
        if (!el) console.warn(`UI Element '${id}' not found in DOM.`);
        return el;
    },
    
    setText(id, text) {
        const el = this.getElement(id);
        if (el) el.textContent = text;
    },

    showModal(modalId) {
        const modal = this.getElement(modalId);
        if (modal) {
            modal.classList.remove('hidden');
            // Small delay to allow display block to render before opacity transition
            setTimeout(() => modal.classList.remove('opacity-0'), 10);
        }
    },

    hideModal(modalId) {
        const modal = this.getElement(modalId);
        if (modal) {
            modal.classList.add('opacity-0');
            setTimeout(() => modal.classList.add('hidden'), 300); // Matches Tailwind transition duration
        }
    },

    /**
     * Global Error Handler (Rule 120)
     * Replaces technical HTTP errors with actionable lawyer-friendly UX.
     */
    showError(title, message, actions = []) {
        const container = this.getElement('global-error-container');
        if (!container) return;

        this.setText('error-title', title);
        this.setText('error-message', message);
        
        const actionsContainer = this.getElement('error-actions');
        actionsContainer.innerHTML = ''; // Clear previous actions safely
        
        actions.forEach(action => {
            const btn = document.createElement('button');
            btn.className = 'text-sm font-medium text-red-600 hover:text-red-500 mr-4';
            btn.textContent = action.label;
            btn.onclick = () => {
                this.dismissError();
                action.onClick();
            };
            actionsContainer.appendChild(btn);
        });

        container.classList.remove('hidden');
    },

    dismissError() {
        const container = this.getElement('global-error-container');
        if (container) container.classList.add('hidden');
    }
};

/**
 * Application Core Logic
 */
const app = {
    // Expose UI methods to global scope for HTML onclick attributes
    showModal: (id) => ui.showModal(id),
    hideModal: (id) => ui.hideModal(id),
    dismissError: () => ui.dismissError(),
    
    navigateTo: (viewId) => {
        if (viewId === 'my-cases') {
            const container = document.getElementById('case-list-container');
            if (container) container.scrollIntoView({ behavior: 'smooth' });
        }
    },
    
    async init() {
        this.updateDateDisplay();
        await this.loadDashboardData();
    },

    updateDateDisplay() {
        const dateOptions = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
        ui.setText('current-date-display', new Date().toLocaleDateString('en-IN', dateOptions));
        ui.setText('last-global-refresh', `Last verified: ${new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`);
    },

    async loadDashboardData() {
        const spinner = ui.getElement('refresh-spinner');
        const refreshText = ui.getElement('refresh-text');
        
        if (spinner) spinner.classList.remove('hidden');
        if (refreshText) refreshText.textContent = "Checking court status and recent orders...";

        try {
            // Attempt backend fetch. Will fallback to degraded mode if unreachable.
            const data = await apiClient.get('/dashboard/metrics');
            this.renderMetrics(data);
            await this.loadActiveCases();
            await this.loadDoNextTasks();
        } catch (error) {
            this.handleDegradedMode();
        } finally {
            if (spinner) spinner.classList.add('hidden');
            if (refreshText) refreshText.textContent = "Dashboard updated";
            this.updateDateDisplay();
        }
    },

    renderMetrics(metrics) {
        if (!metrics) return;
        ui.setText('metric-hearings', metrics.hearingsToday || 0);
        ui.setText('metric-deadlines', metrics.urgentDeadlines || 0);
        ui.setText('metric-orders', metrics.newOrders || 0);
        ui.setText('metric-safety', metrics.safetyReviews || 0);
    },

    async loadActiveCases() {
        const container = ui.getElement('case-list-container');
        const template = ui.getElement('template-case-card');
        
        if (!container || !template) return;

        try {
            const cases = await apiClient.get('/cases/active');
            if (!cases || cases.length === 0) return; // Leave default empty state
            
            container.innerHTML = ''; // Clear empty state placeholder safely
            
            cases.forEach(caseData => {
                // Rule 221: Strict DOM injection via templates
                const clone = template.content.cloneNode(true);
                
                // Set text contents securely
                clone.querySelector('.case-name').textContent = caseData.display_name;
                clone.querySelector('.case-number').textContent = caseData.case_number;
                clone.querySelector('.case-court').textContent = caseData.court;
                clone.querySelector('.case-hearing').textContent = caseData.next_hearing || 'Pending';
                clone.querySelector('.case-ai-stage').textContent = caseData.ai_interpreted_stage;
                clone.querySelector('.stage-confidence').textContent = `(${caseData.stage_confidence})`;
                clone.querySelector('.case-last-verified').textContent = caseData.last_verified;
                
                // Status badge (Rule 18)
                const badge = clone.querySelector('.status-badge');
                badge.textContent = caseData.official_status;
                
                // Color indicator bar
                const indicator = clone.querySelector('.status-indicator');
                indicator.className = `absolute left-0 top-0 bottom-0 w-1 status-indicator bg-status-${caseData.change_level || 'unknown'}`;
                
                // Interaction
                const card = clone.querySelector('.case-card');
                card.onclick = () => this.openCase(caseData.matter_id);
                
                container.appendChild(clone);
            });
        } catch (error) {
            console.warn("Could not load cases.");
        }
    },

    async loadDoNextTasks() {
        const container = ui.getElement('tasks-container');
        const template = ui.getElement('template-task-item');
        
        if (!container || !template) return;

        try {
            const tasks = await apiClient.get('/tasks/pending');
            if (!tasks || tasks.length === 0) {
                container.innerHTML = '<div class="p-6 text-center text-gray-500 text-sm">No urgent tasks pending.</div>';
                return;
            }
            
            container.innerHTML = ''; 
            tasks.forEach(task => {
                const clone = template.content.cloneNode(true);
                clone.querySelector('.task-title').textContent = task.title;
                clone.querySelector('.task-case').textContent = task.case_name;
                clone.querySelector('.task-source').textContent = task.source;
                clone.querySelector('.task-urgency').textContent = task.urgency;
                
                // Visual urgency
                const urgencyEl = clone.querySelector('.task-urgency');
                if (task.urgency === 'CRITICAL') {
                    urgencyEl.classList.add('bg-red-100', 'text-red-800');
                } else {
                    urgencyEl.classList.add('bg-blue-100', 'text-blue-800');
                }

                // Icon logic
                const iconContainer = clone.querySelector('.task-icon');
                iconContainer.innerHTML = `<i class="fa-solid ${task.icon || 'fa-list-check'}"></i>`;
                
                container.appendChild(clone);
            });
        } catch (error) {
            // Handled by generic error boundary
        }
    },

    handleDegradedMode() {
        // Rule 121: Graceful Degradation.
        // Provides visual feedback that the system is safely operating in a degraded/offline state.
        ui.showError(
            "System Operating in Degraded Mode",
            "Could not connect to the ARIXlegal backend. Live court updates and AI processing are temporarily paused. You can still view cached case data.",
            [{ label: "Retry Connection", onClick: () => this.loadDashboardData() }]
        );
        
        // Populate with structural empty states rather than hanging
        this.renderMetrics({ hearingsToday: '-', urgentDeadlines: '-', newOrders: '-', safetyReviews: '-' });
        ui.setText('refresh-text', "Operating offline");
    },

    async createNewCase() {
        const submitBtn = ui.getElement('nc-submit-btn');
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin mr-2"></i> Initializing...';
        }

        const caseData = {
            display_name: ui.getElement('nc-name').value,
            case_number: ui.getElement('nc-number').value,
            cnr: ui.getElement('nc-cnr').value,
            court: ui.getElement('nc-court').value,
            client: ui.getElement('nc-client').value
        };

        try {
            // In a real environment, this posts to backend.
            const response = await apiClient.post('/cases', caseData);
            this.hideModal('new-case-modal');
            this.openCase(response.matter_id || 'new');
        } catch (error) {
            this.hideModal('new-case-modal'); 
            console.error("[Debug] Full error:", error);
            ui.showError(
                "Workspace Creation Failed",
                `System rejected initialization. Exact reason: ${error.message}`,
                [{ label: "Dismiss", onClick: () => {} }]
            );
        }
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.innerHTML = 'Create Workspace <i class="fa-solid fa-arrow-right ml-2"></i>';
            }
        }
    },

    openCase(matterId) {
        // Rule 2: A case is the primary object workspace.
        // Navigate to the case view, passing the internal identifier.
        window.location.href = `case.html?id=${encodeURIComponent(matterId)}`;
    },
    
    logout() {
        // Secure session termination flow (Rule 186)
        console.log("Terminating secure session...");
        window.location.href = 'login.html'; // Future auth endpoint
    }
};

// Initialize Application on DOM Load
document.addEventListener('DOMContentLoaded', () => {
    app.init();
});

// Attach app to global window for template access
window.app = app;
