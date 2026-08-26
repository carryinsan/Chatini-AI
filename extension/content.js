/**
 * AI Browser Agent - Resilient Content Script
 * Manifest V3 DOM Execution & Context Engine
 * 
 * Features:
 * - Shadow DOM traversal & deep element querying
 * - 8-Tier Heuristic & NLP Token Matching (Synonyms, Labels, ARIA, TestIDs)
 * - Framework-compatible state manipulation (React/Vue/Angular native property setters)
 * - Rich-text / ContentEditable / Shadow input dispatching
 * - Comprehensive Page State & DOM Structure Extractor
 */

(() => {
  // Prevent duplicate script execution
  if (window.__AI_AGENT_CONTENT_SCRIPT_INITIALIZED__) return;
  window.__AI_AGENT_CONTENT_SCRIPT_INITIALIZED__ = true;

  // Maximum character caps for token safety & fast extraction
  const MAX_TEXT_EXTRACT_LENGTH = 5000;
  const MAX_INTERACTIVE_ELEMENTS = 50;

  const INTERACTIVE_SELECTOR = [
    'input',
    'textarea',
    'select',
    'button',
    'a[href]',
    '[contenteditable="true"]',
    '[contenteditable=""]',
    '[role="button"]',
    '[role="link"]',
    '[role="searchbox"]',
    '[role="combobox"]',
    '[role="textbox"]',
    '[role="checkbox"]',
    '[role="radio"]',
    '[role="tab"]',
    '[role="menuitem"]',
    '[tabindex]:not([tabindex="-1"])'
  ].join(', ');

  // Common synonym map for robust fuzzy matching
  const SYNONYMS = {
    search: ['search', 'find', 'query', 'lookup', 'explore', 'q', 'search_query', 'keywords'],
    submit: ['submit', 'enter', 'send', 'confirm', 'apply', 'go', 'save', 'post'],
    cart: ['cart', 'basket', 'bag', 'trolley', 'checkout'],
    login: ['login', 'sign in', 'log in', 'signin', 'auth', 'account'],
    signup: ['sign up', 'signup', 'register', 'create account', 'join']
  };

  // --- 1. DEEP DOM & SHADOW DOM TRAVERSAL ---

  /**
   * Recursively traverses open Shadow DOM roots to retrieve all matching elements.
   */
  function deepQuerySelectorAll(root = document, selector = INTERACTIVE_SELECTOR) {
    const results = [];

    function traverse(node) {
      if (!node) return;

      if (node.querySelectorAll) {
        try {
          const matched = node.querySelectorAll(selector);
          for (let i = 0; i < matched.length; i++) {
            results.push(matched[i]);
          }
        } catch {}
      }

      // Traverse children for potential Shadow Roots
      const children = node.children || [];
      for (let i = 0; i < children.length; i++) {
        const child = children[i];
        if (child.shadowRoot) {
          traverse(child.shadowRoot);
        }
        traverse(child);
      }
    }

    traverse(root);
    return Array.from(new Set(results));
  }

  // --- 2. ELEMENT GEOMETRY & VISIBILITY EVALUATOR ---

  function cleanText(text) {
    if (!text || typeof text !== 'string') return '';
    return text.replace(/\s+/g, ' ').trim();
  }

  function isElementVisible(el) {
    if (!el || !(el instanceof Element)) return false;

    // Fast check
    if (el.offsetWidth === 0 && el.offsetHeight === 0 && !el.getClientRects().length) {
      return false;
    }

    const style = window.getComputedStyle(el);
    if (
      style.display === 'none' ||
      style.visibility === 'hidden' ||
      style.opacity === '0' ||
      style.pointerEvents === 'none'
    ) {
      return false;
    }

    const rect = el.getBoundingClientRect();
    if (rect.width <= 1 || rect.height <= 1) return false;

    // Check if element is within document render bounds
    if (rect.bottom < 0 || rect.top > (window.innerHeight || document.documentElement.clientHeight) * 4) {
      // Still allow scrolling targets within reasonable document flow
    }

    return true;
  }

  /**
   * Discovers associated text from <label for="..."> or parent <label>
   */
  function getAssociatedLabelText(el) {
    let labelText = '';

    // 1. Explicit <label for="id">
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) labelText += ' ' + label.innerText;
    }

    // 2. Wrapping <label>
    const parentLabel = el.closest('label');
    if (parentLabel) {
      labelText += ' ' + parentLabel.innerText;
    }

    // 3. ARIA labelledby
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const ids = labelledBy.split(/\s+/);
      ids.forEach((id) => {
        const refEl = document.getElementById(id);
        if (refEl) labelText += ' ' + refEl.innerText;
      });
    }

    return cleanText(labelText);
  }

  // --- 3. ADVANCED HEURISTIC TARGETING ENGINE ---

  function tokenize(str) {
    return cleanText(str)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 1);
  }

  function scoreTokenOverlap(targetTokens, candidateText) {
    if (!targetTokens.length || !candidateText) return 0;
    const candidateLower = candidateText.toLowerCase();
    let matches = 0;

    for (const token of targetTokens) {
      if (candidateLower.includes(token)) {
        matches++;
      }
    }
    return (matches / targetTokens.length) * 100;
  }

  /**
   * Multi-Tier element resolution algorithm
   */
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
    if (!candidates.length) return null;

    let bestMatch = null;
    let bestScore = -1;

    // Check for search intent in request
    const isSearchIntent =
      searchTargetTokens.some((t) => SYNONYMS.search.includes(t)) ||
      rawRole.toLowerCase().includes('search') ||
      rawDesc.toLowerCase().includes('search');

    for (const el of candidates) {
      let score = 0;
      const tagName = el.tagName.toLowerCase();
      const elType = cleanText(el.getAttribute('type') || '').toLowerCase();
      const elRole = cleanText(el.getAttribute('role') || tagName).toLowerCase();
      const elPlaceholder = cleanText(el.getAttribute('placeholder') || '');
      const elAriaLabel = cleanText(el.getAttribute('aria-label') || el.getAttribute('title') || '');
      const elName = cleanText(el.getAttribute('name') || '');
      const elId = cleanText(el.id || '');
      const elClass = cleanText(el.className || '');
      const elText = cleanText(el.innerText || el.textContent || '');
      const elValue = cleanText(el.value || '');
      const labelText = getAssociatedLabelText(el);

      const combinedIdentity = `${elPlaceholder} ${elAriaLabel} ${labelText} ${elName} ${elId} ${elClass}`;

      // TIER 2: Exact Placeholder / Aria-label Match
      if (rawPlaceholder && elPlaceholder.toLowerCase() === rawPlaceholder.toLowerCase()) {
        score += 150;
      }
      if (rawDesc && elAriaLabel.toLowerCase() === rawDesc.toLowerCase()) {
        score += 140;
      }

      // TIER 3: Exact InnerText match (Buttons / Links)
      if (rawDesc && elText.toLowerCase() === rawDesc.toLowerCase()) {
        score += 120;
      }

      // TIER 4: Token Overlap across Semantic Labels
      const semanticScore = scoreTokenOverlap(searchTargetTokens, `${combinedIdentity} ${elText}`);
      score += semanticScore;

      // TIER 5: Input Type & Role Alignment
      if (rawRole && (elRole === rawRole.toLowerCase() || (rawRole === 'button' && tagName === 'button'))) {
        score += 40;
      }

      // TIER 6: Intelligent Search Bar Heuristic Booster
      if (isSearchIntent && (tagName === 'input' || tagName === 'textarea' || el.isContentEditable)) {
        if (elType === 'search' || elRole === 'searchbox') score += 80;
        if (SYNONYMS.search.some((s) => combinedIdentity.toLowerCase().includes(s))) score += 70;
        if (['q', 'query', 'search', 's', 'field-keywords'].includes(elName.toLowerCase())) score += 60;
        if (elPlaceholder.toLowerCase().includes('search')) score += 50;
      }

      // TIER 7: Test IDs (QA, Cypress, Playwright hooks)
      const testId = el.getAttribute('data-testid') || el.getAttribute('data-cy') || el.getAttribute('data-qa');
      if (testId && rawDesc && testId.toLowerCase().includes(rawDesc.toLowerCase())) {
        score += 90;
      }

      if (score > bestScore) {
        bestScore = score;
        bestMatch = el;
      }
    }

    // TIER 8: Emergency Fallback for Universal Inputs if Search is targeted
    if (!bestMatch || bestScore < 20) {
      if (isSearchIntent) {
        const fallbackSearchInput = candidates.find((el) => {
          const t = el.tagName.toLowerCase();
          const type = (el.getAttribute('type') || '').toLowerCase();
          return (t === 'input' && (type === 'text' || type === 'search' || !type)) || el.isContentEditable;
        });
        if (fallbackSearchInput) return fallbackSearchInput;
      }
    }

    return bestScore >= 20 ? bestMatch : null;
  }

  // --- 4. ACTION EXECUTORS & REACT/FRAMEWORK STATE SETTERS ---

  function highlightElement(el) {
    if (!el || !el.style) return;
    const prevOutline = el.style.outline;
    const prevTransition = el.style.transition;
    el.style.transition = 'outline 0.15s ease-in-out';
    el.style.outline = '3px solid #3b82f6';
    setTimeout(() => {
      el.style.outline = prevPrevSafe(prevOutline);
      el.style.transition = prevPrevSafe(prevTransition);
    }, 1200);
  }

  function prevPrevSafe(val) {
    return val !== undefined ? val : '';
  }

  /**
   * Sets value using native HTML prototype descriptors to bypass React/Vue synthetic wrapper traps
   */
  function setNativeInputValue(element, value) {
    const isTextArea = element.tagName.toLowerCase() === 'textarea';
    const prototype = isTextArea ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(prototype, 'value');

    if (descriptor && descriptor.set) {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
  }

  async function executeClick(target) {
    const el = findElementByTarget(target);
    if (!el) {
      return { ok: false, error: `Interactive element not found for target: ${JSON.stringify(target)}` };
    }

    highlightElement(el);
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    await new Promise((r) => setTimeout(r, 150));

    // Full synthetic pointer and mouse event dispatch sequence
    const eventOptions = { bubbles: true, cancelable: true, view: window };
    el.focus();
    el.dispatchEvent(new PointerEvent('pointerdown', eventOptions));
    el.dispatchEvent(new MouseEvent('mousedown', eventOptions));
    el.dispatchEvent(new PointerEvent('pointerup', eventOptions));
    el.dispatchEvent(new MouseEvent('mouseup', eventOptions));
    el.click();

    return { ok: true, clicked: true, tag: el.tagName.toLowerCase() };
  }

  async function executeType(target, text, clear = true) {
    const el = findElementByTarget(target);
    if (!el) {
      return { ok: false, error: `Input target not found for: ${JSON.stringify(target)}` };
    }

    highlightElement(el);
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.focus();

    // Support Rich-Text & ContentEditable elements
    if (el.isContentEditable || el.getAttribute('contenteditable') === 'true') {
      if (clear) el.innerHTML = '';
      document.execCommand('insertText', false, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, typedLength: text.length, contentEditable: true };
    }

    const currentVal = clear ? '' : el.value || '';
    const nextVal = currentVal + text;

    setNativeInputValue(el, nextVal);

    // Dispatch full input event chain
    el.dispatchEvent(new Event('input', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new Event('change', { bubbles: true, cancelable: true }));
    el.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', code: 'Enter' }));

    return { ok: true, typedLength: text.length, field: el.name || el.id || el.tagName.toLowerCase() };
  }

  async function executeSelect(target, value) {
    const el = findElementByTarget(target);
    if (!el || el.tagName.toLowerCase() !== 'select') {
      return { ok: false, error: 'Target is not a valid <select> dropdown element' };
    }

    highlightElement(el);
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { ok: true, selectedValue: value };
  }

  function executeScroll(direction = 'down', amount = 600) {
    const scrollAmount = Number(amount) || 600;
    switch (direction) {
      case 'up':
        window.scrollBy({ top: -scrollAmount, behavior: 'smooth' });
        break;
      case 'down':
        window.scrollBy({ top: scrollAmount, behavior: 'smooth' });
        break;
      case 'top':
        window.scrollTo({ top: 0, behavior: 'smooth' });
        break;
      case 'bottom':
        window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
        break;
    }
    return { ok: true, scrolled: direction };
  }

  function executeExtract(target) {
    if (target) {
      const el = findElementByTarget(target);
      if (!el) {
        return { ok: false, error: 'Target element for extraction not located' };
      }
      return {
        ok: true,
        extracted: {
          text: cleanText(el.innerText || el.textContent || ''),
          value: el.value || null,
          attributes: {
            href: el.getAttribute('href') || null,
            src: el.getAttribute('src') || null
          }
        }
      };
    }

    return { ok: true, extracted: extractPageState() };
  }

  // --- 5. COMPACT PAGE STATE EXTRACTOR ---

  function extractPageState() {
    const title = document.title || '';
    const url = window.location.href;

    const headings = Array.from(document.querySelectorAll('h1, h2, h3'))
      .filter(isElementVisible)
      .slice(0, 10)
      .map((h) => cleanText(h.innerText))
      .filter(Boolean);

    const candidates = deepQuerySelectorAll(document, INTERACTIVE_SELECTOR).filter(isElementVisible);

    const interactiveElements = candidates.slice(0, MAX_INTERACTIVE_ELEMENTS).map((el, index) => {
      const text = cleanText(
        el.innerText ||
        el.textContent ||
        el.value ||
        el.getAttribute('aria-label') ||
        el.getAttribute('placeholder') ||
        getAssociatedLabelText(el) ||
        ''
      );

      return {
        index,
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute('type') || null,
        role: el.getAttribute('role') || null,
        placeholder: el.getAttribute('placeholder') || null,
        text: text.slice(0, 70),
        id: el.id || null,
        name: el.getAttribute('name') || null
      };
    });

    const rawBodyText = cleanText(document.body ? document.body.innerText : '');
    const visibleText = rawBodyText.slice(0, MAX_TEXT_EXTRACT_LENGTH);

    return {
      title,
      url,
      headings,
      interactiveElements,
      visibleText,
      totalTextLength: rawBodyText.length
    };
  }

  // --- 6. PROACTIVE EVENT MONITOR ---

  let lastNotificationTime = 0;
  function setupProactiveObserver() {
    const observer = new MutationObserver(() => {
      const now = Date.now();
      if (now - lastNotificationTime < 25000) return;

      const alertEl = document.querySelector('[role="alert"], .toast, .notification, .alert-box');
      if (alertEl && isElementVisible(alertEl)) {
        const text = cleanText(alertEl.innerText);
        if (text.length > 5) {
          lastNotificationTime = now;
          chrome.runtime.sendMessage({
            type: 'DISPATCH_DOM_EVENT',
            event: {
              type: 'page_alert_detected',
              hostname: window.location.hostname,
              identifier: text.slice(0, 40),
              snippet: text.slice(0, 120),
              url: window.location.href
            }
          }).catch(() => {});
        }
      }
    });

    observer.observe(document.documentElement || document.body, {
      childList: true,
      subtree: true
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', setupProactiveObserver);
  } else {
    setupProactiveObserver();
  }

  // --- 7. MESSAGE ROUTING ---

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) {
      sendResponse({ ok: false, error: 'Invalid payload structure' });
      return false;
    }

    if (message.type === 'EXTRACT_PAGE_STATE') {
      try {
        const state = extractPageState();
        sendResponse({ ok: true, pageState: state });
      } catch (err) {
        sendResponse({ ok: false, error: `DOM extraction error: ${err.message}` });
      }
      return false;
    }

    if (message.type === 'EXECUTE_ACTION') {
      const action = message.action;
      if (!action || !action.type) {
        sendResponse({ ok: false, error: 'Missing action payload or type' });
        return false;
      }

      (async () => {
        try {
          switch (action.type) {
            case 'click':
              return await executeClick(action.target);
            case 'type':
              return await executeType(action.target, action.text || '', action.clear !== false);
            case 'select':
              return await executeSelect(action.target, action.value);
            case 'scroll':
              return executeScroll(action.direction, action.amount);
            case 'extract':
            case 'read_page':
              return executeExtract(action.target);
            case 'go_back':
              window.history.back();
              return { ok: true, action: 'go_back' };
            default:
              return { ok: false, error: `Action ${action.type} is not implemented in content.js` };
          }
        } catch (err) {
          return { ok: false, error: `Execution exception: ${err.message}` };
        }
      })().then((result) => sendResponse(result));

      return true; // Keep message channel open for async execution
    }

    sendResponse({ ok: false, error: `Unknown content script message: ${message.type}` });
    return false;
  });
})();
