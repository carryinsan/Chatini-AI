/**
 * lib/updates.js - Production-ready Updates Notification Library
 * Connects directly to Upstash Redis REST API to fetch, display, and manage
 * sandboxed updates, 24-hour recurrence cycles, and settings widgets.
 */

(function (root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.AppUpdates = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // Default configuration
  const DEFAULT_CONFIG = {
    redisUrl: 'https://immortal-eagle-36171.upstash.io',         // e.g., 'https://us1-clean-slug-32847.upstash.io'
    redisToken: 'AY1LAAIgcDE5MjFiMmNkNGQ4M2M0ODQ2YWNhYjU0YmFmMzlhNjliNw',       // Upstash Redis Bearer Token
    redisKey: 'app:system_update', // Redis key storing the update JSON
    storageKey: 'app_update_tracker_v1',
    recurrenceHours: 24,  // Re-display notification every 24 hours if active
    autoCheck: true,      // Run on page load automatically
    checkIntervalMs: 15 * 60 * 1000, // Background poll check every 15 minutes
    settingsMountSelector: '#app-updates-settings-slot' // Default target container in settings
  };

  let activeConfig = { ...DEFAULT_CONFIG };
  let currentUpdateData = null;
  let modalInstance = null;
  let backgroundTimer = null;

  /**
   * Inject component styling into host document with high specificity
   */
  function injectStyles() {
    if (document.getElementById('app-updates-stylesheet')) return;

    const style = document.createElement('style');
    style.id = 'app-updates-stylesheet';
    style.textContent = `
      :root {
        --au-primary: #3b82f6;
        --au-primary-hover: #2563eb;
        --au-bg-overlay: rgba(15, 23, 42, 0.72);
        --au-card-bg: #ffffff;
        --au-card-border: #e2e8f0;
        --au-text-main: #0f172a;
        --au-text-muted: #64748b;
        --au-danger: #ef4444;
        --au-danger-hover: #dc2626;
        --au-radius: 18px;
        --au-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.35);
      }

      @media (prefers-color-scheme: dark) {
        :root {
          --au-card-bg: #0f172a;
          --au-card-border: #1e293b;
          --au-text-main: #f8fafc;
          --au-text-muted: #94a3b8;
        }
      }

      /* Modal Overlay */
      .au-overlay {
        position: fixed;
        inset: 0;
        background: var(--au-bg-overlay);
        backdrop-filter: blur(8px);
        -webkit-backdrop-filter: blur(8px);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 999999;
        padding: 16px;
        opacity: 0;
        visibility: hidden;
        transition: opacity 0.25s ease, visibility 0.25s ease;
      }

      .au-overlay.au-visible {
        opacity: 1;
        visibility: visible;
      }

      /* Vertical Long Notification Dialog */
      .au-modal {
        background: var(--au-card-bg);
        border: 1px solid var(--au-card-border);
        border-radius: var(--au-radius);
        box-shadow: var(--au-shadow);
        width: 100%;
        max-width: 580px;
        max-height: 88vh;
        display: flex;
        flex-direction: column;
        transform: translateY(20px) scale(0.97);
        transition: transform 0.28s cubic-bezier(0.16, 1, 0.3, 1);
        overflow: hidden;
      }

      .au-overlay.au-visible .au-modal {
        transform: translateY(0) scale(1);
      }

      .au-header {
        padding: 18px 24px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        border-bottom: 1px solid var(--au-card-border);
      }

      .au-header-left {
        display: flex;
        align-items: center;
        gap: 12px;
      }

      .au-badge {
        background: rgba(59, 130, 246, 0.12);
        color: var(--au-primary);
        font-size: 11px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.05em;
        padding: 4px 10px;
        border-radius: 9999px;
      }

      .au-title {
        margin: 0;
        font-size: 18px;
        font-weight: 700;
        color: var(--au-text-main);
        line-height: 1.3;
      }

      .au-date {
        font-size: 12px;
        color: var(--au-text-muted);
        margin-top: 2px;
      }

      /* Sandboxed Content Container */
      .au-body {
        flex: 1;
        overflow: hidden;
        padding: 0;
        min-height: 260px;
        max-height: 58vh;
        display: flex;
        position: relative;
        background: transparent;
      }

      .au-sandbox-frame {
        width: 100%;
        height: 100%;
        border: none;
        flex: 1;
        display: block;
        background: transparent;
      }

      .au-footer {
        padding: 16px 24px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        border-top: 1px solid var(--au-card-border);
        background: rgba(0, 0, 0, 0.02);
      }

      .au-btn {
        appearance: none;
        border: none;
        outline: none;
        cursor: pointer;
        font-family: inherit;
        font-size: 14px;
        font-weight: 600;
        padding: 10px 22px;
        border-radius: 10px;
        transition: all 0.18s ease;
      }

      .au-btn-primary {
        background: var(--au-primary);
        color: #ffffff;
      }

      .au-btn-primary:hover {
        background: var(--au-primary-hover);
        transform: translateY(-1px);
      }

      .au-btn-ghost {
        background: transparent;
        color: var(--au-text-muted);
      }

      .au-btn-ghost:hover {
        color: var(--au-danger);
      }

      /* Settings Notification Tab / Widget */
      .au-settings-card {
        border: 1px solid var(--au-card-border);
        background: var(--au-card-bg);
        border-radius: 12px;
        padding: 14px 18px;
        margin: 10px 0;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 14px;
        font-family: system-ui, -apple-system, sans-serif;
      }

      .au-settings-info {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .au-settings-title {
        font-size: 14px;
        font-weight: 600;
        color: var(--au-text-main);
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .au-settings-badge-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: var(--au-primary);
        display: inline-block;
      }

      .au-settings-desc {
        font-size: 12px;
        color: var(--au-text-muted);
      }

      .au-settings-actions {
        display: flex;
        gap: 8px;
      }

      .au-btn-sm {
        padding: 6px 14px;
        font-size: 12px;
        border-radius: 8px;
      }

      .au-btn-secondary {
        background: rgba(148, 163, 184, 0.15);
        color: var(--au-text-main);
      }

      .au-btn-secondary:hover {
        background: rgba(148, 163, 184, 0.25);
      }
    `;
    document.head.appendChild(style);
  }

  /**
   * Fetch current update payload from Upstash Redis REST API
   * Uses native fetch and Bearer authentication
   */
  async function fetchRedisUpdate() {
    const { redisUrl, redisToken, redisKey } = activeConfig;
    if (!redisUrl || !redisToken) {
      console.warn('[AppUpdates] Redis URL or Token is missing. Provide them in AppUpdates.init({ ... })');
      return null;
    }

    try {
      // Clean base url without trailing slash
      const cleanBase = redisUrl.replace(/\/+$/, '');
      const endpoint = `${cleanBase}/get/${encodeURIComponent(redisKey)}`;

      const response = await fetch(endpoint, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${redisToken}`,
          'Content-Type': 'application/json'
        }
      });

      if (!response.ok) {
        throw new Error(`Upstash HTTP Error: ${response.status} ${response.statusText}`);
      }

      const resJson = await response.json();
      if (!resJson || resJson.result === null || resJson.result === undefined) {
        // No update currently published or update was deleted in Redis
        return null;
      }

      let parsed = resJson.result;
      if (typeof parsed === 'string') {
        try {
          parsed = JSON.parse(parsed);
        } catch {
          // If plain text was set directly
          parsed = {
            id: 'legacy_plain_' + Date.now(),
            title: 'System Announcement',
            html: `<div>${parsed}</div>`,
            timestamp: Date.now()
          };
        }
      }

      return parsed;
    } catch (err) {
      console.error('[AppUpdates] Failed to retrieve update from Redis:', err);
      return null;
    }
  }

  /**
   * Retrieve tracking record from localStorage
   */
  function getTrackingRecord() {
    try {
      const raw = localStorage.getItem(activeConfig.storageKey);
      return raw ? JSON.parse(raw) : {};
    } catch (e) {
      return {};
    }
  }

  /**
   * Save tracking record to localStorage
   */
  function saveTrackingRecord(record) {
    try {
      localStorage.setItem(activeConfig.storageKey, JSON.stringify(record));
    } catch (e) {
      console.warn('[AppUpdates] Could not write to localStorage:', e);
    }
  }

  /**
   * Evaluates if update should pop up right now based on:
   * 1. If admin updated or changed update ID
   * 2. If user deleted this specific update in settings
   * 3. If 24 hours have elapsed since the user last clicked "OK"
   */
  function shouldDisplayNotification(update) {
    if (!update || !update.id) return false;

    const record = getTrackingRecord();
    const currentRecord = record[update.id];

    // If never tracked or version changed
    if (!currentRecord) {
      return true;
    }

    // If user explicitly deleted it from their settings
    if (currentRecord.userDeleted === true) {
      return false;
    }

    // 24-hour cycle verification
    const now = Date.now();
    const recurrenceMs = (activeConfig.recurrenceHours || 24) * 60 * 60 * 1000;
    const elapsed = now - (currentRecord.lastDismissedAt || 0);

    return elapsed >= recurrenceMs;
  }

  /**
   * Constructs the secure sandboxed iframe content document
   */
  function buildSandboxDoc(htmlContent) {
    return `
      <!DOCTYPE html>
      <html>
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <style>
          * { box-sizing: border-box; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
            margin: 0;
            padding: 20px 24px;
            color: #1e293b;
            line-height: 1.6;
            background: transparent;
            word-break: break-word;
          }
          @media (prefers-color-scheme: dark) {
            body { color: #e2e8f0; }
          }
          h1, h2, h3, h4, h5, h6 { color: inherit; margin-top: 0; font-weight: 700; }
          p { margin: 0 0 12px 0; }
          ul, ol { padding-left: 20px; margin: 0 0 14px 0; }
          li { margin-bottom: 6px; }
          a { color: #3b82f6; text-decoration: underline; }
          code { background: rgba(148, 163, 184, 0.2); padding: 2px 6px; border-radius: 4px; font-size: 85%; }
          img { max-width: 100%; height: auto; border-radius: 8px; }
          .update-tag {
            display: inline-block;
            padding: 2px 8px;
            font-size: 11px;
            font-weight: 600;
            border-radius: 6px;
            background: #e0f2fe;
            color: #0369a1;
            margin-bottom: 8px;
          }
        </style>
      </head>
      <body>
        ${htmlContent || '<p>No update notes provided.</p>'}
      </body>
      </html>
    `;
  }

  /**
   * Creates or returns the DOM modal structure
   */
  function getOrCreateModal() {
    if (modalInstance) return modalInstance;

    injectStyles();

    const overlay = document.createElement('div');
    overlay.className = 'au-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');

    overlay.innerHTML = `
      <div class="au-modal">
        <header class="au-header">
          <div class="au-header-left">
            <span class="au-badge">New Update</span>
            <div>
              <h3 class="au-title" id="au-modal-title">System Announcement</h3>
              <div class="au-date" id="au-modal-date"></div>
            </div>
          </div>
        </header>

        <section class="au-body">
          <iframe 
            class="au-sandbox-frame" 
            id="au-sandbox-iframe" 
            sandbox="allow-same-origin allow-popups"
            title="Update Content"
          ></iframe>
        </section>

        <footer class="au-footer">
          <button type="button" class="au-btn au-btn-ghost" id="au-btn-dismiss-forever">
            Delete Notification
          </button>
          <button type="button" class="au-btn au-btn-primary" id="au-btn-confirm">
            OK, Understood
          </button>
        </footer>
      </div>
    `;

    document.body.appendChild(overlay);

    const titleEl = overlay.querySelector('#au-modal-title');
    const dateEl = overlay.querySelector('#au-modal-date');
    const iframe = overlay.querySelector('#au-sandbox-iframe');
    const okBtn = overlay.querySelector('#au-btn-confirm');
    const deleteBtn = overlay.querySelector('#au-btn-dismiss-forever');

    // Event: OK Button - Dismisses and sets 24h cooldown
    okBtn.addEventListener('click', () => {
      if (currentUpdateData && currentUpdateData.id) {
        const record = getTrackingRecord();
        record[currentUpdateData.id] = {
          ...(record[currentUpdateData.id] || {}),
          lastDismissedAt: Date.now(),
          userDeleted: false
        };
        saveTrackingRecord(record);
      }
      hideModal();
      refreshSettingsWidget();
    });

    // Event: Delete Notification (user chooses to remove it permanently)
    deleteBtn.addEventListener('click', () => {
      if (currentUpdateData && currentUpdateData.id) {
        const record = getTrackingRecord();
        record[currentUpdateData.id] = {
          ...(record[currentUpdateData.id] || {}),
          lastDismissedAt: Date.now(),
          userDeleted: true
        };
        saveTrackingRecord(record);
      }
      hideModal();
      refreshSettingsWidget();
    });

    // Dismiss when clicking the dark backdrop
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        okBtn.click();
      }
    });

    modalInstance = {
      overlay,
      titleEl,
      dateEl,
      iframe
    };

    return modalInstance;
  }

  /**
   * Present the modal with current update payload
   */
  function showModal(update) {
    if (!update) return;
    const modal = getOrCreateModal();

    modal.titleEl.textContent = update.title || 'System Update';

    if (update.timestamp) {
      const d = new Date(update.timestamp);
      modal.dateEl.textContent = isNaN(d.getTime()) ? '' : d.toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric'
      });
    } else {
      modal.dateEl.textContent = '';
    }

    // Set sandboxed source content
    modal.iframe.srcdoc = buildSandboxDoc(update.html || update.content || '');

    // Show modal
    modal.overlay.classList.add('au-visible');
    document.body.style.overflow = 'hidden';
  }

  /**
   * Hide the modal
   */
  function hideModal() {
    if (!modalInstance) return;
    modalInstance.overlay.classList.remove('au-visible');
    document.body.style.overflow = '';
  }

  /**
   * Mounts or updates the notification tab in user's settings
   */
  function refreshSettingsWidget() {
    const selector = activeConfig.settingsMountSelector;
    const mountEl = typeof selector === 'string' ? document.querySelector(selector) : selector;
    if (!mountEl) return;

    injectStyles();

    // If no update exists or admin removed it
    if (!currentUpdateData || !currentUpdateData.id) {
      mountEl.innerHTML = '';
      return;
    }

    const record = getTrackingRecord();
    const updateState = record[currentUpdateData.id] || {};

    // If user already deleted it in their client settings
    if (updateState.userDeleted === true) {
      mountEl.innerHTML = `
        <div class="au-settings-card">
          <div class="au-settings-info">
            <div class="au-settings-desc">Notifications are up to date.</div>
          </div>
          <button type="button" class="au-btn au-btn-secondary au-btn-sm" id="au-restore-btn">
            Restore Update
          </button>
        </div>
      `;
      const restoreBtn = mountEl.querySelector('#au-restore-btn');
      if (restoreBtn) {
        restoreBtn.addEventListener('click', () => {
          record[currentUpdateData.id].userDeleted = false;
          record[currentUpdateData.id].lastDismissedAt = 0;
          saveTrackingRecord(record);
          showModal(currentUpdateData);
          refreshSettingsWidget();
        });
      }
      return;
    }

    // Normal settings tab showing active update
    mountEl.innerHTML = `
      <div class="au-settings-card">
        <div class="au-settings-info">
          <div class="au-settings-title">
            <span class="au-settings-badge-dot"></span>
            <span>${currentUpdateData.title || 'Latest Update'}</span>
          </div>
          <div class="au-settings-desc">
            ${currentUpdateData.timestamp ? new Date(currentUpdateData.timestamp).toLocaleDateString() : 'Active notification'} • Displays daily until dismissed
          </div>
        </div>
        <div class="au-settings-actions">
          <button type="button" class="au-btn au-btn-secondary au-btn-sm" id="au-settings-view-btn">
            View
          </button>
          <button type="button" class="au-btn au-btn-ghost au-btn-sm" id="au-settings-delete-btn" title="Delete notification">
            Delete
          </button>
        </div>
      </div>
    `;

    const viewBtn = mountEl.querySelector('#au-settings-view-btn');
    const deleteBtn = mountEl.querySelector('#au-settings-delete-btn');

    if (viewBtn) {
      viewBtn.addEventListener('click', () => {
        showModal(currentUpdateData);
      });
    }

    if (deleteBtn) {
      deleteBtn.addEventListener('click', () => {
        record[currentUpdateData.id] = {
          ...(record[currentUpdateData.id] || {}),
          userDeleted: true,
          lastDismissedAt: Date.now()
        };
        saveTrackingRecord(record);
        refreshSettingsWidget();
      });
    }
  }

  /**
   * Checks Redis and triggers the modal if conditions are met
   */
  async function check() {
    try {
      const update = await fetchRedisUpdate();
      currentUpdateData = update;

      // Update the settings tab always if mounted
      refreshSettingsWidget();

      if (!update) {
        return { updated: false, reason: 'NO_ACTIVE_UPDATE' };
      }

      if (shouldDisplayNotification(update)) {
        showModal(update);
        return { updated: true, shown: true, data: update };
      }

      return { updated: true, shown: false, data: update };
    } catch (e) {
      console.error('[AppUpdates] Check execution failed:', e);
      return { updated: false, error: e };
    }
  }

  /**
   * Initializes the library with provided credentials & options
   */
  function init(options = {}) {
    activeConfig = {
      ...activeConfig,
      ...options
    };

    // If global window variables are predefined, read them as fallback
    if (!activeConfig.redisUrl && root.UPSTASH_REDIS_REST_URL) {
      activeConfig.redisUrl = root.UPSTASH_REDIS_REST_URL;
    }
    if (!activeConfig.redisToken && root.UPSTASH_REDIS_REST_TOKEN) {
      activeConfig.redisToken = root.UPSTASH_REDIS_REST_TOKEN;
    }

    if (activeConfig.autoCheck) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => {
          check();
        });
      } else {
        check();
      }
    }

    // Schedule background re-check
    if (activeConfig.checkIntervalMs > 0 && !backgroundTimer) {
      backgroundTimer = setInterval(() => {
        check();
      }, activeConfig.checkIntervalMs);
    }

    return activeConfig;
  }

  // Public API object
  return {
    init,
    check,
    showModal: () => {
      if (currentUpdateData) showModal(currentUpdateData);
      else check().then(res => { if (res.data) showModal(res.data); });
    },
    hideModal,
    mountSettingsWidget: (containerSelector) => {
      if (containerSelector) activeConfig.settingsMountSelector = containerSelector;
      refreshSettingsWidget();
    },
    getCurrentUpdate: () => currentUpdateData,
    clearLocalHistory: () => {
      localStorage.removeItem(activeConfig.storageKey);
    }
  };
});
