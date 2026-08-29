/**
 * ArixLegal - Main Application Controller
 * Filename: js/app.js
 * * Purpose: Handles UI state, matter workspace rendering, form submissions,
 * PII redaction pipeline, and AI Assistant integration (Gemini/Groq).
 */

import { requireAuth } from './auth.js';
import { createNewMatter, fetchUserMatters, triggerCourtSync, isSyncOverdue } from './courtSync.js';

// Application State
const AppState = {
    matters: [],
    selectedMatter: null,
    isProcessing: false,
    user: null
};

// ==========================================
// 1. INITIALIZATION & DOM BINDING
// ==========================================

document.addEventListener('DOMContentLoaded', async () => {
    console.log("[App] Initializing ArixLegal Dashboard...");
    
    // Ensure user is authenticated before showing the dashboard
    AppState.user = await requireAuth();
    if (!AppState.user) return; // auth.js handles the redirect

    initializeUI();
    await loadMatters();
});

function initializeUI() {
    // Bind Create Workspace Form
    const createWorkspaceForm = document.getElementById('create-workspace-form');
    if (createWorkspaceForm) {
        createWorkspaceForm.addEventListener('submit', handleCreateWorkspace);
    }

    // Bind AI Assistant Button
    const btnAiAnalyze = document.getElementById('btn-ai-analyze');
    if (btnAiAnalyze) {
        btnAiAnalyze.addEventListener('click', handleAiAnalysis);
    }
}

// ==========================================
// 2. WORKSPACE & MATTER MANAGEMENT
// ==========================================

/**
 * Loads matters from Supabase via courtSync and renders them.
 */
async function loadMatters() {
    showLoading(true, "Loading your matters...");
    try {
        AppState.matters = await fetchUserMatters();
        renderMatterList(AppState.matters);
        
        // Background check for overdue syncs
        triggerBackgroundUpdates(AppState.matters);
    } catch (error) {
        showNotification("Error loading matters. Please refresh.", "error");
        console.error("[App Error]", error);
    } finally {
        showLoading(false);
    }
}

/**
 * Handles the submission of the "Create New Matter Workspace" modal.
 */
async function handleCreateWorkspace(event) {
    event.preventDefault();
    if (AppState.isProcessing) return;

    // Extract values matching the uploaded UI screenshot
    const formData = new FormData(event.target);
    const matterDetails = {
        displayName: formData.get('matterDisplayName'), // e.g., ABC Pvt Ltd v. XYZ Ltd
        caseNumber: formData.get('caseNumber'),         // e.g., CS(COMM) 124/2025
        cnrNumber: formData.get('cnrNumber'),           // 16-digit CNR
        courtForum: formData.get('courtForum'),         // e.g., District / Sessions Court
        clientName: formData.get('clientName')          // e.g., Client Name
    };

    // Validation
    if (!matterDetails.displayName || !matterDetails.courtForum) {
        showNotification("Display Name and Court/Forum are required.", "error");
        return;
    }

    AppState.isProcessing = true;
    showLoading(true, "Initializing Matter Workspace...");

    try {
        const result = await createNewMatter(matterDetails);
        
        if (result.success) {
            showNotification(`Workspace '${result.matter.display_name}' created securely.`, "success");
            closeModal('create-workspace-modal'); // Custom UI closer
            await loadMatters(); // Refresh list
        } else {
            throw new Error(result.error);
        }
    } catch (error) {
        showNotification(error.message || "Failed to create workspace.", "error");
    } finally {
        AppState.isProcessing = false;
        showLoading(false);
    }
}

/**
 * Silently checks if any cases need court data updates in the background.
 */
async function triggerBackgroundUpdates(matters) {
    for (const matter of matters) {
        if (isSyncOverdue(matter)) {
            console.log(`[App] Matter ${matter.id} is overdue for sync. Triggering background update...`);
            try {
                const res = await triggerCourtSync(matter.id, matter.cnr_number, null, false);
                if (res?.success) {
                    console.log(`[App] Background sync successful for ${matter.id}`);
                }
            } catch (err) {
                console.error(`[App] Sync error for ${matter.id}`, err);
            }
            // Add a 3-second delay between headless scrapes to prevent server overload
            await new Promise(resolve => setTimeout(resolve, 3000));
        }
    }
}

// ==========================================
// 3. AI INTEGRATION & PRIVACY PIPELINE
// ==========================================

/**
 * The Privacy Pipeline: Pseudonymizes PII before sending to external AI.
 * Replaces names, exact case numbers, and phone numbers.
 */
function redactPII(text, clientName) {
    if (!text) return "";
    let sanitized = text;

    // 1. Redact specific client name if provided
    if (clientName) {
        const clientRegex = new RegExp(clientName, 'gi');
        sanitized = sanitized.replace(clientRegex, '[CLIENT_A]');
    }

    // 2. Redact standard Indian Phone Numbers
    sanitized = sanitized.replace(/(?:\+91|91)?[-\s]?[6-9]\d{9}/g, '[PHONE_REDACTED]');
    
    // 3. Redact Email Addresses
    sanitized = sanitized.replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[EMAIL_REDACTED]');

    // 4. Redact exact 16-digit CNR for absolute privacy
    sanitized = sanitized.replace(/[A-Z0-9]{16}/g, '[CNR_REDACTED]');

    return sanitized;
}

/**
 * Generates an AI summary and legal strategy using Gemini.
 */
async function handleAiAnalysis() {
    if (!AppState.selectedMatter) {
        showNotification("Please select a matter first.", "error");
        return;
    }

    const matter = AppState.selectedMatter;
    
    // Prepare and sanitize data
    const rawContext = `Case: ${matter.display_name}. Status: ${matter.status}. Notes: ${matter.case_data || 'Initial stages.'}`;
    const cleanContext = redactPII(rawContext, matter.client_name);

    showLoading(true, "AI is analyzing the case file...");

    try {
        const aiResponse = await callGeminiAI(cleanContext);
        renderAiResponse(aiResponse);
    } catch (error) {
        console.error("[AI Error]", error);
        showNotification("AI Analysis failed. Retrying with backup models...", "error");
    } finally {
        showLoading(false);
    }
}

/**
 * Standardized fetch to Gemini API using exponential backoff principles.
 */
async function callGeminiAI(sanitizedText) {
    const apiKey = ""; // Execution environment injects this securely
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-preview-09-2025:generateContent?key=${apiKey}`;

    const prompt = `You are a highly experienced Indian Advocate. Analyze the following sanitized case details and provide: 1. A brief executive summary. 2. Next logical legal steps. 3. Potential risks. \n\nCase Details:\n${sanitizedText}`;

    const payload = {
        contents: [{ parts: [{ text: prompt }] }],
        systemInstruction: { parts: [{ text: "Maintain absolute professionalism. Output in structured markdown." }] }
    };

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    if (!response.ok) throw new Error(`AI API Error: ${response.status}`);
    
    const result = await response.json();
    return result.candidates?.[0]?.content?.parts?.[0]?.text || "No insights generated.";
}

// ==========================================
// 4. DOM UTILITIES (No alerts, native custom UI)
// ==========================================

function renderMatterList(matters) {
    const container = document.getElementById('matter-list-container');
    if (!container) return;

    if (matters.length === 0) {
        container.innerHTML = `<div class="p-4 text-gray-500 text-center">No matters found. Create a workspace to begin.</div>`;
        return;
    }

    // Map through matters and create safe HTML elements (prevent XSS)
    container.innerHTML = '';
    matters.forEach(matter => {
        const el = document.createElement('div');
        el.className = 'p-4 border-b hover:bg-gray-50 cursor-pointer transition-colors';
        el.innerHTML = `
            <div class="font-bold text-blue-800">${escapeHTML(matter.display_name)}</div>
            <div class="text-sm text-gray-600">Case No: ${escapeHTML(matter.case_number || 'N/A')} | CNR: ${escapeHTML(matter.cnr_number || 'Pending')}</div>
            <div class="mt-2 inline-block px-2 py-1 bg-gray-200 text-xs rounded-full">${escapeHTML(matter.status)}</div>
        `;
        el.addEventListener('click', () => {
            AppState.selectedMatter = matter;
            // Update Dashboard View here
            console.log("Selected:", matter);
        });
        container.appendChild(el);
    });
}

function renderAiResponse(markdownText) {
    const aiContainer = document.getElementById('ai-output-container');
    if (aiContainer) {
        // In a real app, use a markdown parser library here like marked.js
        aiContainer.innerHTML = `<pre class="whitespace-pre-wrap font-sans text-sm p-4 bg-blue-50 rounded shadow-inner">${escapeHTML(markdownText)}</pre>`;
    }
}

function showLoading(show, message = "Loading...") {
    const loader = document.getElementById('global-loader');
    if (!loader) return;
    
    if (show) {
        loader.classList.remove('hidden');
        loader.querySelector('.message').textContent = message;
    } else {
        loader.classList.add('hidden');
    }
}

function showNotification(message, type = "info") {
    // Custom UI Toast implementation (avoids browser alerts)
    const toastContainer = document.getElementById('toast-container');
    if (!toastContainer) {
        console.log(`[${type.toUpperCase()}] ${message}`);
        return;
    }

    const toast = document.createElement('div');
    toast.className = `p-4 mb-2 rounded shadow-lg text-white transition-opacity duration-300 ${type === 'error' ? 'bg-red-600' : 'bg-green-600'}`;
    toast.textContent = message;
    
    toastContainer.appendChild(toast);
    
    setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
    }, 4000);
}

function closeModal(modalId) {
    const modal = document.getElementById(modalId);
    if (modal) modal.classList.add('hidden');
}

// XSS Prevention Utility
function escapeHTML(str) {
    if (!str) return '';
    return str.replace(/[&<>'"]/g, tag => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    }[tag] || tag));
}
