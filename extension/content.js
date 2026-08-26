/**
 * AI Browser Agent - Resilient Content Script
 * Manifest V3 DOM Execution & Context Engine
 * 
 * Features:
 * - 9-Tier Heuristic Engine + NLP Token Matching
 * - "Jugaad" Intent Bypass: Auto-extracts URLs from failed click targets and forces navigation
 * - Shadow DOM traversal & Deep TreeWalker Text Node Extraction
 * - Framework-compatible state manipulation (React/Vue/Angular)
 * - Anti-Overlay Phantom Clicking
 */

(() => {
  if (window.__AI_AGENT_CONTENT_SCRIPT_INITIALIZED__) return;
  window.__AI_AGENT_CONTENT_SCRIPT_INITIALIZED__ = true;

  const MAX_TEXT_EXTRACT_LENGTH = 6000;
  const MAX_INTERACTIVE_ELEMENTS = 75;

  const INTERACTIVE_SELECTOR = [
    'a[href]', 'button', 'input', 'textarea', 'select', 
    '[contenteditable="true"]', '[contenteditable=""]', 
    '[role="button"]', '[role="link"]', '[role="searchbox"]', 
    '[role="combobox"]', '[role="textbox"]', '[role="menuitem"]',
    '[tabindex]:not([tabindex="-1"])',
    'summary', // Often used as clickable toggles
    'label'    // Often wraps hidden checkboxes/radios
  ].join(', ');

  const SYNONYMS = {
    search: ['search', 'find', 'query', 'lookup', 'explore', 'q', 'search_query'],
    submit: ['submit', 'enter', 'send', 'confirm', 'apply', 'go', 'save', 'post'],
    cart: ['cart', 'basket', 'bag', 'trolley', 'checkout'],
    login: ['login', 'sign in', 'log in', 'signin', 'auth', 'account'],
    console: ['console', 'dashboard', 'portal', 'admin', 'manage']
  };

  // --- 1. DEEP DOM & TEXT TRAVERSAL ---

  function deepQuerySelectorAll(root = document, selector = INTERACTIVE_SELECTOR) {
    const results = [];
    function traverse(node) {
      if (!node) return;
      if (node.querySelectorAll) {
        try {
          const matched = node.querySelectorAll(selector);
          for (let i = 0; i < matched.length; i++) results.push(matched[i]);
        } catch {}
      }
      const children = node.children || [];
      for (let i = 0; i < children.length; i++) {
        if (children[i].shadowRoot) traverse(children[i].shadowRoot);
        traverse(children[i]);
      }
    }
    traverse(root);
    return Array.from(new Set(results));
  }

  function findElementByTextWalker(searchText) {
    if (!searchText) return null;
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
    let node;
    const lowerSearch = searchText.toLowerCase();
    
    while ((node = walker.nextNode())) {
      if (node.nodeValue && node.nodeValue.toLowerCase().includes(lowerSearch)) {
        let parent = node.parentElement;
        while (parent && parent !== document.body) {
          if (parent.tagName === 'A' || parent.tagName === 'BUTTON' || parent.getAttribute('role') === 'link') {
            return parent;
          }
          parent = parent.parentElement;
        }
      }
    }
    return null;
  }

  // --- 2. ELEMENT GEOMETRY & VISIBILITY ---

  function cleanText(text) {
    if (!text || typeof text !== 'string') return '';
    return text.replace(/\s+/g, ' ').trim();
  }

  function isElementVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    
    const rect = el.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) {
      // Check if it has visible overflowing children (common in React styled-components)
      if (el.scrollWidth > 1 || el.scrollHeight > 1) return true;
      return false;
    }
    return true;
  }

  function getAssociatedLabelText(el) {
    let labelText = '';
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) labelText += ' ' + label.innerText;
    }
    const parentLabel = el.closest('label');
    if (parentLabel) labelText += ' ' + parentLabel.innerText;
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      labelledBy.split(/\s+/).forEach((id) => {
        const refEl = document.getElementById(id);
        if (refEl) labelText += ' ' + refEl.innerText;
      });
    }
    return cleanText(labelText);
  }

  // --- 3. HEURISTIC TARGETING ENGINE ---

  function tokenize(str) {
    return cleanText(str).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t.length > 2);
  }

  function scoreTokenOverlap(targetTokens, candidateText) {
    if (!targetTokens.length || !candidateText) return 0;
    const candidateLower = candidateText.toLowerCase();
    let matches = 0;
    for (const token of targetTokens) {
      if (candidateLower.includes(token)) matches++;
    }
    return (matches / targetTokens.length) * 100;
  }

  function extractUrlJugaad(targetString) {
    // Extracts URLs embedded in arbitrary text or CSS selectors
    const urlRegex = /(https?:\/\/[^\s'"]+)/i;
    const match = targetString.match(urlRegex);
    return match ? match[1] : null;
  }

  function findElementByTarget(target) {
    if (!target) return null;

    // TIER 1: Direct CSS Selector
    if (target.selector && typeof target.selector === 'string' && target.selector.trim() !== '') {
      try {
        const directEl = document.querySelector(target.selector);
        if (directEl && isElementVisible(directEl)) return directEl;
      } catch {}
    }

    const rawDesc = cleanText(target.description || target.text || '');
    const rawRole = cleanText(target.role || '');
    const rawPlaceholder = cleanText(target.placeholder || '');
    const searchTargetTokens = tokenize(`${rawDesc} ${rawPlaceholder} ${rawRole}`);

    const candidates = deepQuerySelectorAll(document, INTERACTIVE_SELECTOR).filter(isElementVisible);
    
    let bestMatch = null;
    let bestScore = -1;

    for (const el of candidates) {
      let score = 0;
      const tagName = el.tagName.toLowerCase();
      const elRole = cleanText(el.getAttribute('role') || tagName).toLowerCase();
      const elAriaLabel = cleanText(el.getAttribute('aria-label') || el.getAttribute('title') || '');
      const elIdClass = (el.id + ' ' + el.className).toLowerCase();
      const elText = cleanText(el.innerText || el.textContent || '');
      const elHref = cleanText(el.getAttribute('href') || '');
      const combinedIdentity = `${elAriaLabel} ${getAssociatedLabelText(el)} ${elIdClass} ${elHref}`;

      // TIER 2: Exact Text Match
      if (rawDesc && elText.toLowerCase() === rawDesc.toLowerCase()) score += 150;
      
      // TIER 3: Partial Href Match (URL Routing)
      if (target.selector && target.selector.includes('href') && elHref) {
        const targetUrl = extractUrlJugaad(target.selector);
        if (targetUrl && elHref.includes(targetUrl.replace(/^https?:\/\//, ''))) score += 140;
      }

      // TIER 4: Token Overlap
      score += scoreTokenOverlap(searchTargetTokens, `${combinedIdentity} ${elText}`);

      // TIER 5: Semantic Role
      if (rawRole && elRole.includes(rawRole.toLowerCase())) score += 30;

      // TIER 6: Cloud/Console Specific Heuristics
      if (searchTargetTokens.some(t => SYNONYMS.console.includes(t)) && (elHref.includes('console') || elHref.includes('admin'))) {
        score += 80;
      }

      if (score > bestScore) {
        bestScore = score;
        bestMatch = el;
      }
    }

    // TIER 7: Deep Text Node Crawler (Bypass Shadow DOM limits)
    if (!bestMatch || bestScore < 25) {
      const crawlerMatch = findElementByTextWalker(rawDesc);
      if (crawlerMatch) return crawlerMatch;
    }

    return bestScore >= 20 ? bestMatch : null;
  }

  // --- 4. ACTION EXECUTORS & "JUGAAD" FALLBACKS ---

  function highlightElement(el) {
    if (!el || !el.style) return;
    const prevOutline = el.style.outline;
    el.style.outline = '4px solid #f59e0b'; // Amber warning color for interaction
    setTimeout(() => { el.style.outline = prevOutline || ''; }, 1000);
  }

  function setNativeInputValue(element, value) {
    const prototype = element.tagName.toLowerCase() === 'textarea' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');
    if (descriptor && descriptor.set) {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
  }

  async function executeClick(target) {
    const el = findElementByTarget(target);
    
    // TIER 9: JUGAAD INTENT BYPASS
    if (!el) {
      const hiddenUrl = extractUrlJugaad(JSON.stringify(target));
      if (hiddenUrl) {
        console.warn(`[AI Jugaad] Element not found. Bypassing DOM and force-navigating to: ${hiddenUrl}`);
        window.location.assign(hiddenUrl);
        return { ok: true, clicked: false, fallbackNavigation: true, url: hiddenUrl };
      }
      return { ok: false, error: `Interactive element not found for target: ${JSON.stringify(target)}` };
    }

    highlightElement(el);
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await new Promise((r) => setTimeout(r, 100));

    // Anti-Overlay Phantom Click (Bypass Z-Index Modals)
    const eventOptions = { bubbles: true, cancelable: true, view: window };
    el.focus();
    el.dispatchEvent(new PointerEvent('pointerdown', eventOptions));
    el.dispatchEvent(new MouseEvent('mousedown', eventOptions));
    el.dispatchEvent(new PointerEvent('pointerup', eventOptions));
    el.dispatchEvent(new MouseEvent('mouseup', eventOptions));
    
    try {
      el.click();
    } catch {
      // If .click() throws (e.g. cross-origin iframe security on SVG), trigger manual routing if it's an anchor
      if (el.tagName.toLowerCase() === 'a' && el.href) {
        window.location.assign(el.href);
      }
    }

    return { ok: true, clicked: true, tag: el.tagName.toLowerCase(), text: cleanText(el.innerText).substring(0, 30) };
  }

  async function executeType(target, text, clear = true) {
    const el = findElementByTarget(target);
    if (!el) return { ok: false, error: `Input target not found for: ${JSON.stringify(target)}` };

    highlightElement(el);
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.focus();

    if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') {
      if (clear) el.innerHTML = '';
      document.execCommand('insertText', false, text);
    } else {
      const nextVal = (clear ? '' : el.value || '') + text;
      setNativeInputValue(el, nextVal);
    }

    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', code: 'Enter' }));

    return { ok: true, typedLength: text.length };
  }

  async function executeSelect(target, value) {
    const el = findElementByTarget(target);
    if (!el || el.tagName.toLowerCase() !== 'select') return { ok: false, error: 'Target is not a valid <select>' };
    
    highlightElement(el);
    el.value = value;
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, selectedValue: value };
  }

  function executeScroll(direction = 'down', amount = 600) {
    const amt = Number(amount) || 600;
    const ops = { behavior: 'smooth' };
    if (direction === 'up') window.scrollBy({ top: -amt, ...ops });
    else if (direction === 'down') window.scrollBy({ top: amt, ...ops });
    else if (direction === 'top') window.scrollTo({ top: 0, ...ops });
    else if (direction === 'bottom') window.scrollTo({ top: document.body.scrollHeight, ...ops });
    return { ok: true, scrolled: direction };
  }

  function executeExtract(target) {
    if (target) {
      const el = findElementByTarget(target);
      if (!el) return { ok: false, error: 'Target element for extraction not located' };
      return {
        ok: true,
        extracted: {
          text: cleanText(el.innerText || el.textContent || ''),
          value: el.value || null,
          attributes: { href: el.getAttribute('href'), src: el.getAttribute('src') }
        }
      };
    }
    return { ok: true, extracted: extractPageState() };
  }

  // --- 5. COMPACT PAGE STATE EXTRACTOR ---

  function extractPageState() {
    const candidates = deepQuerySelectorAll(document, INTERACTIVE_SELECTOR).filter(isElementVisible);
    const interactiveElements = candidates.slice(0, MAX_INTERACTIVE_ELEMENTS).map((el, index) => {
      return {
        index,
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || null,
        role: el.getAttribute('role') || null,
        text: cleanText(el.innerText || el.value || el.getAttribute('aria-label') || getAssociatedLabelText(el)).slice(0, 70),
        href: el.getAttribute('href') || null
      };
    });

    return {
      title: document.title || '',
      url: window.location.href,
      interactiveElements,
      visibleText: cleanText(document.body ? document.body.innerText : '').slice(0, MAX_TEXT_EXTRACT_LENGTH)
    };
  }

  // --- 6. MESSAGE ROUTING ---

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) {
      sendResponse({ ok: false, error: 'Invalid payload structure' });
      return false;
    }

    if (message.type === 'EXTRACT_PAGE_STATE') {
      try {
        sendResponse({ ok: true, pageState: extractPageState() });
      } catch (err) {
        sendResponse({ ok: false, error: `DOM extraction error: ${err.message}` });
      }
      return false;
    }

    if (message.type === 'EXECUTE_ACTION') {
      (async () => {
        try {
          switch (message.action.type) {
            case 'click': return await executeClick(message.action.target);
            case 'type': return await executeType(message.action.target, message.action.text || '', message.action.clear !== false);
            case 'select': return await executeSelect(message.action.target, message.action.value);
            case 'scroll': return executeScroll(message.action.direction, message.action.amount);
            case 'extract':
            case 'read_page': return executeExtract(message.action.target);
            case 'go_back': window.history.back(); return { ok: true, action: 'go_back' };
            default: return { ok: false, error: `Unknown action: ${message.action.type}` };
          }
        } catch (err) {
          return { ok: false, error: `Execution exception: ${err.message}` };
        }
      })().then(sendResponse);
      return true; // Keep open for async
    }
  });
})();
