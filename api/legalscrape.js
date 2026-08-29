/**
 * ArixLegal - Highly Resilient eCourts Headless Scraper Endpoint
 * Filename: api/scrape.js
 * Environment: Node.js (Serverless or Express backend)
 * 
 * Dependencies required in package.json:
 * npm install puppeteer puppeteer-extra puppeteer-extra-plugin-stealth tesseract.js @supabase/supabase-js ioredis
 */

import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import Tesseract from 'tesseract.js';
import { createClient } from '@supabase/supabase-js';
import Redis from 'ioredis';

// Apply Stealth Plugin to evade basic bot detection
puppeteer.use(StealthPlugin());

// Initialize Database & Cache
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);
const redis = new Redis(process.env.UPSTASH_URL); // e.g., rediss://default:TOKEN@url:port

// eCourts URLs
const ECOURTS_BASE_URL = 'https://services.ecourts.gov.in/ecourtindia_v6/';
const CNR_SEARCH_URL = `${ECOURTS_BASE_URL}?app=r_cino`;

/**
 * Utility: Random Delay to simulate human behavior
 */
const delay = (min, max) => new Promise(r => setTimeout(r, Math.floor(Math.random() * (max - min + 1) + min)));

/**
 * Utility: Block unnecessary resources for speed and stealth
 */
async function optimizePageLoad(page) {
    await page.setRequestInterception(true);
    page.on('request', (req) => {
        const resourceType = req.resourceType();
        // Block tracking, styles, fonts, and media. ONLY allow documents, scripts, XHR, and the CAPTCHA image.
        if (['stylesheet', 'font', 'media', 'video'].includes(resourceType)) {
            req.abort();
        } else if (resourceType === 'image' && !req.url().includes('captcha')) {
            req.abort(); // Block non-captcha images
        } else {
            req.continue();
        }
    });
}

/**
 * WITTY ALGORITHM 1: Local OCR CAPTCHA Solver
 * Takes a screenshot of the specific CAPTCHA element, runs Tesseract.js,
 * cleans the string, and returns it. Zero external API cost.
 */
async function solveCaptcha(page, imageSelector) {
    console.log(`[OCR] Locating CAPTCHA element: ${imageSelector}`);
    try {
        const captchaElement = await page.waitForSelector(imageSelector, { timeout: 5000 });
        
        // Take a screenshot of just the CAPTCHA image as a base64 buffer
        const imageBuffer = await captchaElement.screenshot({ encoding: 'binary' });
        
        console.log(`[OCR] Running Tesseract on image buffer...`);
        // We configure Tesseract to only look for alphanumeric characters to improve accuracy
        const { data: { text } } = await Tesseract.recognize(imageBuffer, 'eng', {
            tessedit_char_whitelist: 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
        });
        
        const cleanedText = text.replace(/[^a-zA-Z0-9]/g, '').trim();
        console.log(`[OCR] Solved CAPTCHA text: ${cleanedText}`);
        return cleanedText;
    } catch (error) {
        console.error(`[OCR] Failed to solve CAPTCHA: ${error.message}`);
        return null;
    }
}

/**
 * WITTY ALGORITHM 2: Fuzzy DOM Parsing
 * eCourts frequently changes table structures. This function grabs ALL tables,
 * reads their textual content, and uses Regex to extract data reliably regardless of structure.
 */
async function extractCaseDataFuzzy(page) {
    return await page.evaluate(() => {
        const data = {
            status: "Unknown",
            nextHearingDate: null,
            judge: "Unknown",
            petitioner: "",
            respondent: "",
            history: []
        };

        // Find all tables on the rendered page
        const tables = Array.from(document.querySelectorAll('table'));
        
        tables.forEach(table => {
            const text = table.innerText.toLowerCase();
            
            // Extract Case Status Table
            if (text.includes('case status') || text.includes('next hearing date')) {
                const rows = Array.from(table.querySelectorAll('tr'));
                rows.forEach(row => {
                    const rowText = row.innerText.toLowerCase();
                    if (rowText.includes('next hearing date')) {
                        // Extract date using regex DD-MM-YYYY
                        const match = row.innerText.match(/\d{2}-\d{2}-\d{4}/);
                        if (match) data.nextHearingDate = match[0];
                    }
                    if (rowText.includes('case stage')) {
                        data.status = row.cells[1] ? row.cells[1].innerText.trim() : "Pending";
                    }
                    if (rowText.includes('coram') || rowText.includes('judge')) {
                        data.judge = row.cells[1] ? row.cells[1].innerText.trim() : "Unknown";
                    }
                });
            }

            // Extract Petitioner and Respondent
            if (text.includes('petitioner and advocate')) {
                data.petitioner = table.innerText.split('\n').filter(l => l.length > 3)[1] || "Available on portal";
            }
            if (text.includes('respondent and advocate')) {
                data.respondent = table.innerText.split('\n').filter(l => l.length > 3)[1] || "Available on portal";
            }

            // Extract Case History (Hearings)
            if (text.includes('history of case hearing')) {
                const historyRows = Array.from(table.querySelectorAll('tr')).slice(1); // Skip header
                historyRows.forEach(row => {
                    const cells = row.querySelectorAll('td');
                    if (cells.length >= 4) {
                        data.history.push({
                            judge: cells[0].innerText.trim(),
                            businessOnDate: cells[1].innerText.trim(),
                            hearingDate: cells[2].innerText.trim(),
                            purpose: cells[3].innerText.trim()
                        });
                    }
                });
            }
        });

        return data;
    });
}

/**
 * Workflow 1: Direct CNR Search (Fastest & most reliable)
 */
async function scrapeByCNR(page, cnrNumber) {
    await page.goto(CNR_SEARCH_URL, { waitUntil: 'networkidle2' });
    
    let success = false;
    let retries = 0;
    const MAX_RETRIES = 5;

    while (!success && retries < MAX_RETRIES) {
        retries++;
        console.log(`[CNR Search] Attempt ${retries} for CNR: ${cnrNumber}`);
        
        // Input CNR
        await page.type('#cino', cnrNumber, { delay: 100 });
        
        // Solve CAPTCHA
        const captchaText = await solveCaptcha(page, '#captcha_image');
        await page.type('#fcaptcha_code', captchaText, { delay: 100 });
        
        // Click Search
        await page.click('#searchbtn');
        
        // Wait for either the data table to load, OR an error alert (invalid captcha)
        try {
            // Race condition: wait for data div OR alert box
            const result = await Promise.race([
                page.waitForSelector('#history_cnr', { timeout: 8000 }).then(() => 'success'),
                page.waitForFunction(() => document.querySelector('.alert-danger') !== null, { timeout: 8000 }).then(() => 'error')
            ]);

            if (result === 'success') {
                success = true;
                console.log(`[CNR Search] Success! Extracting data...`);
                // Expand all history tabs if they are accordions
                const expandBtns = await page.$$('.accordion-button');
                for (let btn of expandBtns) await btn.click();
                await delay(1000, 2000); // let animations finish

                return await extractCaseDataFuzzy(page);
            } else {
                console.log(`[CNR Search] Invalid CAPTCHA or Data not found. Refreshing CAPTCHA...`);
                await page.click('#captcha_refresh'); // Refresh captcha image
                await delay(1500, 3000);
                await page.$eval('#fcaptcha_code', el => el.value = ''); // Clear input
            }
        } catch (e) {
            console.log(`[CNR Search] Timeout waiting for response, retrying...`);
            await page.reload({ waitUntil: 'networkidle2' });
        }
    }
    throw new Error("Failed to extract data via CNR after maximum retries.");
}

/**
 * Workflow 2: Missing CNR Fallback (Case Number Search)
 * Navigates state -> district -> complex -> case type -> number -> year
 */
async function scrapeByCaseNumber(page, params) {
    console.log(`[Fallback] CNR Missing. Starting complex DOM traversal for: ${params.caseNumber}`);
    const CASE_STATUS_URL = `${ECOURTS_BASE_URL}?app=r_cs`;
    await page.goto(CASE_STATUS_URL, { waitUntil: 'networkidle2' });

    // Step 1: Select State, District, Complex
    // Note: eCourts heavily relies on AJAX for these dropdowns. We must wait for network idle after each select.
    await page.select('#sess_state_code', params.stateCode);
    await delay(1000, 2000);
    await page.select('#sess_dist_code', params.districtCode);
    await delay(1000, 2000);
    await page.select('#court_complex_code', params.courtComplexCode);
    await delay(1000, 2000);

    // Click on "Case Number" tab
    await page.click('#radPtype2');
    await delay(1000, 2000);

    let success = false;
    let retries = 0;

    while (!success && retries < 5) {
        retries++;
        // Input Case Details
        await page.select('#case_type', params.caseTypeCode);
        await page.type('#search_case_no', params.caseNumber);
        await page.type('#search_year', params.year);

        // Solve CAPTCHA
        const captchaText = await solveCaptcha(page, '#captcha_image');
        await page.type('#captcha', captchaText);
        
        await page.click('#submit1'); // Search button for Case Number

        // Wait for result table or error
        try {
            const result = await Promise.race([
                page.waitForSelector('#showList2', { timeout: 8000 }).then(() => 'success'),
                page.waitForFunction(() => document.querySelector('#errspan').innerText.length > 0, { timeout: 8000 }).then(() => 'error')
            ]);

            if (result === 'success') {
                success = true;
                console.log(`[Fallback] Case found! Extracting CNR...`);
                // Witty Algorithm: Extract the hidden CNR from the View button
                const cnrNumber = await page.evaluate(() => {
                    const viewBtn = document.querySelector('a[onclick*="viewHistory"]');
                    if(viewBtn) {
                        // Extracts CNR from onclick="viewHistory('MHPU010001232025',...)"
                        const match = viewBtn.getAttribute('onclick').match(/'([A-Z0-9]{16})'/);
                        return match ? match[1] : null;
                    }
                    return null;
                });

                if (cnrNumber) {
                    console.log(`[Fallback] Successfully recovered CNR: ${cnrNumber}. Switching to CNR scraping...`);
                    // Now that we have the CNR, we can use the much more reliable CNR scraping method
                    return await scrapeByCNR(page, cnrNumber);
                } else {
                    throw new Error("Case listed, but unable to parse CNR from the DOM.");
                }
            } else {
                console.log(`[Fallback] CAPTCHA failed. Retrying...`);
                await page.click('#captcha_refresh');
                await delay(1000, 2000);
                await page.$eval('#captcha', el => el.value = '');
            }
        } catch (e) {
            console.log(`[Fallback] Timeout, retrying form submission...`);
        }
    }
    throw new Error("Failed to find case by Case Number.");
}

/**
 * WITTY ALGORITHM 4: Smart Cache Invalidation
 * Checks if we ACTUALLY need to scrape. If the next hearing date is in the future,
 * the court hasn't updated anything yet. Return the database cache to save massive resources.
 */
async function isScrapeRequired(userId, matterId, forceRefresh = false) {
    if (forceRefresh) return true;

    // Check Redis Cache First (Blazing Fast)
    const cacheKey = `matter_status:${matterId}`;
    const cachedData = await redis.get(cacheKey);
    
    if (cachedData) {
        const data = JSON.parse(cachedData);
        if (data.nextHearingDate) {
            // Convert DD-MM-YYYY to comparable date
            const [day, month, year] = data.nextHearingDate.split('-');
            const hearingDate = new Date(`${year}-${month}-${day}`);
            const today = new Date();
            
            // If hearing date is in the future, NO NEED TO SCRAPE. Data hasn't changed.
            if (hearingDate >= today) {
                console.log(`[Cache] Next hearing (${data.nextHearingDate}) is in the future. Returning cached data.`);
                return { requireScrape: false, data: data };
            }
        }
    }

    // Check Supabase if Redis missed
    const { data: dbData } = await supabase
        .from('matters')
        .select('case_data, next_hearing_date')
        .eq('id', matterId)
        .eq('user_id', userId)
        .single();

    if (dbData && dbData.next_hearing_date) {
        const hearingDate = new Date(dbData.next_hearing_date);
        if (hearingDate >= new Date()) {
            // Repopulate Redis and return
            await redis.setex(cacheKey, 86400, JSON.stringify(dbData.case_data)); // Cache for 24h
            return { requireScrape: false, data: dbData.case_data };
        }
    }

    return { requireScrape: true, data: null };
}

/**
 * Main API Route Handler
 * POST /api/scrape
 * Body: { userId, matterId, cnrNumber (optional), fallbackParams (optional), forceRefresh }
 */
export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    const { userId, matterId, cnrNumber, fallbackParams, forceRefresh } = req.body;

    if (!userId || !matterId) {
        return res.status(400).json({ error: 'Missing required tracking fields (userId, matterId).' });
    }
    if (!cnrNumber && !fallbackParams) {
        return res.status(400).json({ error: 'Must provide either cnrNumber or fallbackParams (state, district, case number, etc).' });
    }

    // 1. Check Smart Cache
    const cacheCheck = await isScrapeRequired(userId, matterId, forceRefresh);
    if (!cacheCheck.requireScrape) {
        return res.status(200).json({
            source: 'cache',
            message: 'Hearing date in future. Cached data returned to save resources.',
            data: cacheCheck.data
        });
    }

    // 2. Initialize Headless Browser (Launch only when necessary)
    console.log(`[Scraper] Launching Puppeteer Stealth for Matter: ${matterId}`);
    let browser;
    try {
        browser = await puppeteer.launch({
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--disable-gpu',
                '--window-size=1920x1080',
            ]
        });

        const page = await browser.newPage();
        
        // Randomize User Agent slightly
        await page.setUserAgent(`Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${Math.floor(Math.random() * 20) + 100}.0.0.0 Safari/537.36`);
        
        await optimizePageLoad(page);

        let extractedData = null;

        // 3. Execute Scrape Workflow
        if (cnrNumber && cnrNumber.length === 16) {
            extractedData = await scrapeByCNR(page, cnrNumber);
        } else if (fallbackParams) {
            extractedData = await scrapeByCaseNumber(page, fallbackParams);
        }

        // 4. Update Database and Cache
        if (extractedData) {
            console.log(`[Scraper] Success. Syncing to Supabase and Upstash Redis...`);
            
            // Format Next Hearing Date for Supabase Date column (DD-MM-YYYY to YYYY-MM-DD)
            let formattedNextHearing = null;
            if (extractedData.nextHearingDate) {
                const [d, m, y] = extractedData.nextHearingDate.split('-');
                formattedNextHearing = `${y}-${m}-${d}`;
            }

            // Sync to Supabase
            const { error: dbError } = await supabase
                .from('matters')
                .update({
                    case_data: extractedData,
                    status: extractedData.status,
                    next_hearing_date: formattedNextHearing,
                    last_synced_at: new Date().toISOString()
                })
                .eq('id', matterId)
                .eq('user_id', userId);

            if (dbError) console.error(`[Supabase Sync Error]:`, dbError);

            // Sync to Upstash Redis (Cache for 24 hours)
            await redis.setex(`matter_status:${matterId}`, 86400, JSON.stringify(extractedData));

            return res.status(200).json({
                source: 'live_scrape',
                message: 'Successfully scraped and updated court data.',
                data: extractedData
            });
        }

    } catch (error) {
        console.error(`[Scraper Error] Fatal:`, error);
        return res.status(500).json({
            error: 'Failed to scrape court data.',
            details: error.message
        });
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}
