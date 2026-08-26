/**
 * AI Browser Agent - Resilient Content Script
 * Includes the "JUGAAD" Protocol for heuristic intent-matching
 */

(() => {
  if (window.__AI_AGENT_CONTENT_SCRIPT_INITIALIZED__) return;
  window.__AI_AGENT_CONTENT_SCRIPT_INITIALIZED__ = true;

  const MAX_TEXT_EXTRACT_LENGTH = 5000;
  const MAX_INTERACTIVE_ELEMENTS = 50;

  const INTERACTIVE_SELECTOR = [
    'input', 'textarea', 'select', 'button', 'a[href]',
    '[contenteditable="true"]', '[role="button"]', '[role="link"]',
    '[role="searchbox"]', '[role="textbox"]', '[tabindex]:not([tabindex="-1"])'
  ].join(', ');

  const SYNONYMS = {
    search: ['search', 'find', 'query', 'lookup', 'explore', 'q', 'search_query'],
    submit: ['submit', 'enter', 'send', 'confirm', 'apply', 'go'],
  };

  // --- 1. CORE DOM UTILITIES ---

  function cleanText(text) {
    if (!text || typeof text !== 'string') return '';
    return text.replace(/\s+/g, ' ').trim();
  }

  function isElementVisible(el) {
    if (!el || !(el instanceof Element)) return false;
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 1 && rect.height > 1;
  }

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

  // --- 2. THE JUGAAD PROTOCOL (ULTIMATE FALLBACK ENGINE) ---

  /**
   * Jugaad 1: Extracts any valid URL pattern from a failed AI target payload
   */
  function extractUrlFromTarget(target) {
    const combinedStr = `${target.selector || ''} ${target.description || ''} ${target.text || ''}`;
    
    // Catch absolute URLs
    const urlMatch = combinedStr.match(/(https?:\/\/[^\s'"]+)/);
    if (urlMatch) return urlMatch[1];
    
    // Catch relative hrefs embedded in selectors (e.g., a[href='/dashboard'])
    const hrefMatch = combinedStr.match(/href=['"]([^'"]+)['"]/);
    if (hrefMatch) {
       try {
         return new URL(hrefMatch[1], window.location.origin).href;
       } catch {
         return null;
       }
    }
    return null;
  }

  /**
   * Jugaad 2: Scans all raw text nodes for a string match, ignoring semantic roles
   */
  function findTextNodeHailMary(text) {
     if (!text) return null;
     const searchStr = cleanText(text).toLowerCase();
     if (searchStr.length < 3) return null;

     // TreeWalker is heavily optimized by the browser engine for text traversal
     const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, null, false);
     let node;
     
     while ((node = walker.nextNode())) {
       if (node.nodeValue && cleanText(node.nodeValue).toLowerCase().includes(searchStr)) {
          const parent = node.parentElement;
          if (parent && parent.tagName !== 'SCRIPT' && parent.tagName !== 'STYLE' && isElementVisible(parent)) {
             return parent;
          }
       }
     }
     return null;
  }

  // --- 3. TARGET RESOLUTION ENGINE ---

  function findElementByTarget(target) {
    if (!target) return null;

    if (target.selector && target.selector.trim() !== '') {
      try {
        const directEl = document.querySelector(target.selector);
        if (directEl && isElementVisible(directEl)) return directEl;
      } catch {}
    }

    const rawDesc = cleanText(target.description || target.text || '').toLowerCase();
    const candidates = deepQuerySelectorAll(document, INTERACTIVE_SELECTOR).filter(isElementVisible);
    
    let bestMatch = null;
    let bestScore = -1;

    for (const el of candidates) {
      let score = 0;
      const elText = cleanText(el.innerText || el.textContent || '').toLowerCase();
      const elAriaLabel = cleanText(el.getAttribute('aria-label') || el.getAttribute('title') || '').toLowerCase();
      
      if (rawDesc && (elText === rawDesc || elAriaLabel === rawDesc)) score += 100;
      else if (rawDesc && (elText.includes(rawDesc) || elAriaLabel.includes(rawDesc))) score += 50;

      if (score > bestScore) {
        bestScore = score;
        bestMatch = el;
      }
    }

    return bestScore >= 40 ? bestMatch : null;
  }

  // --- 4. ACTION EXECUTORS ---

  function highlightElement(el) {
    if (!el || !el.style) return;
    const prevOutline = el.style.outline;
    el.style.outline = '3px solid #10b981'; // Green highlight for success
    setTimeout(() => { el.style.outline = prevOutline || ''; }, 1200);
  }

  async function executeClick(target) {
    let el = findElementByTarget(target);
    let jugaadTriggered = false;

    // 🔥 DEPLOY JUGAAD FALLBACKS 🔥
    if (!el) {
      const hiddenUrl = extractUrlFromTarget(target);
      if (hiddenUrl) {
         window.location.assign(hiddenUrl);
         return { ok: true, clicked: true, jugaad: "Phantom URL Navigation", url: hiddenUrl };
      }

      el = findTextNodeHailMary(target.text || target.description);
      if (!el) {
         return { ok: false, error: `Target not found: ${JSON.stringify(target)}. All heuristics exhausted.` };
      }
      jugaadTriggered = true;
    }

    highlightElement(el);
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await new Promise((r) => setTimeout(r, 150));

    el.focus();
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, cancelable: true }));
    el.click();

    return { ok: true, clicked: true, tag: el.tagName.toLowerCase(), jugaadUsed: jugaadTriggered };
  }

  async function executeType(target, text, clear = true) {
    let el = findElementByTarget(target);
    if (!el) {
      el = findTextNodeHailMary(target.description || target.placeholder);
      if (!el) return { ok: false, error: `Input target not found for: ${JSON.stringify(target)}` };
    }

    highlightElement(el);
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.focus();

    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (setter && el.tagName === 'INPUT') setter.call(el, clear ? text : el.value + text);
    else el.value = clear ? text : el.value + text;

    el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }));

    return { ok: true, typedLength: text.length };
  }

  function executeScroll(direction = 'down', amount = 600) {
    const y = direction === 'up' ? -amount : amount;
    window.scrollBy({ top: y, behavior: 'smooth' });
    return { ok: true, scrolled: direction };
  }

  // --- 5. MESSAGE ROUTING ---

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) return false;

    if (message.type === 'EXTRACT_PAGE_STATE') {
      sendResponse({ ok: true, pageState: { url: window.location.href, title: document.title } });
      return false;
    }

    if (message.type === 'EXECUTE_ACTION') {
      (async () => {
        try {
          switch (message.action.type) {
            case 'click': return await executeClick(message.action.target);
            case 'type': return await executeType(message.action.target, message.action.text || '');
            case 'scroll': return executeScroll(message.action.direction, message.action.amount);
            default: return { ok: false, error: `Unsupported action: ${message.action.type}` };
          }
        } catch (err) {
          return { ok: false, error: err.message };
        }
      })().then(sendResponse);
      return true;
    }
  });
})();
