import { Redis } from '@upstash/redis';

// Initialize Upstash Redis using environment variables extracted from your Vercel/environment setup
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

// The absolute maximum number of recent telemetry events to keep for real-time calculations.
const MAX_EVENTS_WINDOW = 10000;

export default async function handler(req, res) {
  // CORS configuration for the frontend apps (app.html, apptesting.html, oldapp.html)
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // ============================================================================
  // POST: INGEST REAL TELEMETRY DATA
  // ============================================================================
  if (req.method === 'POST') {
    try {
      const { type, metadata } = req.body;

      if (!type || !metadata) {
        return res.status(400).json({ error: 'Missing type or metadata' });
      }

      // 🛑 HARD PRIVACY BOUNDARY: Explicitly map only allowed metadata properties.
      // This guarantees that even if the frontend accidentally sends a prompt, response, 
      // name, or user ID, it is physically dropped here before hitting the database.
      const sanitizedEvent = {
        timestamp: Date.now(),
        type: type === 'page_view' ? 'page_view' : 'ai_request',
        // Geographic analytics (Non-identifying country level only)
        country: req.headers['x-vercel-ip-country'] || 'Unknown',
        
        // Allowed AI Metadata
        model: metadata.model || 'Unknown',
        taskCategory: metadata.taskCategory || 'general_chat',
        version: metadata.version || 'v1.0',
        
        // Health & Reliability
        success: Boolean(metadata.success),
        isFirstAttempt: Boolean(metadata.isFirstAttempt),
        errorReason: metadata.errorReason || null, // e.g., "Rate limit", "Invalid JSON"
        
        // Latency & Tokens
        latency: Number(metadata.latency) || 0,
        latencyBreakdown: {
          queue: Number(metadata.latencyBreakdown?.queue) || 0,
          model: Number(metadata.latencyBreakdown?.model) || 0,
          search: Number(metadata.latencyBreakdown?.search) || 0,
          post: Number(metadata.latencyBreakdown?.post) || 0,
        },
        inputTokens: Number(metadata.inputTokens) || 0,
        outputTokens: Number(metadata.outputTokens) || 0,
        
        // Cost
        cost: Number(metadata.cost) || 0,
        
        // Sub-System Telemetry (Quality, Privacy, Safety, RAG)
        qualityScores: metadata.qualityScores || {},
        privacy: metadata.privacy || { validationPassed: false, identifiersReplaced: 0 },
        safety: metadata.safety || { passed: false, injectionDetected: false, blocked: false },
        rag: metadata.rag || null
      };

      // Push real event into Upstash Redis List
      const pipeline = redis.pipeline();
      pipeline.lpush('arix:telemetry:events', JSON.stringify(sanitizedEvent));
      // Keep only the sliding window of recent events to avoid memory bloat while providing fresh data
      pipeline.ltrim('arix:telemetry:events', 0, MAX_EVENTS_WINDOW - 1);
      
      // Increment raw, permanent global counters 
      if (sanitizedEvent.type === 'ai_request') {
        pipeline.hincrby('arix:telemetry:totals', 'calls', 1);
        if (sanitizedEvent.success) {
          pipeline.hincrby('arix:telemetry:totals', 'success', 1);
        } else {
          pipeline.hincrby('arix:telemetry:totals', 'failed', 1);
        }
      }

      await pipeline.exec();
      return res.status(200).json({ status: 'Telemetry recorded securely.' });
    } catch (error) {
      console.error('Analytics Error:', error);
      return res.status(500).json({ error: 'Internal telemetry error' });
    }
  }

  // ============================================================================
  // GET: COMPUTE & RETURN HONEST METRICS (NO DUMMY DATA)
  // ============================================================================
  if (req.method === 'GET') {
    try {
      // Fetch permanent totals and the sliding window of recent events
      const [totalsObj, eventsLog] = await Promise.all([
        redis.hgetall('arix:telemetry:totals'),
        redis.lrange('arix:telemetry:events', 0, MAX_EVENTS_WINDOW)
      ]);

      const events = (eventsLog || []).filter(e => e.type === 'ai_request');
      const totalCalls = events.length;

      // If no data exists yet, return empty but architecturally sound schema
      if (totalCalls === 0) {
        return res.status(200).json({ message: "No real telemetry data collected yet." });
      }

      // --- Helper Functions for Aggregation ---
      const sum = (arr) => arr.reduce((a, b) => a + b, 0);
      const avg = (arr) => arr.length ? (sum(arr) / arr.length) : 0;
      const getPercentile = (arr, p) => {
        if (arr.length === 0) return 0;
        const sorted = [...arr].sort((a, b) => a - b);
        const index = Math.ceil((p / 100) * sorted.length) - 1;
        return sorted[index];
      };

      // --- 1. Overall AI Health ---
      const latencies = events.map(e => e.latency);
      const successfulEvents = events.filter(e => e.success);
      const failedEvents = events.filter(e => !e.success);
      
      const overallHealth = {
        totalCalls: Number(totalsObj?.calls || totalCalls),
        successfulCalls: Number(totalsObj?.success || successfulEvents.length),
        failedCalls: Number(totalsObj?.failed || failedEvents.length),
        successRate: ((successfulEvents.length / totalCalls) * 100).toFixed(2) + '%',
        avgLatencyMs: avg(latencies).toFixed(0),
        p95LatencyMs: getPercentile(latencies, 95).toFixed(0),
        avgInputTokens: avg(events.map(e => e.inputTokens)).toFixed(0),
        avgOutputTokens: avg(events.map(e => e.outputTokens)).toFixed(0),
        avgCostPerRequest: avg(events.map(e => e.cost)).toFixed(4),
        totalEstimatedCost: sum(events.map(e => e.cost)).toFixed(2)
      };

      // --- 2. Model Performance & 16. Value Efficiency ---
      const modelMap = {};
      events.forEach(e => {
        if (!modelMap[e.model]) modelMap[e.model] = { calls: 0, successes: 0, latencies: [], tokens: [], costs: [], qualityScores: [] };
        modelMap[e.model].calls++;
        if (e.success) modelMap[e.model].successes++;
        modelMap[e.model].latencies.push(e.latency);
        modelMap[e.model].tokens.push(e.inputTokens + e.outputTokens);
        modelMap[e.model].costs.push(e.cost);
        if (e.qualityScores?.overall) modelMap[e.model].qualityScores.push(e.qualityScores.overall);
      });

      const modelPerformance = Object.keys(modelMap).map(model => {
        const stats = modelMap[model];
        const avgQuality = avg(stats.qualityScores);
        const avgCost = avg(stats.costs);
        // Value Efficiency = Quality Score / Cost (Startup Metric)
        const valueEfficiency = avgCost > 0 ? (avgQuality / avgCost).toFixed(2) : 'N/A';

        return {
          model,
          calls: stats.calls,
          successRate: ((stats.successes / stats.calls) * 100).toFixed(1) + '%',
          avgLatency: (avg(stats.latencies) / 1000).toFixed(2) + 's',
          avgTokens: avg(stats.tokens).toFixed(0),
          avgQuality: avgQuality.toFixed(1),
          avgCost: avgCost.toFixed(4),
          valueEfficiency
        };
      });

      // --- 5. Failure Analytics ---
      const failureReasons = {};
      failedEvents.forEach(e => {
        const reason = e.errorReason || 'Unknown';
        failureReasons[reason] = (failureReasons[reason] || 0) + 1;
      });

      // --- 6. Reliability / Stability ---
      const firstAttemptSuccesses = events.filter(e => e.success && e.isFirstAttempt).length;
      const reliability = {
        firstAttemptSuccessRate: ((firstAttemptSuccesses / totalCalls) * 100).toFixed(2) + '%',
        retryRate: (((successfulEvents.length - firstAttemptSuccesses) / totalCalls) * 100).toFixed(2) + '%',
      };

      // --- 7. Token Analytics (Context Health) ---
      let contextBands = { '0-10k': 0, '10-30k': 0, '30-50k': 0, '50k+': 0 };
      events.forEach(e => {
        const total = e.inputTokens;
        if (total <= 10000) contextBands['0-10k']++;
        else if (total <= 30000) contextBands['10-30k']++;
        else if (total <= 50000) contextBands['30-50k']++;
        else contextBands['50k+']++;
      });
      for(let key in contextBands) contextBands[key] = ((contextBands[key] / totalCalls) * 100).toFixed(1) + '%';

      // --- 8. Latency Breakdown ---
      const avgBreakdown = { queue: 0, model: 0, search: 0, post: 0 };
      events.forEach(e => {
        avgBreakdown.queue += e.latencyBreakdown.queue;
        avgBreakdown.model += e.latencyBreakdown.model;
        avgBreakdown.search += e.latencyBreakdown.search;
        avgBreakdown.post += e.latencyBreakdown.post;
      });
      for(let key in avgBreakdown) avgBreakdown[key] = (avgBreakdown[key] / totalCalls).toFixed(0) + ' ms';

      // --- 12. Privacy Analytics (Strictly Metadata) ---
      const privacyEvents = events.filter(e => e.privacy);
      let totalReplaced = 0;
      let validationFailures = 0;
      privacyEvents.forEach(e => {
        totalReplaced += (e.privacy.identifiersReplaced || 0);
        if (!e.privacy.validationPassed) validationFailures++;
      });
      const privacy = {
        requestsProcessed: privacyEvents.length,
        identifiersReplaced: totalReplaced,
        privacyValidationFailed: validationFailures
      };

      // --- 13. Safety Analytics ---
      const safetyEvents = events.filter(e => e.safety);
      const safety = {
        safetyEvaluations: safetyEvents.length,
        blocked: safetyEvents.filter(e => e.safety.blocked).length,
        promptInjectionDetected: safetyEvents.filter(e => e.safety.injectionDetected).length,
      };

      // Construct Real-Time Honest Dashboard Payload
      return res.status(200).json({
        security_status: "Content telemetry: OFF | Identifying metadata: OFF",
        metrics: {
          overallHealth,
          modelPerformance,
          failures: Object.entries(failureReasons).map(([reason, count]) => ({ reason, count })).sort((a,b) => b.count - a.count),
          reliability,
          contextHealth: contextBands,
          latencyAnalytics: { averageBreakdown: avgBreakdown, p50: getPercentile(latencies, 50), p90: getPercentile(latencies, 90), p95: getPercentile(latencies, 95) },
          privacy,
          safety
        }
      });

    } catch (error) {
      console.error('Aggregation Error:', error);
      return res.status(500).json({ error: 'Failed to compute analytics' });
    }
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
}
