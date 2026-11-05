// Chrome Extension Background Worker
chrome.runtime.onInstalled.addListener(() => {
  console.log("LexisAI Gods-Eye Extension active.");
});

// Relay messages between Popup and Content Scripts securely
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "EXECUTE_OVERLAY_QUERY") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs[0] && tabs[0].id) {
        chrome.tabs.sendMessage(tabs[0].id, {
          action: "INJECT_LEXIS_CANVAS",
          payload: request.payload
        }, sendResponse);
      }
    });
    return true; // Keep channel open for async response
  }
});
