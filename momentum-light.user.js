// ==UserScript==
// @name         Momentum-Light
// @namespace    https://github.com/corentinpoisson44-collab/Momentum-Light
// @version      0.2.3
// @description  Augmente la Timeline JIRA (Plans / Advanced Roadmaps) — progression sur les Epics (SP done/total enfants), chiffrage SP centré sur les barres de tickets, et chip de vélocité moyenne des 5 derniers sprints, ancrée en sticky au sommet de la zone principale du plan.
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
  const OVERLAY_LABEL_CLASS = 'momentum-progress__label';
  const OVERLAY_ESTIMATE_MOD = 'momentum-progress--estimate';
  const VELOCITY_BANNER_ID = 'momentum-velocity-banner';

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

  // Rate-limited info-level logger for recurring signals we want visible
  // regardless of debug mode (e.g. bar discovery counts). Deduplicates the
  // same message so a quiet steady state doesn't spam the console.
  const heartbeat = (() => {
    let lastMsg = null;
    let lastAt = 0;
    return (...args) => {
      const msg = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
      const now = Date.now();
      if (msg === lastMsg && now - lastAt < 5_000) return;
      lastMsg = msg;
      lastAt = now;
      console.log(LOG_PREFIX, ...args);
    };
  })();

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
    async request(path, { method = 'GET', body } = {}) {
      const res = await fetch(path, {
        method,
        credentials: 'same-origin',
        headers: {
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          'X-Atlassian-Token': 'no-check',
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (!res.ok) {
        throw new Error(`JIRA API ${method} ${path} → HTTP ${res.status}`);
      }
      return res.json();
    },

    listFields() {
      return this.request('/rest/api/3/field');
    },

    // /rest/api/3/search (GET) was sunsetted by Atlassian (HTTP 410 Gone).
    // The replacement is POST /rest/api/3/search/jql with a JSON body.
    // https://developer.atlassian.com/cloud/jira/platform/changelog/#CHANGE-1304
    async searchIssues(jql, fields, maxResults = 100) {
      const data = await this.request('/rest/api/3/search/jql', {
        method: 'POST',
        body: { jql, fields, maxResults },
      });
      return data;
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
  // issueMeta — batched fetch of { isEpic, storyPoints } per issue key.
  // Multiple concurrent requests within a 50 ms window are coalesced into a
  // single `key in (...)` JQL query so expanding an Epic with 20 children
  // costs one API round-trip instead of 20.
  // ---------------------------------------------------------------------------

  const issueMeta = (() => {
    const ISSUE_TTL_MS = 60_000;
    const FLUSH_DELAY_MS = 50;
    const BATCH_MAX = 100;

    const cache = new Map(); // key -> { expiresAt, value }
    const waiters = new Map(); // key -> [{ resolve, reject }]
    let pending = new Set();
    let flushTimer = null;

    async function flush() {
      flushTimer = null;
      const keys = [...pending].slice(0, BATCH_MAX);
      pending = new Set([...pending].slice(BATCH_MAX));
      if (pending.size > 0) {
        flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
      }
      if (keys.length === 0) return;

      try {
        const spFieldId = await storyPointsField.resolve();
        const jql = `key in (${keys.map((k) => `"${k}"`).join(',')})`;
        const data = await jiraApi.searchIssues(jql, [spFieldId, 'issuetype'], keys.length);
        const results = new Map();
        for (const issue of data.issues || []) {
          const sp = Number(issue.fields?.[spFieldId]);
          const typeName = issue.fields?.issuetype?.name || '';
          const hierarchy = Number(issue.fields?.issuetype?.hierarchyLevel);
          // "Epic" by name OR hierarchyLevel >= 1 (covers custom hierarchies).
          const isEpic = /epic/i.test(typeName) || (Number.isFinite(hierarchy) && hierarchy >= 1);
          results.set(issue.key, {
            isEpic,
            storyPoints: Number.isFinite(sp) ? sp : null,
          });
        }
        const expiresAt = Date.now() + ISSUE_TTL_MS;
        for (const key of keys) {
          const value = results.get(key) || { isEpic: false, storyPoints: null };
          cache.set(key, { expiresAt, value });
          const ws = waiters.get(key) || [];
          waiters.delete(key);
          ws.forEach(({ resolve }) => resolve(value));
        }
      } catch (e) {
        for (const key of keys) {
          const ws = waiters.get(key) || [];
          waiters.delete(key);
          ws.forEach(({ reject }) => reject(e));
        }
      }
    }

    return {
      get(issueKey) {
        const hit = cache.get(issueKey);
        if (hit && hit.expiresAt > Date.now()) return Promise.resolve(hit.value);
        return new Promise((resolve, reject) => {
          if (!waiters.has(issueKey)) waiters.set(issueKey, []);
          waiters.get(issueKey).push({ resolve, reject });
          pending.add(issueKey);
          if (!flushTimer) flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
        });
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
  // velocity — average SP delivered across the last N closed sprints.
  // Uses the Agile REST API. Result is cached in memory for 5 min.
  //
  // Board selection order:
  //   1. localStorage override `momentum-light::velocity-board-id`
  //   2. boardId extracted from the URL (`/boards/<id>/…`)
  //   3. first scrum board returned by /rest/agile/1.0/board?type=scrum
  // ---------------------------------------------------------------------------

  const velocity = (() => {
    const BOARD_OVERRIDE_KEY = 'momentum-light::velocity-board-id';
    const SPRINT_WINDOW = 5;
    const CACHE_TTL_MS = 5 * 60_000;
    const MAX_CLOSED_SPRINTS_SCANNED = 200;

    let cache = null; // { expiresAt, value }
    let inflight = null;

    async function listScrumBoards() {
      const data = await jiraApi.request(
        '/rest/agile/1.0/board?type=scrum&maxResults=50',
      );
      return data.values || [];
    }

    async function listClosedSprints(boardId) {
      const all = [];
      let startAt = 0;
      const pageSize = 50;
      while (all.length < MAX_CLOSED_SPRINTS_SCANNED) {
        const data = await jiraApi.request(
          `/rest/agile/1.0/board/${boardId}/sprint?state=closed&startAt=${startAt}&maxResults=${pageSize}`,
        );
        const values = data.values || [];
        all.push(...values);
        if (data.isLast || values.length < pageSize) break;
        startAt += pageSize;
      }
      return all;
    }

    async function sprintDoneSP(sprintId, spFieldId) {
      const data = await jiraApi.request(
        `/rest/agile/1.0/sprint/${sprintId}/issue?fields=${encodeURIComponent(spFieldId)},status&maxResults=500`,
      );
      let done = 0;
      for (const issue of data.issues || []) {
        const sp = Number(issue.fields?.[spFieldId]);
        if (!Number.isFinite(sp) || sp <= 0) continue;
        const cat = issue.fields?.status?.statusCategory?.key;
        if (cat === 'done') done += sp;
      }
      return done;
    }

    function pickBoardFromUrl() {
      const m = location.pathname.match(/\/boards\/(\d+)/);
      return m ? Number(m[1]) : null;
    }

    async function resolveBoardId() {
      const override = localStorage.getItem(BOARD_OVERRIDE_KEY);
      if (override) return Number(override);
      const urlBoard = pickBoardFromUrl();
      if (urlBoard) return urlBoard;
      const boards = await listScrumBoards();
      if (!boards.length) throw new Error('No scrum board accessible for velocity');
      return boards[0].id;
    }

    async function compute() {
      const [spFieldId, boardId] = await Promise.all([
        storyPointsField.resolve(),
        resolveBoardId(),
      ]);

      const sprints = await listClosedSprints(boardId);
      if (!sprints.length) {
        return { average: 0, sprints: [], boardId, note: 'no closed sprints' };
      }
      // Most recently closed first. `completeDate` is the actual close time;
      // fall back to `endDate` then `startDate` so sprints without a close
      // stamp still sort reasonably.
      const byCloseDesc = (a, b) => {
        const ka = new Date(a.completeDate || a.endDate || a.startDate || 0).getTime();
        const kb = new Date(b.completeDate || b.endDate || b.startDate || 0).getTime();
        return kb - ka;
      };
      const recent = sprints.sort(byCloseDesc).slice(0, SPRINT_WINDOW);

      const perSprint = [];
      for (const s of recent) {
        const done = await sprintDoneSP(s.id, spFieldId);
        perSprint.push({ id: s.id, name: s.name, velocity: done });
      }
      const total = perSprint.reduce((acc, s) => acc + s.velocity, 0);
      const average = perSprint.length ? total / perSprint.length : 0;
      return { average, sprints: perSprint, boardId };
    }

    return {
      async get() {
        const now = Date.now();
        if (cache && cache.expiresAt > now) return cache.value;
        if (inflight) return inflight;
        inflight = (async () => {
          try {
            const value = await compute();
            cache = { expiresAt: Date.now() + CACHE_TTL_MS, value };
            return value;
          } finally {
            inflight = null;
          }
        })();
        return inflight;
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
        inset: 0;
        pointer-events: none;
        /* Pick up the bar's rounded corners so our fill matches the shape of
           the host bar (prevents the sharp-corner artifact at the ends). */
        border-radius: inherit;
        /* Clip the fill to the rounded rectangle. Safe: the native widgets
           that need to paint over our area (edge link-dots, icons, warnings)
           are siblings of this overlay — they are not inside it and are not
           affected by this overflow. */
        overflow: hidden;
      }
      .${OVERLAY_FILL_CLASS} {
        height: 100%;
        width: 0%;
        /* Darken the bar's own color instead of overlaying a fixed hue.
           A 30%-opaque black multiplied over the bar produces a shaded version
           of the bar color — orange stays orange, blue stays blue, etc. */
        background-color: rgba(0, 0, 0, 0.30);
        mix-blend-mode: multiply;
        transition: width 200ms ease-out;
      }
      .${OVERLAY_LABEL_CLASS} {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 0 8px;
        color: #fff;
        font-size: 11px;
        font-weight: 600;
        line-height: 1;
        letter-spacing: 0.02em;
        text-shadow: 0 1px 2px rgba(0, 0, 0, 0.55);
        pointer-events: none;
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
      }
      /* Ticket variant: no fill, label keeps the default centered alignment
         inherited from .momentum-progress__label (flex center + padding).
         The text-shadow keeps it legible on any bar color without needing
         the mix-blend-mode fill. */
      .${OVERLAY_ESTIMATE_MOD} .${OVERLAY_FILL_CLASS} {
        display: none;
      }
      /* Full-width sticky banner anchored at the top of the plan's main
         content area. "pointer-events: none" on the wrapper lets clicks
         reach the underlying UI through the transparent margin; the chip
         itself opts back in. The high z-index beats the timeline grid's
         own stacking context so it is never hidden behind rows or the
         date-header bar. */
      #${VELOCITY_BANNER_ID} {
        position: sticky;
        top: 0;
        z-index: 100;
        display: flex;
        justify-content: flex-end;
        box-sizing: border-box;
        width: 100%;
        margin: 0;
        padding: 8px 16px;
        background: transparent;
        pointer-events: none;
      }
      /* Fallback mode: if we couldn't find a main-content anchor, we fall
         back to fixed-positioned chip in the viewport top-right. */
      #${VELOCITY_BANNER_ID}[data-anchor="fixed"] {
        position: fixed;
        top: 88px;
        right: 16px;
        width: auto;
        padding: 0;
      }
      #${VELOCITY_BANNER_ID} .momentum-velocity-banner__chip {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 12px;
        border-radius: 14px;
        background: #DFE1E6;
        color: #172B4D;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 12px;
        line-height: 1.3;
        cursor: pointer;
        user-select: none;
        white-space: nowrap;
        pointer-events: auto;
        box-shadow: 0 1px 2px rgba(9, 30, 66, 0.12);
      }
      #${VELOCITY_BANNER_ID} .momentum-velocity-banner__chip:hover {
        background: #C1C7D0;
      }
      #${VELOCITY_BANNER_ID} .momentum-velocity-banner__label {
        font-weight: 500;
        color: #42526E;
      }
      #${VELOCITY_BANNER_ID} .momentum-velocity-banner__value {
        font-weight: 700;
        font-variant-numeric: tabular-nums;
      }
      #${VELOCITY_BANNER_ID}[data-state="error"] .momentum-velocity-banner__chip {
        background: #F4F5F7;
        color: #6B778C;
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

    // Testid prefixes — Atlassian occasionally tweaks the leaf segment
    // (e.g. `.date-content.bar` vs `.bar` vs `.content`), so we match by
    // prefix rather than exact string to stay resilient across DOM revisions.
    const CHART_CONTENT_TESTID_PREFIX = 'roadmap.timeline-table-kit.ui.chart-item-content';
    const ROW_TESTID_PREFIX = 'roadmap.timeline-table-kit.ui.row';
    // Anchor used as a fallback — the native progress-wrapper is reliably rendered
    // per Epic in the list-side summary cell.
    const PROGRESS_WRAPPER_SELECTOR =
      '[data-testid="common.components.progress-bar.progress-wrapper"]';
    const KEY_CELL_SELECTOR =
      '[data-testid="roadmap.timeline-table-kit.ui.list-item-content.summary.key"]';

    // Geometric filters to tell a real Epic bar from a corner widget (link
    // dots, resize handles) or a near-square chip (warning lozenges, link
    // icons). Replaces a testid blacklist — Atlassian's widget naming is
    // not stable enough to rely on.
    //
    //   - Drag handles / link dots: ~12–16 px squares → caught by min width.
    //   - Warning lozenges / link icons: ~22–32 px squares (aspect ≈ 1) →
    //     caught by the aspect-ratio rule.
    //   - Real Epic bars: always significantly wider than tall (they span
    //     days/weeks/months) → pass both filters.
    const BAR_MIN_WIDTH = 24;
    const BAR_MIN_HEIGHT = 12;
    const BAR_MIN_ASPECT = 2; // width / height

    function hasChartPrefix(el) {
      const tid = el.getAttribute('data-testid') || '';
      return tid.startsWith(CHART_CONTENT_TESTID_PREFIX);
    }

    function isBarSized(el) {
      const rect = el.getBoundingClientRect();
      if (rect.width < BAR_MIN_WIDTH || rect.height < BAR_MIN_HEIGHT) return false;
      if (rect.width < rect.height * BAR_MIN_ASPECT) return false;
      return true;
    }

    // From a list of candidate elements, return only those that do NOT contain
    // another candidate — i.e. the deepest matches. This lets us target the
    // actual visible bar and avoid decorating its wrapping containers.
    function leavesOnly(candidates) {
      return candidates.filter(
        (el) => !candidates.some((other) => other !== el && el.contains(other)),
      );
    }

    function findBars(root) {
      // Strategy 1 — every testid starting with the chart-item-content prefix.
      // Pick the deepest matches (leaves), then drop anything smaller than a
      // real bar to keep out the corner link-dots / resize handles that share
      // the same prefix.
      const prefixHits = [...root.querySelectorAll('[data-testid]')].filter(hasChartPrefix);
      if (prefixHits.length > 0) {
        const leaves = leavesOnly(prefixHits);
        const bars = leaves.filter(isBarSized);
        if (isDebug()) {
          debug(
            'findBars → prefix hits:', prefixHits.length,
            'leaves:', leaves.length,
            'bars:', bars.length,
          );
        }
        return bars;
      }

      // Strategy 2 — walk up from each progress-wrapper to the row container,
      // then descend to pick any descendant whose testid references "chart".
      // Progress-wrapper usually sits on the list side; the row is the shared
      // ancestor that also owns the chart side.
      const wrappers = root.querySelectorAll(PROGRESS_WRAPPER_SELECTOR);
      const found = new Set();
      for (const w of wrappers) {
        let cursor = w.parentElement;
        let steps = 0;
        let row = null;
        while (cursor && cursor !== document.body && steps < 20) {
          const tid = cursor.getAttribute?.('data-testid') || '';
          if (tid.startsWith(ROW_TESTID_PREFIX)) {
            row = cursor;
            break;
          }
          cursor = cursor.parentElement;
          steps += 1;
        }
        if (!row) continue;
        const chartHits = [...row.querySelectorAll('[data-testid]')].filter(hasChartPrefix);
        leavesOnly(chartHits).filter(isBarSized).forEach((leaf) => found.add(leaf));
      }
      if (isDebug()) {
        debug('findBars → prefix:0, wrappers:', wrappers.length, 'row-scan resolved:', found.size);
      }
      return [...found];
    }

    // Diagnostic probe — runs when findBars returns empty. Collects testid
    // stats + the ancestor chain of a progress-wrapper, and stores them on
    // `window.__MOMENTUM_PROBE__` so they survive console truncation (the user
    // can inspect the live object or `JSON.stringify(window.__MOMENTUM_PROBE__)`
    // any time without racing the rate limit). Rate-limited to once per 3 s.
    let lastProbeAt = 0;
    function probeCandidates(root) {
      const now = Date.now();
      if (now - lastProbeAt < 3_000) return;
      lastProbeAt = now;

      const counts = new Map();
      root.querySelectorAll('[data-testid]').forEach((el) => {
        const id = el.getAttribute('data-testid');
        if (!id) return;
        counts.set(id, (counts.get(id) || 0) + 1);
      });
      const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);

      const top = sorted.slice(0, 20).map(([testid, count]) => ({ testid, count }));
      const chartHits = sorted
        .filter(([id]) => id.toLowerCase().includes('chart'))
        .map(([testid, count]) => ({ testid, count }));
      const rowHits = sorted
        .filter(([id]) => id.toLowerCase().includes('row'))
        .map(([testid, count]) => ({ testid, count }));

      let wrapperChain = null;
      const firstPw = root.querySelector(PROGRESS_WRAPPER_SELECTOR);
      if (firstPw) {
        wrapperChain = [];
        let cursor = firstPw;
        let steps = 0;
        while (cursor && cursor !== document.body && steps < 15) {
          const tid = cursor.getAttribute?.('data-testid') || '';
          const tag = (cursor.tagName || '').toLowerCase();
          wrapperChain.push(tid ? `${tag}[testid="${tid}"]` : tag);
          cursor = cursor.parentElement;
          steps += 1;
        }
      }

      // Persist for post-hoc inspection. The user can run
      //   copy(JSON.stringify(window.__MOMENTUM_PROBE__, null, 2))
      // in DevTools to reliably extract the full probe without console truncation.
      window.__MOMENTUM_PROBE__ = {
        timestamp: new Date().toISOString(),
        totalUniqueTestids: sorted.length,
        top20: top,
        chartHits,
        rowHits,
        firstProgressWrapperAncestorChain: wrapperChain,
        allTestids: sorted.map(([testid, count]) => ({ testid, count })),
      };

      warn(
        `probe — ${sorted.length} unique testids on page | chart:${chartHits.length} | row:${rowHits.length}`,
      );
      warn('probe — full dump at window.__MOMENTUM_PROBE__ — run `copy(JSON.stringify(window.__MOMENTUM_PROBE__, null, 2))`');
      warn('probe — top 20:', top);
      warn('probe — chart-related testids:', chartHits);
      warn('probe — row-related testids:', rowHits);
      if (wrapperChain) {
        warn('probe — ancestor chain of first progress-wrapper:\n' + wrapperChain.join('\n  ↑ '));
      } else {
        warn('probe — no progress-wrapper found either');
      }
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
      // In-bar label: "X / Y SP" rendered on top of the fill/bar for
      // at-a-glance reading without hovering. The label sits in its own
      // absolutely-positioned element so the mix-blend-mode on the fill does
      // not affect the text color.
      const label = document.createElement('div');
      label.className = OVERLAY_LABEL_CLASS;
      overlay.appendChild(label);
      // Insert as the FIRST child of the bar so the native widgets that JIRA
      // renders inside the bar (edge link-creation dots, link icons, warning
      // triangles) paint on top of our overlay via natural DOM order — no
      // z-index juggling needed.
      bar.insertBefore(overlay, bar.firstChild);
      return overlay;
    }

    function removeOverlay(bar) {
      const overlay = bar.querySelector(`:scope > .${OVERLAY_CLASS}`);
      if (overlay) overlay.remove();
    }

    function applyProgress(bar, { done, total, epicKey }) {
      if (!total || total <= 0) {
        removeOverlay(bar);
        delete bar.dataset.momentumTooltip;
        return;
      }
      const pct = Math.max(0, Math.min(100, (done / total) * 100));
      const pctStr = `${pct.toFixed(1)}%`;

      const overlay = ensureOverlay(bar);
      overlay.classList.remove(OVERLAY_ESTIMATE_MOD);
      const fill = overlay.querySelector(`.${OVERLAY_FILL_CLASS}`);
      const label = overlay.querySelector(`.${OVERLAY_LABEL_CLASS}`);
      if (fill) fill.style.width = pctStr;
      if (label) label.textContent = `${done} / ${total} SP`;

      // Tooltip text — the interceptor (installed at bootstrap) will rewrite
      // JIRA's Atlaskit tooltip with this value when it appears on hover.
      // aria-label and title are set as accessibility/fallback hints.
      const tooltipText = `${epicKey} — ${done} / ${total} SP (${pct.toFixed(0)}%)`;
      bar.dataset.momentumTooltip = tooltipText;
      bar.setAttribute('aria-label', tooltipText);
      bar.title = tooltipText;
    }

    // Non-Epic variant: just paint the ticket's SP estimate as a chip on the
    // bar. No fill — tickets aren't "x% done", they're just sized at X SP.
    // If the ticket has no SP, we silently skip (no overlay, no noise).
    function applyEstimate(bar, { sp, issueKey }) {
      if (sp == null || !(sp > 0)) {
        removeOverlay(bar);
        delete bar.dataset.momentumTooltip;
        return;
      }
      const overlay = ensureOverlay(bar);
      overlay.classList.add(OVERLAY_ESTIMATE_MOD);
      const label = overlay.querySelector(`.${OVERLAY_LABEL_CLASS}`);
      if (label) label.textContent = `${sp} SP`;

      const tooltipText = `${issueKey} — ${sp} SP`;
      bar.dataset.momentumTooltip = tooltipText;
      bar.setAttribute('aria-label', tooltipText);
      bar.title = tooltipText;
    }

    async function decorateBar(bar) {
      const issueKey = extractIssueKey(bar);
      if (!issueKey) {
        if (isDebug()) debug('no issue key resolved for a bar — skipping');
        return;
      }

      const previous = decorated.get(bar);
      const isRefresh = previous && previous.issueKey === issueKey;
      if (!isRefresh) decorated.set(bar, { issueKey });

      const meta = await issueMeta.get(issueKey);
      if (meta.isEpic) {
        const { done, total } = await epicProgress.get(issueKey);
        if (isDebug() && !isRefresh) debug(`${issueKey} (epic): ${done}/${total} SP`);
        applyProgress(bar, { done, total, epicKey: issueKey });
      } else {
        if (isDebug() && !isRefresh) debug(`${issueKey} (ticket): ${meta.storyPoints ?? '—'} SP`);
        applyEstimate(bar, { sp: meta.storyPoints, issueKey });
      }
    }

    return { findBars, decorateBar, probeCandidates };
  })();

  // ---------------------------------------------------------------------------
  // velocityBanner — sticky chip rendered at the top of the plan's main
  // content region, showing the average velocity of the last N closed
  // sprints. Click the chip to refresh.
  //
  // Anchor strategy:
  //   1. Primary: `[role="main"]` (or `<main>`). We prepend the wrapper
  //      so the chip sticks to the top of the plan's main region. The
  //      wrapper is `position: sticky` with `z-index: 100` so it stays
  //      visible above the timeline grid during scroll.
  //   2. Fallback: if no main-region anchor is found, we attach the
  //      wrapper to `document.body` with `position: fixed` (top-right).
  //      Better a slightly floating chip than no chip at all.
  //
  // The wrapper is `pointer-events: none` over its transparent margins so
  // it never steals clicks from the UI underneath — only the visible chip
  // is clickable.
  // ---------------------------------------------------------------------------

  const velocityBanner = (() => {
    function findAnchor() {
      // Prefer a semantic main region — that's the plan's content area.
      const main =
        document.querySelector('[role="main"]') ||
        document.querySelector('main');
      if (main) return { el: main, mode: 'sticky' };
      return { el: document.body, mode: 'fixed' };
    }

    function build(mode) {
      const wrapper = document.createElement('div');
      wrapper.id = VELOCITY_BANNER_ID;
      wrapper.dataset.anchor = mode;
      const chip = document.createElement('span');
      chip.className = 'momentum-velocity-banner__chip';
      chip.title = 'Cliquez pour rafraîchir';
      chip.innerHTML =
        '<span class="momentum-velocity-banner__label">Vélocité moyenne (5 derniers sprints)</span>' +
        '<span class="momentum-velocity-banner__value">…</span>';
      chip.addEventListener('click', () => {
        const value = chip.querySelector('.momentum-velocity-banner__value');
        if (value) value.textContent = '…';
        update();
      });
      wrapper.appendChild(chip);
      return wrapper;
    }

    function ensure() {
      const anchor = findAnchor();
      if (!anchor) return null;

      const existing = document.getElementById(VELOCITY_BANNER_ID);
      // Happy path: still connected AND attached to the expected anchor.
      const stillValid =
        existing &&
        existing.isConnected &&
        ((anchor.mode === 'sticky' && existing.parentElement === anchor.el) ||
          (anchor.mode === 'fixed' && existing.parentElement === document.body));
      if (stillValid) return existing;
      if (existing) existing.remove();

      const el = build(anchor.mode);
      if (anchor.mode === 'sticky') {
        anchor.el.insertBefore(el, anchor.el.firstChild);
      } else {
        document.body.appendChild(el);
      }
      return el;
    }

    function remove() {
      const el = document.getElementById(VELOCITY_BANNER_ID);
      if (el) el.remove();
    }

    let updating = false;
    async function update() {
      const el = ensure();
      if (!el || updating) return;
      updating = true;
      try {
        const { average, sprints } = await velocity.get();
        const chip = el.querySelector('.momentum-velocity-banner__chip');
        const value = el.querySelector('.momentum-velocity-banner__value');
        if (sprints.length === 0) {
          value.textContent = 'N/A';
          el.dataset.state = 'error';
          if (chip) chip.title = 'Aucun sprint clos trouvé';
          return;
        }
        value.textContent = `${Math.round(average)} SP`;
        el.dataset.state = 'ok';
        const breakdown = sprints
          .map((s) => `${s.name}: ${s.velocity} SP`)
          .join('\n');
        if (chip) {
          chip.title = `Moyenne de ${sprints.length} sprint(s) clos :\n${breakdown}\n(cliquer pour rafraîchir)`;
        }
      } catch (e) {
        const chip = el.querySelector('.momentum-velocity-banner__chip');
        const value = el.querySelector('.momentum-velocity-banner__value');
        if (value) value.textContent = 'N/A';
        el.dataset.state = 'error';
        if (chip) chip.title = `Vélocité indisponible : ${e?.message || e}`;
        warn('velocity error:', e?.message || e);
      } finally {
        updating = false;
      }
    }

    return { ensure, remove, update };
  })();

  // ---------------------------------------------------------------------------
  // Feature registry — add future Momentum features here
  // ---------------------------------------------------------------------------

  const isTimelineLikePath = () => {
    const p = location.pathname;
    return p.includes('/plans/') || p.includes('/timeline');
  };

  const features = [
    {
      id: 'timeline-bar-overlays',
      description:
        'Overlays on timeline bars: progress on Epics (SP done / total of children) ' +
        'and SP estimate on ticket bars.',
      isActive: isTimelineLikePath,
      async onMutation(root) {
        const bars = timelineDom.findBars(root);
        // Always-on heartbeat (rate-limited) so we can tell from console whether
        // the feature is finding bars, without having to enable debug mode.
        heartbeat('timeline bars found:', bars.length);
        if (bars.length === 0) {
          // Unconditional probe — we need the diagnostic data even if the user
          // didn't flip on debug mode. Rate-limited internally.
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
    {
      id: 'sprint-velocity-banner',
      description: 'Fixed banner showing the average velocity of the last 3 closed sprints.',
      isActive: isTimelineLikePath,
      onMutation() {
        // `update()` is idempotent and piggybacks on the 5 min velocity cache,
        // so calling it on every debounced mutation is cheap.
        velocityBanner.update();
      },
      onInactive() {
        // User navigated away from a timeline/plan page — clean up so the
        // banner doesn't linger on unrelated views.
        velocityBanner.remove();
      },
    },
  ];

  // ---------------------------------------------------------------------------
  // tooltipInterceptor — rewrite JIRA's tooltip when it appears for one of our
  // decorated wrappers. JIRA uses Atlaskit's React tooltip whose content is a
  // React prop (not a DOM attribute), so we can't set it with title/aria-label.
  // Strategy: MutationObserver on document.body, and whenever a [role="tooltip"]
  // node is added, figure out which element it belongs to. If the trigger has
  // a data-momentum-tooltip attribute, replace the tooltip's textContent with
  // that value and keep it replaced if React re-renders the tooltip body.
  // ---------------------------------------------------------------------------

  const tooltipInterceptor = (() => {
    let installed = false;

    function findTrigger(tooltip) {
      // Strategy 1: aria-describedby wiring (Atlaskit's default pattern).
      if (tooltip.id) {
        try {
          const t = document.querySelector(
            `[aria-describedby~="${CSS.escape(tooltip.id)}"]`,
          );
          if (t) return t;
        } catch (_) { /* CSS.escape missing on very old browsers */ }
      }
      // Strategy 2: currently-hovered ancestor chain.
      const hovered = document.querySelectorAll(':hover');
      for (const el of hovered) {
        if (el instanceof HTMLElement && el.dataset && el.dataset.momentumTooltip) {
          return el;
        }
      }
      return null;
    }

    function lockTooltipText(tooltip, newText) {
      if (tooltip.dataset.momentumLocked === '1') return;
      tooltip.dataset.momentumLocked = '1';
      const apply = () => {
        if (tooltip.textContent !== newText) {
          tooltip.textContent = newText;
        }
      };
      apply();
      // React may re-render the tooltip's inner body; keep our text locked
      // until the tooltip is detached.
      const inner = new MutationObserver(apply);
      inner.observe(tooltip, { childList: true, subtree: true, characterData: true });
    }

    function onAddedNode(node) {
      if (!(node instanceof HTMLElement)) return;
      const tooltips = node.matches?.('[role="tooltip"]')
        ? [node]
        : [...(node.querySelectorAll?.('[role="tooltip"]') || [])];
      for (const tip of tooltips) {
        const trigger = findTrigger(tip);
        if (!trigger) continue;
        const text = trigger.dataset?.momentumTooltip;
        if (!text) continue;
        lockTooltipText(tip, text);
      }
    }

    return {
      install() {
        if (installed) return;
        installed = true;
        const obs = new MutationObserver((mutations) => {
          for (const m of mutations) {
            for (const n of m.addedNodes) onAddedNode(n);
          }
        });
        obs.observe(document.body, { childList: true, subtree: true });
      },
    };
  })();

  // ---------------------------------------------------------------------------
  // Bootstrap
  // ---------------------------------------------------------------------------

  function runActiveFeatures() {
    const root = document.body;
    if (!root) return;
    for (const feature of features) {
      try {
        if (feature.isActive()) {
          feature.onMutation?.(root);
        } else {
          feature.onInactive?.();
        }
      } catch (e) {
        error(`feature "${feature.id}" crashed:`, e);
      }
    }
  }

  function bootstrap() {
    ensureStyles();
    tooltipInterceptor.install();
    const onMutation = debounce(runActiveFeatures, MUTATION_DEBOUNCE_MS);
    const observer = new MutationObserver(onMutation);
    observer.observe(document.body, { childList: true, subtree: true });
    // Initial pass (in case the timeline is already rendered at document-idle).
    runActiveFeatures();
    log(
      'loaded — version 0.2.3',
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
