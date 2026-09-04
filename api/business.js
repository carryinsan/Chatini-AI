/**
 * ARIXAI - BUSINESS OPERATING SYSTEM (BACKEND)
 * ---------------------------------------------------------
 * Architecture: Node.js + Express
 * Engine: ArixAI Core
 * Core Concept: The "Business Brain" - A persistent, stateful 
 * object representing the entire business entity.
 * * Features implemented:
 * 1. Business Blueprint Generation (Market, Customer, MVP, etc.)
 * 2. Command Center Aggregation
 * 3. India Startup Copilot (Compliance & Ecosystem)
 * 4. Government Scheme Matcher
 * 5. CEO Agent (Next Best Action Engine)
 */

const express = require('express');
const cors = require('cors');
const crypto = require('crypto');

// ============================================================================
// 1. CONFIGURATION & SETTINGS
// ============================================================================

const CONFIG = {
    PORT: process.env.PORT || 3000,
    API_KEY: process.env.ARIX_API_KEY || process.env.GEMINI_API_KEY || "YOUR_API_KEY_HERE",
    ENGINE_MODEL: "gemini-2.5-flash",
    API_BASE_URL: "https://generativelanguage.googleapis.com/v1beta/models",
    MAX_RETRIES: 3,
    RETRY_DELAY_MS: 1000
};

// ============================================================================
// 2. ERROR HANDLING & CLEANUP UTILITIES
// ============================================================================

class ArixAIError extends Error {
    constructor(message, statusCode = 500, details = null) {
        super(message);
        this.statusCode = statusCode;
        this.details = details;
        this.name = this.constructor.name;
    }
}

const Logger = {
    info: (msg, data = '') => console.log(`[INFO] ${new Date().toISOString()} | ${msg}`, data ? JSON.stringify(data) : ''),
    warn: (msg, data = '') => console.warn(`[WARN] ${new Date().toISOString()} | ${msg}`, data ? JSON.stringify(data) : ''),
    error: (msg, err) => console.error(`[ERROR] ${new Date().toISOString()} | ${msg}`, err)
};

/**
 * Text Cleaner & Parser.
 * Safely converts raw AI responses into ready-to-use business data.
 * Uses character escape codes for backticks to prevent formatting conflicts.
 */
function parseAIResponse(rawText) {
    if (!rawText) {
        throw new ArixAIError("ArixAI could not generate a response. Please try again.", 500);
    }
    
    let cleanedText = rawText.trim();
    
    // Backtick fence patterns written using hex escapes (\x60 = `)
    const codeBlockPattern = new RegExp('^\\x60{3}(?:\\w+)?\\s*([\\s\\S]*?)\\s*\\x60{3}$');
    const startFencePattern = new RegExp('^\\x60{3}[a-zA-Z]*', 'i');
    const endFencePattern = new RegExp('\\x60{3}$');

    if (cleanedText.startsWith('\x60\x60\x60')) {
        const match = cleanedText.match(codeBlockPattern);
        if (match && match[1]) {
            cleanedText = match[1].trim();
        } else {
            cleanedText = cleanedText.replace(startFencePattern, '').replace(endFencePattern, '').trim();
        }
    }

    // Isolate opening and closing braces or brackets
    const firstBrace = cleanedText.indexOf('{');
    const firstBracket = cleanedText.indexOf('[');
    const lastBrace = cleanedText.lastIndexOf('}');
    const lastBracket = cleanedText.lastIndexOf(']');

    let startIndex = -1;
    let endIndex = -1;

    if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
        startIndex = firstBrace;
        endIndex = lastBrace + 1;
    } else if (firstBracket !== -1) {
        startIndex = firstBracket;
        endIndex = lastBracket + 1;
    }

    if (startIndex !== -1 && endIndex !== -1) {
        cleanedText = cleanedText.substring(startIndex, endIndex);
    }

    try {
        return JSON.parse(cleanedText);
    } catch (error) {
        Logger.error("Failed to parse response", { rawText, cleanedText });
        throw new ArixAIError("Unable to read blueprint results. Please try again.", 502, error.message);
    }
}

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// ============================================================================
// 3. DATABASE LAYER (THE PERSISTENT "BUSINESS BRAIN")
// ============================================================================

class Database {
    constructor() {
        this.businesses = new Map();
    }

    createBusiness(initialData) {
        const id = crypto.randomUUID();
        const businessBrain = {
            id,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            status: 'initializing',
            healthScore: 0,
            
            // Core Inputs
            core: {
                idea: initialData.idea || "",
                location: initialData.location || "",
                budget: initialData.budget || "",
                experience: initialData.experience || "",
                targetCustomer: initialData.targetCustomer || "",
                businessType: initialData.businessType || ""
            },
            
            // Blueprint Sections
            market: null,
            customer: null,
            competitors: null,
            pricing: null,
            businessModel: null,
            mvp: null,
            launch: null,
            
            // Financial Engine
            financials: {
                cashFlow: 0,
                revenue: 0,
                expenses: 0
            },
            
            // India Startup Layer
            indiaCopilot: {
                gst: { status: 'pending', details: null },
                udyam: { status: 'pending', details: null },
                dpiit: { status: 'pending', details: null },
                complianceChecklist: []
            },
            
            // Funding & Schemes
            funding: {
                schemes: [],
                loans: []
            },
            
            // Execution Engine
            commandCenter: {
                tasks: [],
                opportunities: [],
                nextBestAction: null
            },
            
            // Memory & Logs
            memoryLogs: []
        };
        
        this.businesses.set(id, businessBrain);
        return businessBrain;
    }

    getBusiness(id) {
        const biz = this.businesses.get(id);
        if (!biz) throw new ArixAIError("Business profile not found", 404);
        return biz;
    }

    updateBusiness(id, section, data) {
        const biz = this.getBusiness(id);
        biz[section] = { ...biz[section], ...data };
        biz.updatedAt = new Date().toISOString();
        this.businesses.set(id, biz);
        return biz;
    }
    
    updateRoot(id, data) {
        const biz = this.getBusiness(id);
        Object.assign(biz, data);
        biz.updatedAt = new Date().toISOString();
        this.businesses.set(id, biz);
        return biz;
    }
}

const DB = new Database();

// ============================================================================
// 4. ARIXAI CORE ENGINE CLIENT
// ============================================================================

class ArixClient {
    static async generate(systemInstruction, userPrompt, outputStructure) {
        let attempt = 0;
        
        const payload = {
            contents: [{ parts: [{ text: userPrompt }] }],
            systemInstruction: { parts: [{ text: systemInstruction }] },
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: outputStructure,
                temperature: 0.2
            }
        };

        while (attempt < CONFIG.MAX_RETRIES) {
            try {
                const response = await fetch(`${CONFIG.API_BASE_URL}/${CONFIG.ENGINE_MODEL}:generateContent?key=${CONFIG.API_KEY}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                if (!response.ok) {
                    const errText = await response.text();
                    throw new Error(`ArixAI Connection Error: ${response.status} - ${errText}`);
                }

                const data = await response.json();
                
                if (!data.candidates || !data.candidates[0] || !data.candidates[0].content) {
                    throw new Error("Empty response received from ArixAI engine");
                }

                const rawText = data.candidates[0].content.parts[0].text;
                return parseAIResponse(rawText);

            } catch (error) {
                attempt++;
                Logger.warn(`ArixAI attempt ${attempt} failed. Retrying...`, error.message);
                if (attempt >= CONFIG.MAX_RETRIES) {
                    throw new ArixAIError("ArixAI is temporarily busy. Please try again in a moment.", 502, error.message);
                }
                await delay(CONFIG.RETRY_DELAY_MS * Math.pow(2, attempt - 1));
            }
        }
    }
}

// ============================================================================
// 5. BLUEPRINT STRUCTURES
// ============================================================================

const STRUCTURES = {
    MARKET: {
        type: "OBJECT",
        properties: {
            marketOpportunity: { type: "STRING" },
            localDemandHypotheses: { type: "ARRAY", items: { type: "STRING" } },
            trends: { type: "ARRAY", items: { type: "STRING" } },
            potentialNiches: { type: "ARRAY", items: { type: "STRING" } }
        },
        required: ["marketOpportunity", "localDemandHypotheses", "trends", "potentialNiches"]
    },
    CUSTOMER: {
        type: "OBJECT",
        properties: {
            primaryCustomer: { type: "STRING" },
            customerPersonas: { 
                type: "ARRAY", 
                items: { 
                    type: "OBJECT", 
                    properties: { name: { type: "STRING" }, age: { type: "STRING" }, description: { type: "STRING" } } 
                } 
            },
            painPoints: { type: "ARRAY", items: { type: "STRING" } },
            buyingBehavior: { type: "STRING" }
        },
        required: ["primaryCustomer", "customerPersonas", "painPoints", "buyingBehavior"]
    },
    COMPETITION: {
        type: "OBJECT",
        properties: {
            directCompetitors: { type: "ARRAY", items: { type: "STRING" } },
            indirectCompetitors: { type: "ARRAY", items: { type: "STRING" } },
            competitiveGaps: { type: "ARRAY", items: { type: "STRING" } },
            differentiationOpportunities: { type: "ARRAY", items: { type: "STRING" } }
        }
    },
    FINANCE: {
        type: "OBJECT",
        properties: {
            suggestedPriceRanges: { type: "STRING" },
            costAssumptions: { type: "ARRAY", items: { type: "STRING" } },
            grossMarginScenarios: { type: "STRING" },
            revenueModel: { type: "STRING" },
            majorCosts: { type: "ARRAY", items: { type: "STRING" } }
        }
    },
    MVP: {
        type: "OBJECT",
        properties: {
            minimumProduct: { type: "STRING" },
            requiredFeatures: { type: "ARRAY", items: { type: "STRING" } },
            firstCustomerExperiment: { type: "STRING" },
            thirtyDayLaunchPlan: { type: "ARRAY", items: { type: "STRING" } }
        }
    },
    INDIA_COPILOT: {
        type: "OBJECT",
        properties: {
            gstConsiderations: { type: "STRING" },
            udyamEligibility: { type: "STRING" },
            dpiitStartupConsiderations: { type: "STRING" },
            stateSpecificRequirements: { type: "ARRAY", items: { type: "STRING" } }
        }
    },
    SCHEMES: {
        type: "OBJECT",
        properties: {
            matches: {
                type: "ARRAY",
                items: {
                    type: "OBJECT",
                    properties: {
                        schemeName: { type: "STRING" },
                        whyItFits: { type: "ARRAY", items: { type: "STRING" } },
                        potentialSupportAmount: { type: "STRING" },
                        eligibilityStatus: { type: "STRING", description: "Must be 'Likely', 'Needs verification', or 'Unlikely'" }
                    }
                }
            }
        }
    },
    NEXT_BEST_ACTION: {
        type: "OBJECT",
        properties: {
            actionTitle: { type: "STRING" },
            whyDoThis: { type: "STRING" },
            steps: { type: "ARRAY", items: { type: "STRING" } },
            resourcesNeeded: { type: "ARRAY", items: { type: "STRING" } }
        }
    }
};

// ============================================================================
// 6. SPECIALIZED ARIXAI AGENTS
// ============================================================================

class Agents {
    static async getMarketAnalysis(coreInfo) {
        const system = `You are ArixAI Market Research Agent. Analyze the business parameters and output a precise, practical market analysis. Focus heavily on local dynamics if a location is provided. Skip generic filler.`;
        const prompt = `Business Idea: ${coreInfo.idea}\nLocation: ${coreInfo.location}\nBudget: ${coreInfo.budget}\nTarget Customer: ${coreInfo.targetCustomer}`;
        return await ArixClient.generate(system, prompt, STRUCTURES.MARKET);
    }

    static async getCustomerAnalysis(coreInfo) {
        const system = `You are ArixAI Customer Profiler. Define the exact audience, top frustrations, and purchase habits for this business. Keep it razor-sharp.`;
        const prompt = `Business Idea: ${coreInfo.idea}\nTarget Customer: ${coreInfo.targetCustomer}\nLocation: ${coreInfo.location}`;
        return await ArixClient.generate(system, prompt, STRUCTURES.CUSTOMER);
    }

    static async getCompetitionAnalysis(coreInfo, marketData) {
        const system = `You are ArixAI Strategy Agent. Identify real rivals and market openings based on the provided market data.`;
        const prompt = `Idea: ${coreInfo.idea}\nLocation: ${coreInfo.location}\nMarket Data: ${JSON.stringify(marketData)}`;
        return await ArixClient.generate(system, prompt, STRUCTURES.COMPETITION);
    }

    static async getFinancialBlueprint(coreInfo, customerData) {
        const system = `You are ArixAI Finance Agent. Build a realistic pricing, revenue, and cost breakdown based on the budget constraints.`;
        const prompt = `Idea: ${coreInfo.idea}\nBudget: ${coreInfo.budget}\nCustomers: ${JSON.stringify(customerData)}`;
        return await ArixClient.generate(system, prompt, STRUCTURES.FINANCE);
    }

    static async getMVPAndLaunch(coreInfo, financeData) {
        const system = `You are ArixAI Launch Agent. Define the smallest working version to test early and outline a simple 30-day action plan.`;
        const prompt = `Idea: ${coreInfo.idea}\nBudget: ${coreInfo.budget}\nFinancials: ${JSON.stringify(financeData)}`;
        return await ArixClient.generate(system, prompt, STRUCTURES.MVP);
    }

    static async getIndiaCompliance(coreInfo) {
        const system = `You are ArixAI India Startup Copilot. Give direct legal and setup guidance for India: GST, Udyam MSME, DPIIT, and state requirements.`;
        const prompt = `Idea: ${coreInfo.idea}\nLocation: ${coreInfo.location}\nType: ${coreInfo.businessType}`;
        return await ArixClient.generate(system, prompt, STRUCTURES.INDIA_COPILOT);
    }

    static async getGovernmentSchemes(coreInfo) {
        const system = `You are ArixAI India Scheme Matcher. Find real central and state schemes and grants matching this profile. Rate each as 'Likely' or 'Unlikely'.`;
        const prompt = `Idea: ${coreInfo.idea}\nLocation: ${coreInfo.location}\nFounder Experience: ${coreInfo.experience}`;
        return await ArixClient.generate(system, prompt, STRUCTURES.SCHEMES);
    }

    static async calculateNextBestAction(businessBrain) {
        const system = `You are ArixAI CEO Agent. Review the business brain and choose the SINGLE highest priority action the founder must take right now. Give one clear goal, why it matters, and 3 quick micro-steps.`;
        const prompt = `BUSINESS BRAIN:\n${JSON.stringify({
            core: businessBrain.core,
            health: businessBrain.healthScore,
            market: businessBrain.market,
            mvp: businessBrain.mvp,
            tasks: businessBrain.commandCenter.tasks
        })}`;
        return await ArixClient.generate(system, prompt, STRUCTURES.NEXT_BEST_ACTION);
    }
}

// ============================================================================
// 7. ORCHESTRATION SERVICES
// ============================================================================

class BusinessService {
    static async generateFullBlueprint(businessId) {
        const biz = DB.getBusiness(businessId);
        const core = biz.core;
        
        DB.updateRoot(businessId, { status: 'generating_market' });
        
        // Stage 1: Fast Parallel Research
        Logger.info(`[${businessId}] Starting initial analysis...`);
        const [market, customer, india, schemes] = await Promise.all([
            Agents.getMarketAnalysis(core),
            Agents.getCustomerAnalysis(core),
            Agents.getIndiaCompliance(core),
            Agents.getGovernmentSchemes(core)
        ]);

        DB.updateRoot(businessId, { 
            market, 
            customer, 
            indiaCopilot: { ...biz.indiaCopilot, ...india },
            funding: { ...biz.funding, schemes: schemes.matches }
        });

        // Stage 2: Strategy & Numbers
        Logger.info(`[${businessId}] Calculating strategy and numbers...`);
        const [competitors, finance] = await Promise.all([
            Agents.getCompetitionAnalysis(core, market),
            Agents.getFinancialBlueprint(core, customer)
        ]);

        DB.updateRoot(businessId, { competitors, financials: { ...biz.financials, ...finance }});

        // Stage 3: Launch Plan
        Logger.info(`[${businessId}] Building launch setup...`);
        const mvp = await Agents.getMVPAndLaunch(core, finance);
        DB.updateRoot(businessId, { mvp, status: 'active', healthScore: 40 });

        // Stage 4: Set Top Action
        Logger.info(`[${businessId}] Determining immediate next step...`);
        const updatedBiz = DB.getBusiness(businessId);
        const nextAction = await Agents.calculateNextBestAction(updatedBiz);
        
        DB.updateRoot(businessId, { 
            commandCenter: { 
                ...updatedBiz.commandCenter, 
                nextBestAction: nextAction 
            }
        });

        return DB.getBusiness(businessId);
    }

    static async processCommandCenterQuery(businessId, userQuery) {
        const biz = DB.getBusiness(businessId);
        
        const system = `You are ArixAI, the Business Operating System. 
        You have direct access to this business profile.
        Give short, clear, highly actionable advice. Skip greetings and filler.`;
        
        const contextData = {
            idea: biz.core.idea,
            marketOpportunity: biz.market?.marketOpportunity,
            pricing: biz.financials?.suggestedPriceRanges,
            mvp: biz.mvp?.minimumProduct,
            currentAction: biz.commandCenter.nextBestAction?.actionTitle
        };

        const prompt = `QUESTION: ${userQuery}\n\nBUSINESS OVERVIEW:\n${JSON.stringify(contextData)}`;
        
        const CHAT_STRUCTURE = {
            type: "OBJECT",
            properties: {
                answer: { type: "STRING" },
                generatedTask: { 
                    type: "OBJECT", 
                    properties: { title: { type: "STRING" }, required: { type: "BOOLEAN" } },
                    nullable: true
                }
            },
            required: ["answer"]
        };

        const response = await ArixClient.generate(system, prompt, CHAT_STRUCTURE);
        
        biz.memoryLogs.push({ role: 'user', content: userQuery, timestamp: new Date().toISOString() });
        biz.memoryLogs.push({ role: 'ai', content: response.answer, timestamp: new Date().toISOString() });
        
        if (response.generatedTask && response.generatedTask.title) {
            biz.commandCenter.tasks.push({
                id: crypto.randomUUID(),
                title: response.generatedTask.title,
                status: 'pending',
                addedAt: new Date().toISOString()
            });
        }
        
        DB.updateRoot(businessId, { memoryLogs: biz.memoryLogs, commandCenter: biz.commandCenter });
        return response;
    }
}

// ============================================================================
// 8. API ENDPOINTS & ROUTES
// ============================================================================

const app = express();
app.use(cors());
app.use(express.json());

const router = express.Router();

/**
 * POST /api/business/build
 * Main entry: Generates the full business blueprint
 */
router.post('/build', async (req, res) => {
    try {
        const { idea, location, budget, experience, targetCustomer, businessType } = req.body;
        
        if (!idea) {
            return res.status(400).json({ error: "Please enter your business idea." });
        }

        Logger.info(`New Business Request: ${idea.substring(0, 50)}...`);
        
        const business = DB.createBusiness({ idea, location, budget, experience, targetCustomer, businessType });
        const populatedBlueprint = await BusinessService.generateFullBlueprint(business.id);
        
        res.status(201).json({
            message: "Blueprint Ready",
            businessId: populatedBlueprint.id,
            dashboardUrl: `/api/business/${populatedBlueprint.id}/dashboard`
        });

    } catch (error) {
        Logger.error("Error in /build", error);
        const status = error.statusCode || 500;
        res.status(status).json({ error: error.message || "Failed to create blueprint" });
    }
});

/**
 * GET /api/business/:id/dashboard
 * Command Center overview
 */
router.get('/:id/dashboard', (req, res) => {
    try {
        const { id } = req.params;
        const biz = DB.getBusiness(id);
        
        const commandCenterView = {
            id: biz.id,
            health: {
                score: biz.healthScore,
                cashFlow: biz.financials.cashFlow,
                revenue: biz.financials.revenue,
                customers: 0,
                opportunities: biz.commandCenter.opportunities.length
            },
            nextBestAction: biz.commandCenter.nextBestAction,
            blueprintStatus: {
                market: biz.market ? 100 : 0,
                customer: biz.customer ? 100 : 0,
                mvp: biz.mvp ? 100 : 0,
                launch: biz.launch ? 100 : 0
            },
            indiaCopilot: {
                udyamStatus: biz.indiaCopilot.udyam.status,
                gstStatus: biz.indiaCopilot.gst.status,
                dpiitStatus: biz.indiaCopilot.dpiit.status,
                potentialSchemes: biz.funding.schemes.length
            },
            opportunities: biz.commandCenter.opportunities
        };

        res.status(200).json(commandCenterView);

    } catch (error) {
        const status = error.statusCode || 500;
        res.status(status).json({ error: error.message });
    }
});

/**
 * GET /api/business/:id/blueprint
 * Detailed blueprint information
 */
router.get('/:id/blueprint', (req, res) => {
    try {
        const biz = DB.getBusiness(req.params.id);
        res.status(200).json({
            market: biz.market,
            customer: biz.customer,
            competitors: biz.competitors,
            pricing: biz.financials,
            businessModel: biz.financials?.revenueModel,
            mvp: biz.mvp
        });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

/**
 * GET /api/business/:id/india
 * Indian regulatory & scheme details
 */
router.get('/:id/india', (req, res) => {
    try {
        const biz = DB.getBusiness(req.params.id);
        res.status(200).json({
            compliance: biz.indiaCopilot,
            schemes: biz.funding.schemes
        });
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

/**
 * POST /api/business/:id/action/complete
 * Marks the active step complete and gives the next action
 */
router.post('/:id/action/complete', async (req, res) => {
    try {
        const biz = DB.getBusiness(req.params.id);
        const { actionResultData } = req.body;
        
        if (actionResultData) {
            biz.memoryLogs.push({
                type: 'action_result',
                action: biz.commandCenter.nextBestAction?.actionTitle,
                result: actionResultData,
                timestamp: new Date().toISOString()
            });
            biz.healthScore = Math.min(100, biz.healthScore + 5); 
        }

        DB.updateRoot(biz.id, { memoryLogs: biz.memoryLogs, healthScore: biz.healthScore });
        const newAction = await Agents.calculateNextBestAction(biz);
        
        DB.updateRoot(biz.id, { 
            commandCenter: { ...biz.commandCenter, nextBestAction: newAction } 
        });

        res.status(200).json({
            message: "Action completed",
            newHealthScore: biz.healthScore,
            nextBestAction: newAction
        });

    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

/**
 * POST /api/business/:id/chat
 * Command Center instant Q&A
 */
router.post('/:id/chat', async (req, res) => {
    try {
        const { message } = req.body;
        if (!message) return res.status(400).json({ error: "Please enter your message." });
        
        const response = await BusinessService.processCommandCenterQuery(req.params.id, message);
        res.status(200).json(response);
    } catch (error) {
        res.status(error.statusCode || 500).json({ error: error.message });
    }
});

// ============================================================================
// 9. SERVER STARTUP
// ============================================================================

app.use('/api/business', router);

// Global Error Handler
app.use((err, req, res, next) => {
    Logger.error("Application Error", err);
    res.status(500).json({ error: "Something went wrong. Please try again." });
});

if (require.main === module) {
    app.listen(CONFIG.PORT, () => {
        console.log(`========================================================`);
        console.log(`🚀 ARIXAI BUSINESS  ${CONFIG.PORT}`);
        console.log(`🧠ArixAI `);
        console.log(`========================================================`);
    });
}

module.exports = { app, DB, BusinessService, Agents };
