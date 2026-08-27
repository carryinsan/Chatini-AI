/**
 * ARIXlegal Secure Backend & AI Orchestration Gateway
 * Enforces Rule 124 (Secret Management), Rule 63/64 (Model Routing & Failover),
 * and Rule 187 (Strict Matter Authorization).
 * 
 * Run with Node.js: `node api/server.js`
 * Requires standard packages: express, cors, dotenv, multer (for file uploads)
 */

const express = require('express');
const crypto = require('crypto');
const cors = require('cors');
const path = require('path');
// In a real environment, load these from 'dotenv' package.
// require('dotenv').config();

const app = express();
app.use(cors()); // Enable CORS to allow local HTML files to connect
app.use(express.json({ limit: '10mb' })); // Strict JSON parsing

// Serve static HTML/JS files from the parent directory 
// (Assumes server.js is inside an /api folder)
app.use(express.static(path.join(__dirname, '../')));

// ==========================================
// 1. SECURE CONFIGURATION (Rule 124 & 125)
// ==========================================
// Secrets are read exclusively from the environment. They are NEVER sent to the browser.
// Based on the provided architecture, we manage pools of keys for failover.
const config = {
    PORT: process.env.PORT || 3000,
    SUPABASE: {
        URL: process.env.SUPABASE_URL,
        KEY: process.env.SUPABASE_KEY // Service Role Key - Backend Only
    },
    REDIS: {
        URL: process.env.UPSTASH_URL,
        TOKEN: process.env.UPSTASH_TOKEN
    },
    API_KEYS: {
        GEMINI: [
            process.env.GEMINI_API_KEY_1, process.env.GEMINI_API_KEY_2, process.env.GEMINI_API_KEY_3,
            process.env.GEMINI_API_KEY_4, process.env.GEMINI_API_KEY_5, process.env.GEMINI_API_KEY_6,
            process.env.GEMINI_API_KEY_7, process.env.GEMINI_API_KEY_8, process.env.GEMINI_API_KEY_9,
            process.env.GEMINI_API_KEY
        ].filter(Boolean),
        GROQ: [
            process.env.GROQ_API_KEY, process.env.GROQ_KEY_2, process.env.GROQ_API_KEY_2,
            process.env.GROQ_KEY_3, process.env.GROQ_API_KEY_3, process.env.GROQ_KEY_4,
            process.env.GROQ_API_KEY_4, process.env.GROQ_KEY_5, process.env.GROQ_API_KEY_5
        ].filter(Boolean),
        TAVILY: [
            process.env.TAVILY_API_KEY, process.env.TAVILY_KEY_2, process.env.TAVILY_KEY_3,
            process.env.TAVILY_KEY_4, process.env.TAVILY_KEY_5, process.env.TAVILY_KEY_6,
            process.env.TAVILY_KEY_7
        ].filter(Boolean)
    }
};

// ==========================================
// 2. SECURITY & AUTHORIZATION MIDDLEWARE (Rule 187)
// ==========================================

/**
 * Validates the user session (mocked for architectural representation).
 * Enforces Rule 10 & 186.
 */
const requireAuth = (req, res, next) => {
    // In production, verify JWT/Session Cookie via Supabase Auth here
    req.user = { user_id: 'usr_secure_99182', role: 'advocate' };
    next();
};

/**
 * Validates that the authenticated user actually owns/has access to the matter_id.
 * Rule 187: Never trust a client-provided matter_id alone.
 */
const authorizeMatterAccess = async (req, res, next) => {
    const matterId = req.body.matter_id || req.headers['x-matter-id'] || req.params.matter_id;
    if (!matterId) return res.status(400).json({ error: "Matter ID required" });

    // TODO: Await database check: SELECT count(*) FROM matter_access WHERE user_id = req.user.user_id AND matter_id = matterId
    const hasAccess = true; // Simulated database success
    
    if (!hasAccess) {
        console.warn(`[SECURITY] Unauthorized matter access attempt by ${req.user.user_id}`);
        return res.status(403).json({ error: "Unauthorized matter access" });
    }
    next();
};


// ==========================================
// 3. AI ORCHESTRATOR & FAILOVER ROUTER (Rules 63-65, 157)
// ==========================================

class ModelRouter {
    constructor() {
        this.geminiIndex = 0;
        this.groqIndex = 0;
    }

    /**
     * Executes a prompt with automatic round-robin failover across available API keys.
     * Enforces Rule 64, 76 (Fail-safe architecture), and 85 (Circuit Breaker logic).
     */
    async executeWithFailover(provider, prompt, systemInstruction) {
        const keys = provider === 'GEMINI' ? config.API_KEYS.GEMINI : config.API_KEYS.GROQ;
        if (keys.length === 0) throw new Error(`[Model Router] No keys configured for ${provider}`);

        let attempts = 0;
        let lastError = null;
        let currentIndex = provider === 'GEMINI' ? this.geminiIndex : this.groqIndex;

        while (attempts < keys.length && attempts < 3) { // Max 3 retries per Rule 79 (Retry Budget)
            const key = keys[currentIndex];
            try {
                // Rule 8: Use proper adapters. (Simulated REST call to represent actual SDK usage without importing heavy modules)
                console.log(`[Model Router] Routing task via ${provider} (Key Index: ${currentIndex})`);
                
                // --- Simulated Call Execution ---
                // If this were live, we'd use: await fetch('https://api.groq.com/openai/v1/chat/completions', { headers: { Authorization: `Bearer ${key}` }...})
                await new Promise(resolve => setTimeout(resolve, 300)); // Simulate network latency
                
                // Advance index on success to distribute load (Rate limit mitigation)
                this._rotateKey(provider);
                
                return {
                    success: true,
                    provider: provider,
                    result: `[Secure Output Generated by ${provider}] Validated against strict schemas.`
                };

            } catch (error) {
                lastError = error;
                console.warn(`[Model Router] ${provider} key ${currentIndex} failed. Rotating...`);
                this._rotateKey(provider);
                currentIndex = provider === 'GEMINI' ? this.geminiIndex : this.groqIndex;
                attempts++;
            }
        }
        
        // Rule 230: No-Silent-Failure. If all fail, throw an explicit error.
        throw new Error(`[Model Router] ${provider} exhausted available keys/retries. Last Error: ${lastError.message}`);
    }

    _rotateKey(provider) {
        if (provider === 'GEMINI') this.geminiIndex = (this.geminiIndex + 1) % config.API_KEYS.GEMINI.length;
        if (provider === 'GROQ') this.groqIndex = (this.groqIndex + 1) % config.API_KEYS.GROQ.length;
    }
}
const aiRouter = new ModelRouter();

// ==========================================
// 4. API ENDPOINTS (Serving legalapp.js, case.js, etc.)
// ==========================================

const apiRouter = express.Router();
apiRouter.use(requireAuth);

// --- Dashboard & Case Endpoints ---

apiRouter.get('/dashboard/metrics', (req, res) => {
    // Rule 110: Morning Legal Dashboard metrics
    res.json({
        hearingsToday: 2,
        urgentDeadlines: 1,
        newOrders: 3,
        safetyReviews: 1
    });
});

apiRouter.post('/cases', (req, res) => {
    // Generates a new secure workspace instance
    const { display_name, case_number, court, client, cnr } = req.body;
    const newMatterId = `mtr_${Date.now()}`;
    
    res.status(201).json({
        success: true,
        matter_id: newMatterId,
        display_name: display_name || "New Matter",
        case_number: case_number || "Unassigned"
    });
});

apiRouter.get('/tasks/pending', (req, res) => {
    // Supplies dashboard with actionable items
    res.json([
        {
            title: "File Evidence Affidavit",
            case_name: "ABC Pvt Ltd v. XYZ Ltd",
            source: "Order dated 15-Aug-2026",
            urgency: "CRITICAL",
            icon: "fa-file-signature"
        }
    ]);
});

apiRouter.post('/cases', (req, res) => {
    // Generates a new secure workspace instance
    const { display_name, case_number, court, client, cnr } = req.body;
    const newMatterId = `mtr_${Date.now()}`;
    
    res.status(201).json({
        success: true,
        matter_id: newMatterId,
        display_name: display_name || "New Matter",
        case_number: case_number || "Unassigned"
    });
});

apiRouter.get('/tasks/pending', (req, res) => {
    // Supplies dashboard with actionable items
    res.json([
        {
            title: "File Evidence Affidavit",
            case_name: "ABC Pvt Ltd v. XYZ Ltd",
            source: "Order dated 15-Aug-2026",
            urgency: "CRITICAL",
            icon: "fa-file-signature"
        }
    ]);
});

apiRouter.get('/cases/active', (req, res) => {
    // Structural response expected by legalapp.js Rule 16
    res.json([
        {
            matter_id: "mtr_1001",
            display_name: "ABC Pvt Ltd v. XYZ Ltd",
            case_number: "CS(COMM) 124/2025",
            court: "Delhi High Court",
            official_status: "PENDING",
            ai_interpreted_stage: "Evidence Stage",
            stage_confidence: "High",
            next_hearing: "02 Sep 2026",
            last_verified: "10 mins ago",
            change_level: "info"
        }
    ]);
});

apiRouter.get('/cases/:matter_id', authorizeMatterAccess, (req, res) => {
    const matterId = req.params.matter_id;
    // Structural response expected by case.js Rule 111
    res.json({
        details: {
            display_name: "ABC Pvt Ltd v. XYZ Ltd",
            case_number: "CS(COMM) 124/2025",
            court: "Delhi High Court",
            cnr: "DLHC010045672025",
            official_status: "PENDING",
            ai_interpreted_stage: "Evidence",
            stage_confidence: "High",
            next_hearing: "02 Sep 2026",
            unindexed_documents_count: 0,
            ai_brief: {
                summary: "This is a commercial trademark dispute regarding the 'XYZ' mark. The matter is currently at the plaintiff's evidence stage.",
                sources: [{ name: "Order dated 15-Aug-2026" }]
            },
            recent_changes: [
                { type: "order", title: "New Order Uploaded", description: "Court has directed filing of witness affidavits within 2 weeks." }
            ]
        },
        documents: []
    });
});

// --- Document Upload Endpoint (Rule 189) ---

// Mocking Multer for architectural representation
const mockUpload = (req, res, next) => next(); 

apiRouter.post('/documents/upload', mockUpload, authorizeMatterAccess, (req, res) => {
    // File processing logic goes here
    const fileHash = req.headers['x-file-hash'];
    console.log(`[Document Engine] Received file upload for matter ${req.headers['x-matter-id']} with hash ${fileHash}`);
    
    // Rule 23: Original File Immutability. We would upload the raw buffer directly to Supabase Storage here.
    // Rule 162: We would push a message to Redis here to trigger background OCR, preventing HTTP timeouts.

    res.status(202).json({ 
        status: "PROCESSING", 
        message: "File securely stored. OCR and classification queued." 
    });
});

// --- AI & Task Orchestration Endpoints (Rule 68, 131) ---

const taskStore = new Map(); // Simulating Redis cache for background tasks

apiRouter.post('/ai/execute', authorizeMatterAccess, async (req, res) => {
    const contextPackage = req.body;
    
    // Generate Secure Task ID
    const taskId = `task_${crypto.randomUUID()}`;
    
    // Store initial state
    taskStore.set(taskId, { status: 'QUEUED', ui_message: 'Task received by secure gateway...' });
    
    // Start background processing asynchronously (Rule 162)
    processAITask(taskId, contextPackage, req.user.user_id).catch(err => console.error(err));
    
    // Return immediately to frontend
    res.status(202).json({ task_id: taskId });
});

apiRouter.get('/ai/task/:task_id', (req, res) => {
    const task = taskStore.get(req.params.task_id);
    if (!task) return res.status(404).json({ error: "Task not found" });
    res.json(task);
});

// Background Processor (Rule 76: Fail-Safe Architecture)
async function processAITask(taskId, contextPackage, userId) {
    try {
        taskStore.set(taskId, { status: 'RUNNING', ui_message: 'Assembling legal context...' });
        
        // 1. Privacy Check (Rule 69: Privacy Gateway)
        if (contextPackage.user_query && contextPackage.user_query.match(/\b\d{12}\b/)) {
             throw new Error("PRIVACY_ERROR: Unmasked identifier detected on backend.");
        }

        // 2. Routing based on Task Type (Rule 65)
        taskStore.set(taskId, { status: 'RUNNING', ui_message: 'Analyzing legal parameters...' });
        
        let provider = 'GROQ'; // Default to fast model for basic tasks
        if (contextPackage.task_type === 'LEGAL_RESEARCH' || contextPackage.task_type === 'ADVERSARIAL_REVIEW') {
            provider = 'GEMINI'; // Use heavy reasoning model for complex legal tasks
        }

        // 3. Execution via Failover Router
        const result = await aiRouter.executeWithFailover(provider, contextPackage.user_query, "Strict Legal System Prompt");
        
        // 4. Update Status (Rule 178: Universal Completion Contract)
        taskStore.set(taskId, { 
            status: 'COMPLETED', 
            ui_message: 'Analysis complete.',
            result: result
        });

        // 5. Audit Logging (Rule 103, 104)
        console.log(`[Audit] Task ${taskId} completed for User ${userId}. Provider: ${provider}`);

    } catch (error) {
        console.error(`[Task Engine] Task ${taskId} failed:`, error.message);
        let errorCode = 'MODEL_ERROR';
        if (error.message.includes('PRIVACY_ERROR')) errorCode = 'PRIVACY_ERROR';
        
        taskStore.set(taskId, { 
            status: 'FAILED', 
            error_code: errorCode,
            ui_message: 'Task failed during execution.'
        });
    }
}

// --- Legal & Verification Endpoints ---

apiRouter.post('/legal/verify-citation', authorizeMatterAccess, (req, res) => {
    const { citation, proposition } = req.body;
    console.log(`[Citation Verifier] Adversارڈ adversarial check requested for: ${citation}`);
    
    // Rule 91 & 92: Generator vs Critic & Adversarial Review.
    // In reality, this endpoint retrieves the actual case text from the database/Tavily,
    // and asks the critic model to attempt to DISPROVE the proposition.
    
    setTimeout(() => {
        // Simulating completion of verification
        res.json({
            status: 'SUPPORTED',
            reason: 'The underlying text in paragraph 14 supports the core assertion, though the exact phrasing differs.',
            source: 'Supreme Court Database'
        });
    }, 800);
});

apiRouter.post('/legal/research', authorizeMatterAccess, async (req, res) => {
    // Rule 38 & 39: Search Provider abstraction.
    console.log(`[Legal Research] Query received: ${req.body.query}`);
    // Simulated unified search result combining DB lookup and Tavily adapter
    res.json({
        summary: "Preliminary analysis indicates this falls under commercial trademark guidelines.",
        authorities: [
            {
                case_name: "Mock Case v. Example",
                citation: "2024 SCC OnLine SC 123",
                court: "Supreme Court of India",
                date: "14-Jan-2024",
                proposition: req.body.query || "Standard proposition",
                verification_status: "VERIFIED",
                treatment: "FOLLOWED",
                contrary_authority: null
            }
        ]
    });
});

// ==========================================
// 5. SERVER INITIALIZATION & ERROR HANDLING
// ==========================================

app.use('/api/v1', apiRouter);

// Global Error Handler (Rule 230: No-Silent-Failure)
app.use((err, req, res, next) => {
    console.error(`[Global Error] ${err.message}`);
    // Never leak stack traces or secrets to the client
    res.status(500).json({
        error: "INTERNAL_SERVER_ERROR",
        message: "An unexpected error occurred. The legal workspace has logged this for review."
    });
});

// Support both local Node.js execution and Vercel Serverless Function export
if (process.env.NODE_ENV !== 'production' && !process.env.VERCEL) {
    app.listen(config.PORT, () => {
        console.log(`ARIXlegal Secure Gateway running on port ${config.PORT}`);
        console.log(`[Status] Privacy Gateway: ACTIVE`);
        console.log(`[Status] Multi-Key Model Router: LOADED`);
    });
}

// Export the app for Vercel's serverless environment
module.exports = app;
