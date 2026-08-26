/**
 * AI Browser Agent - Content Script
 * Executes validated DOM actions and extracts structured page state.
 * Strictly prohibits eval or arbitrary script execution.
 */

(() => {
  // Prevent multiple injections
  if (window.__AI_AGENT_CONTENT_SCRIPT_LOADED__) return;
  window.__AI_AGENT_CONTENT_SCRIPT_LOADED__ = true;

  // Maximum characters of visible text to extract (Data Minimization)
  const MAX_TEXT_EXTRACT_LENGTH = 4000;
  const INTERACTIVE_SELECTOR = 'button, a, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="radio"], [role="combobox"], [tabindex]:not([tabindex="-1"])';

  /**
   * Helper: Check if an element is visible in the DOM
   */
  function isElementVisible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    const rect = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);

    return (
      rect.width > 0 &&
      rect.height > 0 &&
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      style.opacity !== "0" &&
      el.getAttribute("aria-hidden") !== "true"
    );
  }

  /**
   * Helper: Clean text snippet
   */
  function cleanText(text) {
    if (!text || typeof text !== "string") return "";
    return text.replace(/\s+/g, " ").trim();
  }

  /**
   * Semantic Element Targeting Engine
   * Matches elements based on role, visible text, aria-label, placeholder, and attributes.
   */
  function findElementByTarget(target) {
    if (!target) return null;

    // 1. Direct CSS Selector attempt (if provided and valid)
    if (target.selector && typeof target.selector === "string") {
      try {
        const el = document.querySelector(target.selector);
        if (el && isElementVisible(el)) return el;
      } catch {
        // Invalid selector, fall through to semantic search
      }
    }

    const searchDesc = cleanText(target.description || target.text || "").toLowerCase();
    const searchRole = cleanText(target.role || "").toLowerCase();
    const searchPlaceholder = cleanText(target.placeholder || "").toLowerCase();

    if (!searchDesc && !searchRole && !searchPlaceholder) {
      return null;
    }

    const candidates = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR)).filter(isElementVisible);

    let bestMatch = null;
    let bestScore = 0;

    for (const el of candidates) {
      let score = 0;
      const elText = cleanText(el.innerText || el.textContent || "").toLowerCase();
      const elValue = cleanText(el.value || "").toLowerCase();
      const elAria = cleanText(el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("title") || "").toLowerCase();
      const elRole = cleanText(el.getAttribute("role") || el.tagName.toLowerCase()).toLowerCase();
      const elName = cleanText(el.getAttribute("name") || "").toLowerCase();

      // Exact text match (high confidence)
      if (searchDesc && (elText === searchDesc || elAria === searchDesc || elValue === searchDesc)) {
        score += 100;
      } else if (searchDesc && (elText.includes(searchDesc) || elAria.includes(searchDesc) || elName.includes(searchDesc))) {
        // Substring match
        score += 50;
      }

      // Placeholder match for inputs
      if (searchPlaceholder && (elAria.includes(searchPlaceholder) || elText.includes(searchPlaceholder))) {
        score += 40;
      }

      // Role match
      if (searchRole && (elRole === searchRole || (searchRole === "button" && el.tagName === "BUTTON") || (searchRole === "link" && el.tagName === "A"))) {
        score += 20;
      }

      if (score > bestScore) {
        bestScore = score;
        bestMatch = el;
      }
    }

    // Minimum confidence threshold to prevent clicking random elements
    return bestScore >= 40 ? bestMatch : null;
  }

  /**
   * Extract compact, data-minimized page state
   */
  function extractPageState() {
    const title = document.title || "";
    const url = window.location.href;

    // Collect prominent headings
    const headings = Array.from(document.querySelectorAll("h1, h2, h3"))
      .filter(isElementVisible)
      .slice(0, 10)
      .map((h) => cleanText(h.innerText))
      .filter(Boolean);

    // Collect interactive element summaries
    const interactiveElements = Array.from(document.querySelectorAll(INTERACTIVE_SELECTOR))
      .filter(isElementVisible)
      .slice(0, 35)
      .map((el, index) => {
        const text = cleanText(el.innerText || el.textContent || el.value || el.getAttribute("aria-label") || el.getAttribute("placeholder") || "");
        return {
          index,
          tag: el.tagName.toLowerCase(),
          type: el.getAttribute("type") || null,
          role: el.getAttribute("role") || null,
          text: text.slice(0, 60),
          id: el.id || null
        };
      })
      .filter((item) => item.text.length > 0);

    // Collect bounded visible body text
    const rawBodyText = cleanText(document.body ? document.body.innerText : "");
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

  /**
   * Action: Visual Highlight Indicator (Safe UI feedback)
   */
  function highlightElement(el) {
    if (!el) return;
    const originalOutline = el.style.outline;
    const originalTransition = el.style.transition;
    el.style.transition = "outline 0.2s ease";
    el.style.outline = "3px solid #2563eb";
    setTimeout(() => {
      el.style.outline = originalOutline;
      el.style.transition = originalTransition;
    }, 1200);
  }

  /**
   * Action Executors
   */
  async function executeClick(target) {
    const el = findElementByTarget(target);
    if (!el) {
      return { ok: false, error: `Element not found or confidence too low for target: ${JSON.stringify(target)}` };
    }

    highlightElement(el);
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    await new Promise((r) => setTimeout(r, 200));

    // Dispatch realistic click sequence
    el.focus();
    el.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, cancelable: true }));
    el.click();

    return { ok: true, clicked: true, tagName: el.tagName };
  }

  async function executeType(target, text, clear = true) {
    const el = findElementByTarget(target);
    if (!el) {
      return { ok: false, error: `Input target not found for: ${JSON.stringify(target)}` };
    }

    highlightElement(el);
    el.scrollIntoView({ behavior: "smooth", block: "center" });
    el.focus();

    if (clear) {
      el.value = "";
    }

    // React/Framework compatible native value setter
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set;
    const nativeTextAreaValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;

    if (nativeInputValueSetter && el.tagName === "INPUT") {
      nativeInputValueSetter.call(el, (el.value || "") + text);
    } else if (nativeTextAreaValueSetter && el.tagName === "TEXTAREA") {
      nativeTextAreaValueSetter.call(el, (el.value || "") + text);
    } else {
      el.value = (el.value || "") + text;
    }

    // Dispatch standard change/input events for frameworks listening to bubbling
    el.dispatchEvent(new Event("input", { bubbles: true, cancelable: true }));
    el.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));

    return { ok: true, typedLength: text.length };
  }

  async function executeSelect(target, value) {
    const el = findElementByTarget(target);
    if (!el || el.tagName !== "SELECT") {
      return { ok: false, error: "Target is not a valid <select> element" };
    }

    highlightElement(el);
    el.value = value;
    el.dispatchEvent(new Event("change", { bubbles: true, cancelable: true }));
    return { ok: true, selectedValue: value };
  }

  function executeScroll(direction = "down", amount = 500) {
    switch (direction) {
      case "up":
        window.scrollBy({ top: -amount, behavior: "smooth" });
        break;
      case "down":
        window.scrollBy({ top: amount, behavior: "smooth" });
        break;
      case "top":
        window.scrollTo({ top: 0, behavior: "smooth" });
        break;
      case "bottom":
        window.scrollTo({ top: document.body.scrollHeight, behavior: "smooth" });
        break;
    }
    return { ok: true, scrolled: direction };
  }

  function executeExtract(target) {
    if (target) {
      const el = findElementByTarget(target);
      if (!el) {
        return { ok: false, error: "Target element for extraction not found" };
      }
      return {
        ok: true,
        extracted: {
          text: cleanText(el.innerText || el.textContent || ""),
          value: el.value || null,
          attributes: {
            href: el.getAttribute("href") || null,
            src: el.getAttribute("src") || null
          }
        }
      };
    }

    // Fallback: extract structured page content
    return { ok: true, extracted: extractPageState() };
  }

  /**
   * Safe Action Dispatcher
   */
  async function handleExecuteAction(action) {
    if (!action || !action.type) {
      return { ok: false, error: "Missing action or action type" };
    }

    switch (action.type) {
      case "click":
        return await executeClick(action.target);

      case "type":
        return await executeType(action.target, action.text || "", action.clear !== false);

      case "select":
        return await executeSelect(action.target, action.value);

      case "scroll":
        return executeScroll(action.direction, action.amount);

      case "extract":
      case "read_page":
        return executeExtract(action.target);

      case "go_back":
        window.history.back();
        return { ok: true, action: "go_back" };

      default:
        return { ok: false, error: `Unsupported or unknown action type: ${action.type}` };
    }
  }

  /**
   * Proactive Event Monitoring (Throttled DOM observer)
   */
  let lastNotificationTime = 0;
  const NOTIFICATION_COOLDOWN_MS = 20000;

  function setupProactiveObserver() {
    // Monitor title and price/badge mutations
    const observer = new MutationObserver(() => {
      const now = Date.now();
      if (now - lastNotificationTime < NOTIFICATION_COOLDOWN_MS) return;

      // Detect prominent alert, notification, or price tags
      const alertEl = document.querySelector('[role="alert"], .notification-badge, .price-drop');
      if (alertEl && isElementVisible(alertEl)) {
        const text = cleanText(alertEl.innerText);
        if (text.length > 3) {
          lastNotificationTime = now;
          chrome.runtime.sendMessage({
            type: "DISPATCH_DOM_EVENT",
            event: {
              type: "page_alert_detected",
              hostname: window.location.hostname,
              identifier: text.slice(0, 40),
              snippet: text.slice(0, 120),
              url: window.location.href
            }
          }).catch(() => {});
        }
      }
    });

    observer.observe(document.body || document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true
    });
  }

  // Initialize proactive observer when document is ready
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", setupProactiveObserver);
  } else {
    setupProactiveObserver();
  }

  /**
   * Message Listener for Background Worker Commands
   */
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!message || !message.type) {
      sendResponse({ ok: false, error: "Invalid message payload" });
      return false;
    }

    if (message.type === "EXTRACT_PAGE_STATE") {
      try {
        const state = extractPageState();
        sendResponse({ ok: true, pageState: state });
      } catch (err) {
        sendResponse({ ok: false, error: `Failed to extract page state: ${err.message}` });
      }
      return false;
    }

    if (message.type === "EXECUTE_ACTION") {
      handleExecuteAction(message.action)
        .then((result) => sendResponse(result))
        .catch((err) => sendResponse({ ok: false, error: `Action execution failure: ${err.message}` }));
      return true; // Keep message channel open for async response
    }

    sendResponse({ ok: false, error: `Unknown content message type: ${message.type}` });
    return false;
  });
})();
