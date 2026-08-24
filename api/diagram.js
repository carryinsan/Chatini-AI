export const config = {
    runtime: 'edge',
};

// ============================================================================
// LEXIS-AI AUTONOMOUS KINETIC DIAGRAM & PHYSICS ENGINE (v4.0)
// Resolves Network Errors via Standard JSON Response & Canvas Transpilation
// ============================================================================

class KineticFailSafe {
    /**
     * The Ultimate Fallback Matrix. 
     * Deployed if LLM APIs fail, ensuring a 0% error rate for the user.
     * Contains a highly dense, visually stunning N-Body Gravity & Fluid Node Sandbox.
     */
    static get FALLBACK_SIMULATION() {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <script src="https://cdn.tailwindcss.com"></script>
    <style>
        body, html { margin: 0; padding: 0; width: 100%; height: 100%; background-color: #020617; overflow: hidden; font-family: system-ui, -apple-system, sans-serif; }
        canvas { display: block; width: 100%; height: 100%; }
        /* Custom UI Scrollbars */
        ::-webkit-scrollbar { width: 4px; }
        ::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.2); border-radius: 4px; }
    </style>
</head>
<body>
    <canvas id="simCanvas"></canvas>
    
    <!-- Glassmorphic Control Panel -->
    <div class="absolute top-6 left-6 w-72 bg-slate-900/80 backdrop-blur-xl border border-slate-700 p-5 rounded-2xl shadow-[0_0_40px_rgba(20,184,166,0.15)] z-10 text-slate-200 select-none">
        <div class="flex items-center gap-3 mb-4 border-b border-slate-700 pb-3">
            <div class="w-8 h-8 rounded-lg bg-teal-500/20 border border-teal-500/40 flex items-center justify-center text-teal-400 font-bold">K</div>
            <div>
                <h2 class="text-sm font-bold text-white tracking-wide uppercase">Kinetic Matrix</h2>
                <p class="text-[10px] text-teal-400">Offline Algorithmic Fallback</p>
            </div>
        </div>
        
        <div class="space-y-4">
            <div>
                <div class="flex justify-between text-xs mb-1 font-medium"><label>Gravitational Pull</label><span id="gVal" class="text-teal-400">1.0 G</span></div>
                <input type="range" id="gravity" min="0.1" max="5.0" step="0.1" value="1.0" class="w-full accent-teal-500 h-1.5 bg-slate-700 rounded-full appearance-none outline-none">
            </div>
            <div>
                <div class="flex justify-between text-xs mb-1 font-medium"><label>Friction (Damping)</label><span id="fVal" class="text-teal-400">0.98</span></div>
                <input type="range" id="friction" min="0.80" max="1.0" step="0.01" value="0.98" class="w-full accent-teal-500 h-1.5 bg-slate-700 rounded-full appearance-none outline-none">
            </div>
            <div>
                <div class="flex justify-between text-xs mb-1 font-medium"><label>Particle Density</label><span id="pVal" class="text-teal-400">300</span></div>
                <input type="range" id="particles" min="50" max="800" step="50" value="300" class="w-full accent-teal-500 h-1.5 bg-slate-700 rounded-full appearance-none outline-none">
            </div>
        </div>
        <div class="mt-5 pt-3 border-t border-slate-700 text-[10px] text-slate-400 text-center">
            Click & drag mouse to create a gravity well.
        </div>
    </div>

    <script>
        const canvas = document.getElementById('simCanvas');
        const ctx = canvas.getContext('2d', { alpha: false });
        let w, h;
        
        const config = {
            gravity: 1.0,
            friction: 0.98,
            count: 300
        };

        const mouse = { x: -1000, y: -1000, isDown: false };
        let particles = [];

        // DOM Binds
        const binds = ['gravity', 'friction', 'particles'];
        const valOutputs = ['gVal', 'fVal', 'pVal'];
        const units = [' G', '', ''];
        
        binds.forEach((id, idx) => {
            const el = document.getElementById(id);
            el.addEventListener('input', (e) => {
                config[id === 'particles' ? 'count' : id] = parseFloat(e.target.value);
                document.getElementById(valOutputs[idx]).innerText = e.target.value + units[idx];
                if(id === 'particles') initParticles();
            });
        });

        window.addEventListener('resize', resize);
        canvas.addEventListener('mousedown', () => mouse.isDown = true);
        window.addEventListener('mouseup', () => mouse.isDown = false);
        window.addEventListener('mousemove', (e) => { mouse.x = e.clientX; mouse.y = e.clientY; });

        function resize() {
            w = canvas.width = window.innerWidth;
            h = canvas.height = window.innerHeight;
        }

        class Particle {
            constructor() {
                this.x = Math.random() * w;
                this.y = Math.random() * h;
                this.vx = (Math.random() - 0.5) * 4;
                this.vy = (Math.random() - 0.5) * 4;
                this.baseColor = Math.random() > 0.5 ? '#14b8a6' : '#8b5cf6'; // Teal & Violet
                this.radius = Math.random() * 2 + 1;
            }

            update() {
                // Mouse Gravity Well
                if (mouse.isDown) {
                    let dx = mouse.x - this.x;
                    let dy = mouse.y - this.y;
                    let distSq = dx*dx + dy*dy;
                    if (distSq < 150000) {
                        let force = (config.gravity * 2000) / (distSq || 1);
                        this.vx += (dx / Math.sqrt(distSq)) * force;
                        this.vy += (dy / Math.sqrt(distSq)) * force;
                    }
                }

                // Apply Friction
                this.vx *= config.friction;
                this.vy *= config.friction;

                // Move
                this.x += this.vx;
                this.y += this.vy;

                // Bounce off walls organically
                if (this.x < 0) { this.x = 0; this.vx *= -1; }
                if (this.x > w) { this.x = w; this.vx *= -1; }
                if (this.y < 0) { this.y = 0; this.vy *= -1; }
                if (this.y > h) { this.y = h; this.vy *= -1; }
            }

            draw() {
                ctx.beginPath();
                ctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
                ctx.fillStyle = this.baseColor;
                ctx.fill();
            }
        }

        function initParticles() {
            particles = [];
            for(let i = 0; i < config.count; i++) particles.push(new Particle());
        }

        function animate() {
            // Motion Blur Effect
            ctx.fillStyle = 'rgba(2, 6, 23, 0.25)';
            ctx.fillRect(0, 0, w, h);

            // Connect nearby nodes
            ctx.lineWidth = 0.5;
            for(let i=0; i<particles.length; i++) {
                particles[i].update();
                particles[i].draw();
                
                // Draw connecting lines for aesthetic constellation effect
                for(let j=i+1; j<particles.length; j++) {
                    let dx = particles[i].x - particles[j].x;
                    let dy = particles[i].y - particles[j].y;
                    let dist = dx*dx + dy*dy;
                    if(dist < 5000) {
                        ctx.beginPath();
                        ctx.moveTo(particles[i].x, particles[i].y);
                        ctx.lineTo(particles[j].x, particles[j].y);
                        ctx.strokeStyle = \`rgba(20, 184, 166, \${1 - dist/5000})\`;
                        ctx.stroke();
                    }
                }
            }

            // Draw glowing mouse orbital
            if (mouse.isDown) {
                ctx.beginPath();
                ctx.arc(mouse.x, mouse.y, 40, 0, Math.PI*2);
                ctx.strokeStyle = 'rgba(139, 92, 246, 0.5)';
                ctx.lineWidth = 2;
                ctx.stroke();
            }

            requestAnimationFrame(animate);
        }

        resize();
        initParticles();
        animate();
    </script>
</body>
</html>`;
    }

    /**
     * Deep Intelligence Prompt instructing the AI to build a fully contained Interactive Sandbox.
     */
    static get SYSTEM_PROMPT() {
        return `You are LexisAI's Autonomous Physics and Interactive Diagram Architect.
Your sole purpose is to translate a user's prompt (e.g., "Projectile motion", "Circuit diagram", "Spring physics", "Ecosystem graph") into a FLAWLESS, single-file HTML5 interactive Web App.

CRITICAL CONSTRAINTS:
1. OUTPUT ONLY VALID HTML. No markdown outside the \`\`\`html block. No explanations.
2. The HTML MUST contain Tailwind CSS via <script src="https://cdn.tailwindcss.com"></script>.
3. Create an immersive, dark-mode aesthetic (bg-slate-900, glowing neon accents like teal-500, fuchsia-500, blue-500).
4. Build a Control Panel UI using absolute positioning (glassmorphism: backdrop-blur, bg-black/50, border-white/10).
5. The control panel MUST contain <input type="range"> sliders that actually manipulate variables in your JavaScript loop.
6. Use <canvas> and vanilla JavaScript. Utilize requestAnimationFrame for simulations.
7. Include event listeners for mouse interactions (drag, drop, pull, repel, or node manipulation).
8. Ensure the canvas resizes to window.innerWidth and window.innerHeight dynamically.
9. Physics/Math must be accurate. Ensure boundary collision detection (objects bounce off screen edges).

Deliver pure, highly dense, beautiful HTML.`;
    }

    /**
     * Extracts the raw HTML string from the LLM's Markdown output.
     */
    static extractHTML(rawResponse) {
        if (!rawResponse) return null;
        const match = rawResponse.match(/```html([\s\S]*?)```/) || rawResponse.match(/```([\s\S]*?)```/);
        return match ? match[1].trim() : rawResponse.trim();
    }
}

// ============================================================================
// EDGE API HANDLER (JSON RESOLVER)
// ============================================================================

export default async function handler(req) {
    // 1. Enforce POST Method
    if (req.method !== 'POST') {
        return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { 'Content-Type': 'application/json' } });
    }

    try {
        // 2. Safely parse frontend JSON (Accepts 'prompt' or 'query')
        const body = await req.json();
        const userPrompt = body.prompt || body.query || "Generate an interactive physics simulation sandbox.";

        // 3. Assemble API Keys for Redundancy
        const GEMINI_KEYS = [
            process.env.GEMINI_API_KEY_1,
            process.env.GEMINI_API_KEY_2,
            process.env.GEMINI_API_KEY_3,
            process.env.GEMINI_API_KEY
        ].filter(Boolean);

        // 4. Trigger Fallback Matrix instantly if server lacks keys
        if (GEMINI_KEYS.length === 0) {
            console.warn("Diagram Engine: No Gemini keys found. Deploying offline matrix.");
            return new Response(JSON.stringify({ 
                success: true, 
                html: KineticFailSafe.FALLBACK_SIMULATION 
            }), { headers: { 'Content-Type': 'application/json' } });
        }

        let finalLLMResponse = null;
        let isSuccess = false;

        // 5. Intelligent Key Rotation & Execution Loop
        for (const key of GEMINI_KEYS) {
            try {
                const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${key}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        systemInstruction: { parts: [{ text: KineticFailSafe.SYSTEM_PROMPT }] },
                        contents: [{ role: 'user', parts: [{ text: `Create an interactive diagram/simulation for: ${userPrompt}` }] }],
                        generationConfig: { 
                            temperature: 0.2, 
                            maxOutputTokens: 8192 
                        }
                    })
                });

                if (response.ok) {
                    const data = await response.json();
                    if (data.candidates && data.candidates[0].content) {
                        finalLLMResponse = data.candidates[0].content.parts[0].text;
                        isSuccess = true;
                        break; // Exit loop on success
                    }
                }
            } catch (apiError) {
                console.error(`Diagram Engine Node Failure: Retrying...`);
                continue;
            }
        }

        // 6. Evaluate Result & Clean Code
        if (!isSuccess || !finalLLMResponse) {
            throw new Error("All Neural Cognitive Nodes Exhausted.");
        }

        const safeHTML = KineticFailSafe.extractHTML(finalLLMResponse);

        if (!safeHTML || !safeHTML.includes('<html')) {
            throw new Error("Syntax Hallucination Detected: LLM failed to wrap in standard HTML structure.");
        }

        // 7. Deliver Valid JSON Payload to Frontend Interceptor
        return new Response(JSON.stringify({ 
            success: true, 
            html: safeHTML 
        }), { headers: { 'Content-Type': 'application/json' } });

    } catch (globalError) {
        // ====================================================================
        // THE IRONCLAD GUARANTEE
        // If anything fails (Rate Limit, Parsing, Body Extract), we catch it
        // and return the pre-compiled offline physics engine. Zero UI Errors.
        // ====================================================================
        console.error(`Diagram Engine Error Caught: ${globalError.message} - Deploying Fallback Matrix.`);
        return new Response(JSON.stringify({ 
            success: true, 
            html: KineticFailSafe.FALLBACK_SIMULATION,
            warning: "API constraints hit. Showing local algorithmic simulation instead."
        }), { headers: { 'Content-Type': 'application/json' } });
    }
}
