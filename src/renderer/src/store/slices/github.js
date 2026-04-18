import { syncPRChecksStatus } from './github-checks';
const CACHE_TTL = 300_000; // 5 minutes (stale data shown instantly, then refreshed)
const CHECKS_CACHE_TTL = 60_000; // 1 minute — checks change more frequently
// Why: the NewWorkspace page's work-item list is a browse surface, not a
// source of truth, so 60s staleness is fine — stale data renders instantly
// while a background refresh keeps it current.
const WORK_ITEMS_CACHE_TTL = 60_000;
const inflightPRRequests = new Map();
const inflightIssueRequests = new Map();
const inflightChecksRequests = new Map();
const inflightCommentsRequests = new Map();
const inflightWorkItemsRequests = new Map();
const prRequestGenerations = new Map();
function workItemsCacheKey(repoPath, limit, query) {
    return `${repoPath}::${limit}::${query}`;
}
// Why: 500 entries is generous enough that active developers will never hit it
// during normal use, but prevents the cache from growing without bound across
// many repos and branches over a long-running session.
const MAX_CACHE_ENTRIES = 500;
function isFresh(entry, ttl = CACHE_TTL) {
    return entry !== undefined && Date.now() - entry.fetchedAt < ttl;
}
/**
 * Evict the oldest entries from a cache record when it exceeds the max size.
 * Returns a pruned copy, or the original reference if no eviction was needed.
 */
function evictStaleEntries(cache, maxEntries = MAX_CACHE_ENTRIES) {
    const keys = Object.keys(cache);
    if (keys.length <= maxEntries) {
        return cache;
    }
    const sorted = keys
        .map((k) => ({ key: k, fetchedAt: cache[k].fetchedAt }))
        .sort((a, b) => b.fetchedAt - a.fetchedAt);
    const keep = new Set(sorted.slice(0, maxEntries).map((e) => e.key));
    const pruned = {};
    for (const k of keep) {
        pruned[k] = cache[k];
    }
    return pruned;
}
let saveTimer = null;
function debouncedSaveCache(state) {
    if (saveTimer) {
        clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(() => {
        saveTimer = null;
        window.api.cache.setGitHub({
            cache: {
                pr: state.prCache,
                issue: state.issueCache
            }
        });
    }, 1000); // Save at most once per second
}
export const createGitHubSlice = (set, get) => ({
    prCache: {},
    issueCache: {},
    checksCache: {},
    commentsCache: {},
    workItemsCache: {},
    getCachedWorkItems: (repoPath, limit, query) => {
        const key = workItemsCacheKey(repoPath, limit, query);
        return get().workItemsCache[key]?.data ?? null;
    },
    fetchWorkItems: async (repoPath, limit, query, options) => {
        const key = workItemsCacheKey(repoPath, limit, query);
        const cached = get().workItemsCache[key];
        if (!options?.force && isFresh(cached, WORK_ITEMS_CACHE_TTL)) {
            return cached.data ?? [];
        }
        const inflight = inflightWorkItemsRequests.get(key);
        if (inflight) {
            return inflight;
        }
        const request = (async () => {
            try {
                const items = (await window.api.gh.listWorkItems({
                    repoPath,
                    limit,
                    query: query || undefined
                }));
                set((s) => ({
                    workItemsCache: {
                        ...s.workItemsCache,
                        [key]: { data: items, fetchedAt: Date.now() }
                    }
                }));
                return items;
            }
            catch (err) {
                // Why: surface the error to the caller; keep stale cache entry so the
                // UI can continue to render something useful while the user retries.
                console.error('Failed to fetch GitHub work items:', err);
                throw err;
            }
            finally {
                inflightWorkItemsRequests.delete(key);
            }
        })();
        inflightWorkItemsRequests.set(key, request);
        return request;
    },
    prefetchWorkItems: (repoPath, limit = 36, query = '') => {
        const key = workItemsCacheKey(repoPath, limit, query);
        const cached = get().workItemsCache[key];
        // Skip when the cache is fresh or a request is already in flight.
        if (isFresh(cached, WORK_ITEMS_CACHE_TTL) || inflightWorkItemsRequests.has(key)) {
            return;
        }
        void get()
            .fetchWorkItems(repoPath, limit, query)
            .catch(() => { });
    },
    initGitHubCache: async () => {
        try {
            const persisted = await window.api.cache.getGitHub();
            if (persisted) {
                set({
                    prCache: persisted.pr || {},
                    issueCache: persisted.issue || {}
                });
            }
        }
        catch (err) {
            console.error('Failed to load GitHub cache from disk:', err);
        }
    },
    fetchPRForBranch: async (repoPath, branch, options) => {
        const cacheKey = `${repoPath}::${branch}`;
        const cached = get().prCache[cacheKey];
        if (!options?.force && isFresh(cached)) {
            return cached.data;
        }
        const inflightRequest = inflightPRRequests.get(cacheKey);
        if (inflightRequest && (!options?.force || inflightRequest.force)) {
            return inflightRequest.promise;
        }
        const generation = (prRequestGenerations.get(cacheKey) ?? 0) + 1;
        prRequestGenerations.set(cacheKey, generation);
        const request = (async () => {
            try {
                const pr = await window.api.gh.prForBranch({ repoPath, branch });
                if (prRequestGenerations.get(cacheKey) === generation) {
                    set((s) => ({
                        prCache: { ...s.prCache, [cacheKey]: { data: pr, fetchedAt: Date.now() } }
                    }));
                    debouncedSaveCache(get());
                }
                return pr;
            }
            catch (err) {
                console.error('Failed to fetch PR:', err);
                if (prRequestGenerations.get(cacheKey) === generation) {
                    set((s) => ({
                        prCache: { ...s.prCache, [cacheKey]: { data: null, fetchedAt: Date.now() } }
                    }));
                    debouncedSaveCache(get());
                }
                return null;
            }
            finally {
                const activeRequest = inflightPRRequests.get(cacheKey);
                if (activeRequest?.generation === generation) {
                    inflightPRRequests.delete(cacheKey);
                }
            }
        })();
        inflightPRRequests.set(cacheKey, {
            promise: request,
            force: Boolean(options?.force),
            generation
        });
        return request;
    },
    fetchIssue: async (repoPath, number) => {
        const cacheKey = `${repoPath}::${number}`;
        const cached = get().issueCache[cacheKey];
        if (isFresh(cached)) {
            return cached.data;
        }
        const inflightRequest = inflightIssueRequests.get(cacheKey);
        if (inflightRequest) {
            return inflightRequest;
        }
        const request = (async () => {
            try {
                const issue = await window.api.gh.issue({ repoPath, number });
                set((s) => ({
                    issueCache: { ...s.issueCache, [cacheKey]: { data: issue, fetchedAt: Date.now() } }
                }));
                debouncedSaveCache(get());
                return issue;
            }
            catch (err) {
                console.error('Failed to fetch issue:', err);
                set((s) => ({
                    issueCache: { ...s.issueCache, [cacheKey]: { data: null, fetchedAt: Date.now() } }
                }));
                debouncedSaveCache(get());
                return null;
            }
            finally {
                inflightIssueRequests.delete(cacheKey);
            }
        })();
        inflightIssueRequests.set(cacheKey, request);
        return request;
    },
    fetchPRChecks: async (repoPath, prNumber, branch, headSha, options) => {
        const cacheKey = `${repoPath}::pr-checks::${prNumber}`;
        const cached = get().checksCache[cacheKey];
        if (!options?.force && isFresh(cached, CHECKS_CACHE_TTL)) {
            const cachedChecks = cached.data ?? [];
            const prStatusUpdate = syncPRChecksStatus(get(), repoPath, branch, cachedChecks);
            if (prStatusUpdate) {
                set(prStatusUpdate);
                debouncedSaveCache(get());
            }
            return cachedChecks;
        }
        const inflightRequest = inflightChecksRequests.get(cacheKey);
        if (inflightRequest) {
            return inflightRequest;
        }
        const request = (async () => {
            try {
                const checks = (await window.api.gh.prChecks({
                    repoPath,
                    prNumber,
                    headSha,
                    noCache: options?.force
                }));
                set((s) => {
                    const nextState = {
                        checksCache: { ...s.checksCache, [cacheKey]: { data: checks, fetchedAt: Date.now() } }
                    };
                    const prStatusUpdate = syncPRChecksStatus(s, repoPath, branch, checks);
                    if (prStatusUpdate?.prCache) {
                        nextState.prCache = prStatusUpdate.prCache;
                    }
                    return nextState;
                });
                debouncedSaveCache(get());
                return checks;
            }
            catch (err) {
                console.error('Failed to fetch PR checks:', err);
                return get().checksCache[cacheKey]?.data ?? [];
            }
            finally {
                inflightChecksRequests.delete(cacheKey);
            }
        })();
        inflightChecksRequests.set(cacheKey, request);
        return request;
    },
    fetchPRComments: async (repoPath, prNumber, options) => {
        const cacheKey = `${repoPath}::pr-comments::${prNumber}`;
        const cached = get().commentsCache[cacheKey];
        if (!options?.force && isFresh(cached)) {
            return cached.data ?? [];
        }
        const inflightRequest = inflightCommentsRequests.get(cacheKey);
        if (inflightRequest) {
            return inflightRequest;
        }
        const request = (async () => {
            try {
                const comments = (await window.api.gh.prComments({
                    repoPath,
                    prNumber,
                    noCache: options?.force
                }));
                set((s) => ({
                    commentsCache: {
                        ...s.commentsCache,
                        [cacheKey]: { data: comments, fetchedAt: Date.now() }
                    }
                }));
                return comments;
            }
            catch (err) {
                console.error('Failed to fetch PR comments:', err);
                return get().commentsCache[cacheKey]?.data ?? [];
            }
            finally {
                inflightCommentsRequests.delete(cacheKey);
            }
        })();
        inflightCommentsRequests.set(cacheKey, request);
        return request;
    },
    resolveReviewThread: async (repoPath, prNumber, threadId, resolve) => {
        const cacheKey = `${repoPath}::pr-comments::${prNumber}`;
        // Optimistic update: toggle isResolved on all comments in this thread immediately
        // so the UI feels instant. Reverts if the API call fails.
        const prev = get().commentsCache[cacheKey]?.data;
        if (prev) {
            set((s) => ({
                commentsCache: {
                    ...s.commentsCache,
                    [cacheKey]: {
                        ...s.commentsCache[cacheKey],
                        data: prev.map((c) => (c.threadId === threadId ? { ...c, isResolved: resolve } : c))
                    }
                }
            }));
        }
        const ok = await window.api.gh.resolveReviewThread({ repoPath, threadId, resolve });
        if (!ok && prev) {
            // Revert optimistic update on failure
            set((s) => ({
                commentsCache: {
                    ...s.commentsCache,
                    [cacheKey]: { ...s.commentsCache[cacheKey], data: prev }
                }
            }));
        }
        return ok;
    },
    refreshAllGitHub: () => {
        // Invalidate checks and comments caches so they refresh on next access.
        // Also evict old entries from prCache and issueCache to prevent unbounded
        // growth across many repos and branches over a long-running session.
        set((s) => ({
            checksCache: {},
            commentsCache: {},
            prCache: evictStaleEntries(s.prCache),
            issueCache: evictStaleEntries(s.issueCache)
        }));
        // Why: prRequestGenerations tracks generation counters for inflight
        // fetch deduplication. Pruning keys that were just evicted from prCache
        // would race with inflight requests — their generation check would fail
        // and silently discard valid responses. Since each entry is just a number,
        // the memory overhead is negligible; let it shrink naturally as keys stop
        // being fetched. The eviction on prCache/issueCache above is sufficient
        // to bound the dominant source of growth.
        // Only re-fetch PR/issue entries that are already stale — skip fresh ones
        const state = get();
        const now = Date.now();
        for (const worktrees of Object.values(state.worktreesByRepo)) {
            for (const wt of worktrees) {
                const repo = state.repos.find((r) => r.id === wt.repoId);
                if (!repo) {
                    continue;
                }
                const branch = wt.branch.replace(/^refs\/heads\//, '');
                if (!wt.isBare && branch) {
                    const prKey = `${repo.path}::${branch}`;
                    const prEntry = state.prCache[prKey];
                    if (!prEntry || now - prEntry.fetchedAt >= CACHE_TTL) {
                        void get().fetchPRForBranch(repo.path, branch);
                    }
                }
                if (wt.linkedIssue) {
                    const issueKey = `${repo.path}::${wt.linkedIssue}`;
                    const issueEntry = state.issueCache[issueKey];
                    if (!issueEntry || now - issueEntry.fetchedAt >= CACHE_TTL) {
                        void get().fetchIssue(repo.path, wt.linkedIssue);
                    }
                }
            }
        }
    },
    refreshGitHubForWorktree: (worktreeId) => {
        const state = get();
        let worktree;
        for (const worktrees of Object.values(state.worktreesByRepo)) {
            worktree = worktrees.find((w) => w.id === worktreeId);
            if (worktree) {
                break;
            }
        }
        if (!worktree) {
            return;
        }
        const repo = state.repos.find((r) => r.id === worktree.repoId);
        if (!repo) {
            return;
        }
        // Invalidate this worktree's cache entries
        const branch = worktree.branch.replace(/^refs\/heads\//, '');
        const prKey = `${repo.path}::${branch}`;
        const issueKey = worktree.linkedIssue ? `${repo.path}::${worktree.linkedIssue}` : '';
        set((s) => {
            const updates = {};
            if (s.prCache[prKey]) {
                updates.prCache = { ...s.prCache, [prKey]: { ...s.prCache[prKey], fetchedAt: 0 } };
            }
            if (issueKey && s.issueCache[issueKey]) {
                updates.issueCache = {
                    ...s.issueCache,
                    [issueKey]: { ...s.issueCache[issueKey], fetchedAt: 0 }
                };
            }
            return updates;
        });
        // Re-fetch (skip when branch is empty — detached HEAD during rebase)
        if (!worktree.isBare && branch) {
            void get().fetchPRForBranch(repo.path, branch, { force: true });
        }
        if (worktree.linkedIssue) {
            void get().fetchIssue(repo.path, worktree.linkedIssue);
        }
    },
    // Why: worktree switches previously force-refreshed GitHub data on every
    // click, bypassing the 5-min TTL. This variant only fetches when stale,
    // avoiding unnecessary API calls and latency during rapid switching.
    refreshGitHubForWorktreeIfStale: (worktreeId) => {
        const state = get();
        let worktree;
        for (const worktrees of Object.values(state.worktreesByRepo)) {
            worktree = worktrees.find((w) => w.id === worktreeId);
            if (worktree) {
                break;
            }
        }
        if (!worktree) {
            return;
        }
        const repo = state.repos.find((r) => r.id === worktree.repoId);
        if (!repo) {
            return;
        }
        const now = Date.now();
        const branch = worktree.branch.replace(/^refs\/heads\//, '');
        const prKey = `${repo.path}::${branch}`;
        const prEntry = state.prCache[prKey];
        const prStale = !prEntry || now - prEntry.fetchedAt >= CACHE_TTL;
        if (!worktree.isBare && branch && prStale) {
            void get().fetchPRForBranch(repo.path, branch, { force: true });
        }
        if (worktree.linkedIssue) {
            const issueKey = `${repo.path}::${worktree.linkedIssue}`;
            const issueEntry = state.issueCache[issueKey];
            if (!issueEntry || now - issueEntry.fetchedAt >= CACHE_TTL) {
                void get().fetchIssue(repo.path, worktree.linkedIssue);
            }
        }
    }
});
