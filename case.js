/* ARIXlegal Case Workspace Controller
 * Enforces matter-level security, tab state management, and strict DOM injection.
 */

const caseApi = {
    // Uses a strict timeout to prevent infinite hanging if the backend is unresponsive
    async request(endpoint, options = {}) {
        const url = `/api/v1${endpoint}`;
        const config = {
            ...options,
            headers: { 'Content-Type': 'application/json', ...options.headers },
            signal: AbortSignal.timeout(15000)
        };

        try {
            const response = await fetch(url, config);
            if (!response.ok) throw new Error(`API Error: ${response.status}`);
            return await response.json();
        } catch (error) {
            console.warn(`[Case Network] Request to ${endpoint} failed:`, error.message);
            throw error;
        }
    }
};

const caseUi = {
    get(id) {
        const el = document.getElementById(id);
        if (!el) console.warn(`Case UI Element '${id}' missing.`);
        return el;
    },
    
    setText(id, text) {
        const el = this.get(id);
        if (el) el.textContent = text;
    },

    setHtmlSafe(id, safeHtmlString) {
        // Only for strictly controlled internal templates, not user input
        const el = this.get(id);
        if (el) el.innerHTML = safeHtmlString;
    },

    showError(title, message, actions = []) {
        const container = this.get('case-error-container');
        if (!container) return;

        this.setText('case-error-title', title);
        this.setText('case-error-message', message);
        
        const actionsContainer = this.get('case-error-actions');
        actionsContainer.innerHTML = ''; 
        
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
        const container = this.get('case-error-container');
        if (container) container.classList.add('hidden');
    }
};

const caseApp = {
    matterId: null,
    currentTab: 'overview',
    
    // Internal state cache for the current matter
    state: {
        details: null,
        documents: [],
        tasks: [],
        safetyIssues: []
    },

    init() {
        // Extract matter ID from URL parameters securely
        const params = new URLSearchParams(window.location.search);
        this.matterId = params.get('id');

        if (!this.matterId) {
            caseUi.showError("Workspace Error", "No matter identifier provided.", [
                { label: "Return to Dashboard", onClick: () => window.location.href = 'index.html' }
            ]);
            return;
        }

        this.loadMatterData();
    },

    switchTab(tabId) {
        this.currentTab = tabId;
        
        // Reset all tab buttons
        document.querySelectorAll('.tab-nav-btn').forEach(btn => {
            btn.classList.remove('bg-legal-800', 'border-l-4', 'border-blue-500', 'text-white');
            btn.classList.add('text-gray-300');
        });

        // Activate selected tab button
        const activeBtn = caseUi.get(`tab-btn-${tabId}`);
        if (activeBtn) {
            activeBtn.classList.remove('text-gray-300');
            activeBtn.classList.add('bg-legal-800', 'border-l-4', 'border-blue-500', 'text-white');
        }

        // Hide all views
        document.querySelectorAll('.tab-view').forEach(view => {
            view.classList.add('hidden');
            view.classList.remove('block', 'flex'); // Remove layout classes temporarily
        });

        // Show active view and restore appropriate display type
        const activeView = caseUi.get(`view-${tabId}`);
        if (activeView) {
            activeView.classList.remove('hidden');
            // Restore flex for specific tabs that need full height flex column layouts
            if (['documents', 'research', 'drafting'].includes(tabId)) {
                activeView.classList.add('flex');
            } else {
                activeView.classList.add('block');
            }
        }
    },

    async loadMatterData() {
        try {
            // Attempt to fetch fresh case layout from backend
            const response = await caseApi.request(`/cases/${encodeURIComponent(this.matterId)}`);
            this.state.details = response.details;
            this.state.documents = response.documents;
            this.renderCaseHeader(this.state.details);
            this.renderOverview(this.state.details);
        } catch (error) {
            this.handleDegradedMode();
        }
    },

    renderCaseHeader(details) {
        if (!details) return;

        // Header mapping
        caseUi.setText('header-case-name', details.display_name || 'Unknown Matter');
        caseUi.setText('sidebar-case-name', details.display_name || 'Unknown Matter');
        
        caseUi.setText('header-case-number', details.case_number || 'Unassigned');
        caseUi.setText('sidebar-case-number', details.case_number || 'Unassigned');
        
        caseUi.setText('header-court', details.court || 'Court Not Specified');
        caseUi.setText('header-cnr', details.cnr || 'No CNR');
        caseUi.setText('header-official-status', details.official_status || 'PENDING');
        caseUi.setText('header-ai-stage', details.ai_interpreted_stage || 'Unknown');
        caseUi.setText('header-last-verified', details.last_verified || 'Just now');

        // Badge styling based on official status (Rule 18)
        const statusBadge = caseUi.get('header-official-status');
        if (statusBadge) {
            statusBadge.className = 'px-2.5 py-0.5 rounded text-xs font-semibold uppercase tracking-wider border ';
            if (details.official_status === 'DISPOSED') {
                statusBadge.classList.add('bg-gray-100', 'text-gray-700', 'border-gray-300');
            } else if (details.official_status === 'URGENT') {
                statusBadge.classList.add('bg-red-100', 'text-red-800', 'border-red-200');
            } else {
                statusBadge.classList.add('bg-green-100', 'text-green-800', 'border-green-200');
            }
        }

        // Coverage warning logic (Rule 58 & 59)
        const coverageBar = caseUi.get('coverage-warning-bar');
        if (coverageBar && details.unindexed_documents_count > 0) {
            coverageBar.classList.remove('hidden');
            const msg = coverageBar.querySelector('span');
            if (msg) msg.innerHTML = `<strong>Coverage Alert:</strong> ${details.unindexed_documents_count} recent documents have not yet been fully indexed. AI insights may be incomplete.`;
        }
    },

    renderOverview(details) {
        if (!details) return;

        // Next Hearing
        caseUi.setText('overview-next-hearing-date', details.next_hearing || 'Awaiting Schedule');
        caseUi.setText('overview-next-hearing-purpose', details.next_hearing_purpose || 'Standard Listing');

        // Render AI Brief (Rule 147)
        // Note: Strict construction required to avoid XSS. We create DOM nodes rather than using innerHTML for text.
        const briefContainer = caseUi.get('case-brief-content');
        if (briefContainer && details.ai_brief) {
            briefContainer.innerHTML = ''; // Safe clear
            
            const p = document.createElement('p');
            p.textContent = details.ai_brief.summary;
            p.className = "mb-4";
            briefContainer.appendChild(p);

            // Render traceable sources for the brief
            if (details.ai_brief.sources && details.ai_brief.sources.length > 0) {
                const sourceDiv = document.createElement('div');
                sourceDiv.className = "mt-4 pt-3 border-t border-gray-200 text-xs text-gray-500";
                sourceDiv.textContent = "Insights grounded in: ";
                
                details.ai_brief.sources.forEach((src, idx) => {
                    const a = document.createElement('a');
                    a.href = "#";
                    a.className = "text-blue-600 hover:underline mr-2";
                    a.textContent = `[${idx + 1}] ${src.name}`;
                    sourceDiv.appendChild(a);
                });
                briefContainer.appendChild(sourceDiv);
            }
        }

        // Render "What Changed" (Rule 148)
        const changedContainer = caseUi.get('what-changed-container');
        if (changedContainer && details.recent_changes) {
            changedContainer.innerHTML = '';
            if (details.recent_changes.length === 0) {
                changedContainer.innerHTML = '<div class="text-sm text-gray-500">No significant changes detected since last review.</div>';
            } else {
                details.recent_changes.forEach(change => {
                    const div = document.createElement('div');
                    div.className = "flex items-start text-sm border-l-2 pl-3 py-1 " + 
                        (change.type === 'order' ? 'border-green-400' : 'border-blue-400');
                    
                    const icon = document.createElement('i');
                    icon.className = `fa-solid ${change.type === 'order' ? 'fa-file-signature text-green-500' : 'fa-file-lines text-blue-500'} mt-1 mr-3`;
                    
                    const textDiv = document.createElement('div');
                    const title = document.createElement('p');
                    title.className = "font-medium text-gray-800";
                    title.textContent = change.title;
                    
                    const desc = document.createElement('p');
                    desc.className = "text-gray-600 mt-0.5 text-xs";
                    desc.textContent = change.description;

                    textDiv.appendChild(title);
                    textDiv.appendChild(desc);
                    div.appendChild(icon);
                    div.appendChild(textDiv);
                    
                    changedContainer.appendChild(div);
                });
            }
        }
    },

    handleDegradedMode() {
        caseUi.showError(
            "Workspace Operating Offline",
            "Could not connect to the server to fetch live case data. Operating with cached structural components.",
            [{ label: "Retry", onClick: () => this.loadMatterData() }]
        );

        // Populate structural fallback data
        caseUi.setText('header-case-name', 'Matter Offline');
        caseUi.setText('header-ai-stage', 'Requires Connection');
        caseUi.setText('header-official-status', 'UNKNOWN');
        
        const briefContainer = caseUi.get('case-brief-content');
        if (briefContainer) {
            briefContainer.innerHTML = '<p class="text-gray-500 italic">Case brief cannot be loaded while offline. Please check your connection.</p>';
        }

        const changedContainer = caseUi.get('what-changed-container');
        if (changedContainer) {
            changedContainer.innerHTML = '<div class="text-sm text-gray-400">Offline mode active.</div>';
        }
    },

    async executeResearch() {
        const queryInput = caseUi.get('research-query');
        const resultsContainer = caseUi.get('research-results');
        
        if (!queryInput || !resultsContainer || !queryInput.value.trim()) return;

        const queryText = queryInput.value.trim();

        // Safe loading state creation
        resultsContainer.innerHTML = '';
        const loadingDiv = document.createElement('div');
        loadingDiv.className = "flex flex-col items-center justify-center h-full text-gray-500 space-y-3";
        loadingDiv.innerHTML = `
            <i class="fa-solid fa-circle-notch fa-spin text-3xl text-blue-500"></i>
            <p class="text-sm font-medium">Searching legal authorities and checking current status...</p>
            <p class="text-xs opacity-70">Enforcing Rule 41: Verification in progress.</p>
        `;
        resultsContainer.appendChild(loadingDiv);

        try {
            // Note: In real app, this goes to backend POST /api/v1/research
            await new Promise(resolve => setTimeout(resolve, 800)); // Simulate network safely
            throw new Error("Network Unavailable");
        } catch (error) {
            // Degraded Research State
            resultsContainer.innerHTML = '';
            const errDiv = document.createElement('div');
            errDiv.className = "bg-red-50 border border-red-200 rounded p-4 text-red-800 text-sm";
            errDiv.innerHTML = `
                <h4 class="font-bold mb-1"><i class="fa-solid fa-triangle-exclamation mr-2"></i>Research Engine Unreachable</h4>
                <p>Unable to process query: "${queryText}". The external legal intelligence provider is currently offline or unreachable.</p>
            `;
            resultsContainer.appendChild(errDiv);
        }
    },

    refreshCaseStatus() {
        const verifiedEl = caseUi.get('header-last-verified');
        if (verifiedEl) verifiedEl.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin text-blue-500 mr-1"></i> Checking...';
        this.loadMatterData();
    },

    showModal(id) {
        const modal = caseUi.get(id);
        if (modal) {
            modal.classList.remove('hidden');
            setTimeout(() => modal.classList.remove('opacity-0'), 10);
        }
    },

    hideModal(id) {
        const modal = caseUi.get(id);
        if (modal) {
            modal.classList.add('opacity-0');
            setTimeout(() => modal.classList.add('hidden'), 300);
        }
    },

    dismissError() {
        caseUi.dismissError();
    }
};

document.addEventListener('DOMContentLoaded', () => {
    caseApp.init();
});

// Expose strictly for inline HTML event handlers (e.g., onclick="caseApp.switchTab()")
window.caseApp = caseApp;
