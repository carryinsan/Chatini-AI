/**
 * lib/updates.js - Production-Ready Upstash App Updates Client Engine
 * Fully autonomous: pulls announcements from Upstash Redis REST, checks 24h
 * recurrence cooldowns, renders isolated sandboxed modal popups, and embeds
 * into user settings.
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

  // Primary configuration with your provided Upstash REST cluster
  const DEFAULT_CONFIG = {
    redisUrl: 'https://immortal-eagle-36171.upstash.io',
    redisToken: 'AY1LAAIgcDE5MjFiMmNkNGQ4M2M0ODQ2YWNhYjU0YmFmMzlhNjliNw',
    redisKey: 'app:system_update',
    storageKey: 'app_update_tracker_v1',
    recurrenceHours: 24,
    autoCheck: true,
    checkIntervalMs: 15 * 60 * 1000,
    settingsMountSelector: '#arix-settings-updates-slot'
  };

  let activeConfig = { ...DEFAULT_CONFIG };
  let currentUpdateData = null;
  let modalInstance = null;
  let backgroundTimer = null;

  /**
   * Inject high-specificity styling for the long vertical modal and settings widget
   */
  function injectStyles() {
    if (document.getElementById('app-updates-stylesheet')) return;

    const style = document.createElement('style');
    style.id = 'app-updates-stylesheet';
    style.textContent = `
      :root {
        --au-primary: #3b82f6;
        --au-primary-hover: #2563eb;
        --au-overlay-bg: rgba(10, 15, 29, 0.78);
        --au-modal-bg: #0f172a;
        --au-modal-border: #1e293b;
        --au-text: #f8fafc;
        --au-text-muted: #94a3b8;
        --au-danger: #ef4444;
        --au-radius: 20px;
        --au-shadow: 0 25px 60px -15px rgba(0, 0, 0, 0.65);
      }

      /* Fixed Backdrop */
      .au-overlay {
        position: fixed;
        inset: 0;
        background: var(--au-overlay-bg);
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 999999;
        padding: 16px;
        opacity: 0;
        visibility: hidden;
        transition: opacity 0.28s ease, visibility 0.28s ease;
      }

      .au-overlay.au-visible {
        opacity: 1;
        visibility: visible;
      }

      /* Long Vertical Modal Box */
      .au-modal {
        background: var(--au-modal-bg);
        border: 1px solid var(--au-modal-border);
        border-radius: var(--au-radius);
        box-shadow: var(--au-shadow);
        width: 100%;
        max-width: 540px;
        max-height: 86vh;
        display: flex;
        flex-direction: column;
        transform: translateY(24px) scale(0.96);
        transition: transform 0.3s cubic-bezier(0.16, 1, 0.3, 1);
        overflow: hidden;
      }

      .au-overlay.au-visible .au-modal {
        transform: translateY(0) scale(1);
      }

      /* Header Bar */
      .au-header {
        padding: 18px 22px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        background: rgba(15, 23, 42, 0.95);
        border-bottom: 1px solid var(--au-modal-border);
      }

      .au-header-left {
        display: flex;
        align-items: center;
        gap: 12px;
        min-width: 0;
      }

      .au-badge {
        background: rgba(59, 130, 246, 0.16);
        color: #60a5fa;
        border: 1px solid rgba(59, 130, 246, 0.28);
        font-size: 10px;
        font-weight: 700;
        text-transform: uppercase;
        letter-spacing: 0.06em;
        padding: 4px 10px;
        border-radius: 999px;
        white-space: nowrap;
        flex-shrink: 0;
      }

      .au-title {
        margin: 0;
        font-size: 15px;
        font-weight: 700;
        color: #ffffff;
        line-height: 1.3;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }

      .au-meta {
        font-size: 11px;
        color: var(--au-text-muted);
        margin-top: 2px;
        display: flex;
        align-items: center;
        gap: 6px;
      }

      /* Sandboxed Content Viewport */
      .au-body {
        flex: 1;
        overflow: hidden;
        min-height: 320px;
        max-height: 58vh;
        position: relative;
        background: #020617;
      }

      .au-sandbox-frame {
        width: 100%;
        height: 100%;
        border: none;
        display: block;
        background: transparent;
      }

      /* Action Footer */
      .au-footer {
        padding: 14px 22px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        background: rgba(15, 23, 42, 0.98);
        border-top: 1px solid var(--au-modal-border);
      }

      .au-btn {
        appearance: none;
        border: none;
        outline: none;
        cursor: pointer;
        font-family: inherit;
        font-size: 13px;
        font-weight: 600;
        padding: 9px 20px;
        border-radius: 12px;
        transition: all 0.18s ease;
      }

      .au-btn-primary {
        background: var(--au-primary);
        color: #ffffff;
        box-shadow: 0 4px 14px rgba(59, 130, 246, 0.35);
      }

      .au-btn-primary:hover {
        background: var(--au-primary-hover);
        transform: translateY(-1px);
      }

      .au-btn-ghost {
        background: transparent;
        color: var(--au-text-muted);
        padding: 8px 12px;
      }

      .au-btn-ghost:hover {
        color: var(--au-danger);
      }

      /* Embeddable Settings Card */
      .au-settings-card {
        border: 1px solid #1e293b;
        background: #0f172a;
        border-radius: 16px;
        padding: 14px 18px;
        margin: 10px 0;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 14px;
        color: #f8fafc;
        font-family: inherit;
      }

      .au-settings-info {
        display: flex;
        flex-direction: column;
        gap: 3px;
        min-width: 0;
      }

      .au-settings-title {
        font-size: 13px;
        font-weight: 700;
        color: #ffffff;
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .au-settings-dot {
        width: 8px;
        height: 8px;
        border-radius: 50%;
        background: #3b82f6;
        display: inline-block;
        flex-shrink: 0;
      }

      .au-settings-desc {
        font-size: 11px;
        color: #94a3b8;
      }

      .au-settings-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-shrink: 0;
      }

      .au-btn-sm {
        padding: 6px 14px;
        font-size: 12px;
        border-radius: 9px;
      }

      .au-btn-secondary {
        background: rgba(255, 255, 255, 0.08);
        color: #ffffff;
        border: 1px solid rgba(255, 255, 255, 0.12);
      }

      .au-btn-secondary:hover {
        background: rgba(255, 255, 255, 0.15);
      }
    `;
    document.head.appendChild(style);
  }

  /**
   * Universal parser for raw Upstash values
   */
  function parseRawResult(raw) {
    if (raw === null || raw === undefined || raw === '') return null;
    if (typeof raw === 'object') return raw;
    try {
      return JSON.parse(raw);
    } catch {
      return {
        id: 'legacy_txt_' + Date.now(),
        title: 'System Notice',
        tag: 'Update',
        html: `<div>${raw}</div>`,
        timestamp: Date.now()
      };
    }
  }

  /**
   * Fetches update JSON from Upstash using POST command body (resolves path 404s)
   */
  async function fetchRedisUpdate() {
    const url = (activeConfig.redisUrl || '').trim().replace(/\/+$/, '');
    const token = (activeConfig.redisToken || '').trim();
    const key = (activeConfig.redisKey || 'app:system_update').trim();

    if (!url || !token) {
      console.warn('[AppUpdates] Redis credentials missing in configuration.');
      return null;
    }

    try {
      // Primary standard Upstash REST endpoint: POST ["GET", key] to the root URL
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(['GET', key])
      });

      if (response.ok) {
        const json = await response.json();
        if (json && !json.error) {
          return parseRawResult(json.result);
        }
      }

      // Fallback: GET /get/<key> endpoint
      const fallbackEndpoint = `${url}/get/${encodeURIComponent(key)}`;
      const fallbackRes = await fetch(fallbackEndpoint, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (fallbackRes.ok) {
        const fallbackJson = await fallbackRes.json();
        return parseRawResult(fallbackJson?.result);
      }

      return null;
    } catch (err) {
      console.warn('[AppUpdates] Upstash fetch deferred:', err.message);
      return null;
    }
  }

  /**
   * Get dismiss tracking dictionary
   */
  function getTrackingRecord() {
    try {
      const raw = localStorage.getItem(activeConfig.storageKey);
      return raw ? JSON.parse(raw) : {};
    } catch {
      return {};
    }
  }

  /**
   * Save dismiss tracking record
   */
  function saveTrackingRecord(record) {
    try {
      localStorage.setItem(activeConfig.storageKey, JSON.stringify(record));
    } catch (e) {
      console.warn('[AppUpdates] Unable to access localStorage:', e);
    }
  }

  /**
   * Evaluates if update should pop up on screen
   */
  function shouldDisplayNotification(update) {
    if (!update || !update.id) return false;

    const record = getTrackingRecord();
    const current = record[update.id];

    // Brand new update ID created by creator: show immediately
    if (!current) {
      return true;
    }

    // Explicitly deleted by user in modal or settings
    if (current.userDeleted === true) {
      return false;
    }

    // 24-hour cycle verification
    const now = Date.now();
    const recurrenceMs = (activeConfig.recurrenceHours || 24) * 60 * 60 * 1000;
    const elapsed = now - (current.lastDismissedAt || 0);

    return elapsed >= recurrenceMs;
  }

  /**
   * Renders the publisher's custom HTML inside an isolated iframe sandbox
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
            padding: 20px 22px;
            color: #e2e8f0;
            background: transparent;
            line-height: 1.6;
            word-break: break-word;
          }
          h1, h2, h3, h4, h5, h6 { color: #ffffff; margin-top: 0; }
          p { margin: 0 0 12px 0; font-size: 13.5px; }
          ul, ol { padding-left: 20px; margin: 0 0 14px 0; font-size: 13px; }
          li { margin-bottom: 6px; }
          a { color: #38bdf8; text-decoration: underline; }
          code { background: rgba(148, 163, 184, 0.2); padding: 2px 6px; border-radius: 4px; font-size: 85%; font-family: monospace; }
          img { max-width: 100%; height: auto; border-radius: 8px; }
          ::-webkit-scrollbar { width: 6px; }
          ::-webkit-scrollbar-thumb { background: rgba(148, 163, 184, 0.3); border-radius: 3px; }
        </style>
      </head>
      <body>
        ${htmlContent || '<p style="color:#64748b;">No announcement text.</p>'}
      </body>
      </html>
    `;
  }

  /**
   * Builds or returns singleton modal structure
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
            <span class="au-badge" id="au-modal-tag">Update</span>
            <div style="min-width: 0;">
              <h3 class="au-title" id="au-modal-title">System Announcement</h3>
              <div class="au-meta">
                <span id="au-modal-date">Recent</span>
                <span>•</span>
                <span style="color:#38bdf8;">Notice</span>
              </div>
            </div>
          </div>
        </header>

        <section class="au-body">
          <iframe 
            class="au-sandbox-frame" 
            id="au-sandbox-iframe" 
            sandbox="allow-same-origin allow-popups"
            title="System Update Content"
          ></iframe>
        </section>

        <footer class="au-footer">
          <button type="button" class="au-btn au-btn-ghost" id="au-btn-delete">
            Delete Notification
          </button>
          <button type="button" class="au-btn au-btn-primary" id="au-btn-ok">
            OK, Understood
          </button>
        </footer>
      </div>
    `;

    document.body.appendChild(overlay);

    const titleEl = overlay.querySelector('#au-modal-title');
    const tagEl = overlay.querySelector('#au-modal-tag');
    const dateEl = overlay.querySelector('#au-modal-date');
    const iframe = overlay.querySelector('#au-sandbox-iframe');
    const okBtn = overlay.querySelector('#au-btn-ok');
    const deleteBtn = overlay.querySelector('#au-btn-delete');

    // Click OK: Set 24h cooldown timer
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

    // Click Delete: Hide permanently for this user
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

    // Dismiss on dark backdrop tap
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        okBtn.click();
      }
    });

    modalInstance = { overlay, titleEl, tagEl, dateEl, iframe };
    return modalInstance;
  }

  /**
   * Open the modal popup
   */
  function showModal(update) {
    if (!update) return;
    const modal = getOrCreateModal();

    modal.titleEl.textContent = update.title || 'System Update';
    modal.tagEl.textContent = update.tag || 'Notice';

    if (update.timestamp) {
      const d = new Date(update.timestamp);
      modal.dateEl.textContent = isNaN(d.getTime()) ? 'Today' : d.toLocaleDateString();
    } else {
      modal.dateEl.textContent = 'Today';
    }

    modal.iframe.srcdoc = buildSandboxDoc(update.html || update.content || '');
    modal.overlay.classList.add('au-visible');
    document.body.style.overflow = 'hidden';
  }

  /**
   * Close the modal popup
   */
  function hideModal() {
    if (!modalInstance) return;
    modalInstance.overlay.classList.remove('au-visible');
    document.body.style.overflow = '';
  }

  /**
   * Renders the notification pill row inside the settings drawer
   */
  function refreshSettingsWidget() {
    // Check default target selector or fallback to legacy selector
    let mountEl = document.querySelector(activeConfig.settingsMountSelector);
    if (!mountEl) mountEl = document.querySelector('#app-updates-settings-slot');
    if (!mountEl) mountEl = document.querySelector('#arix-settings-updates-slot');
    if (!mountEl) return;

    injectStyles();

    if (!currentUpdateData || !currentUpdateData.id) {
      mountEl.innerHTML = '';
      return;
    }

    const record = getTrackingRecord();
    const updateState = record[currentUpdateData.id] || {};

    // User previously deleted notification
    if (updateState.userDeleted === true) {
      mountEl.innerHTML = `
        <div class="au-settings-card">
          <div class="au-settings-info">
            <div class="au-settings-desc">Notifications up to date.</div>
          </div>
          <button type="button" class="au-btn au-btn-secondary au-btn-sm" id="au-restore-btn">
            Restore Update
          </button>
        </div>
      `;
      mountEl.querySelector('#au-restore-btn')?.addEventListener('click', () => {
        record[currentUpdateData.id].userDeleted = false;
        record[currentUpdateData.id].lastDismissedAt = 0;
        saveTrackingRecord(record);
        showModal(currentUpdateData);
        refreshSettingsWidget();
      });
      return;
    }

    // Active notification widget
    mountEl.innerHTML = `
      <div class="au-settings-card">
        <div class="au-settings-info">
          <div class="au-settings-title">
            <span class="au-settings-dot"></span>
            <span class="truncate">${currentUpdateData.title || 'Latest Update'}</span>
          </div>
          <div class="au-settings-desc">
            ${currentUpdateData.tag ? `[${currentUpdateData.tag}] ` : ''}Active • Re-displays daily
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

    mountEl.querySelector('#au-settings-view-btn')?.addEventListener('click', () => {
      showModal(currentUpdateData);
    });

    mountEl.querySelector('#au-settings-delete-btn')?.addEventListener('click', () => {
      record[currentUpdateData.id] = {
        ...(record[currentUpdateData.id] || {}),
        userDeleted: true,
        lastDismissedAt: Date.now()
      };
      saveTrackingRecord(record);
      refreshSettingsWidget();
    });
  }

  /**
   * Main poll check
   */
  async function check() {
    try {
      const update = await fetchRedisUpdate();
      currentUpdateData = update;

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
      console.warn('[AppUpdates] Check execution failed:', e);
      return { updated: false, error: e };
    }
  }

  /**
   * Initialize updates system with optional overrides
   */
  function init(options = {}) {
    activeConfig = {
      ...activeConfig,
      ...options
    };

    // Auto-detect global overrides if provided
    if (root.UPSTASH_REDIS_REST_URL) activeConfig.redisUrl = root.UPSTASH_REDIS_REST_URL;
    if (root.UPSTASH_REDIS_REST_TOKEN) activeConfig.redisToken = root.UPSTASH_REDIS_REST_TOKEN;

    if (activeConfig.autoCheck) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { check(); }, { once: true });
      } else {
        check();
      }
    }

    // Background interval check
    if (activeConfig.checkIntervalMs > 0 && !backgroundTimer) {
      backgroundTimer = setInterval(() => { check(); }, activeConfig.checkIntervalMs);
    }

    return activeConfig;
  }

  return {
    init,
    check,
    showModal: () => {
      if (currentUpdateData) showModal(currentUpdateData);
      else check().then(res => { if (res && res.data) showModal(res.data); });
    },
    hideModal,
    mountSettingsWidget: (selector) => {
      if (selector) activeConfig.settingsMountSelector = selector;
      refreshSettingsWidget();
    },
    getCurrentUpdate: () => currentUpdateData,
    clearLocalHistory: () => {
      localStorage.removeItem(activeConfig.storageKey);
    }
  };
});
