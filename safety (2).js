/**
 * ARIXlegal Safety & Verification Engine
 * Enforces strict adversarial review, source checking, and final document gates.
 */

const safetyConfig = {
    // Universal Safety Taxonomy (Rule 89)
    STATUS: {
        VERIFIED: { id: 'VERIFIED', label: 'Verified', color: 'text-green-700', bg: 'bg-green-50', border: 'border-green-200', icon: 'fa-check-double' },
        SUPPORTED: { id: 'SUPPORTED', label: 'Supported', color: 'text-blue-700', bg: 'bg-blue-50', border: 'border-blue-200', icon: 'fa-check' },
        UNVERIFIED: { id: 'UNVERIFIED', label: 'Unverified', color: 'text-gray-700', bg: 'bg-gray-50', border: 'border-gray-200', icon: 'fa-circle-question' },
        CONFLICTING: { id: 'CONFLICTING', label: 'Conflicting', color: 'text-red-700', bg: 'bg-red-50', border: 'border-red-200', icon: 'fa-code-compare' },
        BLOCKED: { id: 'BLOCKED', label: 'Blocked', color: 'text-white', bg: 'bg-red-600', border: 'border-red-700', icon: 'fa-ban' }
    },
    
    // Critical fields that require human review if auto-corrected (Rule 181)
    CRITICAL_FIELDS: ['PARTY_NAME', 'CASE_NUMBER', 'DATE', 'MONETARY_AMOUNT', 'CITATION', 'PROCEDURAL_STAGE']
};

const safetyEngine = {
    /**
     * Final Document Safety Gate (Rule 97)
     * Runs a pre-flight checklist before any document is exported or printed.
     */
    async finalDocumentGate(draftDocument, caseMetadata) {
        console.log("[Safety Engine] Initiating Final Document Gate...");
        
        let gateResults = {
            passed: true,
            issues: []
        };

        // 1. Party-Name Consistency Check (Rule 96)
        if (!draftDocument.text.includes(caseMetadata.display_name)) {
            gateResults.passed = false;
            gateResults.issues.push({
                severity: 'CRITICAL',
                type: 'PARTY_NAME',
                message: `The primary case name "${caseMetadata.display_name}" is missing or mangled in the draft.`
            });
        }

        // 2. Unsupported Number Detection (Rule 95)
        const unsupportedNumbers = this.detectUnsupportedNumbers(draftDocument.text, draftDocument.sources);
        if (unsupportedNumbers.length > 0) {
            gateResults.passed = false;
            gateResults.issues.push({
                severity: 'HIGH',
                type: 'UNSUPPORTED_NUMBERS',
                message: `Detected ${unsupportedNumbers.length} dates/amounts without direct source grounding.`
            });
        }

        // 3. Privacy/Identifier Leak Check (Rule 72) fallback check
        if (window.privacyValidator) {
            const privacyCheck = window.privacyValidator.checkOutgoingPayload(draftDocument.text);
            if (!privacyCheck.safe) {
                gateResults.passed = false;
                gateResults.issues.push({
                    severity: 'BLOCKED',
                    type: 'PRIVACY_LEAK',
                    message: privacyCheck.reason
                });
            }
        }

        // 4. Missing Field Schema Check
        if (draftDocument.text.includes('[') && draftDocument.text.includes(']')) {
             gateResults.issues.push({
                severity: 'MEDIUM',
                type: 'MISSING_FIELDS',
                message: "Draft contains unresolved placeholder brackets (e.g., [Date], [Insert Fact])."
            });
        }

        return gateResults;
    },

    /**
     * Rule 95: Give special scrutiny to dates and monetary amounts.
     * Identifies numbers in the generated text that aren't present in the source context.
     */
    detectUnsupportedNumbers(generatedText, sourceTexts) {
        // Simple regex for dates (DD-MM-YYYY) and Indian currency formats (Rs., ₹)
        const numRegex = /(\b\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}\b)|(₹\s?\d+(?:,\d{2,3})*(?:\.\d{2})?)|(Rs\.?\s?\d+(?:,\d{2,3})*(?:\.\d{2})?)/gi;
        
        const generatedNumbers = generatedText.match(numRegex) || [];
        const combinedSources = sourceTexts.join(' ');
        
        let unsupported = [];
        
        generatedNumbers.forEach(num => {
            // Strip formatting for comparison if needed, here we do exact match check
            if (!combinedSources.includes(num)) {
                unsupported.push(num);
            }
        });
        
        return unsupported;
    },

    /**
     * Rule 181: Never silently self-correct critical facts.
     * Logs the correction and triggers a mandatory human review notification.
     */
    logCriticalCorrection(originalValue, correctedValue, fieldType, reason, sourceId) {
        if (!safetyConfig.CRITICAL_FIELDS.includes(fieldType)) return;

        const correctionRecord = {
            id: `CORR-${Date.now()}`,
            timestamp: new Date().toISOString(),
            field_type: fieldType,
            original: originalValue,
            corrected: correctedValue,
            reason: reason,
            source: sourceId,
            status: 'PENDING_HUMAN_REVIEW'
        };

        console.warn(`[Safety Engine] CRITICAL CORRECTION BLOCKED from silent apply:`, correctionRecord);
        
        // Push to Safety UI
        safetyUi.addIssue({
            severity: 'HIGH',
            type: 'SILENT_CORRECTION_ATTEMPT',
            title: `AI attempted to modify a critical ${fieldType.toLowerCase()}.`,
            description: `Original: "${originalValue}"\nProposed: "${correctedValue}"\nReason: ${reason}`,
            actionLabel: 'Review & Approve',
            actionHandler: () => { console.log("Lawyer explicitly approved correction."); }
        });
    }
};

const safetyUi = {
    issuesList: [],

    /**
     * Dynamically renders issues to the Safety Center Tab (Rule 205).
     */
    renderIssues() {
        const container = document.getElementById('safety-issues-container');
        const badge = document.getElementById('case-safety-badge');
        const globalBadge = document.getElementById('global-safety-badge');
        
        if (!container) return;
        
        container.innerHTML = ''; // Safely clear

        if (this.issuesList.length === 0) {
            container.innerHTML = `
                <div class="p-8 text-center text-gray-500 bg-white border border-gray-200 rounded-xl">
                    <i class="fa-solid fa-shield-check text-4xl text-green-500 mb-3"></i>
                    <p class="font-medium">No unresolved safety warnings.</p>
                    <p class="text-xs mt-1">All AI outputs have passed verification checks.</p>
                </div>
            `;
            if (badge) badge.classList.add('hidden');
            if (globalBadge) globalBadge.classList.add('hidden');
            return;
        }

        // Update Badges
        if (badge) {
            badge.textContent = this.issuesList.length;
            badge.classList.remove('hidden');
        }
        if (globalBadge) {
            globalBadge.textContent = this.issuesList.length;
            globalBadge.classList.remove('hidden');
        }

        this.issuesList.forEach((issue, index) => {
            const card = document.createElement('div');
            
            // Apply styles based on severity (Rule 206)
            let borderClass = 'border-gray-200';
            let badgeClass = 'bg-gray-100 text-gray-800';
            let iconClass = 'fa-circle-info text-gray-500';
            
            if (issue.severity === 'CRITICAL' || issue.severity === 'BLOCKED') {
                borderClass = 'border-red-400 border-l-4';
                badgeClass = 'bg-red-100 text-red-800';
                iconClass = 'fa-triangle-exclamation text-red-500';
            } else if (issue.severity === 'HIGH') {
                borderClass = 'border-orange-400 border-l-4';
                badgeClass = 'bg-orange-100 text-orange-800';
                iconClass = 'fa-bolt text-orange-500';
            } else if (issue.severity === 'MEDIUM') {
                borderClass = 'border-yellow-400 border-l-4';
                badgeClass = 'bg-yellow-100 text-yellow-800';
                iconClass = 'fa-magnifying-glass text-yellow-500';
            }

            card.className = `bg-white rounded shadow-sm p-5 mb-4 ${borderClass}`;
            
            const header = document.createElement('div');
            header.className = 'flex justify-between items-start';
            
            const titleDiv = document.createElement('div');
            titleDiv.innerHTML = `
                <div class="flex items-center space-x-2 mb-1">
                    <span class="text-xs font-bold uppercase tracking-wider px-2 py-0.5 rounded ${badgeClass}">${issue.type}</span>
                    <span class="text-xs text-gray-500"><i class="fa-solid fa-clock mr-1"></i> Just now</span>
                </div>
                <h4 class="text-base font-bold text-gray-900 mt-2">${issue.title || 'Safety Verification Alert'}</h4>
            `;
            
            const actionBtn = document.createElement('button');
            actionBtn.className = 'px-3 py-1.5 bg-gray-100 hover:bg-gray-200 text-sm font-medium rounded text-gray-700 transition-colors';
            actionBtn.textContent = issue.actionLabel || 'Resolve';
            actionBtn.onclick = () => {
                if (issue.actionHandler) issue.actionHandler();
                this.removeIssue(index);
            };

            header.appendChild(titleDiv);
            header.appendChild(actionBtn);
            card.appendChild(header);

            if (issue.description) {
                const descDiv = document.createElement('div');
                descDiv.className = 'mt-4 bg-gray-50 p-3 rounded border border-gray-200 text-sm text-gray-700 whitespace-pre-wrap';
                descDiv.textContent = issue.description;
                card.appendChild(descDiv);
            }

            container.appendChild(card);
        });
    },

    addIssue(issue) {
        this.issuesList.push(issue);
        this.renderIssues();
    },

    removeIssue(index) {
        this.issuesList.splice(index, 1);
        this.renderIssues();
    }
};

// Expose strictly controlled interfaces
window.safetyConfig = safetyConfig;
window.safetyEngine = safetyEngine;
window.safetyUi = safetyUi;
