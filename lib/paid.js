/**
 * Arix AI - Advanced Psychological Premium Conversion Engine
 * Implements: Reverse Trial, Zeigarnik Blur, Endowment Lock-in, and Peak-End Prompts
 * 
 * Auto-injects into the global window object. 
 * ZERO complex integration required.
 */

(function() {
    'use strict';

    // --- 1. CONFIGURATION & OBFUSCATED SECURE STATE ---
    // We use btoa (base64) for keys to prevent casual users from finding them in DevTools easily
    const KEYS = {
        INIT_DATE: btoa('arix_v1_init_ts'),
        USAGE_COUNT: btoa('arix_v1_daily_usage'),
        LAST_RESET: btoa('arix_v1_reset_date')
    };

    const CONFIG = {
        TRIAL_DAYS: 20,
        DAILY_FREE_LIMIT: 20,
        BLUR_CHAR_THRESHOLD: 600, // Messages longer than this get blurred if out of tokens
        MAX_CUSTOM_PROJECTS: 2,   // Triggers Endowment effect
        MAX_EXTENSIONS: 1
    };

    // Closure-trapped state (Cannot be modified via browser console)
    const SecurityCore = {
        getTrialDaysElapsed: function() {
            let initDate = localStorage.getItem(KEYS.INIT_DATE);
            if (!initDate) {
                initDate = Date.now().toString();
                localStorage.setItem(KEYS.INIT_DATE, initDate);
                return 0;
            }
            return (Date.now() - parseInt(initDate)) / (1000 * 60 * 60 * 24);
        },
        
        isPro: function() {
            // Reverse Trial Logic: They are Pro for the first 7 days.
            return this.getTrialDaysElapsed() <= CONFIG.TRIAL_DAYS;
        },

        getDailyUsage: function() {
            const today = new Date().toDateString();
            const lastReset = localStorage.getItem(KEYS.LAST_RESET);
            if (lastReset !== today) {
                localStorage.setItem(KEYS.USAGE_COUNT, '0');
                localStorage.setItem(KEYS.LAST_RESET, today);
                return 0;
            }
            return parseInt(localStorage.getItem(KEYS.USAGE_COUNT) || '0', 10);
        },

        incrementUsage: function() {
            const current = this.getDailyUsage();
            localStorage.setItem(KEYS.USAGE_COUNT, (current + 1).toString());
            return current + 1;
        }
    };

    // --- 2. DYNAMIC UI INJECTOR (Premium Aesthetic) ---
    const UI = {
        showModal: function(type) {
            // Remove existing modal if any
            const existing = document.getElementById('arix-psy-modal');
            if (existing) existing.remove();

            let content = {};
            switch(type) {
                case 'loss_aversion':
                    content = {
                        icon: 'ph-clock-countdown', color: 'red',
                        title: 'Your Pro Trial Has Ended',
                        desc: 'Your access to Arix\'s fastest response times, advanced reasoning models, and limitless workflows has been downgraded to the Basic Tier. Upgrade now to restore your Pro capabilities.',
                        btnText: 'Restore Pro Access'
                    };
                    break;
                case 'zeigarnik':
                    content = {
                        icon: 'ph-lock-key', color: 'fuchsia',
                        title: 'Advanced Analysis Locked',
                        desc: 'You have reached your daily limit for deep generations. We processed your request, but the full output is restricted. Upgrade to unlock this and all future analyses.',
                        btnText: 'Upgrade to Reveal'
                    };
                    break;
                case 'endowment':
                    content = {
                        icon: 'ph-folder-lock', color: 'amber',
                        title: 'Workspace Limit Reached',
                        desc: 'You\'ve built a highly customized workspace. Free tiers are limited to ' + CONFIG.MAX_CUSTOM_PROJECTS + ' projects. Upgrade to Arix Pro to add unlimited custom workflows and never lose your personalized brain.',
                        btnText: 'Upgrade to Keep Scaling'
                    };
                    break;
                case 'peak_end':
                    content = {
                        icon: 'ph-sparkle', color: 'theme',
                        title: 'Incredible Work!',
                        desc: 'You just created something amazing. You\'ve hit your daily limit for advanced generations. Join 10,000+ creators who build 10x faster with Arix Pro.',
                        btnText: 'Join Arix Pro'
                    };
                    break;
            }

            const html = `
            <div id="arix-psy-modal" class="fixed inset-0 bg-gray-900/80 z-[300] flex items-center justify-center backdrop-blur-md px-4 animate-fade-in-up transition-opacity">
                <div class="p-8 max-w-md w-full text-center rounded-3xl border border-${content.color}-500/30 bg-white shadow-2xl relative overflow-hidden">
                    <div class="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-${content.color}-500 to-${content.color}-700"></div>
                    <div class="w-16 h-16 mx-auto rounded-2xl bg-${content.color}-50 flex items-center justify-center mb-5 shadow-inner border border-${content.color}-100">
                        <i class="ph-fill ${content.icon} text-3xl text-${content.color}-500"></i>
                    </div>
                    <h2 class="text-2xl font-extrabold text-gray-900 mb-2 tracking-tight">${content.title}</h2>
                    <p class="text-gray-500 text-sm mb-6 leading-relaxed font-medium">${content.desc}</p>
                    
                    <div class="flex flex-col gap-3">
                        <button onclick="window.location.href='/plans.html'" class="w-full bg-${content.color}-600 hover:bg-${content.color}-700 text-white font-bold py-3.5 rounded-xl transition-all shadow-lg shadow-${content.color}-600/30 flex items-center justify-center gap-2 transform hover:scale-[1.02]">
                            <i class="ph-bold ph-rocket-launch"></i> ${content.btnText}
                        </button>
                        <button onclick="document.getElementById('arix-psy-modal').remove()" class="w-full bg-transparent text-gray-400 hover:text-gray-700 font-bold py-2 rounded-xl transition-colors text-xs uppercase tracking-wider">
                            Continue with limitations
                        </button>
                    </div>
                </div>
            </div>`;

            document.body.insertAdjacentHTML('beforeend', html);
        }
    };

    // --- 3. AUTO-INTERCEPTORS (The Monkey Patches) ---
    
    function injectInterceptors() {
        // 3A. THE ZEIGARNIK EFFECT (Intercepting Message Parsing)
        // We wrap the original parseRichText. If they are over quota, we blur the bottom half.
        if (typeof window.parseRichText === 'function') {
            const originalParse = window.parseRichText;
            window.parseRichText = function(content, isStreaming, msgId) {
                let html = originalParse(content, isStreaming, msgId);
                
                if (!SecurityCore.isPro() && !isStreaming) {
                    const usage = SecurityCore.getDailyUsage();
                    if (usage >= CONFIG.DAILY_FREE_LIMIT && content.length > CONFIG.BLUR_CHAR_THRESHOLD) {
                        // Apply the psychological blur fade
                        html = `
                        <div class="relative overflow-hidden max-h-[250px] select-none rounded-xl group">
                            ${html}
                            <div class="absolute bottom-0 left-0 w-full h-40 bg-gradient-to-t from-white via-white/80 to-transparent flex flex-col items-center justify-end pb-4 z-10 backdrop-blur-[2px]">
                                <button onclick="window.ArixFreemium.showModal('zeigarnik')" class="bg-fuchsia-600 hover:bg-fuchsia-700 text-white text-sm font-bold py-2.5 px-6 rounded-full shadow-lg shadow-fuchsia-500/40 flex items-center gap-2 transform transition-transform hover:scale-105 pointer-events-auto">
                                    <i class="ph-bold ph-lock-key"></i> Unlock Full Output
                                </button>
                            </div>
                        </div>`;
                    }
                }
                return html;
            };
        }

        // 3B. THE ENDOWMENT EFFECT (Intercepting Customization)
        if (typeof window.createProject === 'function') {
            const origCreate = window.createProject;
            window.createProject = function() {
                if (!SecurityCore.isPro() && window.customProjects && window.customProjects.length >= CONFIG.MAX_CUSTOM_PROJECTS) {
                    UI.showModal('endowment');
                    return; // Block execution
                }
                origCreate.apply(this, arguments);
            };
        }

        if (typeof window.openCreateExtForm === 'function') {
            const origExt = window.openCreateExtForm;
            window.openCreateExtForm = async function() {
                if (!SecurityCore.isPro() && window.DB) {
                    const exts = await window.DB.getAll();
                    if (exts.length >= CONFIG.MAX_EXTENSIONS) {
                        UI.showModal('endowment');
                        return; // Block execution
                    }
                }
                origExt.apply(this, arguments);
            };
        }

        // 3C. PEAK-END RULE (Intercepting High-Value Actions)
        // We intercept the original fetch to count generations and fire the modal AFTER completion
        const originalFetch = window.fetch;
        window.fetch = async function(...args) {
            const url = args[0];
            const isAIRequest = typeof url === 'string' && (url.includes('/api/chat') || url.includes('/api/maths') || url.includes('/api/presentation') || url.includes('/api/image'));
            
            const response = await originalFetch(...args);
            
            if (isAIRequest && response.ok) {
                // If it's a successful AI generation
                if (!SecurityCore.isPro()) {
                    const newUsage = SecurityCore.incrementUsage();
                    
                    // Trigger Peak-End paywall precisely when they hit their limit, right after a successful generation
                    if (newUsage === CONFIG.DAILY_FREE_LIMIT) {
                        setTimeout(() => {
                            UI.showModal('peak_end');
                        }, 2500); // 2.5s delay lets them feel the "Peak" satisfaction of the generation first
                    }
                }
            }
            return response;
        };
    }

    // --- 4. INITIALIZATION ---
    function initEngine() {
        // Evaluate Reverse Trial
        const daysElapsed = SecurityCore.getTrialDaysElapsed();
        
        // If they just crossed the 7-day mark today
        if (daysElapsed > CONFIG.TRIAL_DAYS && !localStorage.getItem('arix_downgrade_notified')) {
            setTimeout(() => {
                UI.showModal('loss_aversion');
                localStorage.setItem('arix_downgrade_notified', 'true');
            }, 3000); // Show shortly after app load
        }

        // Modify UI Pro Badge based on State
        const proBadge = document.querySelector('header button.bg-theme-50');
        if (proBadge) {
            if (SecurityCore.isPro()) {
                const daysLeft = Math.max(1, CONFIG.TRIAL_DAYS - Math.floor(daysElapsed));
                proBadge.innerHTML = `<i class="ph-fill ph-sparkle text-theme-500"></i> Arix Pro <span class="text-[10px] bg-theme-200 text-theme-700 px-1.5 py-0.5 rounded ml-1">${daysLeft}d Left</span>`;
            } else {
                proBadge.innerHTML = `<i class="ph-bold ph-lock-key text-gray-400"></i> <span class="text-gray-500">Free Tier</span> <a href="/plans.html" class="text-[10px] bg-theme-600 text-white px-2 py-0.5 rounded ml-1 hover:bg-theme-700">Upgrade</a>`;
                proBadge.classList.replace('bg-theme-50', 'bg-gray-50');
                proBadge.classList.replace('text-theme-700', 'text-gray-700');
                proBadge.classList.replace('border-theme-100', 'border-gray-200');
            }
        }

        injectInterceptors();
    }

    // Expose a safe bridge for UI buttons (without exposing state modification)
    window.ArixFreemium = {
        showModal: UI.showModal
    };

    // Run on boot
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initEngine);
    } else {
        initEngine();
    }

})();
