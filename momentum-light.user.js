// ==UserScript==
// @name         Momentum-Light
// @namespace    https://github.com/corentinpoisson44-collab/Momentum-Light
// @version      0.1.3
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

  // Styles kept as a placeholder for future features that inject their own DOM.
  // The Epic Progress Bar feature overrides JIRA's own fill element directly, so
  // no custom CSS is required for it.
  function ensureStyles() {
    if (document.getElementById('momentum-light-styles')) return;
    const style = document.createElement('style');
    style.id = 'momentum-light-styles';
    style.textContent = '';
    document.head.appendChild(style);
  }

  // ---------------------------------------------------------------------------
  // timelineDom — detect Epic bars, extract their issue key, inject the overlay
  // ---------------------------------------------------------------------------

  const timelineDom = (() => {
    // Tracks bars we've already decorated to avoid reprocessing every mutation.
    // Holds { epicKey, overlay } so we can update without rebuilding.
    const decorated = new WeakMap();

    // JIRA obfuscates classes, so we target the public data-testid hooks observed
    // on real Timelines. Primary target: the progress-bar wrapper JIRA renders
    // on each Epic's chart bar. Adjust here if Atlassian ships a DOM change.
    const BAR_SELECTORS = [
      '[data-testid="common.components.progress-bar.progress-wrapper"]',
    ];
    const KEY_CELL_SELECTOR =
      '[data-testid="roadmap.timeline-table-kit.ui.list-item-content.summary.key"]';

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
      // The progress-wrapper lives in the chart side of a row. The issue key lives
      // in the list side, in a sibling cell. Walk up until we find an ancestor
      // that also contains the key cell, then read the key from its text.
      let cursor = bar.parentElement;
      let steps = 0;
      while (cursor && cursor !== document.body && steps < 20) {
        const keyEl = cursor.querySelector(KEY_CELL_SELECTOR);
        if (keyEl) {
          const text = (keyEl.textContent || '').trim();
          const m = text.match(ISSUE_KEY_REGEX);
          if (m) return m[1];
        }
        cursor = cursor.parentElement;
        steps += 1;
      }
      // Fallback: look for any /browse/KEY anchor inside the bar itself.
      const anchor = bar.querySelector?.('a[href*="/browse/"]');
      if (anchor) {
        const m = anchor.getAttribute('href').match(ISSUE_KEY_REGEX);
        if (m) return m[1];
      }
      return null;
    }

    // Memorise each wrapper's fill node so we can re-apply the width if React
    // re-renders and resets it. Keyed on the wrapper element (WeakMap).
    const fillObservers = new WeakMap();

    function applyProgress(bar, { done, total, epicKey }) {
      if (!total || total <= 0) return;
      const pct = Math.max(0, Math.min(100, (done / total) * 100));
      const pctStr = `${pct.toFixed(1)}%`;

      // JIRA's progress-wrapper structure: <wrapper><fill style="width:X%"></wrapper>.
      // We override the first child's width using !important so JIRA's inline
      // style (set by React) loses the specificity fight.
      const fill = bar.firstElementChild;
      if (fill instanceof HTMLElement) {
        fill.style.setProperty('width', pctStr, 'important');

        // If we haven't already, watch this fill for React re-renders that would
        // reset the width, and re-apply ours.
        if (!fillObservers.has(bar)) {
          const obs = new MutationObserver(() => {
            const current = fill.style.width;
            const desired = bar.dataset.momentumPct || '';
            if (desired && current !== desired) {
              fill.style.setProperty('width', desired, 'important');
            }
          });
          obs.observe(fill, { attributes: true, attributeFilter: ['style'] });
          fillObservers.set(bar, obs);
        }
      }
      bar.dataset.momentumPct = pctStr;
      bar.title = `${epicKey}: ${done} / ${total} SP (${pct.toFixed(0)}%)`;
    }

    async function decorateBar(bar) {
      const epicKey = extractIssueKey(bar);
      if (!epicKey) {
        if (isDebug()) debug('no epic key resolved for a bar — skipping');
        return;
      }

      const previous = decorated.get(bar);
      if (previous && previous.epicKey === epicKey) {
        // Already decorated for this key; refresh value silently (cache hit is free).
        const { done, total } = await epicProgress.get(epicKey);
        applyProgress(bar, { done, total, epicKey });
        return;
      }

      decorated.set(bar, { epicKey });
      const { done, total } = await epicProgress.get(epicKey);
      if (isDebug()) debug(`${epicKey}: ${done}/${total} SP`);
      applyProgress(bar, { done, total, epicKey });
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
      'loaded — version 0.1.3',
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
