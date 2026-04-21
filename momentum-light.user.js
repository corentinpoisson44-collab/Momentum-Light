// ==UserScript==
// @name         Momentum-Light
// @namespace    https://github.com/corentinpoisson44-collab/Momentum-Light
// @version      0.8.0
// @description  Augmente la Timeline JIRA (Plans / Advanced Roadmaps) — progression sur les Epics (SP done/total enfants), chiffrage SP centré sur les barres de tickets, chip de vélocité moyenne des 5 derniers sprints (calculée via le Sprint Report comme dans l'UI Backlog), indicateur de remplissage sur chaque chip de sprint actif/futur vs. la vélocité moyenne, macro-estimation T-Shirt (XS/S/M/L/XL → SP) avec badge discret sur la barre d'Epic, projection de fin de sprint et indicateur de sur/sous-cadrage dans le tooltip, menu « How-to » guidé qui surligne chaque feature au premier lancement, toggle « Vue PM / Vue Business » qui remplace les overlays de chiffrage par la date d'atterrissage (duedate) de chaque Epic, et surcharge du menu Export → Image (.png) qui capture la Timeline au format natif (via html2canvas) avec tous les overlays Momentum-Light visibles dessus.
// @author       corentinpoisson44
// @match        https://*.atlassian.net/*
// @run-at       document-idle
// @grant        none
// @require      https://cdn.jsdelivr.net/npm/html2canvas@1.4.1/dist/html2canvas.min.js
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
  // DOM-side: Jira re-renders the timeline in dozens of micro-mutations, so we
  // wait a bit to coalesce them into a single feature pass.
  const MUTATION_DEBOUNCE_MS = 200;
  // API-side: a ticket move fires at most a couple of requests (REST + GraphQL
  // mirror). We just want to coalesce that burst, not wait for anything else,
  // so this debounce is kept tight to minimise perceived update latency.
  const API_MUTATION_DEBOUNCE_MS = 50;
  const OVERLAY_CLASS = 'momentum-progress';
  const OVERLAY_FILL_CLASS = 'momentum-progress__fill';
  const OVERLAY_LABEL_CLASS = 'momentum-progress__label';
  const OVERLAY_ESTIMATE_MOD = 'momentum-progress--estimate';
  const OVERLAY_SPRINT_FILL_MOD = 'momentum-progress--sprint-fill';
  const VELOCITY_BANNER_ID = 'momentum-velocity-banner';
  const CONFIDENCE_LEGEND_CLASS = 'momentum-confidence-legend';
  const SIZE_LEGEND_CLASS = 'momentum-size-legend';
  const HOWTO_BUTTON_ID = 'momentum-howto-button';
  const HOWTO_OVERLAY_ID = 'momentum-howto-overlay';
  const HOWTO_SEEN_KEY = 'momentum-light::howto-seen';
  const OVERLAY_TSHIRT_CLASS = 'momentum-progress__tshirt';
  // View-mode toggle — "pm" (default, full chiffrage overlays) vs "business"
  // (Epic bars show only their landing date; ticket overlays are hidden).
  const VIEW_MODE_KEY = 'momentum-light::view-mode';
  const VIEW_MODE_PM = 'pm';
  const VIEW_MODE_BUSINESS = 'business';
  const VIEW_TOGGLE_CLASS = 'momentum-view-toggle';
  const OVERLAY_LANDING_MOD = 'momentum-progress--landing';

  // ---------------------------------------------------------------------------
  // Macro-estimation (T-Shirt sizing) — each Epic-level size bucket is mapped
  // to a Story Point budget. The scale follows a Fibonacci-ish curve to
  // reflect the growing uncertainty of larger scopes. Tweak the numbers
  // below to recalibrate for your team (XS ≈ a few days of work, XL ≈ about
  // a quarter). The KEYS are what JIRA stores in the custom field, so leave
  // them unchanged unless you also remap your JIRA field options.
  //
  // `TSHIRT_FIELD_NAME` must match the exact display name of the JIRA
  // custom field that holds the size (case-insensitive). If the field is
  // absent, every T-Shirt feature silently no-ops.
  // ---------------------------------------------------------------------------
  const TSHIRT_SIZE_SP = {
    XS: 3,
    S: 8,
    M: 20,
    L: 40,
    XL: 80,
  };
  // Sprint-count convention exposed to the team via the legend chip. Purely
  // informational — the macro-estimation math still runs off TSHIRT_SIZE_SP.
  // Follows the Fibonacci pattern used by most agile shops (1, 2, 3, 5, 8, 13).
  const TSHIRT_SIZE_SPRINTS = {
    XS: 1,
    S: 2,
    M: 3,
    L: 5,
    XL: 8,
    XXL: 13,
  };
  const TSHIRT_FIELD_NAME = 'T-Shirt Sizing';
  // Sizing-drift tolerance window — ratio of (real child SP) / (macro size SP).
  // Below UNDER → Epic was optimistically under-sized; above OVER → dépassement.
  // The drift state is shown in the tooltip only (kept subtle on the badge).
  const TSHIRT_DRIFT_UNDER = 0.7;
  const TSHIRT_DRIFT_OVER = 1.3;

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

  // Rate-limited heartbeat logger. Suppressed entirely when debug mode is off
  // (the steady-state mutation loop can emit the same signals tens of times
  // per minute; useful for diagnosis but noisy for end users). In debug mode,
  // each unique message fires at most once per 30 s so state changes still
  // show through without flooding.
  const heartbeat = (() => {
    const lastByMsg = new Map();
    const TTL_MS = 30_000;
    const MAX_KEYS = 40;
    return (...args) => {
      if (!isDebug()) return;
      const msg = args.map((a) => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
      const now = Date.now();
      const prev = lastByMsg.get(msg) || 0;
      if (now - prev < TTL_MS) return;
      lastByMsg.set(msg, now);
      if (lastByMsg.size > MAX_KEYS) {
        const oldestKey = lastByMsg.keys().next().value;
        lastByMsg.delete(oldestKey);
      }
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

  // perfMark / perfStamp — tiny timing instrument used to trace the
  // sprint-fill update pipeline in debug mode. `perfMark(reason)` starts
  // a fresh clock; `perfStamp(reason)` logs ms elapsed since the last
  // mark, but only within PERF_WINDOW_MS of that mark — otherwise the
  // stamp has no meaningful correlation with any user action (the DOM
  // observer re-runs the pipeline every ~200 ms regardless). No-op when
  // debug mode is off.
  const PERF_WINDOW_MS = 5_000;
  let lastPerfMarkAt = null;
  function perfNow() {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
  }
  function perfMark(reason) {
    lastPerfMarkAt = perfNow();
    if (isDebug()) console.log(LOG_PREFIX, `[t=0] ${reason}`);
  }
  function perfStamp(reason) {
    if (!isDebug()) return;
    if (lastPerfMarkAt == null) return;
    const t = perfNow() - lastPerfMarkAt;
    if (t > PERF_WINDOW_MS) return; // stale mark → skip silently
    console.log(LOG_PREFIX, `[t=${Math.round(t)}] ${reason}`);
  }

  // ---------------------------------------------------------------------------
  // viewMode — "pm" (default) vs "business". Persisted in localStorage so a
  // refresh keeps the toggle where the user left it. Consumers subscribe via
  // `onChange(cb)` — the velocity banner re-paints its toggle, and the main
  // bootstrap re-runs the feature pipeline so every Epic bar is re-decorated
  // under the new mode without waiting for the next DOM mutation.
  // ---------------------------------------------------------------------------
  const viewMode = (() => {
    const listeners = new Set();
    function read() {
      try {
        const v = localStorage.getItem(VIEW_MODE_KEY);
        return v === VIEW_MODE_BUSINESS ? VIEW_MODE_BUSINESS : VIEW_MODE_PM;
      } catch (_) {
        return VIEW_MODE_PM;
      }
    }
    let current = read();
    function syncBody() {
      if (document.body) document.body.dataset.momentumView = current;
    }
    function get() { return current; }
    function set(next) {
      if (next !== VIEW_MODE_PM && next !== VIEW_MODE_BUSINESS) return;
      if (next === current) return;
      current = next;
      try { localStorage.setItem(VIEW_MODE_KEY, next); } catch (_) { /* private mode */ }
      syncBody();
      for (const cb of listeners) {
        try { cb(current); } catch (e) { warn('viewMode listener error:', e?.message || e); }
      }
    }
    function onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    }
    return { get, set, onChange, syncBody };
  })();

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
  // sprintField — dynamic discovery of the Sprint custom field id (mirror of
  // storyPointsField). Needed so we can bucket issues returned by a single
  // "sprint in (a,b,c)" JQL into their respective sprints without issuing one
  // /rest/agile/1.0/sprint/{id}/issue call per sprint.
  // ---------------------------------------------------------------------------

  const sprintField = (() => {
    const CACHE_KEY = 'momentum-light::sprint-field-id';
    let inflight = null;

    return {
      async resolve() {
        const cached = sessionStorage.getItem(CACHE_KEY);
        if (cached) return cached;
        if (inflight) return inflight;

        inflight = (async () => {
          const fields = await jiraApi.listFields();
          // The sprint field is an Atlassian-managed custom field whose
          // schema.custom ends with ":gh-sprint". Match on that primarily,
          // fall back to name === "sprint" for older instances.
          const match =
            fields.find((f) => String(f.schema?.custom || '').endsWith(':gh-sprint')) ||
            fields.find((f) => (f.name || '').toLowerCase().trim() === 'sprint');
          if (!match) {
            throw new Error('Sprint custom field not found on this instance');
          }
          sessionStorage.setItem(CACHE_KEY, match.id);
          log('Sprint field resolved:', match.id, `(${match.name})`);
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
  // tshirtSizeField — dynamic discovery of the T-Shirt Sizing custom field id
  // (configurable via TSHIRT_FIELD_NAME). Shape mirrors storyPointsField, but
  // resolves to `null` (instead of throwing) when the field isn't present —
  // macro-estimation is optional, everything else must keep working even on
  // instances that don't configure it. The miss is cached with a sentinel
  // so we don't re-scan /rest/api/3/field on every Epic decoration.
  // ---------------------------------------------------------------------------

  const tshirtSizeField = (() => {
    const CACHE_KEY = 'momentum-light::tshirt-field-id';
    const MISS_SENTINEL = '__absent__';
    let inflight = null;

    return {
      async resolve() {
        const cached = sessionStorage.getItem(CACHE_KEY);
        if (cached === MISS_SENTINEL) return null;
        if (cached) return cached;
        if (inflight) return inflight;

        inflight = (async () => {
          const fields = await jiraApi.listFields();
          const wanted = TSHIRT_FIELD_NAME.toLowerCase().trim();
          const match = fields.find(
            (f) => (f.name || '').toLowerCase().trim() === wanted,
          );
          if (!match) {
            sessionStorage.setItem(CACHE_KEY, MISS_SENTINEL);
            warn(
              `T-Shirt Sizing field "${TSHIRT_FIELD_NAME}" not found — ` +
              'macro-estimation features will be disabled.',
            );
            return null;
          }
          sessionStorage.setItem(CACHE_KEY, match.id);
          log('T-Shirt Sizing field resolved:', match.id, `(${match.name})`);
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

  // Normalize a raw JIRA custom-field value into a canonical T-Shirt size key
  // (one of XS|S|M|L|XL), or null if absent / unknown. JIRA "single-select"
  // fields return `{ value: 'M', id: '10042', … }` objects; text fields
  // return a plain string. Anything that doesn't map to a known bucket
  // (e.g. 'XXL' when the team only defined XS-XL) is treated as absent so
  // the downstream code can't assign an SP budget it doesn't know about.
  function normalizeTshirtSize(raw) {
    if (raw == null) return null;
    const value = typeof raw === 'string' ? raw : raw.value;
    if (!value) return null;
    const upper = String(value).toUpperCase().trim();
    return Object.prototype.hasOwnProperty.call(TSHIRT_SIZE_SP, upper)
      ? upper
      : null;
  }

  // ---------------------------------------------------------------------------
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
        // Resolve the T-Shirt field in parallel with Story Points; a miss
        // returns null and is absorbed below (macro-estimation optional).
        const [spFieldId, tshirtFieldId] = await Promise.all([
          storyPointsField.resolve(),
          tshirtSizeField.resolve().catch(() => null),
        ]);
        const jql = `key in (${keys.map((k) => `"${k}"`).join(',')})`;
        const fieldList = [spFieldId, 'issuetype', 'status', 'duedate'];
        if (tshirtFieldId) fieldList.push(tshirtFieldId);
        const data = await jiraApi.searchIssues(jql, fieldList, keys.length);
        const results = new Map();
        for (const issue of data.issues || []) {
          const sp = Number(issue.fields?.[spFieldId]);
          const typeName = issue.fields?.issuetype?.name || '';
          const hierarchy = Number(issue.fields?.issuetype?.hierarchyLevel);
          // "Epic" by name OR hierarchyLevel >= 1 (covers custom hierarchies).
          const isEpic = /epic/i.test(typeName) || (Number.isFinite(hierarchy) && hierarchy >= 1);
          // statusCategory key ∈ {'new' (≈ Open/To Do/Discovery),
          // 'indeterminate' (≈ In Progress), 'done'}. Used downstream to
          // restrict the confidence hatch to Epics still in discovery.
          const statusCategory = issue.fields?.status?.statusCategory?.key || null;
          const tshirtSize = tshirtFieldId
            ? normalizeTshirtSize(issue.fields?.[tshirtFieldId])
            : null;
          // Landing date (duedate) — populated in the Business view as the
          // Epic's "date d'atterrissage". Raw ISO string (YYYY-MM-DD) or null.
          const dueDate = issue.fields?.duedate || null;
          results.set(issue.key, {
            isEpic,
            storyPoints: Number.isFinite(sp) ? sp : null,
            statusCategory,
            tshirtSize,
            dueDate,
          });
        }
        const expiresAt = Date.now() + ISSUE_TTL_MS;
        for (const key of keys) {
          const value = results.get(key) || {
            isEpic: false,
            storyPoints: null,
            statusCategory: null,
            tshirtSize: null,
            dueDate: null,
          };
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
        [spFieldId, 'status', 'issuetype'],
        100,
      );
      let done = 0;
      let total = 0;
      let countedChildren = 0;
      // childStats counts TICKETS (not SP) across all children, including
      // those without SP — used by the confidence score to reflect both
      // delivery progress and chiffrage completeness. A child with no SP
      // contributes 0 to confidence regardless of its status.
      const childStats = {
        done: 0,
        inProgress: 0,
        todo: 0,
        unestimated: 0,
        totalChildren: 0,
      };
      // Type allow-list: epic progress & confidence reflect only the
      // "real work" tickets — Stories, Technical Stories and Bugs. Tasks,
      // Sub-tasks and Tests are treated as plumbing and excluded from both
      // the SP progress bar and the confidence score. The regex covers
      // French/English variants ("User Story", "Story technique", "Bug",
      // etc.) while rejecting "Task", "Test", "Sub-task", "Epic".
      const COUNTABLE_TYPE = /story|bug/i;
      for (const issue of data.issues || []) {
        const typeName = issue.fields?.issuetype?.name || '';
        if (!COUNTABLE_TYPE.test(typeName)) continue;
        // Exclude CANCELED tickets entirely — they land in the "done"
        // status category in JIRA but do NOT represent delivered work, so
        // counting them would inflate both progress and confidence.
        const statusName = issue.fields?.status?.name || '';
        if (/^cancel/i.test(statusName)) continue;
        childStats.totalChildren += 1;
        const sp = Number(issue.fields?.[spFieldId]);
        const cat = issue.fields?.status?.statusCategory?.key;
        const hasSp = Number.isFinite(sp) && sp > 0;
        if (!hasSp) {
          childStats.unestimated += 1;
          continue;
        }
        countedChildren += 1;
        total += sp;
        if (cat === 'done') {
          done += sp;
          childStats.done += 1;
        } else if (cat === 'indeterminate') {
          childStats.inProgress += 1;
        } else {
          childStats.todo += 1;
        }
      }
      // Confidence = (done × 1.0 + inProgress × 0.6 + todo × 0.15) / total × 100
      // Unestimated children count in the denominator but contribute 0 to
      // the numerator — so incomplete chiffrage drags the score down.
      const denom = childStats.totalChildren;
      const confidence = denom > 0
        ? ((childStats.done * 1.0
            + childStats.inProgress * 0.6
            + childStats.todo * 0.15) / denom) * 100
        : 0;
      return { done, total, countedChildren, childStats, confidence };
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
  //
  // Sprint SP completion is read from the Greenhopper Sprint Report
  // (`/rest/greenhopper/1.0/rapid/charts/sprintreport`) — the same source
  // Jira's Backlog "Sprint commitment" widget uses. This matters: listing
  // a sprint's issues via the Agile API and summing current `done` SP
  // over-counts, because an issue that lived in this sprint and was later
  // moved and completed in a subsequent sprint still reads as `done` today.
  // The Sprint Report only counts issues that were actually completed
  // within the sprint, matching Jira's official velocity figure.
  //
  // Falls back to the Agile-API count if the Greenhopper endpoint is
  // unreachable (very rare on Cloud, but worth guarding).
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

    // Active + future sprints of a board — the "open" sprints we overlay
    // with a fill indicator on the timeline's Sprints row.
    async function listOpenSprints(boardId) {
      const all = [];
      let startAt = 0;
      const pageSize = 50;
      while (all.length < 200) {
        const data = await jiraApi.request(
          `/rest/agile/1.0/board/${boardId}/sprint?state=active,future&startAt=${startAt}&maxResults=${pageSize}`,
        );
        const values = data.values || [];
        all.push(...values);
        if (data.isLast || values.length < pageSize) break;
        startAt += pageSize;
      }
      return all;
    }

    // Authoritative per-sprint velocity via the Sprint Report endpoint.
    // Returns the SP sum of issues that were completed WITHIN the sprint
    // window — ignores issues that were moved out and completed elsewhere.
    async function sprintCompletedSPViaReport(boardId, sprintId) {
      const data = await jiraApi.request(
        `/rest/greenhopper/1.0/rapid/charts/sprintreport?rapidViewId=${boardId}&sprintId=${sprintId}`,
      );
      const raw = data?.contents?.completedIssuesEstimateSum?.value;
      // `value` can be number, numeric string, or null when tracking is off.
      const n = typeof raw === 'number' ? raw : Number(raw);
      return Number.isFinite(n) ? n : 0;
    }

    // Fallback: sum current-`done` SP among issues listed against the sprint.
    // Known to over-count when issues are moved between sprints, but kept
    // as a safety net for instances where the Greenhopper endpoint is off.
    async function sprintCompletedSPViaAgile(sprintId, spFieldId) {
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

    async function sprintCompletedSP(boardId, sprintId, spFieldId) {
      try {
        return await sprintCompletedSPViaReport(boardId, sprintId);
      } catch (e) {
        warn(
          `sprint-report unavailable for sprint ${sprintId}, falling back to agile API:`,
          e?.message || e,
        );
        return sprintCompletedSPViaAgile(sprintId, spFieldId);
      }
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

      // Fetch closed (for average) and open (for planning overlays) in
      // parallel — they are independent.
      const [closed, openSprints] = await Promise.all([
        listClosedSprints(boardId),
        listOpenSprints(boardId).catch((e) => {
          warn('listOpenSprints failed:', e?.message || e);
          return [];
        }),
      ]);

      let average = 0;
      let perSprint = [];
      if (closed.length) {
        // Most recently closed first. `completeDate` is the actual close time;
        // fall back to `endDate` then `startDate` so sprints without a close
        // stamp still sort reasonably.
        const byCloseDesc = (a, b) => {
          const ka = new Date(a.completeDate || a.endDate || a.startDate || 0).getTime();
          const kb = new Date(b.completeDate || b.endDate || b.startDate || 0).getTime();
          return kb - ka;
        };
        const recent = closed.sort(byCloseDesc).slice(0, SPRINT_WINDOW);
        // Fetch all N sprint-reports in parallel. Jira comfortably handles
        // a handful of concurrent requests against the same endpoint, and
        // this cuts the velocity first-paint from ~N× round-trip to ~1×.
        const velocities = await Promise.all(
          recent.map((s) =>
            sprintCompletedSP(boardId, s.id, spFieldId).catch((e) => {
              warn(`velocity: sprint ${s.id} failed:`, e?.message || e);
              return 0;
            }),
          ),
        );
        perSprint = recent.map((s, i) => ({ id: s.id, name: s.name, velocity: velocities[i] }));
        const total = perSprint.reduce((acc, s) => acc + s.velocity, 0);
        average = perSprint.length ? total / perSprint.length : 0;
      }

      const openLite = openSprints.map((s) => ({
        id: s.id,
        name: s.name,
        state: s.state, // 'active' | 'future'
      }));

      return { average, sprints: perSprint, boardId, openSprints: openLite };
    }

    async function getCached() {
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
    }

    return {
      // Kept for compatibility with the velocity-banner (returns
      // { average, sprints, boardId } — extra fields are ignored).
      get: getCached,
      // Planning view: everything `get()` returns + `openSprints` (active
      // and future sprints on the board).
      getPlanningContext: getCached,
      // Sync best-effort access to the open-sprint id set. Returns an
      // empty set before the first resolution; used by the API
      // interceptor to sanity-check candidate sprint ids extracted from
      // GraphQL variables (no schema means we need a reality check).
      getKnownOpenSprintIds() {
        if (!cache || !cache.value) return new Set();
        return new Set((cache.value.openSprints || []).map((s) => Number(s.id)));
      },
      // Synchronous snapshot of the last resolved planning context, or
      // null if velocity hasn't been computed yet. Consumers that can
      // tolerate "no data yet" (e.g. the Epic tooltip projecting a sprint
      // end) can read this without awaiting anything — a fresh value
      // will reach them on the next debounced mutation pass anyway.
      getCachedSnapshot() {
        return cache && cache.value ? cache.value : null;
      },
    };
  })();

  // ---------------------------------------------------------------------------
  // sprintCapacity — per-sprint planned SP load, for the timeline Sprints
  // row overlays. Same TTL + inflight-dedup pattern as `epicProgress`.
  //
  // Metric depends on the sprint state:
  //   - `active`  → sum of SP of issues NOT in a done statusCategory
  //                 (remaining work, matching what a team would still
  //                 need to deliver before sprint close).
  //   - `future`  → sum of SP of ALL assigned issues (what's been planned
  //                 into the sprint so far).
  // Issues without a valid SP value are ignored (SP 0 = not estimated).
  // ---------------------------------------------------------------------------

  const sprintCapacity = (() => {
    // Short TTL: the sprint-fill overlay is primarily read while the user
    // is actively moving tickets between sprints, so fresh data matters
    // more than request economy. The interceptor invalidates explicitly
    // on mutation but may miss proprietary/graphql paths — the TTL is
    // the safety net that bounds staleness even in the miss case.
    const TTL_MS = 15_000;
    // Batching window: concurrent get() calls within this window coalesce
    // into a single JQL round-trip. 20ms is enough to catch the burst of
    // chip decorations fired by one runActiveFeatures pass, short enough
    // that it doesn't contribute meaningfully to perceived latency.
    const FLUSH_DELAY_MS = 20;

    const cache = new Map(); // `${id}:${state}` -> { expiresAt, value }
    const inflight = new Map(); // `${id}:${state}` -> Promise<value>
    const batchWaiters = new Map(); // `${id}:${state}` -> [{ resolve, reject }]
    let pending = new Map(); // sprintId -> state (last state wins; states are stable per sprint)
    let flushTimer = null;
    let onFreshListener = null;

    // Issue catalog — populated as a side-effect of runBatch. For every
    // issue that appears in a batch response we remember its SP, the set
    // of sprint IDs it belonged to, and its done-ness. This is what makes
    // optimistic updates possible: when Jira fires a sprint-change
    // mutation we look up the issue's prior state here, compute the delta
    // locally, and repaint instantly — no round-trip wait.
    const issueCatalog = new Map(); // issueKey -> { sp, sprintIds: Set<number>, isDone }

    async function runBatch(entries) {
      // entries: [[sprintId, state], ...]
      const [spFieldId, sprintFieldId] = await Promise.all([
        storyPointsField.resolve(),
        sprintField.resolve(),
      ]);
      const ids = entries.map(([id]) => id);
      const idSet = new Set(ids);
      const jql = `sprint in (${ids.join(',')})`;
      // maxResults=1000: covers the vast majority of plans (20 sprints ×
      // ~50 issues). If a user has a giant plan we'll undercount the
      // tail — acceptable; matches the previous /sprint/{id}/issue limit
      // of 500 per sprint in practice.
      const data = await jiraApi.searchIssues(
        jql,
        [spFieldId, 'status', sprintFieldId],
        1000,
      );

      const perSprint = new Map();
      for (const [id] of entries) perSprint.set(id, { total: 0, remaining: 0 });

      for (const issue of data.issues || []) {
        const sp = Number(issue.fields?.[spFieldId]);
        if (!Number.isFinite(sp) || sp <= 0) continue;
        const isDone = issue.fields?.status?.statusCategory?.key === 'done';
        const sprintsRaw = issue.fields?.[sprintFieldId];
        const sprintList = Array.isArray(sprintsRaw) ? sprintsRaw : [];
        const issueSprintIds = new Set();
        for (const s of sprintList) {
          const sid = Number(s?.id);
          if (!Number.isFinite(sid) || sid <= 0) continue;
          issueSprintIds.add(sid);
          if (!idSet.has(sid)) continue;
          const bucket = perSprint.get(sid);
          bucket.total += sp;
          if (!isDone) bucket.remaining += sp;
        }
        // Catalog the issue (for optimistic updates on sprint moves).
        // Keep a record even if no requested sprint matched — the issue
        // might still be moved INTO one of our tracked sprints later.
        if (issue.key) {
          issueCatalog.set(issue.key, { sp, sprintIds: issueSprintIds, isDone });
        }
      }

      const results = new Map();
      for (const [id, state] of entries) {
        const b = perSprint.get(id) || { total: 0, remaining: 0 };
        const load = state === 'active' ? b.remaining : b.total;
        results.set(`${id}:${state}`, { total: b.total, remaining: b.remaining, load, state });
      }
      return results;
    }

    async function flushBatch() {
      flushTimer = null;
      const entries = [...pending.entries()];
      pending = new Map();
      if (entries.length === 0) return;

      perfStamp(`JQL batch start (${entries.length} sprints)`);
      let results;
      try {
        results = await runBatch(entries);
      } catch (e) {
        for (const [id, state] of entries) {
          const key = `${id}:${state}`;
          const w = batchWaiters.get(key);
          if (w) {
            w.forEach(({ reject }) => reject(e));
            batchWaiters.delete(key);
          }
          inflight.delete(key);
        }
        return;
      }

      const now = Date.now();
      for (const [id, state] of entries) {
        const key = `${id}:${state}`;
        const value = results.get(key);
        if (value) cache.set(key, { expiresAt: now + TTL_MS, value });
        const w = batchWaiters.get(key);
        if (w) {
          w.forEach(({ resolve }) => resolve(value));
          batchWaiters.delete(key);
        }
        inflight.delete(key);
      }
      perfStamp(`JQL batch done (${entries.length} sprints, ${cache.size} cache entries)`);
      // Let the feature pipeline re-run so stale-while-revalidate consumers
      // repaint with the freshly-landed numbers.
      if (onFreshListener) {
        try { onFreshListener(); } catch (e) { /* listener error shouldn't poison batch */ }
      }
    }

    function enqueue(sprintId, state) {
      pending.set(sprintId, state);
      if (!flushTimer) flushTimer = setTimeout(flushBatch, FLUSH_DELAY_MS);
    }

    function awaitBatch(key) {
      return new Promise((resolve, reject) => {
        if (!batchWaiters.has(key)) batchWaiters.set(key, []);
        batchWaiters.get(key).push({ resolve, reject });
      });
    }

    function scheduleRefresh(sprintId, state) {
      const key = `${sprintId}:${state}`;
      if (inflight.has(key)) return inflight.get(key);
      const p = awaitBatch(key);
      // Swallow rejections on the inflight reference; callers that await
      // will still observe them.
      p.catch(() => {});
      inflight.set(key, p);
      enqueue(sprintId, state);
      return p;
    }

    function adjustCachedBucket(sprintId, deltaSp, isDone) {
      for (const state of ['active', 'future']) {
        const hit = cache.get(`${sprintId}:${state}`);
        if (!hit) continue;
        const v = hit.value;
        v.total = Math.max(0, v.total + deltaSp);
        if (!isDone) v.remaining = Math.max(0, v.remaining + deltaSp);
        v.load = state === 'active' ? v.remaining : v.total;
      }
    }

    return {
      async get(sprintId, state) {
        const key = `${sprintId}:${state}`;
        const now = Date.now();
        const hit = cache.get(key);
        if (hit && hit.expiresAt > now) return hit.value;
        // Stale-while-revalidate: return old value immediately so the chip
        // stays painted (no flicker / no empty state), while a background
        // batch refreshes the numbers. The onFresh listener triggers a
        // re-run of runActiveFeatures once the batch lands.
        if (hit) {
          scheduleRefresh(sprintId, state);
          return hit.value;
        }
        // Cold cache: must wait for the first batch to complete.
        return scheduleRefresh(sprintId, state);
      },
      invalidate(sprintId) {
        // Mark expired but keep the last known value for stale-while-
        // revalidate — so the user sees the old numbers during the refetch
        // instead of an empty overlay or pre-mutation stale data.
        const a = cache.get(`${sprintId}:active`);
        const f = cache.get(`${sprintId}:future`);
        if (a) a.expiresAt = 0;
        if (f) f.expiresAt = 0;
      },
      invalidateAll() {
        for (const entry of cache.values()) entry.expiresAt = 0;
      },
      onFresh(listener) {
        onFreshListener = listener;
      },
      // Optimistic update: called from the API interceptor the moment a
      // ticket-sprint change is detected. We mutate the cached load/total
      // in place so the next SWR read (triggered synchronously via the
      // onFresh listener) paints the correct numbers without waiting for
      // the JQL refresh to land. The real batch still fires in the
      // background and will overwrite with authoritative values.
      //
      // Returns true if the delta was applied, false if we didn't know
      // about the issue (catalog miss → fall back to JQL-refresh timing).
      applyOptimisticMove(issueKey, targetSprintIds) {
        const meta = issueCatalog.get(issueKey);
        if (!meta) return false;
        const prevIds = meta.sprintIds;
        const newIds = new Set(targetSprintIds.filter((n) => Number.isFinite(n) && n > 0));
        const removed = [...prevIds].filter((id) => !newIds.has(id));
        const added = [...newIds].filter((id) => !prevIds.has(id));
        if (removed.length === 0 && added.length === 0) return false;
        for (const id of removed) adjustCachedBucket(id, -meta.sp, meta.isDone);
        for (const id of added) adjustCachedBucket(id, +meta.sp, meta.isDone);
        // Mirror the move in the catalog so repeated moves compose correctly.
        meta.sprintIds = newIds;
        return true;
      },
      getSprintFieldIdSync() {
        // Synchronous read of the resolved sprint field id (if any).
        // Used by the interceptor to parse mutation bodies without awaiting.
        return sessionStorage.getItem('momentum-light::sprint-field-id');
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
        /* Keep the SP label above the confidence wash (::before) and the
           hatch (::after) — the text must stay crisp and full-opacity
           even when the rest of the bar is faded. */
        z-index: 2;
      }
      /* Ticket variant: no fill, label keeps the default centered alignment
         inherited from .momentum-progress__label (flex center + padding).
         The text-shadow keeps it legible on any bar color without needing
         the mix-blend-mode fill. */
      .${OVERLAY_ESTIMATE_MOD} .${OVERLAY_FILL_CLASS} {
        display: none;
      }
      /* Confidence treatment on Epic bars — reflects the ETA confidence
         score (done/inProgress/todo/unestimated weighted blend). Two
         orthogonal signals stack, and they fire under different
         conditions:
           1. ::before wash — translucent white layer that lightens the
              native bar color (more white = lower confidence). Applies
              to EVERY Epic with low/medium confidence regardless of
              status, so a low-confidence Epic in progress still reads
              as "risky". Sits BELOW the SP label (label uses z-index:
              2) so the text stays crisp and full-opacity even when the
              bar is faded. We do NOT fade via CSS opacity on the host
              element, because opacity cascades to descendants and
              would wash out the label text too.
           2. ::after hatch — diagonal stripes across the full overlay,
              reinforcing the "uncertainty" read. Added ONLY on top of
              the wash when the Epic is still in Discovery (status
              category 'new' → we mark it via data-discovery). The
              intent is to make not-yet-started low/medium-confidence
              Epics visually pop as "scope work still needed", without
              noising up in-flight bars where the uncertainty is
              already being burned down. Low and medium share the
              same hatch.

         Both pseudo-elements are guarded against the ticket-estimate
         and sprint-fill variants, which have their own visual language. */
      .${OVERLAY_CLASS}:not(.${OVERLAY_ESTIMATE_MOD}):not(.${OVERLAY_SPRINT_FILL_MOD})[data-confidence="medium"]::before,
      .${OVERLAY_CLASS}:not(.${OVERLAY_ESTIMATE_MOD}):not(.${OVERLAY_SPRINT_FILL_MOD})[data-confidence="low"]::before {
        content: '';
        position: absolute;
        inset: 0;
        pointer-events: none;
        border-radius: inherit;
        z-index: 0;
      }
      .${OVERLAY_CLASS}:not(.${OVERLAY_ESTIMATE_MOD}):not(.${OVERLAY_SPRINT_FILL_MOD})[data-confidence="medium"]::before {
        background-color: rgba(255, 255, 255, 0.30);
      }
      .${OVERLAY_CLASS}:not(.${OVERLAY_ESTIMATE_MOD}):not(.${OVERLAY_SPRINT_FILL_MOD})[data-confidence="low"]::before {
        background-color: rgba(255, 255, 255, 0.60);
      }
      /* Low-confidence bars are heavily washed (60% white) so they risk
         disappearing into the timeline background. A 1px inset border
         frames the bar so it stays readable as a distinct shape. */
      .${OVERLAY_CLASS}:not(.${OVERLAY_ESTIMATE_MOD}):not(.${OVERLAY_SPRINT_FILL_MOD})[data-confidence="low"] {
        box-shadow: inset 0 0 0 1px rgba(9, 30, 66, 0.35);
      }
      .${OVERLAY_CLASS}:not(.${OVERLAY_ESTIMATE_MOD}):not(.${OVERLAY_SPRINT_FILL_MOD})[data-confidence="medium"][data-discovery]::after,
      .${OVERLAY_CLASS}:not(.${OVERLAY_ESTIMATE_MOD}):not(.${OVERLAY_SPRINT_FILL_MOD})[data-confidence="low"][data-discovery]::after {
        content: '';
        position: absolute;
        inset: 0;
        pointer-events: none;
        border-radius: inherit;
        z-index: 1;
        background-image: repeating-linear-gradient(
          45deg,
          transparent 0,
          transparent 5px,
          rgba(255, 255, 255, 0.22) 5px,
          rgba(255, 255, 255, 0.22) 9px
        );
      }
      /* T-Shirt size badge — intentionally discreet. A low-contrast pill on
         the LEFT edge of the Epic bar shows the macro-estimate bucket
         (XS|S|M|L|XL). No per-size palette and no drift ring: the
         timeline already carries a lot of color (native Atlaskit hues,
         confidence wash, sprint-fill states), so the badge reads as a
         neutral annotation that you notice only when you look for it.
         The drift state still surfaces in the hover tooltip for Epics
         whose real chiffrage disagrees with the macro-estimate. */
      .${OVERLAY_TSHIRT_CLASS} {
        position: absolute;
        top: 50%;
        left: 6px;
        transform: translateY(-50%);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 20px;
        height: 14px;
        padding: 0 5px;
        border-radius: 7px;
        background: rgba(9, 30, 66, 0.35);
        color: rgba(255, 255, 255, 0.92);
        font-size: 9px;
        font-weight: 600;
        line-height: 1;
        letter-spacing: 0.04em;
        z-index: 3;
        box-sizing: border-box;
        pointer-events: none;
        white-space: nowrap;
      }
      /* Shift the centered SP label a touch to the right when a badge is
         present so the two don't visually collide on narrow bars. */
      .${OVERLAY_CLASS}[data-epic-size] .${OVERLAY_LABEL_CLASS} {
        padding-left: 32px;
      }

      /* Sprint-fill variant: a full-height translucent wash that covers the
         chip's body, so the fill level reads at a glance across the whole
         button while the chip's own text ("FHSBFF Sprint 53…") stays fully
         legible. A saturated 2px accent strip along the bottom edge
         preserves the strong state-color cue (green / amber / red). The
         numeric label lives in the tooltip, not inside the chip.

         The overlay DOM parent is the chip's body div (data-testid ends
         with "marker.content"), not the button itself — see sprintChip
         .ensureOverlay. That means inset:0 + border-radius:inherit from
         the base OVERLAY_CLASS rule already line up with the chip's
         visible rounded-left shape; no hardcoded inset or radius here. */
      .${OVERLAY_SPRINT_FILL_MOD} {
        background-color: transparent;
      }
      .${OVERLAY_SPRINT_FILL_MOD} .${OVERLAY_FILL_CLASS} {
        mix-blend-mode: normal;
        opacity: 1;
        /* 2px bottom accent line in the saturated state color, drawn via
           an inset box-shadow so it hugs the fill's trailing edge and
           reinforces the color cue without needing an extra element. */
        box-shadow:
          inset 0 -2px 0 0 var(--momentum-sprint-fill-accent, transparent),
          inset -1px 0 0 rgba(9, 30, 66, 0.08);
      }
      .${OVERLAY_SPRINT_FILL_MOD}[data-fill-state="under"] .${OVERLAY_FILL_CLASS} {
        background: linear-gradient(
          90deg,
          rgba(54, 179, 126, 0.32) 0%,
          rgba(54, 179, 126, 0.22) 100%
        );
        --momentum-sprint-fill-accent: #36B37E;
      }
      .${OVERLAY_SPRINT_FILL_MOD}[data-fill-state="on-target"] .${OVERLAY_FILL_CLASS} {
        background: linear-gradient(
          90deg,
          rgba(255, 171, 0, 0.36) 0%,
          rgba(255, 171, 0, 0.26) 100%
        );
        --momentum-sprint-fill-accent: #FFAB00;
      }
      .${OVERLAY_SPRINT_FILL_MOD}[data-fill-state="over"] .${OVERLAY_FILL_CLASS} {
        background: linear-gradient(
          90deg,
          rgba(222, 53, 11, 0.30) 0%,
          rgba(222, 53, 11, 0.22) 100%
        );
        --momentum-sprint-fill-accent: #DE350B;
      }
      /* No in-chip numeric label — the sprint name stays clean and the
         exact numbers live in the tooltip via dataset.momentumTooltip. */
      .${OVERLAY_SPRINT_FILL_MOD} .${OVERLAY_LABEL_CLASS} {
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
        align-items: center;
        gap: 8px;
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

      /* Confidence legend — compact reference chip that lives inside the
         sticky velocity banner. Shows the three confidence tiers with
         swatches whose visual treatment mirrors the actual Epic bars
         (low wash + hatch / medium wash + hatch / plain), plus the
         "(Open)" qualifier to remind readers that the hatch only lights
         up during the Discovery phase. Non-interactive — purely a
         reference, so no hover affordance. */
      .${CONFIDENCE_LEGEND_CLASS} {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 10px;
        border-radius: 14px;
        background: #F4F5F7;
        color: #42526E;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 11px;
        line-height: 1.3;
        user-select: none;
        white-space: nowrap;
        pointer-events: auto;
        box-shadow: 0 1px 2px rgba(9, 30, 66, 0.12);
      }
      .${CONFIDENCE_LEGEND_CLASS}__title {
        font-weight: 600;
        color: #172B4D;
      }
      .${CONFIDENCE_LEGEND_CLASS}__item {
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }
      /* Swatch dimensions are generous enough to render the same 5px/9px
         diagonal hatch used on timeline Epic bars — this is the whole
         point: the legend shows the *exact* treatment viewers will see
         on the chart, not a stylized approximation. Base color, wash
         opacities (0.60 / 0.30) and hatch parameters (5px transparent,
         4px rgba(255,255,255,0.22)) mirror the Epic bar CSS above. */
      .${CONFIDENCE_LEGEND_CLASS}__swatch {
        position: relative;
        display: inline-block;
        width: 40px;
        height: 12px;
        border-radius: 2px;
        /* Base color mirrors a typical JIRA epic bar (Atlaskit purple). */
        background-color: #6554C0;
        overflow: hidden;
      }
      .${CONFIDENCE_LEGEND_CLASS}__swatch[data-tier="medium"]::before,
      .${CONFIDENCE_LEGEND_CLASS}__swatch[data-tier="low"]::before {
        content: '';
        position: absolute;
        inset: 0;
      }
      .${CONFIDENCE_LEGEND_CLASS}__swatch[data-tier="medium"]::before {
        background-color: rgba(255, 255, 255, 0.30);
      }
      .${CONFIDENCE_LEGEND_CLASS}__swatch[data-tier="low"]::before {
        background-color: rgba(255, 255, 255, 0.60);
      }
      /* Mirror the inset border we paint on low-confidence timeline bars so
         the swatch stays readable under the heavy wash. */
      .${CONFIDENCE_LEGEND_CLASS}__swatch[data-tier="low"] {
        box-shadow: inset 0 0 0 1px rgba(9, 30, 66, 0.35);
      }
      /* Hatch overlay — only on swatches explicitly flagged as Discovery,
         mirroring the [data-discovery] gate on timeline Epic bars. */
      .${CONFIDENCE_LEGEND_CLASS}__swatch[data-tier="medium"][data-discovery]::after,
      .${CONFIDENCE_LEGEND_CLASS}__swatch[data-tier="low"][data-discovery]::after {
        content: '';
        position: absolute;
        inset: 0;
        background-image: repeating-linear-gradient(
          45deg,
          transparent 0,
          transparent 5px,
          rgba(255, 255, 255, 0.22) 5px,
          rgba(255, 255, 255, 0.22) 9px
        );
      }
      .${CONFIDENCE_LEGEND_CLASS}__separator {
        color: #6B778C;
        font-weight: 500;
      }

      /* Size legend — mirror of the confidence chip, but for the T-Shirt
         macro-estimation scale. Each item shows the bucket name and its
         sprint-count convention (XS=1, S=2, M=3, L=5, XL=8, XXL=13).
         The swatch reuses the neutral pill treatment of the T-Shirt badge
         painted on Epic bars so readers instantly map legend → bar. */
      .${SIZE_LEGEND_CLASS} {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        padding: 6px 10px;
        border-radius: 14px;
        background: #F4F5F7;
        color: #42526E;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 11px;
        line-height: 1.3;
        user-select: none;
        white-space: nowrap;
        pointer-events: auto;
        box-shadow: 0 1px 2px rgba(9, 30, 66, 0.12);
      }
      .${SIZE_LEGEND_CLASS}__title {
        font-weight: 600;
        color: #172B4D;
      }
      .${SIZE_LEGEND_CLASS}__item {
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }
      .${SIZE_LEGEND_CLASS}__swatch {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 22px;
        height: 14px;
        padding: 0 5px;
        border-radius: 7px;
        background: rgba(9, 30, 66, 0.35);
        color: rgba(255, 255, 255, 0.92);
        font-size: 9px;
        font-weight: 600;
        letter-spacing: 0.04em;
        box-sizing: border-box;
      }

      /* ---------------------------------------------------------------------
       * View toggle — segmented "Vue PM / Vue Business" chip that lives in
       * the sticky velocity banner alongside the legend chips. Switches
       * every Epic bar between the PM overlays (progress, confidence, T-Shirt
       * badge) and the Business overlay (landing date / duedate).
       * ------------------------------------------------------------------ */
      .${VIEW_TOGGLE_CLASS} {
        display: inline-flex;
        gap: 2px;
        padding: 2px;
        border-radius: 14px;
        background: #DFE1E6;
        pointer-events: auto;
        box-shadow: 0 1px 2px rgba(9, 30, 66, 0.12);
      }
      .${VIEW_TOGGLE_CLASS}__btn {
        padding: 4px 10px;
        border: none;
        background: transparent;
        color: #42526E;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 11px;
        font-weight: 600;
        line-height: 1.2;
        cursor: pointer;
        border-radius: 12px;
      }
      .${VIEW_TOGGLE_CLASS}__btn:hover {
        color: #172B4D;
      }
      .${VIEW_TOGGLE_CLASS}__btn[data-active="1"] {
        background: #FFFFFF;
        color: #0052CC;
        box-shadow: 0 1px 2px rgba(9, 30, 66, 0.12);
      }
      /* In Business view the PM-only legend chips (confidence / size) lose
         their meaning — hide them so the banner stays uncluttered. */
      body[data-momentum-view="business"] .${CONFIDENCE_LEGEND_CLASS},
      body[data-momentum-view="business"] .${SIZE_LEGEND_CLASS} {
        display: none;
      }

      /* ---------------------------------------------------------------------
       * Landing-date variant (Business view) — the overlay covers the whole
       * Epic bar with a subtle dark wash (to keep the formatted date
       * readable on any Atlaskit bar color) and renders the formatted
       * duedate centered. No fill width, no T-Shirt badge, no confidence
       * wash — the Business view is purely about the "when".
       * ------------------------------------------------------------------ */
      .${OVERLAY_LANDING_MOD} .${OVERLAY_FILL_CLASS} {
        display: none;
      }
      .${OVERLAY_LANDING_MOD}::before,
      .${OVERLAY_LANDING_MOD}::after {
        display: none !important;
      }
      .${OVERLAY_LANDING_MOD} {
        background-color: rgba(9, 30, 66, 0.25);
      }
      .${OVERLAY_LANDING_MOD} .${OVERLAY_LABEL_CLASS} {
        /* Right-align the landing date so it sits next to the bar's end
           edge — the visual position of the "date d'atterrissage" the
           stakeholder reads on the timeline ruler. */
        justify-content: flex-end;
        padding: 0 8px;
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.02em;
      }
      .${OVERLAY_LANDING_MOD}[data-has-date="0"] .${OVERLAY_LABEL_CLASS} {
        font-style: italic;
        color: rgba(255, 255, 255, 0.82);
      }

      /* ---------------------------------------------------------------------
       * How-to menu — a small floating "?" button that opens a guided tour
       * spotlighting each feature one by one with Skip / Previous / Next.
       * ------------------------------------------------------------------ */
      #${HOWTO_BUTTON_ID} {
        position: fixed;
        bottom: 24px;
        right: 24px;
        z-index: 9998;
        width: 40px;
        height: 40px;
        border: none;
        border-radius: 50%;
        background: #0052CC;
        color: #fff;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 18px;
        font-weight: 700;
        line-height: 1;
        cursor: pointer;
        box-shadow: 0 2px 8px rgba(9, 30, 66, 0.30);
        transition: transform 120ms ease-out, background 120ms ease-out;
      }
      #${HOWTO_BUTTON_ID}:hover {
        background: #0747A6;
        transform: translateY(-1px);
      }
      #${HOWTO_BUTTON_ID}:focus {
        outline: 2px solid #4C9AFF;
        outline-offset: 2px;
      }
      /* Full-screen backdrop — catches clicks outside the card so the tour
       * can't be accidentally dismissed by clicking through to the app. */
      #${HOWTO_OVERLAY_ID} {
        position: fixed;
        inset: 0;
        z-index: 9999;
        background: rgba(9, 30, 66, 0.55);
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        color: #172B4D;
      }
      /* Spotlight ring positioned over the currently-highlighted target.
       * The huge box-shadow darkens everything outside the ring without a
       * second DOM element; pointer-events:none lets the ring sit on top
       * without eating clicks. */
      #${HOWTO_OVERLAY_ID} .momentum-howto__spotlight {
        position: fixed;
        border: 2px solid #FFAB00;
        border-radius: 6px;
        box-shadow: 0 0 0 9999px rgba(9, 30, 66, 0.55);
        pointer-events: none;
        transition: top 180ms ease-out, left 180ms ease-out,
                    width 180ms ease-out, height 180ms ease-out;
      }
      /* Step card — centered by default, repositioned near the spotlight
       * when a target exists. */
      #${HOWTO_OVERLAY_ID} .momentum-howto__card {
        position: fixed;
        width: 340px;
        max-width: calc(100vw - 32px);
        padding: 16px 20px 14px;
        background: #fff;
        border-radius: 8px;
        box-shadow: 0 8px 32px rgba(9, 30, 66, 0.35);
        box-sizing: border-box;
      }
      #${HOWTO_OVERLAY_ID} .momentum-howto__card[data-placement="center"] {
        top: 50%;
        left: 50%;
        transform: translate(-50%, -50%);
      }
      #${HOWTO_OVERLAY_ID} .momentum-howto__step {
        margin: 0 0 4px;
        font-size: 11px;
        font-weight: 600;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: #6B778C;
      }
      #${HOWTO_OVERLAY_ID} .momentum-howto__title {
        margin: 0 0 8px;
        font-size: 16px;
        font-weight: 700;
        color: #172B4D;
      }
      #${HOWTO_OVERLAY_ID} .momentum-howto__body {
        margin: 0 0 16px;
        font-size: 13px;
        line-height: 1.5;
        color: #42526E;
      }
      #${HOWTO_OVERLAY_ID} .momentum-howto__actions {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      #${HOWTO_OVERLAY_ID} .momentum-howto__actions-right {
        display: flex;
        gap: 8px;
      }
      #${HOWTO_OVERLAY_ID} .momentum-howto__btn {
        padding: 6px 14px;
        border: none;
        border-radius: 4px;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        font-family: inherit;
      }
      #${HOWTO_OVERLAY_ID} .momentum-howto__btn--skip {
        background: transparent;
        color: #6B778C;
      }
      #${HOWTO_OVERLAY_ID} .momentum-howto__btn--skip:hover {
        background: #F4F5F7;
        color: #172B4D;
      }
      #${HOWTO_OVERLAY_ID} .momentum-howto__btn--secondary {
        background: #F4F5F7;
        color: #42526E;
      }
      #${HOWTO_OVERLAY_ID} .momentum-howto__btn--secondary:hover {
        background: #DFE1E6;
      }
      #${HOWTO_OVERLAY_ID} .momentum-howto__btn--primary {
        background: #0052CC;
        color: #fff;
      }
      #${HOWTO_OVERLAY_ID} .momentum-howto__btn--primary:hover {
        background: #0747A6;
      }
      #${HOWTO_OVERLAY_ID} .momentum-howto__btn:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      #${HOWTO_OVERLAY_ID} .momentum-howto__missing {
        margin: 0 0 16px;
        padding: 8px 10px;
        background: #FFFAE6;
        border-left: 3px solid #FFAB00;
        border-radius: 2px;
        font-size: 12px;
        color: #42526E;
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
        // Heartbeat (not raw debug): this log fires on every pipeline
        // pass (~200ms) and the numbers are identical across passes
        // while the DOM is stable — dedup via heartbeat's 30s TTL so a
        // steady-state timeline doesn't flood the console.
        heartbeat(
          'findBars → prefix hits:', prefixHits.length,
          'leaves:', leaves.length,
          'bars:', bars.length,
        );
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
      // Always clear any confidence fade we may have set previously — the
      // bar might be about to be recycled by JIRA for a different issue.
      resetBarConfidence(bar);
    }

    // Confidence tiers drive the opacity / hatch treatment applied to the
    // epic bar: low-confidence epics read as "uncertain" at a glance via
    // diagonal stripes + a faded host bar, without requiring a tooltip hover.
    function confidenceTier(confidence) {
      if (!(confidence >= 0)) return 'high'; // treat NaN/undefined as neutral
      if (confidence < 40) return 'low';
      if (confidence < 70) return 'medium';
      return 'high';
    }

    // Confidence fade is now driven purely by the CSS ::before wash on the
    // overlay, gated by [data-confidence] — no JS-side opacity writes on
    // the bar or its parent. The wash paints a translucent white layer
    // below the SP label so the colored bar fades while the label stays
    // crisp (opacity on an ancestor would cascade to the label text).
    //
    // This tracker lets us clean up opacity values written by older
    // versions (v0.5.2 on `bar`, v0.5.3 on `bar.parentElement`) in case
    // they survived a page-reload during a script upgrade.
    const OUR_BAR_OPACITIES = new Set(['0.4', '0.75']);

    function applyBarConfidence(bar /* , tier */) {
      // No-op on the host DOM — the wash handles it. Only strip legacy
      // opacities we may have written in earlier versions.
      resetBarConfidence(bar);
    }

    function resetBarConfidence(bar) {
      const parent = bar.parentElement;
      if (parent && OUR_BAR_OPACITIES.has(parent.style.opacity)) {
        parent.style.opacity = '';
      }
      if (OUR_BAR_OPACITIES.has(bar.style.opacity)) bar.style.opacity = '';
    }

    function applyProgress(
      bar,
      { done, total, epicKey, childStats, confidence, statusCategory, tshirtSize },
    ) {
      const stats = childStats || { done: 0, inProgress: 0, todo: 0, unestimated: 0, totalChildren: 0 };
      const isOpen = statusCategory === 'new';
      // No children at all AND no macro-estimate either → usually nothing to
      // visualize. Two exceptions keep the overlay alive:
      //   • an Epic with a T-Shirt size but zero chiffred children — the
      //     badge IS the signal in that case;
      //   • an Epic in "Open" status — it's still in Discovery (scope work
      //     pending), and must read as such via the low-confidence wash +
      //     hatch instead of falling back to a bare native bar.
      if (stats.totalChildren === 0 && (!total || total <= 0) && !tshirtSize && !isOpen) {
        removeOverlay(bar);
        delete bar.dataset.momentumTooltip;
        return;
      }
      const pct = total > 0 ? Math.max(0, Math.min(100, (done / total) * 100)) : 0;
      const pctStr = `${pct.toFixed(1)}%`;
      const conf = Number.isFinite(confidence) ? confidence : 0;
      const tier = confidenceTier(conf);
      // Two independent signals drive the Epic bar appearance:
      //   • wash (opacity) — applies to EVERY low/medium-confidence Epic
      //     regardless of status, so a risky Epic already in progress
      //     still reads as faded.
      //   • hatch (diagonal stripes) — added on top of the wash only
      //     when the Epic is still in Discovery (statusCategory 'new').
      //     This makes not-yet-started Epics pop as "scope work
      //     pending", without cluttering bars for work in flight.
      // High-confidence Epics get neither treatment.
      const showWash = tier !== 'high';
      const isDiscovery = isOpen;
      const showHatch = showWash && isDiscovery;

      const overlay = ensureOverlay(bar);
      overlay.classList.remove(OVERLAY_ESTIMATE_MOD);
      overlay.classList.remove(OVERLAY_LANDING_MOD);
      delete overlay.dataset.hasDate;
      if (showWash) {
        overlay.dataset.confidence = tier;
      } else {
        delete overlay.dataset.confidence;
      }
      if (showHatch) {
        overlay.dataset.discovery = '';
      } else {
        delete overlay.dataset.discovery;
      }
      applyBarConfidence(bar, tier);
      const fill = overlay.querySelector(`.${OVERLAY_FILL_CLASS}`);
      const label = overlay.querySelector(`.${OVERLAY_LABEL_CLASS}`);
      if (fill) fill.style.width = pctStr;

      // --- Macro-estimation (T-Shirt size) ------------------------------
      // The macro budget (in SP) comes from the TSHIRT_SIZE_SP table at
      // the top of this file — edit those numbers to recalibrate for your
      // team. When the Epic already has real child SP, compute a
      // sizing-drift indicator: the ratio (actualSP / macroSP) tells us
      // whether the macro-estimate holds.
      const macroSP = tshirtSize ? TSHIRT_SIZE_SP[tshirtSize] : null;
      let drift = null;
      if (macroSP != null && total > 0) {
        const ratio = total / macroSP;
        if (ratio < TSHIRT_DRIFT_UNDER) drift = 'under';
        else if (ratio > TSHIRT_DRIFT_OVER) drift = 'over';
        else drift = 'on-target';
      }
      if (tshirtSize) {
        overlay.dataset.epicSize = tshirtSize;
      } else {
        delete overlay.dataset.epicSize;
      }
      if (drift) {
        overlay.dataset.sizingDrift = drift;
      } else {
        delete overlay.dataset.sizingDrift;
      }
      let badge = overlay.querySelector(`.${OVERLAY_TSHIRT_CLASS}`);
      if (tshirtSize) {
        if (!badge) {
          badge = document.createElement('span');
          badge.className = OVERLAY_TSHIRT_CLASS;
          overlay.appendChild(badge);
        }
        badge.textContent = tshirtSize;
      } else if (badge) {
        badge.remove();
      }

      // Inline "chiffrage incomplet" suffix — "X / Y SP (∅ N)" where N is
      // the count of child tickets without Story Points. The empty-set
      // glyph reads as "missing value" and sits inside the main label so
      // it fades alongside the rest of the text on narrow bars instead of
      // competing for its own reserved space.
      const missingSuffix = stats.unestimated > 0 ? ` (∅ ${stats.unestimated})` : '';
      if (label) label.textContent = `${done} / ${total} SP${missingSuffix}`;

      // --- Sprint-end projection ----------------------------------------
      // Best-effort synchronous read of the cached velocity snapshot.
      // When it isn't ready yet we just omit the projection line — the
      // next mutation cycle will fill it in once velocity.get() resolves.
      let projectionLine = null;
      if (macroSP != null) {
        const vctx = velocity.getCachedSnapshot();
        if (vctx && vctx.average > 0 && vctx.openSprints?.length) {
          const remaining = Math.max(0, macroSP - done);
          const sprintsAhead = remaining === 0
            ? 0
            : Math.max(1, Math.ceil(remaining / vctx.average));
          if (sprintsAhead === 0) {
            projectionLine = 'Projection : budget macro déjà couvert par le chiffrage réel';
          } else {
            const idx = Math.min(sprintsAhead - 1, vctx.openSprints.length - 1);
            const target = vctx.openSprints[idx];
            const overflow = sprintsAhead > vctx.openSprints.length;
            const plural = sprintsAhead > 1 ? 's' : '';
            projectionLine = overflow
              ? `Fin estimée : au-delà du dernier sprint planifié (${sprintsAhead} sprint${plural} à ${Math.round(vctx.average)} SP)`
              : `Fin estimée : ${target.name} (dans ${sprintsAhead} sprint${plural} à ${Math.round(vctx.average)} SP)`;
          }
        }
      }

      // Tooltip text — the interceptor (installed at bootstrap) will rewrite
      // JIRA's Atlaskit tooltip with this value when it appears on hover.
      // aria-label and title are set as accessibility/fallback hints.
      // "Discovery" annotation reflects the Epic's status (Open), not the
      // hatch — a high-confidence Open Epic is still in Discovery even
      // though the hatch is suppressed.
      const tierLabel = isDiscovery ? `${tier} · Discovery` : tier;
      const confidenceLine = `Confiance : ${conf.toFixed(0)}% (${tierLabel})`;
      const breakdownParts = [];
      if (stats.done) breakdownParts.push(`${stats.done} done`);
      if (stats.inProgress) breakdownParts.push(`${stats.inProgress} en cours`);
      if (stats.todo) breakdownParts.push(`${stats.todo} todo`);
      if (stats.unestimated) breakdownParts.push(`${stats.unestimated} sans SP`);
      const breakdown = breakdownParts.length
        ? ` — ${breakdownParts.join(', ')}`
        : '';
      let tshirtLine = null;
      if (macroSP != null) {
        let driftTag = '';
        if (drift === 'under') driftTag = ' · sous-cadrage ⚠️';
        else if (drift === 'over') driftTag = ' · dépassement 🔴';
        tshirtLine = `Macro-estimé ${tshirtSize} (~${macroSP} SP)${driftTag}`;
      }
      const tooltipText = [
        `${epicKey} — ${done} / ${total} SP (${pct.toFixed(0)}%)`,
        tshirtLine,
        projectionLine,
        `${confidenceLine}${breakdown}`,
      ].filter(Boolean).join('\n');
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
      overlay.classList.remove(OVERLAY_LANDING_MOD);
      delete overlay.dataset.hasDate;
      // Ticket variant never carries a confidence tier — strip any stale
      // attribute and bar opacity left over if this bar was previously
      // decorated as an epic.
      delete overlay.dataset.confidence;
      delete overlay.dataset.discovery;
      resetBarConfidence(bar);
      const label = overlay.querySelector(`.${OVERLAY_LABEL_CLASS}`);
      if (label) label.textContent = `${sp} SP`;

      const tooltipText = `${issueKey} — ${sp} SP`;
      bar.dataset.momentumTooltip = tooltipText;
      bar.setAttribute('aria-label', tooltipText);
      bar.title = tooltipText;
    }

    // Business view: paint the formatted landing date on the Epic bar. The
    // overlay purposefully strips every PM-only signal (fill, confidence
    // wash, T-Shirt badge) so the date is the only thing a stakeholder
    // reads. Tickets aren't decorated in this view — their overlays are
    // removed by decorateBar before we get here.
    function applyLanding(bar, { issueKey, dueDate }) {
      const overlay = ensureOverlay(bar);
      overlay.classList.remove(OVERLAY_ESTIMATE_MOD);
      overlay.classList.add(OVERLAY_LANDING_MOD);
      delete overlay.dataset.confidence;
      delete overlay.dataset.discovery;
      delete overlay.dataset.epicSize;
      delete overlay.dataset.sizingDrift;
      resetBarConfidence(bar);
      // Strip the T-Shirt badge if the bar was previously PM-decorated.
      const badge = overlay.querySelector(`.${OVERLAY_TSHIRT_CLASS}`);
      if (badge) badge.remove();
      const fill = overlay.querySelector(`.${OVERLAY_FILL_CLASS}`);
      if (fill) fill.style.width = '0%';

      const short = formatDueDate(dueDate, 'short');
      const long = formatDueDate(dueDate, 'long');
      const label = overlay.querySelector(`.${OVERLAY_LABEL_CLASS}`);
      if (label) label.textContent = short || 'Sans date d\'atterrissage';
      overlay.dataset.hasDate = dueDate ? '1' : '0';

      const tooltipText = dueDate
        ? `${issueKey} — Atterrissage : ${long}`
        : `${issueKey} — Aucune date d'atterrissage définie`;
      bar.dataset.momentumTooltip = tooltipText;
      bar.setAttribute('aria-label', tooltipText);
      bar.title = tooltipText;
    }

    // Format a raw Jira duedate (YYYY-MM-DD) for display. `short` is used
    // inside the bar overlay (compact), `long` is the tooltip form.
    // Graceful fallbacks: invalid / empty strings return null (short) or
    // the raw string (long) so the tooltip still carries something useful.
    function formatDueDate(raw, variant) {
      if (!raw) return null;
      const d = new Date(raw);
      if (Number.isNaN(d.getTime())) {
        return variant === 'long' ? String(raw) : null;
      }
      try {
        const opts = variant === 'long'
          ? { day: 'numeric', month: 'long', year: 'numeric' }
          : { day: '2-digit', month: 'short', year: 'numeric' };
        return new Intl.DateTimeFormat('fr-FR', opts).format(d);
      } catch (_) {
        return raw;
      }
    }

    async function decorateBar(bar) {
      const issueKey = extractIssueKey(bar);
      if (!issueKey) {
        if (isDebug()) debug('no issue key resolved for a bar — skipping');
        return;
      }

      const view = viewMode.get();
      const previous = decorated.get(bar);
      // Include the view in the refresh key so a PM → Business switch forces
      // a re-decoration even on bars whose issueKey hasn't changed.
      const isRefresh = previous && previous.issueKey === issueKey && previous.view === view;
      if (!isRefresh) decorated.set(bar, { issueKey, view });

      const meta = await issueMeta.get(issueKey);

      if (view === VIEW_MODE_BUSINESS) {
        if (meta.isEpic) {
          if (isDebug() && !isRefresh) {
            debug(`${issueKey} (epic, business): dueDate=${meta.dueDate ?? '—'}`);
          }
          applyLanding(bar, { issueKey, dueDate: meta.dueDate });
        } else {
          // Ticket bars: no overlay in Business view.
          removeOverlay(bar);
          delete bar.dataset.momentumTooltip;
        }
        return;
      }

      if (meta.isEpic) {
        const { done, total, childStats, confidence } = await epicProgress.get(issueKey);
        if (isDebug() && !isRefresh) {
          debug(
            `${issueKey} (epic): ${done}/${total} SP, confidence=${Math.round(confidence)}%, ` +
            `unestimated=${childStats?.unestimated ?? 0}/${childStats?.totalChildren ?? 0}, ` +
            `statusCategory=${meta.statusCategory ?? '—'}`,
          );
        }
        applyProgress(bar, {
          done,
          total,
          epicKey: issueKey,
          childStats,
          confidence,
          statusCategory: meta.statusCategory,
          tshirtSize: meta.tshirtSize,
        });
      } else {
        if (isDebug() && !isRefresh) debug(`${issueKey} (ticket): ${meta.storyPoints ?? '—'} SP`);
        applyEstimate(bar, { sp: meta.storyPoints, issueKey });
      }
    }

    return { findBars, decorateBar, probeCandidates };
  })();

  // ---------------------------------------------------------------------------
  // sprintChipDom — detect sprint chips on the timeline's "Sprints" row and
  // paint a fill overlay that reports load vs. the 5-sprint average velocity.
  //
  // Detection strategy (first hit wins):
  //   1. Semantic — find a list-side cell whose trimmed text is exactly
  //      "Sprints", climb to its row container, then pick every <button>
  //      descendant on the chart-side. This survives Atlaskit class-name
  //      churn because it keys off the visible label, not generated CSS.
  //   2. Testid probe — if step 1 yields nothing, we rate-limit-dump the
  //      DOM's testid distribution to `window.__MOMENTUM_PROBE__` (same
  //      pattern as `timelineDom.probeCandidates`) so a future build can
  //      add the right selector without re-releasing.
  //
  // Geometric filter: chips narrower than 40px or taller than 32px are
  // skipped (too small to render a readable overlay, or not actually a
  // sprint chip).
  // ---------------------------------------------------------------------------

  const sprintChipDom = (() => {
    const CHIP_MIN_WIDTH = 40;
    const CHIP_MIN_HEIGHT = 14;
    const CHIP_MAX_HEIGHT = 32;
    const decorated = new WeakMap(); // chip -> { sprintId, state }

    // Find the "Sprints" row on the list side of the timeline. Relies on
    // the visible label rather than Atlaskit testids (which change).
    function findSprintsRow(root) {
      const candidates = root.querySelectorAll('div, span, th, td');
      for (const el of candidates) {
        // Cheap reject before reading textContent (which can be huge on
        // container nodes). Only consider leaf-ish elements.
        if (el.children.length > 2) continue;
        const text = (el.textContent || '').trim();
        if (text !== 'Sprints') continue;
        // Climb to the enclosing row. Rows in the Atlaskit timeline are
        // typically several levels up; stop at the first ancestor that
        // also contains at least one <button> sibling further right.
        let cursor = el.parentElement;
        let steps = 0;
        while (cursor && cursor !== document.body && steps < 12) {
          if (cursor.querySelector('button')) return cursor;
          cursor = cursor.parentElement;
          steps += 1;
        }
      }
      return null;
    }

    function isChipSized(el) {
      const r = el.getBoundingClientRect();
      if (r.width < CHIP_MIN_WIDTH) return false;
      if (r.height < CHIP_MIN_HEIGHT || r.height > CHIP_MAX_HEIGHT) return false;
      return true;
    }

    function findChips(root) {
      const row = findSprintsRow(root);
      if (!row) return [];
      return [...row.querySelectorAll('button')].filter(isChipSized);
    }

    let lastProbeAt = 0;
    function probe(root) {
      const now = Date.now();
      if (now - lastProbeAt < 3_000) return;
      lastProbeAt = now;
      // Collect every element whose trimmed text starts with "Sprint" to
      // help us tune the detection heuristic offline.
      const hits = [];
      root.querySelectorAll('button, span, div').forEach((el) => {
        if (el.children.length > 0) return;
        const t = (el.textContent || '').trim();
        if (t && /sprint/i.test(t) && t.length < 60) {
          hits.push({
            text: t,
            tag: el.tagName.toLowerCase(),
            testid: el.getAttribute('data-testid') || null,
          });
        }
      });
      window.__MOMENTUM_SPRINT_PROBE__ = {
        timestamp: new Date().toISOString(),
        sprintRowFound: !!findSprintsRow(root),
        sampleSprintLabels: hits.slice(0, 40),
      };
      warn(
        `sprintChipDom probe — row found: ${!!findSprintsRow(root)}, sample sprint-label hits: ${hits.length}. ` +
          'Dump at window.__MOMENTUM_SPRINT_PROBE__',
      );
    }

    // The sprint chip button is a flex row with three children:
    //   1. (our overlay, once injected)
    //   2. <div data-testid="…marker.content"> — the rounded-left body
    //      that holds the sprint name and has the visible chip shape.
    //   3. <div> — a 7px SVG flag tip on the right.
    // Anchoring the overlay to the button's border-box makes it fill the
    // full width including the tip area, so the wash bleeds past the
    // chip's visible right edge (and misaligns on the left when the
    // button itself has padding or transforms). Anchor to the body div
    // instead — its bounds and border-radius ARE the chip's visible
    // shape, so `inset: 0 + border-radius: inherit` lines up exactly.
    const CHIP_BODY_SELECTOR = '[data-testid$="intervals.marker.content"]';

    function overlayHost(chip) {
      return chip.querySelector(CHIP_BODY_SELECTOR) || chip;
    }

    function ensureOverlay(chip) {
      const host = overlayHost(chip);
      let overlay = host.querySelector(`:scope > .${OVERLAY_CLASS}`);
      if (overlay) return overlay;
      const computed = getComputedStyle(host);
      if (computed.position === 'static') host.style.position = 'relative';
      overlay = document.createElement('div');
      overlay.className = `${OVERLAY_CLASS} ${OVERLAY_SPRINT_FILL_MOD}`;
      const fill = document.createElement('div');
      fill.className = OVERLAY_FILL_CLASS;
      overlay.appendChild(fill);
      const label = document.createElement('div');
      label.className = OVERLAY_LABEL_CLASS;
      overlay.appendChild(label);
      host.insertBefore(overlay, host.firstChild);
      return overlay;
    }

    function removeOverlay(chip) {
      const host = overlayHost(chip);
      const overlay = host.querySelector(`:scope > .${OVERLAY_CLASS}`);
      if (overlay) overlay.remove();
      // Belt-and-suspenders: earlier versions of this script attached the
      // overlay directly to the button. Clean up any stale one so users
      // upgrading in-place don't end up with two overlays stacked.
      if (host !== chip) {
        const stale = chip.querySelector(`:scope > .${OVERLAY_CLASS}`);
        if (stale) stale.remove();
      }
    }

    function extractSprintName(chip) {
      // The chip's visible label might be truncated ("FHSBFF Sprint..."),
      // so prefer aria-label / title which carry the full name. Fallback
      // to textContent for older builds.
      return (
        (chip.getAttribute('aria-label') || '').trim() ||
        (chip.getAttribute('title') || '').trim() ||
        (chip.textContent || '').trim()
      );
    }

    // Canonicalize a sprint name for resilient matching between the chip's
    // label and the API's `sprint.name`. Jira's timeline sometimes appends
    // a counter (e.g. "FHSBFF Sprint 53 (29 issues)") or wraps the label
    // with whitespace; the API always returns the bare name. Lowercasing
    // and collapsing whitespace makes the match robust to both.
    function normalizeSprintName(raw) {
      if (!raw) return '';
      return raw
        .replace(/\s*\(\d+\s+(issues?|tickets?|items?)\)\s*$/i, '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
    }

    // Build a multi-key index { name → sprint } from the open-sprints list.
    // `byKey` accepts both raw and normalized lookups; the attached
    // `__ordered` array preserves the API order for substring fallback
    // (chip labels may carry a localized prefix like "Sprint sélectionné: <name>").
    function indexOpenSprints(openSprints) {
      const byKey = new Map();
      const ordered = [];
      for (const s of openSprints) {
        if (!s?.name) continue;
        byKey.set(s.name, s);
        byKey.set(normalizeSprintName(s.name), s);
        ordered.push({ sprint: s, normKey: normalizeSprintName(s.name) });
      }
      byKey.__ordered = ordered;
      return byKey;
    }

    function resolveSprint(chipName, byKey) {
      if (!chipName) return null;
      const direct =
        byKey.get(chipName) ||
        byKey.get(chipName.trim()) ||
        byKey.get(normalizeSprintName(chipName));
      if (direct) return direct;
      // Substring fallback for localized/decorated chip labels. Longest
      // sprint name wins so partial matches on short names don't hijack
      // a more specific one.
      const normChip = normalizeSprintName(chipName);
      if (!normChip) return null;
      let best = null;
      let bestLen = 0;
      for (const { sprint, normKey } of byKey.__ordered || []) {
        if (normKey && normChip.includes(normKey) && normKey.length > bestLen) {
          best = sprint;
          bestLen = normKey.length;
        }
      }
      return best;
    }

    function fillStateFor(ratio) {
      if (ratio < 0.9) return 'under';
      if (ratio <= 1.1) return 'on-target';
      return 'over';
    }

    function applyFill(chip, { load, average, state, sprintName }) {
      if (!Number.isFinite(load) || !Number.isFinite(average) || average <= 0) {
        removeOverlay(chip);
        delete chip.dataset.momentumTooltip;
        return;
      }
      const ratio = load / average;
      const pct = Math.max(0, Math.min(100, ratio * 100));
      const overlay = ensureOverlay(chip);
      overlay.dataset.fillState = fillStateFor(ratio);
      const fill = overlay.querySelector(`.${OVERLAY_FILL_CLASS}`);
      const label = overlay.querySelector(`.${OVERLAY_LABEL_CLASS}`);
      if (fill) fill.style.width = `${pct.toFixed(1)}%`;

      // Compact label inside the chip. 80px is the rough breakpoint below
      // which the "X / Y SP" form no longer fits; fall back to a bare
      // percentage there.
      // Label node is hidden via CSS for the sprint-fill variant (the chip's
      // own text is enough and the numbers live in the tooltip). We still
      // populate its textContent as a no-op safety so CSS keeps it the only
      // source of truth for the label visibility.
      if (label) label.textContent = '';

      // Tooltip override via dataset.momentumTooltip — picked up by
      // tooltipInterceptor when Atlaskit's React tooltip appears on hover.
      // Intentionally NOT writing aria-label/title on the chip: doing so
      // would overwrite Jira's own a11y label and pollute the name that
      // extractSprintName reads on the next cycle.
      const stateSuffix = state === 'active' ? ' (restant)' : ' (planifié)';
      chip.dataset.momentumTooltip = `${sprintName} — ${Math.round(
        load,
      )} SP${stateSuffix} / ${Math.round(average)} SP moyenne (${Math.round(ratio * 100)}%)`;
    }

    async function decorate(chip, byKey, average) {
      const name = extractSprintName(chip);
      if (!name) return null;
      const sprint = resolveSprint(name, byKey);
      if (!sprint) {
        // Not an open sprint (closed, or unknown). Leave chip untouched.
        if (decorated.has(chip)) {
          removeOverlay(chip);
          decorated.delete(chip);
        }
        return null;
      }
      const prev = decorated.get(chip);
      const isRefresh = prev && prev.sprintId === sprint.id && prev.state === sprint.state;
      if (!isRefresh) decorated.set(chip, { sprintId: sprint.id, state: sprint.state });

      const capacity = await sprintCapacity.get(sprint.id, sprint.state);
      if (isDebug() && !isRefresh) {
        debug(
          `sprint ${sprint.id} "${name}" (${sprint.state}): load=${capacity.load} SP, avg=${average}`,
        );
      }
      applyFill(chip, {
        load: capacity.load,
        average,
        state: sprint.state,
        sprintName: name,
      });
      return sprint;
    }

    return { findChips, decorate, probe, indexOpenSprints, extractSprintName };
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

    function buildLegend() {
      // Reference-only chip — mirrors the three confidence tier visuals
      // (wash + hatch for low/medium, plain for high) so readers can
      // decode an Epic bar at a glance. The "(Open)" qualifier calls
      // out that the hatch only appears while the Epic is in discovery.
      const legend = document.createElement('span');
      legend.className = CONFIDENCE_LEGEND_CLASS;
      legend.title =
        'Opacité selon l\'indice de confiance (tous les Epics) :\n' +
        '  • faible  (< 40 %)\n' +
        '  • moyenne (40-70 %)\n' +
        '  • haute   (≥ 70 %)\n' +
        '\n' +
        'Hachurage en supplément sur les Epics en statut Open (Discovery).';
      legend.innerHTML =
        `<span class="${CONFIDENCE_LEGEND_CLASS}__title">Confiance Epic :</span>` +
        `<span class="${CONFIDENCE_LEGEND_CLASS}__item">` +
          `<span class="${CONFIDENCE_LEGEND_CLASS}__swatch" data-tier="low" data-discovery></span>Discovery` +
        `</span>` +
        `<span class="${CONFIDENCE_LEGEND_CLASS}__item">` +
          `<span class="${CONFIDENCE_LEGEND_CLASS}__swatch" data-tier="low"></span>Faible` +
        `</span>` +
        `<span class="${CONFIDENCE_LEGEND_CLASS}__item">` +
          `<span class="${CONFIDENCE_LEGEND_CLASS}__swatch" data-tier="medium"></span>Moyenne` +
        `</span>` +
        `<span class="${CONFIDENCE_LEGEND_CLASS}__item">` +
          `<span class="${CONFIDENCE_LEGEND_CLASS}__swatch" data-tier="high"></span>Haute` +
        `</span>`;
      return legend;
    }

    function buildSizeLegend() {
      // Reference-only chip — shows the T-Shirt size → sprint-count
      // convention. Matches the swatch treatment of the T-Shirt badge
      // painted on Epic bars so readers can decode a badge at a glance.
      const legend = document.createElement('span');
      legend.className = SIZE_LEGEND_CLASS;
      const tooltipLines = Object.entries(TSHIRT_SIZE_SPRINTS)
        .map(([size, sprints]) => `  • ${size} = ${sprints} sprint${sprints > 1 ? 's' : ''}`)
        .join('\n');
      legend.title = `Taille Epic → nombre de sprints estimé :\n${tooltipLines}`;
      const items = Object.entries(TSHIRT_SIZE_SPRINTS)
        .map(
          ([size, sprints]) =>
            `<span class="${SIZE_LEGEND_CLASS}__item">` +
              `<span class="${SIZE_LEGEND_CLASS}__swatch">${size}</span>` +
              `${sprints} sprint${sprints > 1 ? 's' : ''}` +
            `</span>`,
        )
        .join('');
      legend.innerHTML =
        `<span class="${SIZE_LEGEND_CLASS}__title">Taille Epic :</span>${items}`;
      return legend;
    }

    function buildViewToggle() {
      const wrapper = document.createElement('div');
      wrapper.className = VIEW_TOGGLE_CLASS;
      wrapper.title =
        'Vue PM : progression, chiffrage SP et badges T-Shirt.\n' +
        'Vue Business : date d\'atterrissage (duedate) de chaque Epic.';
      const options = [
        { view: VIEW_MODE_PM, label: 'Vue PM' },
        { view: VIEW_MODE_BUSINESS, label: 'Vue Business' },
      ];
      const buttons = [];
      for (const { view, label } of options) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = `${VIEW_TOGGLE_CLASS}__btn`;
        btn.dataset.view = view;
        btn.textContent = label;
        btn.addEventListener('click', () => viewMode.set(view));
        wrapper.appendChild(btn);
        buttons.push(btn);
      }
      function sync() {
        const active = viewMode.get();
        for (const btn of buttons) {
          btn.dataset.active = btn.dataset.view === active ? '1' : '0';
          btn.setAttribute('aria-pressed', btn.dataset.view === active ? 'true' : 'false');
        }
      }
      sync();
      viewMode.onChange(sync);
      return wrapper;
    }

    function build(mode) {
      const wrapper = document.createElement('div');
      wrapper.id = VELOCITY_BANNER_ID;
      wrapper.dataset.anchor = mode;
      wrapper.appendChild(buildSizeLegend());
      wrapper.appendChild(buildLegend());
      wrapper.appendChild(buildViewToggle());
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
  // howto — guided "How-to" tour that spotlights each feature one by one.
  //
  // Step model: each step has an id, a localized title/body, and a
  // `findTarget()` callback that returns the DOM element to highlight (or
  // null if the feature isn't currently in view — e.g. the user is looking
  // at the top of the plan where no sprint chips are visible yet). When a
  // step has no target, the card is shown centered with a gentle "feature
  // not in view" hint; Skip / Previous / Next still work so the tour never
  // gets stuck.
  //
  // Persistence: the first time a user lands on a timeline-like page we
  // auto-launch the tour. Once they see it all the way through OR skip it
  // we persist `${HOWTO_SEEN_KEY}=1` so we don't nag them again. They can
  // always re-open it via the "?" floating button.
  // ---------------------------------------------------------------------------

  const howto = (() => {
    const STEPS = [
      {
        id: 'intro',
        title: 'Bienvenue sur Momentum-Light',
        body:
          'Découvrez en quelques étapes les 4 features qui augmentent votre ' +
          'Timeline JIRA. Utilisez « Suivant » pour avancer ou « Passer » pour fermer.',
        findTarget: () => null,
      },
      {
        id: 'epic-progress',
        title: '1. Epic Progress Bar',
        body:
          'Chaque Epic de la Timeline affiche une barre de progression calculée ' +
          'sur Σ SP done / Σ SP total de ses tickets enfants (Stories, ' +
          'Technical Stories et Bugs uniquement — les Tasks, Tests et tickets ' +
          'CANCELED sont ignorés). Un indice de confiance pondère done (×1.0), ' +
          'en cours (×0.6) et todo (×0.15) puis divise par le nombre total de ' +
          'tickets enfants comptés — les tickets sans chiffrage tirent le score ' +
          'vers le bas. L\'opacité de la barre est atténuée sur tous les Epics ' +
          'à confiance faible ou moyenne (le label « X / Y SP » reste lisible) ; ' +
          'un hachuré diagonal s\'ajoute par-dessus uniquement sur les Epics ' +
          'encore en statut « Open » (Discovery) pour les faire ressortir. ' +
          'Un suffixe « (∅ N) » apparaît dans le label quand N tickets enfants ' +
          'sont encore sans chiffrage.',
        findTarget: () =>
          document.querySelector(
            `.${OVERLAY_CLASS}:not(.${OVERLAY_ESTIMATE_MOD}):not(.${OVERLAY_SPRINT_FILL_MOD})`,
          ),
        missingHint:
          'Aucune barre d\'Epic n\'est visible à l\'écran. Scrollez jusqu\'à un Epic, puis relancez le tour.',
      },
      {
        id: 'ticket-estimate',
        title: '2. Ticket Estimate',
        body:
          'Sous les Epics, chaque barre de ticket affiche son chiffrage en Story ' +
          'Points, centré pour rester lisible quelle que soit la largeur de la barre.',
        findTarget: () => document.querySelector(`.${OVERLAY_ESTIMATE_MOD}`),
        missingHint:
          'Aucun ticket chiffré n\'est visible. Dépliez un Epic pour voir ses tickets enfants.',
      },
      {
        id: 'sprint-velocity',
        title: '3. Sprint Velocity',
        body:
          'La chip en haut de la Timeline affiche la vélocité moyenne des 5 derniers ' +
          'sprints clos (calculée comme dans l\'UI Backlog). Cliquez dessus pour ' +
          'rafraîchir à la demande.',
        findTarget: () =>
          document.querySelector(
            `#${VELOCITY_BANNER_ID} .momentum-velocity-banner__chip`,
          ),
        missingHint:
          'La chip de vélocité n\'est pas encore chargée — réessayez dans quelques secondes.',
      },
      {
        id: 'sprint-fill',
        title: '4. Sprint Fill Indicator',
        body:
          'Chaque chip de sprint actif/futur affiche une barre de remplissage ' +
          'comparée à la vélocité moyenne : vert < 90 %, ambre 90–110 %, rouge > 110 %. ' +
          'Survolez une chip pour voir les SP exacts dans la tooltip.',
        findTarget: () => document.querySelector(`.${OVERLAY_SPRINT_FILL_MOD}`),
        missingHint:
          'Aucune chip de sprint actif/futur n\'est visible sur la ligne « Sprints ».',
      },
    ];

    let currentIndex = 0;
    let reflowHandler = null;

    function hasBeenSeen() {
      try {
        return localStorage.getItem(HOWTO_SEEN_KEY) === '1';
      } catch (_) {
        return false;
      }
    }

    function markSeen() {
      try {
        localStorage.setItem(HOWTO_SEEN_KEY, '1');
      } catch (_) { /* private mode, incognito — ignore */ }
    }

    // Floating "?" button ----------------------------------------------------

    function ensureButton() {
      let btn = document.getElementById(HOWTO_BUTTON_ID);
      if (btn && btn.isConnected) return btn;
      btn = document.createElement('button');
      btn.id = HOWTO_BUTTON_ID;
      btn.type = 'button';
      btn.setAttribute('aria-label', 'Ouvrir le guide Momentum-Light');
      btn.title = 'Guide Momentum-Light — voir les features';
      btn.textContent = '?';
      btn.addEventListener('click', () => start());
      document.body.appendChild(btn);
      return btn;
    }

    function removeButton() {
      const btn = document.getElementById(HOWTO_BUTTON_ID);
      if (btn) btn.remove();
    }

    // Tour lifecycle ---------------------------------------------------------

    function start() {
      currentIndex = 0;
      render();
    }

    function end({ completed = false } = {}) {
      const overlay = document.getElementById(HOWTO_OVERLAY_ID);
      if (overlay) overlay.remove();
      if (reflowHandler) {
        window.removeEventListener('resize', reflowHandler);
        window.removeEventListener('scroll', reflowHandler, true);
        reflowHandler = null;
      }
      if (completed) markSeen();
    }

    function next() {
      if (currentIndex >= STEPS.length - 1) {
        end({ completed: true });
        return;
      }
      currentIndex += 1;
      render();
    }

    function prev() {
      if (currentIndex <= 0) return;
      currentIndex -= 1;
      render();
    }

    function skip() {
      end({ completed: true });
    }

    // Rendering --------------------------------------------------------------

    function buildOverlay() {
      const overlay = document.createElement('div');
      overlay.id = HOWTO_OVERLAY_ID;
      overlay.setAttribute('role', 'dialog');
      overlay.setAttribute('aria-modal', 'true');
      overlay.setAttribute('aria-label', 'Guide Momentum-Light');
      // Click on the backdrop (not on the card) closes the tour. We detect
      // this by checking the event target is the overlay itself.
      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) skip();
      });
      return overlay;
    }

    function render() {
      const step = STEPS[currentIndex];
      if (!step) {
        end({ completed: true });
        return;
      }

      let overlay = document.getElementById(HOWTO_OVERLAY_ID);
      if (!overlay) {
        overlay = buildOverlay();
        document.body.appendChild(overlay);
      }
      overlay.innerHTML = '';

      const target = step.findTarget ? step.findTarget() : null;

      // Spotlight ring (only when we actually have a target in view).
      if (target instanceof Element) {
        const rect = target.getBoundingClientRect();
        // Edge case: element is detached or zero-sized (rare but possible
        // mid-mutation). Treat as "no target" so we still show the card.
        if (rect.width > 0 && rect.height > 0) {
          const spotlight = document.createElement('div');
          spotlight.className = 'momentum-howto__spotlight';
          const pad = 6;
          spotlight.style.top = `${rect.top - pad}px`;
          spotlight.style.left = `${rect.left - pad}px`;
          spotlight.style.width = `${rect.width + pad * 2}px`;
          spotlight.style.height = `${rect.height + pad * 2}px`;
          overlay.appendChild(spotlight);
          // Bring the target into view if it's offscreen (e.g. sprint chips
          // scrolled below the fold).
          try {
            if (rect.bottom < 0 || rect.top > window.innerHeight) {
              target.scrollIntoView({ block: 'center', behavior: 'smooth' });
            }
          } catch (_) { /* old browsers — ignore */ }
        }
      }

      // Step card.
      const card = document.createElement('div');
      card.className = 'momentum-howto__card';

      const targetRect =
        target instanceof Element ? target.getBoundingClientRect() : null;
      const hasVisibleTarget =
        targetRect && targetRect.width > 0 && targetRect.height > 0;

      if (hasVisibleTarget) {
        positionCardNearTarget(card, targetRect);
      } else {
        card.dataset.placement = 'center';
      }

      const stepLabel = document.createElement('p');
      stepLabel.className = 'momentum-howto__step';
      stepLabel.textContent = `Étape ${currentIndex + 1} sur ${STEPS.length}`;
      card.appendChild(stepLabel);

      const title = document.createElement('h2');
      title.className = 'momentum-howto__title';
      title.textContent = step.title;
      card.appendChild(title);

      const body = document.createElement('p');
      body.className = 'momentum-howto__body';
      body.textContent = step.body;
      card.appendChild(body);

      // Only surface the "missing target" hint when the step actually points
      // to a feature we couldn't find (intro step has no findTarget).
      if (step.findTarget && !hasVisibleTarget && step.missingHint) {
        const hint = document.createElement('p');
        hint.className = 'momentum-howto__missing';
        hint.textContent = step.missingHint;
        card.appendChild(hint);
      }

      const actions = document.createElement('div');
      actions.className = 'momentum-howto__actions';

      const skipBtn = document.createElement('button');
      skipBtn.type = 'button';
      skipBtn.className = 'momentum-howto__btn momentum-howto__btn--skip';
      skipBtn.textContent = 'Passer';
      skipBtn.addEventListener('click', skip);
      actions.appendChild(skipBtn);

      const rightActions = document.createElement('div');
      rightActions.className = 'momentum-howto__actions-right';

      const prevBtn = document.createElement('button');
      prevBtn.type = 'button';
      prevBtn.className = 'momentum-howto__btn momentum-howto__btn--secondary';
      prevBtn.textContent = 'Précédent';
      prevBtn.disabled = currentIndex === 0;
      prevBtn.addEventListener('click', prev);
      rightActions.appendChild(prevBtn);

      const nextBtn = document.createElement('button');
      nextBtn.type = 'button';
      nextBtn.className = 'momentum-howto__btn momentum-howto__btn--primary';
      nextBtn.textContent =
        currentIndex === STEPS.length - 1 ? 'Terminer' : 'Suivant';
      nextBtn.addEventListener('click', next);
      rightActions.appendChild(nextBtn);

      actions.appendChild(rightActions);
      card.appendChild(actions);
      overlay.appendChild(card);

      // Re-render on resize / scroll so the spotlight tracks the target.
      // We debounce via requestAnimationFrame to avoid layout thrash on
      // fast scroll.
      if (!reflowHandler) {
        let scheduled = false;
        reflowHandler = () => {
          if (scheduled) return;
          scheduled = true;
          requestAnimationFrame(() => {
            scheduled = false;
            // Only re-render if the overlay is still mounted.
            if (document.getElementById(HOWTO_OVERLAY_ID)) render();
          });
        };
        window.addEventListener('resize', reflowHandler);
        window.addEventListener('scroll', reflowHandler, true);
      }
    }

    // Position the card adjacent to the target rect. Prefer right-of,
    // fall back to below, then above, then left-of, then centered. Keep
    // a margin from the viewport edges.
    function positionCardNearTarget(card, rect) {
      const MARGIN = 16;
      const CARD_W = 340;
      const CARD_H = 200; // conservative estimate — actual height is content-driven
      const vw = window.innerWidth;
      const vh = window.innerHeight;

      // Try right of target.
      if (rect.right + MARGIN + CARD_W <= vw - MARGIN) {
        card.style.left = `${rect.right + MARGIN}px`;
        card.style.top = `${clamp(rect.top, MARGIN, vh - CARD_H - MARGIN)}px`;
        return;
      }
      // Try below.
      if (rect.bottom + MARGIN + CARD_H <= vh - MARGIN) {
        card.style.top = `${rect.bottom + MARGIN}px`;
        card.style.left = `${clamp(rect.left, MARGIN, vw - CARD_W - MARGIN)}px`;
        return;
      }
      // Try above.
      if (rect.top - MARGIN - CARD_H >= MARGIN) {
        card.style.top = `${rect.top - CARD_H - MARGIN}px`;
        card.style.left = `${clamp(rect.left, MARGIN, vw - CARD_W - MARGIN)}px`;
        return;
      }
      // Try left of target.
      if (rect.left - MARGIN - CARD_W >= MARGIN) {
        card.style.left = `${rect.left - CARD_W - MARGIN}px`;
        card.style.top = `${clamp(rect.top, MARGIN, vh - CARD_H - MARGIN)}px`;
        return;
      }
      // Give up and center it.
      card.dataset.placement = 'center';
    }

    function clamp(v, min, max) {
      return Math.max(min, Math.min(max, v));
    }

    return {
      ensureButton,
      removeButton,
      start,
      end,
      hasBeenSeen,
    };
  })();

  // ---------------------------------------------------------------------------
  // exportPng — intercepts the native Plans/Timeline "Export" popover and
  // injects a companion menu entry "Image enrichie Momentum (.png)" right
  // after the native "Image (.png)" item.
  //
  // Unlike Jira's native PNG export (which rasterises server-side from the
  // raw plan data and therefore loses every Momentum-Light overlay), this
  // export captures the live DOM of the timeline — epic progress bars, SP
  // labels, T-Shirt badges, confidence washes, sprint-fill chips and the
  // velocity banner are all included in the final image, pixel-identical
  // to what the user sees on screen.
  //
  // Implementation:
  //   1. Menu MutationObserver spots the Export popover when it opens and
  //      adds "Image enrichie Momentum (.png)" right after the native item.
  //   2. On click we locate the capture root. Priority order:
  //        a. `#sr-timeline` — Plans / Advanced Roadmaps renders the whole
  //           plan into this container, so html2canvas gets every Epic
  //           and ticket currently in the DOM in a single pass.
  //        b. outermost `[data-testid^="roadmap.timeline-table-kit"]`.
  //        c. `[role="main"]` as a last resort.
  //      We hand the chosen root to html2canvas, which is bundled via the
  //      userscript `@require` directive so Atlassian's aggressive CSP
  //      never has to allow a runtime CDN fetch.
  //   3. Single-shot, viewport-only capture: we only snapshot what the
  //      user can currently see. Plans virtualises its rows, so trying
  //      to scroll-and-stitch ends up fighting the framework and produces
  //      artefacts (misaligned seams, ghost rows, sticky headers repeated
  //      down the page). If the user wants to cover a plan that overflows
  //      their viewport, they scroll and export again — stitching two or
  //      three PNGs manually is simpler and more reliable than doing it
  //      in-browser.
  //   4. The resulting canvas is downloaded as `momentum-timeline-<iso>.png`.
  //
  // UX: a floating toast reports progress ("rendu de la Timeline…" →
  // "export prêt ✓") so the user knows the click registered.
  // ---------------------------------------------------------------------------

  const exportPng = (() => {
    let installed = false;
    // Match both EN ("Image (.png)") and FR ("Image (.png)") — Atlaskit keeps
    // the ".png" suffix across locales, so the token is enough to key off.
    // Guarded against false positives by requiring the word "image" near it.
    const IMAGE_LABEL = /image[^]*\.\s*png/i;
    const INJECTED_ATTR = 'data-momentum-export-injected';
    const ITEM_ATTR = 'data-momentum-export-item';

    function textLeafMatching(root, rx) {
      // Find the deepest element whose own trimmed textContent matches `rx`.
      // We purposefully avoid TreeWalker on text nodes here because Atlaskit
      // wraps labels in a couple of <span>s we want to preserve for styling.
      const all = [...root.querySelectorAll('*')];
      for (let i = all.length - 1; i >= 0; i -= 1) {
        const el = all[i];
        if (el.children.length > 0) continue;
        const t = (el.textContent || '').trim();
        if (t && rx.test(t)) return el;
      }
      return null;
    }

    function findImagePngItem(menu) {
      const items = menu.querySelectorAll('[role="menuitem"]');
      for (const item of items) {
        const t = (item.textContent || '').trim();
        if (IMAGE_LABEL.test(t)) return item;
      }
      return null;
    }

    function closeOpenMenus() {
      // Atlaskit popovers close on Escape. Firing it at document level
      // propagates to the open menu without needing a reference to it.
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    }

    function injectEnrichedEntry(menu) {
      if (menu.getAttribute(INJECTED_ATTR) === '1') return;
      const native = findImagePngItem(menu);
      if (!native) return;
      menu.setAttribute(INJECTED_ATTR, '1');

      // Clone to inherit Atlaskit styling (focus ring, hover, spacing).
      const enriched = native.cloneNode(true);
      enriched.setAttribute(ITEM_ATTR, '1');
      // Strip attributes that would make the clone collide with the native
      // item (React keys, aria IDs).
      enriched.removeAttribute('id');
      enriched.removeAttribute('aria-describedby');

      const leaf = textLeafMatching(enriched, IMAGE_LABEL)
        || (IMAGE_LABEL.test(enriched.textContent || '') ? enriched : null);
      if (leaf) leaf.textContent = 'Image enrichie Momentum (.png)';

      // Swap the click handler. `capture:true` + stopImmediatePropagation
      // beats Atlaskit's own delegate — we don't want Jira to also trigger
      // its native export pipeline.
      enriched.addEventListener(
        'click',
        (e) => {
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          closeOpenMenus();
          runExport().catch((err) => warn('export failed:', err?.message || err));
        },
        true,
      );
      // Keyboard parity — Atlaskit menu items fire on Enter/Space too.
      enriched.addEventListener(
        'keydown',
        (e) => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          e.stopPropagation();
          e.stopImmediatePropagation();
          closeOpenMenus();
          runExport().catch((err) => warn('export failed:', err?.message || err));
        },
        true,
      );

      native.parentNode.insertBefore(enriched, native.nextSibling);
      debug('exportPng: enriched menu entry injected');
    }

    function install() {
      if (installed) return;
      installed = true;
      const obs = new MutationObserver((muts) => {
        for (const m of muts) {
          for (const n of m.addedNodes) {
            if (!(n instanceof HTMLElement)) continue;
            const menus = n.matches?.('[role="menu"]')
              ? [n]
              : [...(n.querySelectorAll?.('[role="menu"]') || [])];
            for (const menu of menus) injectEnrichedEntry(menu);
          }
        }
      });
      obs.observe(document.body, { childList: true, subtree: true });
    }

    // ------------------------------------------------------------------
    // Capture root detection — we want the outermost Advanced Roadmaps
    // container so the exported PNG matches the live layout (list + chart +
    // sprint chips row, with our overlays in place). Fallbacks keep the
    // feature working even if Atlassian's testid taxonomy shifts.
    // ------------------------------------------------------------------

    function findCaptureRoot() {
      // Strategy 1 — the `#sr-timeline` element. Plans / Advanced Roadmaps
      // renders the whole plan into this container at its intrinsic height,
      // so html2canvas gets every Epic / ticket in a single pass — no
      // virtualisation scroll-and-stitch required. If it's present, always
      // prefer it over the Atlaskit testid wrappers (which can expose only
      // the currently-visible rows).
      const sr = document.getElementById('sr-timeline');
      if (sr instanceof HTMLElement) return sr;
      // Strategy 2 — outermost `[data-testid^="roadmap.timeline-table-kit"]`.
      // That prefix is stable on Plans / Advanced Roadmaps and wraps the
      // entire timeline table (list side + chart side + header rows).
      const kitHits = [...document.querySelectorAll('[data-testid]')].filter((el) => {
        const tid = el.getAttribute('data-testid') || '';
        return tid.startsWith('roadmap.timeline-table-kit');
      });
      if (kitHits.length) {
        // Outermost = the one that contains the most other hits.
        let best = null;
        let bestCount = -1;
        for (const el of kitHits) {
          const count = kitHits.reduce((acc, other) => acc + (el.contains(other) ? 1 : 0), 0);
          if (count > bestCount) { best = el; bestCount = count; }
        }
        if (best) return best;
      }
      // Strategy 3 — Jira main region (works for the native Timeline view
      // inside boards & project roadmaps, not just Plans).
      const main = document.querySelector('[role="main"]') || document.querySelector('main');
      if (main) return main;
      // Last resort so the feature at least produces something.
      return document.body;
    }

    // ------------------------------------------------------------------
    // Loading toast — html2canvas takes a couple of seconds on large
    // plans, so we surface progress so the user doesn't wonder whether
    // their click registered.
    // ------------------------------------------------------------------

    function showToast(text) {
      const toast = document.createElement('div');
      toast.id = 'momentum-export-toast';
      toast.textContent = text;
      Object.assign(toast.style, {
        position: 'fixed',
        top: '20px',
        left: '50%',
        transform: 'translateX(-50%)',
        padding: '10px 18px',
        background: 'rgba(9, 30, 66, 0.88)',
        color: '#FFFFFF',
        borderRadius: '6px',
        fontSize: '13px',
        fontWeight: '500',
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
        zIndex: '99999',
        boxShadow: '0 4px 12px rgba(0,0,0,0.18)',
        pointerEvents: 'none',
        transition: 'opacity 200ms ease-out',
      });
      document.body.appendChild(toast);
      return {
        update(t) { toast.textContent = t; },
        hide() {
          toast.style.opacity = '0';
          setTimeout(() => toast.remove(), 250);
        },
      };
    }

    function downloadCanvas(canvas, filename) {
      canvas.toBlob((blob) => {
        if (!blob) {
          warn('exportPng: toBlob returned null');
          return;
        }
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        // Revoke after a tick — Safari needs the blob to survive the click.
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }, 'image/png');
    }

    // Elements we hide from the captured image — ours (toast, how-to
    // overlay) and Jira's transient UI (open menus, tooltips) so the
    // PNG shows the timeline in its clean resting state.
    function isCaptureChrome(el) {
      if (!(el instanceof HTMLElement)) return false;
      if (el.id === 'momentum-export-toast') return true;
      if (el.id === HOWTO_BUTTON_ID) return true;
      if (el.id === HOWTO_OVERLAY_ID) return true;
      const role = el.getAttribute?.('role');
      if (role === 'menu') return true;
      if (role === 'tooltip') return true;
      // Atlaskit renders transient overlays into a sibling portal layer.
      // Skip the portal container entirely so unrelated popovers don't
      // leak into the export.
      if (el.classList?.contains('atlaskit-portal')) return true;
      return false;
    }

    // ------------------------------------------------------------------
    // Discovery hatching — inject temporary canvases so html2canvas
    // can capture them natively
    //
    // Low/medium-confidence Epic bars still in Discovery are marked with
    // diagonal white stripes via `::after { background-image:
    // repeating-linear-gradient(45deg, ...) }`. html2canvas 1.4.1 drops
    // that gradient on pseudo-elements — the stripes are missing from
    // the PNG even though the `::before` wash makes it through.
    //
    // Earlier attempts tried to paint the hatch onto the returned canvas
    // by mapping each overlay's viewport rect through the capture root's
    // rect + scale, but that proved fragile (the hatching landed at the
    // wrong Y across the whole export). Instead we:
    //   1. Append a real `<canvas>` child to every eligible overlay,
    //      sized to the overlay via inset:0, filled with the hatch
    //      pattern at the current DPR.
    //   2. Suppress the CSS `::after` hatch globally via a throwaway
    //      <style> tag so the live view doesn't double up.
    //   3. Run html2canvas — it captures the <canvas> children natively,
    //      no coordinate math required, because the browser's own
    //      layout engine has already placed them exactly where the
    //      `::after` would have been.
    //   4. Remove the injected canvases and the <style> in `finally`.
    //
    // The browser sees the same visual both before and during the export
    // (swapping one hatch for a pixel-equivalent one), so there's no
    // flicker beyond maybe a single frame at cleanup.
    // ------------------------------------------------------------------

    // Draw the 45° hatch into a canvas sized `w × h` at the given DPR.
    // Matches the CSS `repeating-linear-gradient(45deg, transparent 0
    // 5px, rgba(255,255,255,0.22) 5px 9px)`: stripes perpendicular to a
    // 45° axis with a 9px period and 4px opaque band per period.
    function drawHatchInto(ctx, w, h, dpr) {
      ctx.save();
      ctx.scale(dpr, dpr);
      ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
      ctx.lineWidth = 4;
      ctx.lineCap = 'square';
      ctx.beginPath();
      const period = 9 * Math.SQRT2;
      // Stripes go top-left → bottom-right. Starting x ranges from -h
      // (so a stripe starting above-left of the rect reaches the top
      // edge) through w (so the last stripe starts past the right
      // edge). Each stripe is `h` long so it always crosses the rect.
      for (let ax = -h; ax < w + period; ax += period) {
        ctx.moveTo(ax, 0);
        ctx.lineTo(ax + h, h);
      }
      ctx.stroke();
      ctx.restore();
    }

    function injectDiscoveryHatchCanvases() {
      const overlays = document.querySelectorAll(
        `.${OVERLAY_CLASS}[data-discovery][data-confidence="low"],`
        + `.${OVERLAY_CLASS}[data-discovery][data-confidence="medium"]`,
      );
      const injections = [];
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      for (const overlay of overlays) {
        if (!(overlay instanceof HTMLElement)) continue;
        if (overlay.classList.contains(OVERLAY_ESTIMATE_MOD)) continue;
        if (overlay.classList.contains(OVERLAY_SPRINT_FILL_MOD)) continue;
        const w = overlay.offsetWidth;
        const h = overlay.offsetHeight;
        if (!w || !h) continue;

        const c = document.createElement('canvas');
        c.width = Math.ceil(w * dpr);
        c.height = Math.ceil(h * dpr);
        c.style.cssText =
          'position:absolute;inset:0;width:100%;height:100%;'
          + 'pointer-events:none;border-radius:inherit;z-index:1;';
        c.setAttribute('data-momentum-export-hatch', '');
        drawHatchInto(c.getContext('2d'), w, h, dpr);
        overlay.appendChild(c);
        injections.push(c);
      }
      log(`exportPng: injected ${injections.length} hatch canvas(es)`);
      return injections;
    }

    // Globally hide the CSS `::after` hatch while our injected canvases
    // are in play, so the live screen doesn't render two layers stacked
    // (which would read as darker stripes). Returns the <style> node so
    // the caller can remove it when export is done.
    function suppressCssHatch() {
      const style = document.createElement('style');
      style.id = 'momentum-export-hatch-suppressor';
      style.textContent = `.${OVERLAY_CLASS}::after { display: none !important; }`;
      document.head.appendChild(style);
      return style;
    }

    // ------------------------------------------------------------------
    // Capture — single-shot, viewport-only
    //
    // We deliberately capture only what's currently on screen. Plans
    // virtualises its rows, so trying to scroll-and-stitch a taller frame
    // fights the framework and produces artefacts. If the user wants to
    // export a plan that overflows their viewport, they just scroll and
    // click the export entry again — two or three PNGs stitched by the
    // user in their image viewer is more reliable than us doing it here.
    // ------------------------------------------------------------------
    function html2canvasOpts() {
      return {
        backgroundColor: '#FFFFFF',
        useCORS: true,
        allowTaint: false,
        logging: false,
        // Cap at 2× so wide plans don't produce 20 MB PNGs, but still
        // match Retina clarity on HiDPI displays.
        scale: Math.min(window.devicePixelRatio || 1, 2),
        windowWidth: document.documentElement.clientWidth,
        windowHeight: document.documentElement.clientHeight,
        ignoreElements: isCaptureChrome,
        scrollX: -window.scrollX,
        scrollY: -window.scrollY,
      };
    }

    async function runExport() {
      const toast = showToast('Momentum-Light — préparation de l\'export…');
      try {
        if (typeof window.html2canvas !== 'function') {
          throw new Error(
            'html2canvas introuvable — le userscript doit être chargé via '
            + 'Tampermonkey/Violentmonkey pour que la directive @require '
            + 'fournisse la dépendance.',
          );
        }
        const root = findCaptureRoot();
        // Give Jira a couple of rAF ticks to settle (pending paint from
        // hover states, menu close animations, etc.) before we snapshot.
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

        // Swap the CSS `::after` hatch for live <canvas> children so
        // html2canvas can capture the stripes (it can't render
        // `repeating-linear-gradient` on pseudo-elements reliably).
        // Both operations are guarded by `finally` so the DOM is left
        // clean even if the capture throws.
        const suppressor = suppressCssHatch();
        const injections = injectDiscoveryHatchCanvases();
        let canvas;
        try {
          toast.update('Momentum-Light — rendu de la Timeline…');
          log('exportPng: capturing', root);
          canvas = await window.html2canvas(root, html2canvasOpts());
        } finally {
          for (const c of injections) c.remove();
          suppressor.remove();
        }

        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
        downloadCanvas(canvas, `momentum-timeline-${stamp}.png`);
        toast.update('Momentum-Light — export prêt ✓');
        setTimeout(() => toast.hide(), 1400);
        log('exportPng: done');
      } catch (err) {
        error('exportPng failed:', err?.message || err);
        toast.update('Momentum-Light — échec de l\'export (voir console)');
        setTimeout(() => toast.hide(), 3200);
        throw err;
      }
    }

    return { install };
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
      description: 'Fixed banner showing the average velocity of the last 5 closed sprints.',
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
    {
      id: 'sprint-fill-indicator',
      description:
        'Fill overlay on each active/future sprint chip (Sprints row) keyed to the 5-sprint ' +
        'average velocity. Active sprints show remaining SP; future sprints show planned SP.',
      isActive: isTimelineLikePath,
      _warnedZeroMatch: false,
      async onMutation(root) {
        const chips = sprintChipDom.findChips(root);
        heartbeat('sprint chips found:', chips.length);
        if (chips.length === 0) {
          sprintChipDom.probe(root);
          return;
        }
        perfStamp(`sprint-fill: decorating ${chips.length} chips`);
        let ctx;
        try {
          ctx = await velocity.getPlanningContext();
        } catch (e) {
          warn('planning context unavailable:', e?.message || e);
          return;
        }
        if (!ctx || !(ctx.average > 0) || !ctx.openSprints?.length) return;
        const byKey = sprintChipDom.indexOpenSprints(ctx.openSprints);

        // Run all decorations in parallel; aggregate match outcomes so we
        // can surface a "sprint chips matched: X/Y" heartbeat. This gives
        // us a one-line signal to diagnose the "feature invisible" case
        // without duplicating the matching logic here.
        const outcomes = await Promise.all(
          chips.map((chip) =>
            sprintChipDom.decorate(chip, byKey, ctx.average).catch((e) => {
              warn('sprint decorate failed:', e?.message || e);
              return null;
            }),
          ),
        );
        const matched = outcomes.filter(Boolean).length;
        heartbeat(`sprint chips matched: ${matched}/${chips.length}`);
        if (matched === 0 && !this._warnedZeroMatch) {
          this._warnedZeroMatch = true;
          const unmatchedSample = chips
            .slice(0, 5)
            .map((c) => sprintChipDom.extractSprintName(c))
            .filter(Boolean);
          warn(
            `sprint-fill: 0/${chips.length} chips matched an active/future sprint. ` +
              'Chip labels (sample):',
            unmatchedSample,
            '| open sprint names (sample):',
            ctx.openSprints.slice(0, 10).map((s) => s.name),
          );
        } else if (matched > 0) {
          this._warnedZeroMatch = false;
        }
      },
    },
    {
      id: 'howto-menu',
      description:
        'Floating "?" button + guided tour that spotlights each Momentum-Light feature ' +
        'step by step, with Skip / Previous / Next controls. Auto-launches once per ' +
        'browser (localStorage) so new users discover the tool without surprise.',
      isActive: isTimelineLikePath,
      _autoLaunched: false,
      onMutation() {
        howto.ensureButton();
        // Auto-launch once per browser, only if the user hasn't seen it yet
        // and no tour is already open. We defer via setTimeout so the
        // features around us have a chance to paint first — spotlighting
        // them immediately wouldn't work if they haven't rendered yet.
        if (!this._autoLaunched && !howto.hasBeenSeen()) {
          this._autoLaunched = true;
          setTimeout(() => {
            if (!document.getElementById(HOWTO_OVERLAY_ID)) howto.start();
          }, 1500);
        }
      },
      onInactive() {
        howto.end();
        howto.removeButton();
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
  // apiMutationInterceptor — monkey-patch window.fetch AND XMLHttpRequest so
  // we can invalidate sprintCapacity the moment Jira commits a ticket-sprint
  // change. Plans / Advanced Roadmaps persists scope changes through a
  // patchwork of endpoints (classic REST, proprietary /rest/jpo, gateway
  // routes, GraphQL) so the match list is intentionally broad.
  //
  // Strategy: any non-GET request to an Atlassian backend path that returns
  // 2xx triggers invalidation unless it is on a read-only allowlist
  // (search/jql, graphql queries that are safe to ignore). False positives
  // are harmless — worst case we refetch sprint capacity once, which is
  // cheap and rate-limited by the inflight-dedup.
  // ---------------------------------------------------------------------------

  const apiMutationInterceptor = (() => {
    const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

    // Paths whose mutating method is definitely a sprint-membership
    // change. Broad enough to cover Plans, Agile API, Greenhopper, and
    // proprietary /rest/jpo routes.
    const INVALIDATE_PATTERNS = [
      /\/rest\/api\/\d+\/issue\b/i,              // REST v3 issue edits
      /\/rest\/agile\/[^/]+\/(sprint|backlog|board|issue)\b/i, // Agile API
      /\/rest\/greenhopper\/1\.0\//i,            // Greenhopper scope/sprint
      /\/rest\/plans\//i,                        // Advanced Roadmaps REST
      /\/rest\/jpo\//i,                          // Legacy Portfolio/Plans API
      /\/gateway\/api\/.*\/(issues?|sprints?|plans?)\b/i, // Gateway routes
    ];

    // GraphQL is multiplexed (queries + mutations over the same POST).
    // For non-persisted requests we match on URL but require the body
    // to contain a `mutation` operation to avoid invalidating on every
    // read query.
    const GRAPHQL_URL_PATTERNS = [
      /\/gateway\/api\/graphql\b/i,
      /\/graphql\b/i,
    ];

    // Persisted-query mutations — Jira Cloud and Plans use these
    // extensively (e.g. POST /gateway/api/graphql/pq/<hash>?operation=
    // updateRoadmapItemMutation). The body is just { operationName,
    // variables, extensions } — no literal `mutation` keyword, so
    // isGraphqlMutationBody would miss them. Detect via the ?operation=
    // query param whose value conventionally ends in "Mutation".
    const GRAPHQL_PERSISTED_PATH = /\/graphql\/pq\//i;

    // Read-only endpoints that happen to use POST. Excluded to avoid
    // invalidating the cache when *we* search, or when Jira fetches lists.
    const READONLY_EXCLUDES = [
      /\/rest\/api\/\d+\/search(\b|\/jql)/i,     // POST /search/jql (our calls too)
      /\/rest\/agile\/[^/]+\/board\b.*\/sprint\?/i, // sprint listing (GET-like)
    ];

    function isGraphqlMutationBody(body) {
      if (!body) return false;
      let text = body;
      if (typeof text !== 'string') {
        // Could be FormData/URLSearchParams/Blob; we don't peek those,
        // treat as "possibly mutation" to stay safe.
        return true;
      }
      // Look for a top-level `mutation` operation. Regex is forgiving to
      // whitespace/named operations: `mutation Foo(...)` and bare
      // `mutation { ... }` both match.
      return /(^|["\\s{])mutation\s*[\s({]/i.test(text);
    }

    function isGraphqlPersistedMutation(url) {
      if (!GRAPHQL_PERSISTED_PATH.test(url)) return false;
      // Persisted queries carry the operation name in the query string
      // (or occasionally in the body — we stick with URL for the fast
      // path since it doesn't require parsing).
      const m = url.match(/[?&]operation=([^&]+)/);
      if (!m) return false;
      return /mutation/i.test(decodeURIComponent(m[1]));
    }

    function extractSprintId(url) {
      const m = url.match(/\/sprint\/(\d+)(\/|\?|$)/i);
      return m ? Number(m[1]) : null;
    }

    function extractIssueKey(url) {
      // Matches /rest/api/3/issue/ABC-123 (and variants). Anchored on
      // `/issue/` so we don't accidentally grab keys appearing elsewhere
      // in the URL (e.g. query params).
      const m = url.match(/\/issue\/([A-Z][A-Z0-9]+-\d+)(\b|\/|\?|$)/);
      return m ? m[1] : null;
    }

    // GraphQL mutations (Plans) carry their payload in a typed `variables`
    // object whose shape depends on the operation. Rather than enumerate
    // every mutation's schema (they change without notice), we walk the
    // body heuristically:
    //   - any string matching the issue-key regex is a candidate issue.
    //   - any numeric value (or numeric-string) that coincides with a
    //     known open-sprint id is a candidate target sprint.
    // Cross-referencing against velocity.getKnownOpenSprintIds() keeps
    // false positives near zero: a random number in the variables won't
    // accidentally match a real sprint.
    function extractGraphqlMove(body, openSprintIdSet) {
      if (!body || typeof body !== 'string') return null;
      if (!openSprintIdSet || openSprintIdSet.size === 0) return null;
      let json;
      try { json = JSON.parse(body); } catch { return null; }
      const variables = json?.variables;
      if (!variables || typeof variables !== 'object') return null;

      const issueKeys = new Set();
      const targetIds = new Set();
      const walk = (node, depth) => {
        if (depth > 6 || node == null) return;
        if (typeof node === 'string') {
          if (/^[A-Z][A-Z0-9]+-\d+$/.test(node)) issueKeys.add(node);
          else if (/^\d+$/.test(node)) {
            const n = Number(node);
            if (openSprintIdSet.has(n)) targetIds.add(n);
          }
          return;
        }
        if (typeof node === 'number') {
          if (openSprintIdSet.has(node)) targetIds.add(node);
          return;
        }
        if (Array.isArray(node)) {
          for (const item of node) walk(item, depth + 1);
          return;
        }
        if (typeof node === 'object') {
          for (const v of Object.values(node)) walk(v, depth + 1);
        }
      };
      walk(variables, 0);

      if (issueKeys.size !== 1 || targetIds.size === 0) return null;
      return { issueKey: [...issueKeys][0], targetIds: [...targetIds] };
    }

    // Extract target sprint IDs from a mutation body. Jira's REST accepts
    // the sprint change in several shapes depending on the client:
    //   { fields: { customfield_XXXX: [id, ...] } }          (bulk set)
    //   { fields: { customfield_XXXX: id } }                 (single)
    //   { update: { customfield_XXXX: [{ set: [ids] }] } }   (operation-style)
    //   { update: { customfield_XXXX: [{ add: id }] } }      (incremental)
    // We handle the common set-style shapes; incremental add is treated as
    // "at least one new sprint" (the optimistic delta will still be right
    // if that's the actual move Jira is persisting).
    function extractTargetSprintIds(body, sprintFieldId) {
      if (!body || !sprintFieldId) return null;
      let text = body;
      if (typeof text !== 'string') {
        // ArrayBuffer / Blob / FormData — we'd need async reads to peek.
        // Skip optimistic path; SWR + JQL still kicks in as a fallback.
        return null;
      }
      let json;
      try { json = JSON.parse(text); } catch { return null; }
      if (!json || typeof json !== 'object') return null;

      const ids = new Set();
      const normalize = (v) => {
        if (v == null) return null;
        const n = typeof v === 'object' ? Number(v.id) : Number(v);
        return Number.isFinite(n) && n > 0 ? n : null;
      };

      const fieldsVal = json.fields?.[sprintFieldId];
      if (fieldsVal !== undefined) {
        const arr = Array.isArray(fieldsVal) ? fieldsVal : [fieldsVal];
        for (const v of arr) {
          const n = normalize(v);
          if (n) ids.add(n);
        }
      }
      const updateOps = json.update?.[sprintFieldId];
      if (Array.isArray(updateOps)) {
        for (const op of updateOps) {
          if (op.set !== undefined) {
            // `set` replaces everything — reset accumulator to match.
            ids.clear();
            const setArr = Array.isArray(op.set) ? op.set : [op.set];
            for (const v of setArr) {
              const n = normalize(v);
              if (n) ids.add(n);
            }
          } else if (op.add !== undefined) {
            const n = normalize(op.add);
            if (n) ids.add(n);
          }
          // `remove` left alone: caller's prev-sprints minus removed
          // would give us the target, but we don't know prev-sprints
          // outside the catalog lookup (which is done by applyOptimisticMove
          // itself). Skip — SWR still catches up.
        }
      }
      if (ids.size === 0) return null;
      return [...ids];
    }

    function isMutation(method, status) {
      if (!MUTATING.has(method.toUpperCase())) return false;
      if (status < 200 || status >= 300) return false;
      return true;
    }

    function matchesInvalidationPath(url, body) {
      if (READONLY_EXCLUDES.some((re) => re.test(url))) return false;
      if (INVALIDATE_PATTERNS.some((re) => re.test(url))) return true;
      // Plans / Advanced Roadmaps fires mutations through persisted GraphQL
      // operations; detect those by the ?operation=*Mutation query param
      // rather than by body content (the body is just a hash reference).
      if (isGraphqlPersistedMutation(url)) return true;
      if (GRAPHQL_URL_PATTERNS.some((re) => re.test(url))) {
        return isGraphqlMutationBody(body);
      }
      return false;
    }

    let onAfterInvalidate = null;

    // Send-time: fires the moment we see the request leaving the browser,
    // before the server has acknowledged anything. We apply an optimistic
    // delta locally so the overlay updates in the same animation frame as
    // Jira's own optimistic UI (the ticket card moving). We deliberately
    // DO NOT invalidate/refetch here — a JQL that races the persist might
    // return pre-mutation data and overwrite our optimistic value with
    // stale numbers. Invalidation is deferred to response-time.
    function onMutationSend(url, body) {
      perfMark(`api-mutation send ${url.replace(/\?.*/, '')}`);
      let applied = false;
      try {
        // REST path: issue key in URL, sprint ids in body.fields[<sprintFieldId>].
        const issueKeyFromUrl = extractIssueKey(url);
        const sprintFieldId = sprintCapacity.getSprintFieldIdSync();
        if (issueKeyFromUrl && sprintFieldId) {
          const targetIds = extractTargetSprintIds(body, sprintFieldId);
          if (targetIds && targetIds.length > 0) {
            applied = sprintCapacity.applyOptimisticMove(issueKeyFromUrl, targetIds);
            perfStamp(
              `optimistic(REST) ${applied ? 'applied' : 'skipped(catalog miss)'} ` +
                `${issueKeyFromUrl} → [${targetIds.join(',')}]`,
            );
          }
        }
        // GraphQL path: issue key + sprint ids heuristically inside
        // body.variables. Walk the tree looking for a single issue key +
        // known sprint ids.
        if (!applied) {
          const openIds = velocity.getKnownOpenSprintIds();
          const move = extractGraphqlMove(body, openIds);
          if (move) {
            applied = sprintCapacity.applyOptimisticMove(move.issueKey, move.targetIds);
            perfStamp(
              `optimistic(GraphQL) ${applied ? 'applied' : 'skipped(catalog miss)'} ` +
                `${move.issueKey} → [${move.targetIds.join(',')}]`,
            );
          } else if (isDebug()) {
            perfStamp('optimistic: no move extractable from body (REST+GraphQL both missed)');
          }
        }
      } catch (e) {
        if (isDebug()) debug('onMutationSend error:', e?.message || e);
      }
      // If we applied, trigger a repaint now so the chip updates before
      // the server even responds. If we didn't, no paint yet — the
      // response-time path will invalidate and refresh.
      if (applied && onAfterInvalidate) {
        perfStamp('repaint scheduled (optimistic applied)');
        onAfterInvalidate();
      }
    }

    // Response-time: authoritative. Server has committed (2xx), so a JQL
    // refresh now is guaranteed to see the post-mutation state. We mark
    // cache entries stale (keeping their values for SWR) and schedule a
    // re-run; the confirming JQL will overwrite any optimistic value that
    // was wrong.
    function onMutationConfirmed(url) {
      perfStamp(`api-mutation confirmed ${url.replace(/\?.*/, '')}`);
      const sprintId = extractSprintId(url);
      if (sprintId) sprintCapacity.invalidate(sprintId);
      else sprintCapacity.invalidateAll();
      if (onAfterInvalidate) {
        perfStamp('repaint scheduled (confirm-invalidate)');
        onAfterInvalidate();
      }
    }

    // In debug mode, dump every mutating same-origin request (matched or
    // not) so we can tune INVALIDATE_PATTERNS when Jira introduces new
    // routes. Cross-origin calls (Sentry, Segment, ad trackers) are
    // filtered out — they can't affect Jira's own sprint state. The log
    // is exposed at window.__MOMENTUM_API_LOG__ for offline inspection.
    const apiLog = [];
    function isSameOriginJiraPath(url) {
      try {
        const u = new URL(url, location.origin);
        return u.origin === location.origin;
      } catch {
        // Relative URLs without an origin are same-origin by definition.
        return url.startsWith('/');
      }
    }
    function recordObservation(method, url, status, matched) {
      if (!isDebug()) return;
      if (!isSameOriginJiraPath(url)) return;
      apiLog.push({ ts: Date.now(), method, url, status, matched });
      if (apiLog.length > 100) apiLog.shift();
      window.__MOMENTUM_API_LOG__ = apiLog;
      if (!matched) {
        debug(`api-mutation observed (not acted on): ${method} ${url} → ${status}`);
      }
    }

    let installed = false;
    return {
      install(afterInvalidateCb) {
        if (installed) return;
        installed = true;
        onAfterInvalidate = afterInvalidateCb || null;

        // ------ fetch patch
        const originalFetch = window.fetch.bind(window);
        window.fetch = async function momentumPatchedFetch(input, init) {
          // Peek request details BEFORE awaiting the server — so we can
          // fire optimistic updates at send-time rather than waiting the
          // full request round-trip before even starting to repaint.
          let url = '';
          let method = 'GET';
          let body = null;
          try {
            url = typeof input === 'string' ? input : input?.url || '';
            method =
              (init && init.method) ||
              (typeof input !== 'string' && input?.method) ||
              'GET';
            body =
              (init && init.body) ||
              (typeof input !== 'string' && input?.body) ||
              null;
            if (
              url &&
              MUTATING.has(method.toUpperCase()) &&
              matchesInvalidationPath(url, body)
            ) {
              onMutationSend(url, body);
            }
          } catch (e) {
            if (isDebug()) debug('fetch send-time error:', e?.message || e);
          }

          const res = await originalFetch(input, init);

          try {
            if (url && isMutation(method, res.status)) {
              const matched = matchesInvalidationPath(url, body);
              recordObservation(method, url, res.status, matched);
              if (matched) onMutationConfirmed(url);
            }
          } catch (e) {
            if (isDebug()) debug('api-mutation interceptor error (fetch):', e?.message || e);
          }
          return res;
        };

        // ------ XHR patch
        // Some Jira flows (legacy admin widgets, older Plans gestures)
        // still fire via XMLHttpRequest. Hooking `open` captures the URL
        // + method; `load` reads the final status.
        const origOpen = XMLHttpRequest.prototype.open;
        const origSend = XMLHttpRequest.prototype.send;
        XMLHttpRequest.prototype.open = function momentumXhrOpen(method, url) {
          this.__momentumMethod = method;
          this.__momentumUrl = url;
          return origOpen.apply(this, arguments);
        };
        XMLHttpRequest.prototype.send = function momentumXhrSend(body) {
          this.__momentumBody = body;
          const method = this.__momentumMethod || 'GET';
          const url = this.__momentumUrl || '';
          // Send-time optimistic, before origSend kicks off the network.
          try {
            if (
              url &&
              MUTATING.has(method.toUpperCase()) &&
              matchesInvalidationPath(url, body)
            ) {
              onMutationSend(url, body);
            }
          } catch (e) {
            if (isDebug()) debug('xhr send-time error:', e?.message || e);
          }
          this.addEventListener('load', () => {
            try {
              if (url && isMutation(method, this.status)) {
                const matched = matchesInvalidationPath(url, this.__momentumBody);
                recordObservation(method, url, this.status, matched);
                if (matched) onMutationConfirmed(url);
              }
            } catch (e) {
              if (isDebug()) debug('api-mutation interceptor error (xhr):', e?.message || e);
            }
          });
          return origSend.apply(this, arguments);
        };
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
    // Reflect the persisted view mode on <body> before any feature runs so
    // the CSS guards (e.g. hiding PM-only legends in Business view) apply
    // on the very first paint, no flicker on refresh.
    viewMode.syncBody();
    tooltipInterceptor.install();
    exportPng.install();
    // Two debounces: the DOM one is conservative (coalesces Jira's re-render
    // storm), the API one is tight — once the server has acknowledged a sprint
    // mutation the user is waiting on the overlay, so we want the refresh to
    // land as quickly as possible. Both share the same underlying runner, so
    // overlapping triggers still coalesce via the feature pipeline's own
    // inflight dedup.
    const onMutationFromDom = debounce(runActiveFeatures, MUTATION_DEBOUNCE_MS);
    const onMutationFromApi = debounce(runActiveFeatures, API_MUTATION_DEBOUNCE_MS);
    apiMutationInterceptor.install(onMutationFromApi);
    // When a background sprint-capacity refresh lands (stale-while-revalidate
    // consumers got the stale value, the fresh one arrives async), trigger a
    // re-paint so chips actually update on screen.
    sprintCapacity.onFresh(onMutationFromApi);
    // View-mode toggle — re-run the pipeline so every Epic bar is re-decorated
    // under the new mode without waiting for the next DOM mutation.
    viewMode.onChange(runActiveFeatures);
    const observer = new MutationObserver(onMutationFromDom);
    observer.observe(document.body, { childList: true, subtree: true });
    // Initial pass (in case the timeline is already rendered at document-idle).
    runActiveFeatures();
    log(
      'loaded — version 0.8.0',
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
