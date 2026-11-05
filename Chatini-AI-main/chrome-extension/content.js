// Content script injected into active web page
(function() {
  if (window.hasLexisCanvasInjected) return;
  window.hasLexisCanvasInjected = true;

  // Listen for analysis commands from extension popup
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "EXTRACT_PAGE_CONTEXT") {
      const selectedText = window.getSelection().toString().trim();
      const pageTitle = document.title;
      const pageUrl = window.location.href;
      
      // Clean page body text extraction
      const bodyText = (document.body ? document.body.innerText : '')
        .replace(/\s+/g, ' ')
        .substring(0, 15000); // 15k char clean snapshot

      sendResponse({
        success: true,
        context: {
          title: pageTitle,
          url: pageUrl,
          selectedText: selectedText,
          bodyText: bodyText
        }
      });
      return true;
    }

    if (request.action === "INJECT_LEXIS_CANVAS") {
      renderFloatingCanvas(request.payload);
      sendResponse({ success: true });
      return true;
    }
  });

  function renderFloatingCanvas(payload) {
    let host = document.getElementById('lexis-extension-host');
    if (!host) {
      host = document.createElement('div');
      host.id = 'lexis-extension-host';
      host.style.cssText = 'position:fixed;top:0;right:0;width:420px;height:100vh;z-index:2147483647;pointer-events:none;';
      document.body.appendChild(host);
    }

    const shadow = host.attachShadow ? (host.shadowRoot || host.attachShadow({ mode: 'open' })) : host;
    
    shadow.innerHTML = `
      <style>
        :host { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; }
        .canvas-card {
          position: fixed; top: 20px; right: 20px; width: 380px; max-height: calc(100vh - 40px);
          background: #080808; color: #e5e5e5; border: 1px solid rgba(255, 255, 255, 0.15);
          border-radius: 16px; box-shadow: 0 20px 50px rgba(0, 0, 0, 0.8);
          display: flex; flex-direction: column; overflow: hidden; pointer-events: auto;
          backdrop-filter: blur(20px); transition: all 0.3s ease;
        }
        .header { padding: 14px 18px; background: #111; border-bottom: 1px solid rgba(255,255,255,0.08); display: flex; justify-content: space-between; align-items: center; }
        .title { font-weight: 700; font-size: 14px; color: #38bdf8; display: flex; align-items: center; gap: 8px; }
        .close-btn { background: none; border: none; color: #888; cursor: pointer; font-size: 18px; line-height: 1; }
        .close-btn:hover { color: #fff; }
        .body { padding: 16px; overflow-y: auto; font-size: 13px; line-height: 1.6; color: #d1d5db; white-space: pre-wrap; word-break: break-word; }
        .badge { font-size: 10px; padding: 2px 8px; border-radius: 12px; background: rgba(56, 189, 248, 0.15); color: #38bdf8; font-weight: 600; text-transform: uppercase; }
      </style>
      <div class="canvas-card">
        <div class="header">
          <div class="title"><span>LexisAI Gods-Eye</span> <span class="badge">${payload.modelId}</span></div>
          <button class="close-btn" id="close-lexis-overlay">&times;</button>
        </div>
        <div class="body" id="lexis-overlay-content">${escapeHtml(payload.responseText)}</div>
      </div>
    `;

    shadow.getElementById('close-lexis-overlay').addEventListener('click', () => {
      host.remove();
    });
  }

  function escapeHtml(text) {
    return text.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m]));
  }
})();
