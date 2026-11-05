import { ipAddress, next, waitUntil } from '@vercel/functions';
import { withArixShield } from './lib/arix-shield/sdk/next.js';
import { createArixShieldProxy } from './lib/arix-shield/route-proxy.js';

export default createArixShieldProxy({ next, withArixShield, ipAddress, waitUntil });
