let selectedModel = 'oracle';
let pageContext = null;

// Domain URL for your deployed Vercel Backend
const BACKEND_URL = "https://lexis-ai-chatini.vercel.app";

document.addEventListener('DOMContentLoaded', async () => {
  // Model Selector Logic
  const modelBtns = document.querySelectorAll('.model-btn');
  modelBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      modelBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      selectedModel = btn.getAttribute('data-model');
    });
  });

  // Extract page context from active tab
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs[0] && tabs[0].id) {
      chrome.tabs.sendMessage(tabs[0].id, { action: "EXTRACT_PAGE_CONTEXT" }, (response) => {
        const info = document.getElementById('context-info');
        if (chrome.runtime.lastError || !response || !response.success) {
          info.innerHTML = "<strong>Page Context:</strong> Restricted system page or extension reloading.";
          return;
        }
        pageContext = response.context;
        const selText = pageContext.selectedText ? `<br><strong>Selected:</strong> "${pageContext.selectedText.substring(0, 50)}..."` : '';
        info.innerHTML = `<strong>Page:</strong> ${escapeHtml(pageContext.title.substring(0, 35))}...${selText}`;
      });
    }
  });

  // Handle Analysis Click
  document.getElementById('analyze-btn').addEventListener('click', handlePageAnalysis);
});

async function handlePageAnalysis() {
  const inputEl = document.getElementById('extension-input');
  const btn = document.getElementById('analyze-btn');
  const statusEl = document.getElementById('status-text');
  
  const userText = inputEl.value.trim() || "Analyze this webpage and summarize key insights, risks, and facts.";

  btn.disabled = true;
  btn.innerText = "Analyzing Web Context...";
  statusEl.innerText = "Routing to LexisAI Edge...";

  let compiledPrompt = userText;
  if (pageContext) {
    compiledPrompt = `[SYSTEM: USER IS READING THIS WEBPAGE]:\nURL: ${pageContext.url}\nTitle: ${pageContext.title}\n${pageContext.selectedText ? `Selected Highlight: ${pageContext.selectedText}\n` : ''}Full Content Snapshot: ${pageContext.bodyText}\n\n[USER QUERY]:\n${userText}`;
  }

  try {
    const response = await fetch(`${BACKEND_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: compiledPrompt }],
        modelId: selectedModel,
        researchContext: "",
        userProfile: {}
      })
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let fullText = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunks = decoder.decode(value, { stream: true }).split('\n\n').filter(Boolean);
      for (let chunk of chunks) {
        if (chunk.startsWith('data: ')) {
          try {
            const data = JSON.parse(chunk.substring(6));
            if (data.ui_error) {
              fullText = `[Quota Exceeded]: ${data.ui_error}`;
              break;
            }
            const chunkText = data.choices?.[0]?.delta?.content || data.candidates?.[0]?.content?.parts?.[0]?.text || "";
            fullText += chunkText;
          } catch(e) {}
        }
      }
    }

    // Send final result to be injected in the active tab as floating canvas
    chrome.runtime.sendMessage({
      action: "EXECUTE_OVERLAY_QUERY",
      payload: {
        modelId: selectedModel,
        responseText: fullText || "Analysis complete."
      }
    });

    statusEl.innerText = "Canvas Injected into Tab!";
    window.close(); // Close popup once injected

  } catch(err) {
    statusEl.innerText = "Network Error communicating with Vercel.";
    btn.disabled = false;
    btn.innerText = "Analyze Web Page";
  }
}

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[m]));
}
