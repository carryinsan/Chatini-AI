/**
 * ARIXlegal Legal Research & Verification Engine
 * Enforces strict legal source hierarchy, citation verification (Rule 41),
 * and contrary authority checks (Rule 44).
 */

const legalConfig = {
    // Rule 42: Citation Verification Status
    VERIFICATION_STATUS: {
        VERIFIED: { label: 'Verified', color: 'text-green-700', bg: 'bg-green-100', icon: 'fa-shield-check' },
        SUPPORTED: { label: 'Supported', color: 'text-blue-700', bg: 'bg-blue-100', icon: 'fa-check' },
        UNVERIFIED: { label: 'Unverified', color: 'text-gray-700', bg: 'bg-gray-100', icon: 'fa-circle-question' },
        CONFLICTING: { label: 'Conflicting', color: 'text-red-700', bg: 'bg-red-100', icon: 'fa-triangle-exclamation' },
        BLOCKED: { label: 'Blocked', color: 'text-gray-500', bg: 'bg-gray-200', icon: 'fa-ban' }
    },

    // Rule 39 & 46: Source Hierarchy & Jurisdiction
    AUTHORITY_LEVEL: {
        SUPREME_COURT: { rank: 1, label: 'Supreme Court of India' },
        HIGH_COURT: { rank: 2, label: 'High Court' },
        TRIBUNAL: { rank: 3, label: 'Tribunal / Statutory Body' },
        DISTRICT_COURT: { rank: 4, label: 'District / Sessions Court' },
        SECONDARY: { rank: 5, label: 'Secondary Source' }
    }
};

const citationVerifier = {
    /**
     * Rule 41: "Does this case really say that?"
     * Submits a citation and a claimed proposition to the backend for adversarial review.
     */
    async verify(citationString, claimedProposition, contextMatterId) {
        if (!window.apiClient) throw new Error("API Client unavailable");

        const payload = {
            citation: citationString,
            proposition: claimedProposition,
            matter_id: contextMatterId
        };

        try {
            // Forward to backend verification pipeline
            const response = await window.apiClient.post('/legal/verify-citation', payload);
            return response;
        } catch (error) {
            console.warn(`[Citation Verifier] Verification failed for ${citationString}`, error);
            // Rule 121: Graceful degradation - fail open but unverified
            return {
                status: 'UNVERIFIED',
                reason: 'Verification service unreachable.',
                source: null
            };
        }
    },

    /**
     * Renders a verified citation badge safely using DOM nodes.
     */
    renderBadge(statusKey) {
        const status = legalConfig.VERIFICATION_STATUS[statusKey] || legalConfig.VERIFICATION_STATUS.UNVERIFIED;
        
        const badge = document.createElement('span');
        badge.className = `inline-flex items-center px-2 py-0.5 rounded text-xs font-medium border border-opacity-20 ${status.bg} ${status.color}`;
        badge.innerHTML = `<i class="fa-solid ${status.icon} mr-1"></i> ${status.label}`;
        
        return badge;
    }
};

const legalResearchEngine = {
    /**
     * Rule 44 & 45: Submit a research query with explicit flags for contrary and current-law checks.
     */
    async executeResearch(query, options = {}, onProgress) {
        if (!query || query.trim() === '') return null;

        const researchPayload = {
            query: query,
            matter_id: options.matterId || null,
            filters: {
                jurisdiction: options.jurisdiction || 'ALL',
                temporal_check: options.requireTemporalCheck !== false, // Default true (Rule 45)
                contrary_search: options.requireContrarySearch !== false // Default true (Rule 44)
            }
        };

        try {
            // Relies on ai.js for long-running task polling (Rule 161)
            if (window.aiOrchestrator) {
                // Build a formal context package for the AI orchestrator
                const contextPackage = window.aiContext.build('LEGAL_RESEARCH', options.matterId, { query });
                // Merge research specific parameters
                Object.assign(contextPackage, researchPayload);
                
                return await window.aiOrchestrator.executeTask(contextPackage, onProgress);
            } else {
                // Fallback direct call if aiOrchestrator is somehow missing
                const res = await window.apiClient.post('/legal/research', researchPayload);
                return res;
            }
        } catch (error) {
            console.error("[Legal Research] Operation failed", error);
            throw error;
        }
    },

    /**
     * Analyzes standard Indian legal citations to deduce jurisdiction.
     */
    inferJurisdiction(citation) {
        const upperCit = citation.toUpperCase();
        if (upperCit.includes('SCC') || upperCit.includes('SCR') || upperCit.includes('SC')) {
            return legalConfig.AUTHORITY_LEVEL.SUPREME_COURT;
        }
        if (upperCit.includes('DEL') || upperCit.includes('BOM') || upperCit.includes('MAD')) {
            return legalConfig.AUTHORITY_LEVEL.HIGH_COURT;
        }
        if (upperCit.includes('NCLAT') || upperCit.includes('ITAT')) {
            return legalConfig.AUTHORITY_LEVEL.TRIBUNAL;
        }
        return legalConfig.AUTHORITY_LEVEL.SECONDARY;
    }
};

const legalUi = {
    /**
     * Rule 145 & 146: "Show Why" and Source Jump.
     * Renders research results cleanly without using innerHTML for arbitrary user content.
     */
    renderResults(containerId, results) {
        const container = document.getElementById(containerId);
        if (!container) return;
        
        container.innerHTML = ''; // Safely clear loading state

        if (!results || !results.authorities || results.authorities.length === 0) {
            const emptyDiv = document.createElement('div');
            emptyDiv.className = 'text-center p-8 text-gray-500 text-sm';
            emptyDiv.innerHTML = '<i class="fa-solid fa-scale-balanced text-3xl mb-3 text-gray-300"></i><p>No verified authorities found for this specific query.</p>';
            container.appendChild(emptyDiv);
            return;
        }

        // Render Answer Summary
        if (results.summary) {
            const summaryDiv = document.createElement('div');
            summaryDiv.className = 'bg-blue-50 border border-blue-200 p-4 rounded-lg mb-6';
            
            const summaryTitle = document.createElement('h4');
            summaryTitle.className = 'text-sm font-bold text-blue-900 mb-2 flex items-center';
            summaryTitle.innerHTML = '<i class="fa-solid fa-list-check mr-2"></i> Preliminary Legal Synthesis';
            
            const summaryText = document.createElement('p');
            summaryText.className = 'text-sm text-blue-800';
            summaryText.textContent = results.summary;
            
            summaryDiv.appendChild(summaryTitle);
            summaryDiv.appendChild(summaryText);
            container.appendChild(summaryDiv);
        }

        // Render Authorities List (Rule 208)
        const listDiv = document.createElement('div');
        listDiv.className = 'space-y-4';

        results.authorities.forEach(auth => {
            const card = document.createElement('div');
            card.className = 'bg-white border border-gray-200 p-4 rounded-lg shadow-sm';
            
            // Header: Title & Verification Badge
            const header = document.createElement('div');
            header.className = 'flex justify-between items-start mb-2';
            
            const titleDiv = document.createElement('div');
            const title = document.createElement('h4');
            title.className = 'font-bold text-gray-900 text-base';
            title.textContent = auth.case_name;
            
            const meta = document.createElement('p');
            meta.className = 'text-xs text-gray-500 font-mono mt-0.5';
            meta.textContent = `${auth.citation} • ${auth.court} • ${auth.date}`;
            
            titleDiv.appendChild(title);
            titleDiv.appendChild(meta);
            
            const badge = citationVerifier.renderBadge(auth.verification_status);
            
            header.appendChild(titleDiv);
            header.appendChild(badge);
            card.appendChild(header);

            // Proposition / Claimed Fact
            const propDiv = document.createElement('div');
            propDiv.className = 'mt-3 text-sm text-gray-700 bg-gray-50 p-3 rounded border border-gray-100 border-l-4 border-l-blue-400';
            const propLabel = document.createElement('strong');
            propLabel.className = 'text-gray-900 block mb-1';
            propLabel.textContent = 'Held / Proposition:';
            propDiv.appendChild(propLabel);
            propDiv.appendChild(document.createTextNode(auth.proposition));
            card.appendChild(propDiv);

            // Rule 44 & 45: Contrary / Status Warning
            if (auth.treatment === 'OVERRULED' || auth.contrary_authority) {
                const warningDiv = document.createElement('div');
                warningDiv.className = 'mt-3 text-xs text-red-700 bg-red-50 p-2 rounded flex items-start border border-red-100';
                warningDiv.innerHTML = '<i class="fa-solid fa-triangle-exclamation mt-0.5 mr-2"></i>';
                
                const warningText = document.createElement('div');
                warningText.innerHTML = `<strong>Caution:</strong> ${auth.treatment === 'OVERRULED' ? 'This case has been overruled.' : 'Contrary authority exists.'} `;
                if (auth.contrary_authority) {
                    const contrLink = document.createElement('a');
                    contrLink.href = "#";
                    contrLink.className = "underline hover:text-red-900 ml-1";
                    contrLink.textContent = `See: ${auth.contrary_authority}`;
                    warningText.appendChild(contrLink);
                }
                warningDiv.appendChild(warningText);
                card.appendChild(warningDiv);
            }

            // Source Jump Button (Rule 146)
            const actionDiv = document.createElement('div');
            actionDiv.className = 'mt-4 text-right';
            const btn = document.createElement('button');
            btn.className = 'text-xs font-medium text-blue-600 hover:text-blue-800 flex items-center justify-end w-full';
            btn.innerHTML = '<i class="fa-solid fa-file-lines mr-1"></i> View Source Excerpt';
            actionDiv.appendChild(btn);
            
            card.appendChild(actionDiv);
            listDiv.appendChild(card);
        });

        container.appendChild(listDiv);
    }
};

// Expose strictly controlled interfaces to the global scope
window.legalConfig = legalConfig;
window.citationVerifier = citationVerifier;
window.legalResearchEngine = legalResearchEngine;
window.legalUi = legalUi;
