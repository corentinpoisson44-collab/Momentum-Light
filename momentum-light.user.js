// ==UserScript==
// @name         Momentum-Light
// @namespace    https://github.com/corentinpoisson44-collab/Momentum-Light
// @version      0.1.2
// @description  Augmente la Timeline JIRA (Plans / Advanced Roadmaps) — feature #1 : barre de progression sur les Epics, calculée sur SP done / SP total des tickets enfants.
// @author       corentinpoisson44
// @match        https://*.atlassian.net/*
// @run-at       document-idle
// @grant        none
// @updateURL    https://raw.githubusercontent.com/corentinpoisson44-collab/Momentum-Light/main/momentum-light.user.js
// @downloadURL  https://raw.githubusercontent.com/corentinpoisson44-collab/Momentum-Light/main/momentum-light.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants & utilities
  // ---------------------------------------------------------------------------

  const LOG_PREFIX = '[Momentum-Light]';
  const ISSUE_KEY_REGEX = /\b([A-Z][A-Z0-9]+-\d+)\b/;
  const EPIC_CHILDREN_TTL_MS = 60_000;
  const MUTATION_DEBOUNCE_MS = 200;
  const OVERLAY_CLASS = 'momentum-progress';
  const OVERLAY_FILL_CLASS = 'momentum-progress__fill';

  // Debug mode is opt-in per session. Enable from DevTools:
  //   localStorage.setItem('momentum-light-debug', '1')
  // Or force-enable by setting window.__MOMENTUM_DEBUG = true before the script runs.
  const isDebug = () =>
    window.__MOMENTUM_DEBUG === true ||
    localStorage.getItem('momentum-light-debug') === '1';

  const log = (...args) => console.log(LOG_PREFIX, ...args);
  const debug = (...args) => { if (isDebug()) console.log(LOG_PREFIX, ...args); };
  const warn = (...args) => console.warn(LOG_PREFIX, ...args);
  const error = (...args) => console.error(LOG_PREFIX, ...args);

  function debounce(fn, delay) {
    let t = null;
    return function debounced(...args) {
      if (t) clearTimeout(t);
      t = setTimeout(() => fn.apply(this, args), delay);
    };
  }

  // ---------------------------------------------------------------------------
  // jiraApi — thin fetch wrappers around /rest/api/3/*
  // Same-origin requests inherit the JIRA session cookies.
  // ---------------------------------------------------------------------------

  const jiraApi = {
    async getJson(path) {
      const res = await fetch(path, {
        method: 'GET',
        credentials: 'same-origin',
        headers: { Accept: 'application/json' },
      });
      if (!res.ok) {
        throw new Error(`JIRA API ${path} → HTTP ${res.status}`);
      }
      return res.json();
    },

    listFields() {
      return this.getJson('/rest/api/3/field');
    },

    searchIssues(jql, fields, maxResults = 100) {
      const params = new URLSearchParams({
        jql,
        fields: fields.join(','),
        maxResults: String(maxResults),
      });
      return this.getJson(`/rest/api/3/search?${params.toString()}`);
    },
  };

  // ---------------------------------------------------------------------------
  // storyPointsField — dynamic discovery of the Story Points custom field id
  // Cached in sessionStorage; the id varies across JIRA instances.
  // ---------------------------------------------------------------------------

  const storyPointsField = (() => {
    const CACHE_KEY = 'momentum-light::sp-field-id';
    const CANDIDATE_NAMES = new Set([
      'story points',
      'story point estimate',
      'story point',
    ]);
    let inflight = null;

    return {
      async resolve() {
        const cached = sessionStorage.getItem(CACHE_KEY);
        if (cached) return cached;
        if (inflight) return inflight;

        inflight = (async () => {
          const fields = await jiraApi.listFields();
          const match = fields.find((f) => {
            const name = (f.name || '').toLowerCase().trim();
            return CANDIDATE_NAMES.has(name);
          });
          if (!match) {
            throw new Error('Story Points custom field not found on this instance');
          }
          sessionStorage.setItem(CACHE_KEY, match.id);
          log('Story Points field resolved:', match.id, `(${match.name})`);
          return match.id;
        })();

        try {
          return await inflight;
        } finally {
          inflight = null;
        }
      },
    };
  })();

  // ---------------------------------------------------------------------------
  // epicProgress — compute done/total SP for an Epic, with 60s memory cache
  // ---------------------------------------------------------------------------

  const epicProgress = (() => {
    const cache = new Map(); // key -> { expiresAt, value }
    const inflight = new Map(); // key -> Promise

    async function fetchForEpic(epicKey) {
      const spFieldId = await storyPointsField.resolve();
      // JQL `parent = X` matches children of an Epic on modern Cloud projects.
      // (Legacy "Epic Link" is still honored via `parent` for team-managed projects.)
      const data = await jiraApi.searchIssues(
        `parent = ${epicKey}`,
        [spFieldId, 'status'],
        100,
      );
      let done = 0;
      let total = 0;
      let countedChildren = 0;
      for (const issue of data.issues || []) {
        const sp = Number(issue.fields?.[spFieldId]);
        if (!Number.isFinite(sp) || sp <= 0) continue;
        countedChildren += 1;
        total += sp;
        const cat = issue.fields?.status?.statusCategory?.key;
        if (cat === 'done') done += sp;
      }
      return { done, total, countedChildren };
    }

    return {
      async get(epicKey) {
        const now = Date.now();
        const hit = cache.get(epicKey);
        if (hit && hit.expiresAt > now) return hit.value;

        if (inflight.has(epicKey)) return inflight.get(epicKey);

        const promise = (async () => {
          try {
            const value = await fetchForEpic(epicKey);
            cache.set(epicKey, { expiresAt: Date.now() + EPIC_CHILDREN_TTL_MS, value });
            return value;
          } finally {
            inflight.delete(epicKey);
          }
        })();
        inflight.set(epicKey, promise);
        return promise;
      },
    };
  })();

  // ---------------------------------------------------------------------------
  // styles — injected once
  // ---------------------------------------------------------------------------

  function ensureStyles() {
    if (document.getElementById('momentum-light-styles')) return;
    const style = document.createElement('style');
    style.id = 'momentum-light-styles';
    style.textContent = `
      .${OVERLAY_CLASS} {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 0;
        height: 25%;
        min-height: 4px;
        pointer-events: none;
        border-radius: 0 0 3px 3px;
        overflow: hidden;
        z-index: 1;
      }
      .${OVERLAY_FILL_CLASS} {
        height: 100%;
        width: 0%;
        background-color: rgba(0, 82, 204, 0.45);
        transition: width 200ms ease-out;
      }
    `;
    document.head.appendChild(style);
  }

  // ---------------------------------------------------------------------------
  // timelineDom — detect Epic bars, extract their issue key, inject the overlay
  // ---------------------------------------------------------------------------

  const timelineDom = (() => {
    // Tracks bars we've already decorated to avoid reprocessing every mutation.
    // Holds { epicKey, overlay } so we can update without rebuilding.
    const decorated = new WeakMap();

    // JIRA obfuscates classes, so we probe multiple candidate selectors.
    // These are the public-facing hooks observed on modern Cloud Plans/Timeline
    // and project-board Timeline (software.c.projects/.../boards/.../timeline).
    // Adjust here if Atlassian ships a DOM change.
    const BAR_SELECTORS = [
      // Project-board Timeline (software-roadmap / software.c.projects)
      '[data-testid*="software-roadmap" i][data-testid*="bar" i]',
      '[data-testid*="roadmap.timeline" i][data-testid*="bar" i]',
      // Plans / Advanced Roadmaps
      '[data-testid*="plan-timeline" i][data-testid*="bar" i]',
      '[data-testid*="timeline-bar" i]',
      '[data-testid*="roadmap-bar" i]',
      '[data-testid*="epic-bar" i]',
      // Generic fallbacks
      '[data-testid*="issue-bar" i]',
      '[data-testid*="bar.ui" i]',
      '[data-testid*="lozenge" i][role="button"]',
    ];

    function findBars(root) {
      const nodes = new Set();
      const perSelector = {};
      for (const sel of BAR_SELECTORS) {
        const hits = root.querySelectorAll(sel);
        perSelector[sel] = hits.length;
        hits.forEach((n) => nodes.add(n));
      }
      if (isDebug()) debug('findBars per-selector counts:', perSelector, '→ total:', nodes.size);
      return [...nodes];
    }

    // Diagnostic probe: when findBars returns empty, dump every data-testid value
    // in the document that contains a timeline-related keyword. Paste the output
    // back to the maintainer to calibrate BAR_SELECTORS. Rate-limited to once
    // per 3s to keep the console readable.
    let lastProbeAt = 0;
    function probeCandidates(root) {
      const now = Date.now();
      if (now - lastProbeAt < 3_000) return;
      lastProbeAt = now;
      const KEYWORDS = ['bar', 'timeline', 'roadmap', 'epic', 'issue', 'lozenge', 'row'];
      const counts = new Map();
      root.querySelectorAll('[data-testid]').forEach((el) => {
        const id = el.getAttribute('data-testid');
        if (!id) return;
        const lower = id.toLowerCase();
        if (!KEYWORDS.some((k) => lower.includes(k))) return;
        counts.set(id, (counts.get(id) || 0) + 1);
      });
      const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
      const top = sorted.slice(0, 40).map(([testid, count]) => ({ testid, count }));
      warn('no bars found — data-testid probe (top 40):');
      // eslint-disable-next-line no-console
      console.table(top);
      // Also log a JSON string: easier to copy-paste back to the maintainer.
      warn('probe JSON (copy everything between the braces):\n' + JSON.stringify(top, null, 2));
    }

    function extractIssueKey(bar) {
      // Heuristic 1: data-* attribute on the bar or an ancestor
      let cursor = bar;
      while (cursor && cursor !== document.body) {
        const dataKey =
          cursor.getAttribute?.('data-issue-key') ||
          cursor.getAttribute?.('data-rbd-draggable-id') ||
          cursor.getAttribute?.('data-testid');
        if (dataKey) {
          const m = dataKey.match(ISSUE_KEY_REGEX);
          if (m) return m[1];
        }
        cursor = cursor.parentElement;
      }
      // Heuristic 2: anchor pointing to /browse/KEY
      const anchor = bar.querySelector?.('a[href*="/browse/"]');
      if (anchor) {
        const m = anchor.getAttribute('href').match(ISSUE_KEY_REGEX);
        if (m) return m[1];
      }
      // Heuristic 3: visible text (fragile fallback)
      const text = bar.textContent || '';
      const m = text.match(ISSUE_KEY_REGEX);
      if (m) return m[1];
      return null;
    }

    function ensureOverlay(bar) {
      let overlay = bar.querySelector(`:scope > .${OVERLAY_CLASS}`);
      if (overlay) return overlay;
      // Guarantee a positioning context without clobbering inline styles.
      const computed = getComputedStyle(bar);
      if (computed.position === 'static') {
        bar.style.position = 'relative';
      }
      overlay = document.createElement('div');
      overlay.className = OVERLAY_CLASS;
      const fill = document.createElement('div');
      fill.className = OVERLAY_FILL_CLASS;
      overlay.appendChild(fill);
      bar.appendChild(overlay);
      return overlay;
    }

    function removeOverlay(bar) {
      const overlay = bar.querySelector(`:scope > .${OVERLAY_CLASS}`);
      if (overlay) overlay.remove();
    }

    function applyProgress(bar, { done, total }) {
      if (!total || total <= 0) {
        removeOverlay(bar);
        return;
      }
      const pct = Math.max(0, Math.min(100, (done / total) * 100));
      const overlay = ensureOverlay(bar);
      const fill = overlay.querySelector(`.${OVERLAY_FILL_CLASS}`);
      if (fill) fill.style.width = `${pct.toFixed(1)}%`;
      overlay.title = `${done} / ${total} SP (${pct.toFixed(0)}%)`;
    }

    async function decorateBar(bar) {
      const epicKey = extractIssueKey(bar);
      if (!epicKey) return;

      const previous = decorated.get(bar);
      if (previous && previous.epicKey === epicKey) {
        // Already decorated for this key; refresh value silently (cache hit is free).
        const { done, total } = await epicProgress.get(epicKey);
        applyProgress(bar, { done, total });
        return;
      }

      decorated.set(bar, { epicKey });
      const { done, total } = await epicProgress.get(epicKey);
      applyProgress(bar, { done, total });
    }

    return { findBars, decorateBar, probeCandidates };
  })();

  // ---------------------------------------------------------------------------
  // Feature registry — add future Momentum features here
  // ---------------------------------------------------------------------------

  const features = [
    {
      id: 'epic-progress-bar',
      description: 'Progress bar on Epic timeline bars (SP done / SP total of children)',
      isActive: () => {
        const p = location.pathname;
        return p.includes('/plans/') || p.includes('/timeline');
      },
      async onMutation(root) {
        const bars = timelineDom.findBars(root);
        if (bars.length === 0 && isDebug()) {
          timelineDom.probeCandidates(root);
          return;
        }
        // Fire & forget: errors on a single bar must not cascade to the others.
        for (const bar of bars) {
          timelineDom.decorateBar(bar).catch((e) => {
            warn('decorateBar failed:', e?.message || e);
          });
        }
      },
    },
  ];

  // ---------------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------------

  function runActiveFeatures() {
    const root = document.body;
    if (!root) return;
    for (const feature of features) {
      if (!feature.isActive()) continue;
      try {
        feature.onMutation(root);
      } catch (e) {
        error(`feature "${feature.id}" crashed:`, e);
      }
    }
  }

  function bootstrap() {
    ensureStyles();
    const onMutation = debounce(runActiveFeatures, MUTATION_DEBOUNCE_MS);
    const observer = new MutationObserver(onMutation);
    observer.observe(document.body, { childList: true, subtree: true });
    // Initial pass (in case the timeline is already rendered at document-idle).
    runActiveFeatures();
    log(
      'loaded — version 0.1.2',
      isDebug()
        ? '(debug on)'
        : '(debug off — enable with: localStorage.setItem(\'momentum-light-debug\', \'1\'))',
    );
  }

  try {
    if (document.body) {
      bootstrap();
    } else {
      window.addEventListener('DOMContentLoaded', bootstrap, { once: true });
    }
  } catch (e) {
    error('fatal bootstrap error (script disabled):', e);
  }
})();
