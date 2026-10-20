/**
 * ArixAI 3D Asset Proxy Handler — lib/3d-assets.js
 * Handles fetching, CORS streaming, and caching for cross-origin 3D assets (.glb, .gltf, .bin, .hdr, textures).
 */

export async function handle3DAssetProxy(req, res) {
  if (req.method !== 'GET' && req.method !== 'OPTIONS') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Handle preflight CORS requests cleanly
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const targetUrl = req.query?.url;
  if (!targetUrl || typeof targetUrl !== 'string') {
    return res.status(400).json({ error: 'Missing "url" query parameter' });
  }

  let parsed;
  try {
    parsed = new URL(targetUrl);
    if (parsed.protocol !== 'https:') {
      return res.status(400).json({ error: 'Only HTTPS URLs are allowed' });
    }
  } catch {
    return res.status(400).json({ error: 'Invalid URL supplied' });
  }

  try {
    const upstream = await fetch(parsed.href, {
      headers: {
        'User-Agent': 'ArixAI-3D-Asset-Proxy/1.0',
        'Accept': '*/*'
      }
    });

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: `Upstream fetch failed with HTTP ${upstream.status}`
      });
    }

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const arrayBuffer = await upstream.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'public, max-age=604800, s-maxage=604800, stale-while-revalidate=86400');
    res.setHeader('Content-Length', buffer.length);

    return res.status(200).send(buffer);
  } catch (err) {
    return res.status(502).json({
      error: 'Proxy network failure',
      details: err.message
    });
  }
}

export default handle3DAssetProxy;
