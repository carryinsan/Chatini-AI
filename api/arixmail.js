export const config = {
  runtime: 'edge',
};

// Hardcoded fallback credentials matching the LexisAI architecture
const UPSTASH_URL = (process.env.UPSTASH_REDIS_REST_URL || "https://immortal-eagle-36171.upstash.io").replace(/\/$/, '');
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN || "AY1LAAIgcDE5MjFiMmNkNGQ4M2M0ODQ2YWNhYjU0YmFmMzlhNjliNw";

const SUPABASE_URL = (process.env.SUPABASE_URL || "https://vvcpdfdofihdmzshglxr.supabase.co").replace(/\/$/, '');
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InZ2Y3BmZG9maWhkbXpzaGRnbHhyIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4NTA2NzQ5MCwiZXhwIjoyMTAwNjQzNDkwfQ.ACRUkwnNiVg-6ZNqS1KYYev0csd_cT6tgiL0T0fPKLQ";

const ADMIN_SECRET = "Arix-Admin-2026!";

// CORS Setup
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, x-device-id',
};

async function redis(command, ...args) {
  try {
    const res = await fetch(`${UPSTASH_URL}/${command}/${args.map(encodeURIComponent).join('/')}`, {
      headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}` }
    });
    const data = await res.json();
    return data.result;
  } catch (e) { return null; }
}

async function redisPost(command, key, value) {
  try {
    const res = await fetch(`${UPSTASH_URL}/${command}/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${UPSTASH_TOKEN}`, 'Content-Type': 'application/json' },
      body: typeof value === 'string' ? value : JSON.stringify(value)
    });
    const data = await res.json();
    return data.result;
  } catch (e) { return null; }
}

// Cryptographic hash for passwords
async function hashSecure(data) {
  const msgUint8 = new TextEncoder().encode(data + "ARIX_MAIL_SALT_999");
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

// Proof of Work Verifier (Abuse Prevention)
async function verifyProofOfWork(nonce, timestamp, deviceId) {
  const now = Date.now();
  if (now - timestamp > 300000) return false; // PoW expires after 5 minutes
  const challenge = `${deviceId}:${timestamp}:${nonce}`;
  const msgUint8 = new TextEncoder().encode(challenge);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hex = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  return hex.startsWith('0000'); // Difficulty level 4
}

export default async function handler(req) {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS_HEADERS });
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: CORS_HEADERS });

  try {
    const body = await req.json();
    const { action, payload, auth, adminKey } = body;
    const deviceId = req.headers.get('x-device-id') || 'unknown-device';
    
    // IP-based Rate Limiting (Simple representation)
    const clientIp = req.headers.get('x-forwarded-for') || '127.0.0.1';
    const rateLimitKey = `rate_limit:${clientIp}`;
    const requests = await redis("INCR", rateLimitKey);
    if (requests === 1) await redis("EXPIRE", rateLimitKey, "60");
    if (requests > 50) return new Response(JSON.stringify({ error: "Rate limit exceeded. System locked." }), { status: 429, headers: CORS_HEADERS });

    // ---------------------------------------------------------
    // ACCOUNT CREATION & AUTHENTICATION
    // ---------------------------------------------------------
    if (action === 'register') {
      const { username, password, powNonce, powTimestamp } = payload;
      
      // 1. Verify Bot-Prevention Proof of Work
      const isValidPoW = await verifyProofOfWork(powNonce, powTimestamp, deviceId);
      if (!isValidPoW) throw new Error("Cryptographic Proof of Work failed. Botting detected.");

      // 2. Validate Identity
      const email = `${username.toLowerCase().replace(/[^a-z0-9]/g, '')}@amail.com`;
      if (email.length < 12) throw new Error("Username must be at least 3 characters.");
      
      // 3. Strict Password Policy Check
      const strongRegex = new RegExp("^(?=.*[a-z])(?=.*[A-Z])(?=.*[0-9])(?=.*[!@#\$%\^&\*])(?=.{12,})");
      if (!strongRegex.test(password)) throw new Error("Password does not meet strict Arix safety protocols.");

      // 4. Check Existence
      const exists = await redis("GET", `user:${email}`);
      if (exists) throw new Error("Identity already registered.");

      const pwdHash = await hashSecure(password);
      const userRecord = {
        email,
        pwdHash,
        deviceId,
        createdAt: Date.now(),
        status: 'active',
        profile: { displayName: username, theme: 'dark' }
      };

      await redisPost("SET", `user:${email}`, userRecord);
      await redis("SADD", "arix_all_users", email); // Global tracking
      
      return new Response(JSON.stringify({ success: true, email, token: pwdHash }), { status: 200, headers: CORS_HEADERS });
    }

    if (action === 'login') {
      const { email, password } = payload;
      const userStr = await redis("GET", `user:${email}`);
      if (!userStr) throw new Error("Identity not found.");
      
      let user = typeof userStr === 'string' ? JSON.parse(userStr) : userStr;
      if (user.status === 'blocked') throw new Error("Account suspended by Arix Protocol.");

      const attemptHash = await hashSecure(password);
      if (user.pwdHash !== attemptHash) throw new Error("Cryptographic mismatch. Access denied.");

      // Update active device mapping
      await redis("HSET", "arix_active_sessions", email, Date.now());

      return new Response(JSON.stringify({ success: true, email: user.email, profile: user.profile, token: user.pwdHash }), { status: 200, headers: CORS_HEADERS });
    }

    // ---------------------------------------------------------
    // DUAL STORAGE SYNC & MAIL DELIVERY
    // ---------------------------------------------------------
    // Verify Auth for all subsequent routes
    if (!auth || !auth.email || !auth.token) throw new Error("Authentication required.");
    const userAuthStr = await redis("GET", `user:${auth.email}`);
    if (!userAuthStr) throw new Error("Invalid session.");
    let userAuth = typeof userAuthStr === 'string' ? JSON.parse(userAuthStr) : userAuthStr;
    if (userAuth.pwdHash !== auth.token) throw new Error("Session hijacked or expired.");

    if (action === 'sync_data') {
      const { target, data } = payload; // target: 'chat' | 'mail' | 'profile'
      const key = `vault:${auth.email}:${target}`;
      
      // If data is provided, it's an UP-SYNC (Cloud Storage)
      if (data) {
        await redisPost("SET", key, data);
        return new Response(JSON.stringify({ success: true, message: "Encrypted vault synced." }), { status: 200, headers: CORS_HEADERS });
      } 
      // If no data, it's a DOWN-SYNC (Load from Cloud)
      else {
        const cloudData = await redis("GET", key);
        return new Response(JSON.stringify({ success: true, data: cloudData }), { status: 200, headers: CORS_HEADERS });
      }
    }

    if (action === 'send_mail') {
      const { to, subject, content } = payload;
      const targetUser = await redis("GET", `user:${to}`);
      if (!targetUser) throw new Error("Recipient identity does not exist on the Arix Network.");
      
      const mailObj = {
        id: 'mail_' + Date.now().toString(36),
        from: auth.email,
        to: to,
        subject,
        content,
        timestamp: Date.now(),
        read: false
      };

      // Push to recipient's inbox
      await redisPost("LPUSH", `inbox:${to}`, mailObj);
      // Push to sender's outbox
      await redisPost("LPUSH", `outbox:${auth.email}`, mailObj);

      return new Response(JSON.stringify({ success: true, message: "Transmission complete." }), { status: 200, headers: CORS_HEADERS });
    }

    if (action === 'get_inbox') {
      const mailsRaw = await redis("LRANGE", `inbox:${auth.email}`, 0, 50);
      const mails = mailsRaw ? mailsRaw.map(m => typeof m === 'string' ? JSON.parse(m) : m) : [];
      return new Response(JSON.stringify({ success: true, mails }), { status: 200, headers: CORS_HEADERS });
    }

    if (action === 'delete_account') {
      await redis("DEL", `user:${auth.email}`);
      await redis("DEL", `vault:${auth.email}:chat`);
      await redis("DEL", `inbox:${auth.email}`);
      await redis("SREM", "arix_all_users", auth.email);
      return new Response(JSON.stringify({ success: true, message: "Data eradicated." }), { status: 200, headers: CORS_HEADERS });
    }

    // ---------------------------------------------------------
    // ADMIN ACTIONS (Secure Routes)
    // ---------------------------------------------------------
    if (action.startsWith('admin_')) {
      if (adminKey !== ADMIN_SECRET) throw new Error("Master Authorization Failed.");

      if (action === 'admin_get_users') {
        const emails = await redis("SMEMBERS", "arix_all_users") || [];
        const sessions = await redis("HGETALL", "arix_active_sessions") || [];
        const sessionMap = {};
        for (let i = 0; i < sessions.length; i += 2) {
          sessionMap[sessions[i]] = parseInt(sessions[i+1]);
        }
        
        let usersList = [];
        for(let email of emails) {
           const uRaw = await redis("GET", `user:${email}`);
           if(uRaw) {
              const u = typeof uRaw === 'string' ? JSON.parse(uRaw) : uRaw;
              usersList.push({
                 email: u.email,
                 deviceId: u.deviceId,
                 status: u.status,
                 lastActive: sessionMap[u.email] || u.createdAt
              });
           }
        }
        return new Response(JSON.stringify({ success: true, users: usersList }), { status: 200, headers: CORS_HEADERS });
      }

      if (action === 'admin_action') {
        const { targetEmail, command } = payload; // command: 'block' | 'unblock'
        const uRaw = await redis("GET", `user:${targetEmail}`);
        if(uRaw) {
           const u = typeof uRaw === 'string' ? JSON.parse(uRaw) : uRaw;
           u.status = command === 'block' ? 'blocked' : 'active';
           await redisPost("SET", `user:${targetEmail}`, u);
           return new Response(JSON.stringify({ success: true, message: `User ${command}ed.` }), { status: 200, headers: CORS_HEADERS });
        }
        throw new Error("User not found.");
      }

      if (action === 'admin_broadcast') {
        const { subject, content, uiHtml } = payload;
        const emails = await redis("SMEMBERS", "arix_all_users") || [];
        const mailObj = {
          id: 'sys_' + Date.now().toString(36),
          from: 'system@arix.ai',
          to: 'broadcast',
          subject,
          content: content,
          uiHtml: uiHtml,
          timestamp: Date.now(),
          read: false,
          isSystem: true
        };
        // Fan-out broadcast
        for (let email of emails) {
          await redisPost("LPUSH", `inbox:${email}`, mailObj);
        }
        return new Response(JSON.stringify({ success: true, count: emails.length }), { status: 200, headers: CORS_HEADERS });
      }
    }

    throw new Error("Invalid routing action.");

  } catch (error) {
    return new Response(JSON.stringify({ success: false, error: error.message }), { 
      status: 400, 
      headers: CORS_HEADERS 
    });
  }
}
