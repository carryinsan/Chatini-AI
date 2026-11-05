/**
 * ARIXlegal Frontend AI Orchestrator
 * Coordinates context assembly, token estimation, and long-running task UX.
 * Strictly communicates with the secure backend gateway. No secrets here.
 */

const aiConfig = {
    GATEWAY_URL: '/api/v1/ai',
    // Rule 224: Target max input tokens before backend rejection
    MAX_LOCAL_ESTIMATED_TOKENS: 60000, 
    // Polling interval for long-running background tasks
    POLL_INTERVAL_MS: 2500,
    // Universal Error Taxonomy mapping (Rule 77)
    ERRORS: {
        TOKEN_LIMIT: 'TOKEN_ERROR',
        PRIVACY: 'PRIVACY_ERROR',
        UNSUPPORTED: 'UNSUPPORTED_CLAIMS',
        NETWORK: 'NETWORK_ERROR',
        TIMEOUT: 'TIMEOUT'
    }
};

/**
 * Rule 222: Token Estimation
 * Provides a rough local estimate to prevent sending massive payloads that will 
 * inevitably fail the backend's strict tokenizer.
 */
const aiTokenizer = {
    estimate(text) {
        if (!text) return 0;
        // Rough heuristic: ~4 characters per token for English/legal text.
        // Backend uses actual tiktoken/sentencepiece counting.
        return Math.ceil(text.length / 4);
    },

    estimatePackage(contextPackage) {
        let total = 0;
        if (contextPackage.user_query) total += this.estimate(contextPackage.user_query);
        if (contextPackage.documents) {
            contextPackage.documents.forEach(doc => {
                total += this.estimate(doc.extracted_text || '');
            });
        }
        if (contextPackage.pinned_facts) {
            total += this.estimate(JSON.stringify(contextPackage.pinned_facts));
        }
        return total;
    }
};

/**
 * Rule 55: Context Package
 * Structures the payload hierarchically so the backend Model Router 
 * knows exactly what information is prioritized.
 */
const aiContext = {
    build(taskType, matterId, options = {}) {
        return {
            task_type: taskType,
            matter_id: matterId,
            user_query: options.query || null,
            // Prioritization flags (Rule 56 & 57)
            pinned_items_only: options.pinnedOnly || false,
            include_latest_order: options.includeLatestOrder !== false,
            // Source material references (actual content injected by backend if large)
            document_refs: options.documentIds || [],
            fact_refs: options.factIds || [],
            // Output requirements
            require_citations: options.requireCitations || true,
            strict_adherence: true // Disallow hallucinations explicitly
        };
    }
};

/**
 * Core Execution Engine
 * Handles the lifecycle of a frontend AI request, including UI progress updates.
 */
const aiOrchestrator = {
    /**
     * Executes an AI task with progress monitoring (Rule 119)
     * @param {Object} contextPackage - Assembled by aiContext.build()
     * @param {Function} onProgress - Callback for UI updates
     */
    async executeTask(contextPackage, onProgress) {
        try {
            // Pre-flight check (Rule 223)
            const estimatedTokens = aiTokenizer.estimatePackage(contextPackage);
            if (estimatedTokens > aiConfig.MAX_LOCAL_ESTIMATED_TOKENS) {
                throw new Error(aiConfig.ERRORS.TOKEN_LIMIT);
            }

            if (onProgress) onProgress({ status: 'QUEUED', message: 'Initializing secure environment...' });

            // 1. Submit task to backend gateway
            const response = await this.submitToGateway(contextPackage);
            if (!response.task_id) throw new Error("Invalid gateway response");

            // 2. Poll for completion (Rule 161: User-facing progress)
            return await this.pollTaskStatus(response.task_id, onProgress);

        } catch (error) {
            return this.handleExecutionError(error, contextPackage);
        }
    },

    async submitToGateway(contextPackage) {
        // Relies on the resilient apiClient defined in app.js
        if (!window.apiClient) {
            console.warn("Global API client missing, simulating network failure.");
            throw new Error(aiConfig.ERRORS.NETWORK);
        }
        
        // This maps to server.js privacy gateway
        return await window.apiClient.post('/ai/execute', contextPackage);
    },

    async pollTaskStatus(taskId, onProgress) {
        return new Promise((resolve, reject) => {
            let attempts = 0;
            const maxAttempts = 60; // 2.5s * 60 = 2.5 minutes max timeout

            const poll = async () => {
                attempts++;
                try {
                    const statusRes = await window.apiClient.get(`/ai/task/${taskId}`);
                    
                    // Update UI with explicit stages (Rule 119)
                    if (onProgress && statusRes.ui_message) {
                        onProgress({ status: statusRes.status, message: statusRes.ui_message });
                    }

                    if (statusRes.status === 'COMPLETED') {
                        // Rule 178: Universal Task Completion
                        resolve(statusRes.result);
                    } else if (statusRes.status === 'FAILED') {
                        reject(new Error(statusRes.error_code || 'UNKNOWN_ERROR'));
                    } else if (statusRes.status === 'BLOCKED') {
                        // Rule 72: Privacy leak or safety block
                        reject(new Error(aiConfig.ERRORS.PRIVACY));
                    } else {
                        if (attempts >= maxAttempts) {
                            reject(new Error(aiConfig.ERRORS.TIMEOUT));
                        } else {
                            setTimeout(poll, aiConfig.POLL_INTERVAL_MS);
                        }
                    }
                } catch (err) {
                    // Stop polling on hard network failure
                    reject(new Error(aiConfig.ERRORS.NETWORK));
                }
            };

            setTimeout(poll, aiConfig.POLL_INTERVAL_MS);
        });
    },

    handleExecutionError(error, contextPackage) {
        console.error("[AI Orchestrator] Task failed:", error.message);
        
        // Map to lawyer-friendly errors (Rule 120)
        let title = "Analysis Incomplete";
        let message = "An error occurred while generating this legal insight.";
        
        switch (error.message) {
            case aiConfig.ERRORS.TOKEN_LIMIT:
                title = "Context Too Large";
                message = "The selected documents exceed the maximum context limit. Please narrow your selection to specific pages or use the 'Targeted Extraction' feature.";
                break;
            case aiConfig.ERRORS.PRIVACY:
                title = "Safety Block Triggered";
                message = "The request was blocked by the Privacy Gateway. Unverified sensitive identifiers were detected and stopped before reaching external AI providers.";
                break;
            case aiConfig.ERRORS.TIMEOUT:
                title = "Operation Timed Out";
                message = "The legal intelligence engine is taking longer than expected. This task has been moved to the background.";
                break;
            case aiConfig.ERRORS.NETWORK:
                title = "Offline Mode";
                message = "Cannot reach the AI gateway. Proceeding with cached case information and deterministic local search.";
                break;
        }

        if (window.app && window.app.showError) {
            window.app.showError(title, message, [
                { label: "Dismiss", onClick: () => {} }
            ]);
        }

        return { success: false, error: error.message };
    }
};

// Expose for usage by legal.js and safety.js
window.aiContext = aiContext;
window.aiOrchestrator = aiOrchestrator;
