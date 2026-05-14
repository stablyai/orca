import { detectAgentStatusFromTitle, isExplicitAgentStatusFresh } from '@/lib/agent-status'
import { tabHasLivePty } from '@/lib/tab-has-live-pty'
import { branchName } from '@/lib/git-utils'
import type { Worktree, Repo, TerminalTab } from '../../../../shared/types'
import {
  AGENT_STATUS_STALE_AFTER_MS,
  type AgentStatusEntry
} from '../../../../shared/agent-status-types'

type SortBy = 'name' | 'smart' | 'recent' | 'repo'

// Why: a newly-created worktree's lastActivityAt is stamped at the moment
// createLocalWorktree finishes git + setup-runner prep (often several seconds
// after the user clicked Create). During and after that window, ambient PTY
// bumps on OTHER worktrees (data flush, exit, reconnect) can push the new
// worktree below them in Recent sort. This grace period gives the new
// worktree a floor of `createdAt + CREATE_GRACE_MS` in the Recent comparator
// so it stays on top until the user has had a chance to notice it. 5 min is
// long enough for the user to interact, short enough that steady-state
// ordering resumes quickly.
export const CREATE_GRACE_MS = 5 * 60 * 1000

/**
 * Rank a worktree in Recent sort using `lastActivityAt`, but with a floor of
 * `createdAt + CREATE_GRACE_MS` *only during* the grace window (i.e. while
 * `now < createdAt + CREATE_GRACE_MS`). Once the window has elapsed, returns
 * `lastActivityAt` unchanged. Returns `lastActivityAt` unchanged for worktrees
 * without `createdAt` (discovered on disk, or persisted before this field
 * existed).
 */
export function effectiveRecentActivity(worktree: Worktree, now: number): number {
  const { lastActivityAt, createdAt } = worktree
  // Why bound by now: a worktree with createdAt set but no subsequent activity
  // should not retain artificially-high recency forever; the floor exists to
  // absorb the noisy creation window only. Without this bound, a worktree
  // created days ago and never touched would keep ranking as if its activity
  // were `createdAt + 5min`, masking truly fresher worktrees indefinitely.
  if (createdAt === undefined || now >= createdAt + CREATE_GRACE_MS) {
    return lastActivityAt
  }
  return Math.max(lastActivityAt, createdAt + CREATE_GRACE_MS)
}

type PRCacheEntry = { data: object | null; fetchedAt: number }
export type SmartSortOverride = {
  worktree: Worktree
  tabs: TerminalTab[]
  hasRecentPRSignal: boolean
}

function terminalTabIsLive(
  tab: TerminalTab,
  ptyIdsByTabId?: Record<string, string[]> | null
): boolean {
  // Why: slept terminals retain tab.ptyId as a wake hint, so the live PTY map is
  // the source of truth once callers can provide it.
  return ptyIdsByTabId ? tabHasLivePty(ptyIdsByTabId, tab.id) : Boolean(tab.ptyId)
}

export function hasAnyLivePty(
  tabsByWorktree: Record<string, TerminalTab[]>,
  ptyIdsByTabId?: Record<string, string[]> | null
): boolean {
  return Object.values(tabsByWorktree)
    .flat()
    .some((tab) => terminalTabIsLive(tab, ptyIdsByTabId))
}

// Why: building this index once at the sort call site reduces the smart-
// score computation from O(N × E × T) to O(E) build + O(T) lookups per
// worktree. Before, each worktree's score computation scanned the full
// agentStatusByPaneKey map, which made the decorate-sort-undecorate
// precompute pay the scan N times even though the map is global. Entries are
// keyed by the `tabId` prefix of their paneKey (paneKey format: `${tabId}:…`).
export function buildExplicitEntriesByTabId(
  agentStatusByPaneKey: Record<string, AgentStatusEntry> | undefined
): Map<string, AgentStatusEntry[]> {
  const byTab = new Map<string, AgentStatusEntry[]>()
  if (!agentStatusByPaneKey) {
    return byTab
  }
  for (const entry of Object.values(agentStatusByPaneKey)) {
    const colon = entry.paneKey.indexOf(':')
    // Why: paneKey must be `${tabId}:${paneId}`. Skip malformed entries (no
    // colon or leading colon) rather than bucketing them under an empty tabId,
    // where they would never match a real tab and just waste memory.
    if (colon <= 0) {
      continue
    }
    const tabId = entry.paneKey.slice(0, colon)
    const bucket = byTab.get(tabId)
    if (bucket) {
      bucket.push(entry)
    } else {
      byTab.set(tabId, [entry])
    }
  }
  return byTab
}

export function hasRecentPRSignal(
  worktree: Worktree,
  repoMap: Map<string, Repo>,
  prCache: Record<string, PRCacheEntry> | null
): boolean {
  const repo = repoMap.get(worktree.repoId)
  const branch = branchName(worktree.branch)
  if (!repo || !branch) {
    return worktree.linkedPR !== null
  }

  const cacheKey = `${repo.path}::${branch}`
  const cachedEntry = prCache?.[cacheKey]
  if (cachedEntry) {
    return Boolean(cachedEntry.data)
  }

  return worktree.linkedPR !== null
}

function computeSmartScoreFromSignals(
  worktree: Worktree,
  tabs: TerminalTab[],
  hasRecentPR: boolean,
  now: number,
  agentStatusByPaneKey?: Record<string, AgentStatusEntry>,
  explicitByTabId?: Map<string, AgentStatusEntry[]>,
  ptyIdsByTabId?: Record<string, string[]> | null
): number {
  const liveTabs = tabs.filter((tab) => terminalTabIsLive(tab, ptyIdsByTabId))

  let score = 0

  // Why: explicit agent status (OSC 9999) is authoritative over heuristic title
  // parsing. Check explicit status first; fall through to heuristics for tabs
  // that have no explicit status entry.
  //
  // Why the index parameter: when the caller precomputes the tabId → entries
  // index once (via buildExplicitEntriesByTabId) and threads it through, each
  // worktree does O(T) lookups instead of scanning the full map O(E) times.
  // This matters because `sortWorktreesSmart` calls this function N times in a
  // decorate-sort-undecorate pass; without the shared index we'd pay O(N×E×T)
  // overall. When the index is absent and `agentStatusByPaneKey` is provided
  // we build it inline to preserve backward compatibility for callers (tests,
  // palette) that haven't adopted the optimization.
  const resolvedExplicitByTabId =
    explicitByTabId ?? buildExplicitEntriesByTabId(agentStatusByPaneKey)

  let hasExplicitWorking = false
  let hasExplicitBlocked = false
  let hasHeuristicWorking = false
  let hasHeuristicBlocked = false

  for (const tab of liveTabs) {
    const tabExplicitEntries = resolvedExplicitByTabId.get(tab.id) ?? []
    // Why: compute freshness once per entry instead of recomputing inside each
    // of the three `.some(...)` passes below. Freshness is a pure function of
    // (entry, now) so filtering up front is equivalent and cheaper.
    const freshEntries = tabExplicitEntries.filter((entry) =>
      isExplicitAgentStatusFresh(entry, now, AGENT_STATUS_STALE_AFTER_MS)
    )

    if (freshEntries.length > 0) {
      hasExplicitWorking ||= freshEntries.some((entry) => entry.state === 'working')
      hasExplicitBlocked ||= freshEntries.some(
        (entry) => entry.state === 'blocked' || entry.state === 'waiting'
      )
      continue
    }

    const heuristicState = detectAgentStatusFromTitle(tab.title)
    hasHeuristicWorking ||= heuristicState === 'working'
    hasHeuristicBlocked ||= heuristicState === 'permission'
  }

  // Explicit working → +60, same weight as heuristic working
  // Explicit blocked/waiting → +35, same weight as heuristic permission
  // Explicit done → no bonus (task complete, no attention needed)
  const isRunning = hasExplicitWorking || hasHeuristicWorking
  if (isRunning) {
    score += 60
  }

  const needsAttention = hasExplicitBlocked || hasHeuristicBlocked
  if (needsAttention) {
    score += 35
  }

  if (worktree.isUnread) {
    score += 18
  }

  if (liveTabs.length > 0) {
    score += 12
  }

  if (hasRecentPR) {
    score += 10
  }

  if (worktree.linkedIssue !== null) {
    score += 6
  }

  const activityAge = now - (worktree.lastActivityAt || 0)
  if (worktree.lastActivityAt > 0) {
    const ONE_DAY = 24 * 60 * 60 * 1000
    // Why 36: a just-created worktree has only this signal (no live tab yet,
    // since the PTY spawns asynchronously after creation). Weight must exceed
    // the max passive-signal combination for shutdown worktrees
    // (isUnread 18 + PR 10 + issue 6 = 34) so brand-new worktrees always
    // appear at the top of the "smart" sort immediately.
    score += 36 * Math.max(0, 1 - activityAge / ONE_DAY)
  }

  return score
}

function getSmartSortCandidate(
  worktree: Worktree,
  tabsByWorktree: Record<string, TerminalTab[]> | null,
  repoMap: Map<string, Repo>,
  prCache: Record<string, PRCacheEntry> | null,
  smartSortOverrides: Record<string, SmartSortOverride> | null
): SmartSortOverride {
  return (
    smartSortOverrides?.[worktree.id] ?? {
      worktree,
      tabs: tabsByWorktree?.[worktree.id] ?? [],
      hasRecentPRSignal: hasRecentPRSignal(worktree, repoMap, prCache)
    }
  )
}

/**
 * Build a comparator for sorting worktrees based on the current sort mode.
 *
 * `precomputedScores` is the decorate-sort-undecorate optimization for the
 * `smart` mode: callers should compute each worktree's smart score once and
 * pass the map in, since `Array.prototype.sort` invokes the comparator
 * O(N log N) times and recomputing the score each call scans the
 * `agentStatusByPaneKey` map O(N log N × E) times. When omitted, the
 * comparator falls back to computing scores per-comparison so existing call
 * sites that haven't adopted the optimization keep working.
 *
 * `explicitByTabId` is a secondary optimization: when `precomputedScores` is
 * absent (fallback path), the comparator still has to call
 * `computeSmartScoreFromSignals` per comparison. Passing the prebuilt tabId
 * index avoids rescanning the full `agentStatusByPaneKey` map on every call.
 * When this index is also absent, the inner function builds one inline per
 * invocation to preserve backward compatibility.
 */
export function buildWorktreeComparator(
  sortBy: SortBy,
  tabsByWorktree: Record<string, TerminalTab[]> | null,
  repoMap: Map<string, Repo>,
  prCache: Record<string, PRCacheEntry> | null,
  now: number = Date.now(),
  smartSortOverrides: Record<string, SmartSortOverride> | null = null,
  agentStatusByPaneKey?: Record<string, AgentStatusEntry>,
  precomputedScores?: Map<string, number>,
  explicitByTabId?: Map<string, AgentStatusEntry[]>,
  ptyIdsByTabId?: Record<string, string[]> | null
): (a: Worktree, b: Worktree) => number {
  // Why: when the caller does not pre-build the tabId index but does provide
  // the source map, build it ONCE here and close over it. Array.sort invokes
  // the comparator O(N log N) times in the fallback path (no precomputed
  // scores), and `computeSmartScoreFromSignals` would otherwise rebuild the
  // O(E) index on every comparison — re-introducing the O(N log N × E) cost
  // the precompute was meant to avoid. Only matters for the smart mode; for
  // other modes we skip construction.
  const resolvedExplicitByTabId =
    sortBy === 'smart' && !explicitByTabId && agentStatusByPaneKey
      ? buildExplicitEntriesByTabId(agentStatusByPaneKey)
      : explicitByTabId

  return (a, b) => {
    switch (sortBy) {
      case 'name':
        return a.displayName.localeCompare(b.displayName)
      case 'smart': {
        const smartA = getSmartSortCandidate(
          a,
          tabsByWorktree,
          repoMap,
          prCache,
          smartSortOverrides
        )
        const smartB = getSmartSortCandidate(
          b,
          tabsByWorktree,
          repoMap,
          prCache,
          smartSortOverrides
        )
        // Why precomputedScores: the smart-score computation iterates
        // `agentStatusByPaneKey` (O(E) per call) when no tabId index is
        // threaded in, and still does O(T) lookups per worktree when one is.
        // The comparator is invoked O(N log N) times by Array.sort, so without
        // memoization we pay O(N log N × E) (or O(N log N × T) with the
        // index). When the caller supplies a precomputed score map we get
        // O(1) lookups; when it doesn't we preserve the old behavior and pass
        // the optional `explicitByTabId` index to the inner function so the
        // fallback path avoids the full-map scan as well. Overrides bypass the
        // precomputed map because the override intentionally freezes the
        // candidate's inputs (tabs, hasRecentPRSignal) which may differ from
        // the live score.
        const scoreA =
          precomputedScores && !smartSortOverrides?.[a.id]
            ? (precomputedScores.get(a.id) ?? 0)
            : computeSmartScoreFromSignals(
                smartA.worktree,
                smartA.tabs,
                smartA.hasRecentPRSignal,
                now,
                agentStatusByPaneKey,
                resolvedExplicitByTabId,
                ptyIdsByTabId
              )
        const scoreB =
          precomputedScores && !smartSortOverrides?.[b.id]
            ? (precomputedScores.get(b.id) ?? 0)
            : computeSmartScoreFromSignals(
                smartB.worktree,
                smartB.tabs,
                smartB.hasRecentPRSignal,
                now,
                agentStatusByPaneKey,
                resolvedExplicitByTabId,
                ptyIdsByTabId
              )
        return (
          scoreB - scoreA ||
          effectiveRecentActivity(smartB.worktree, now) -
            effectiveRecentActivity(smartA.worktree, now) ||
          a.displayName.localeCompare(b.displayName)
        )
      }
      case 'recent':
        // Why effectiveRecentActivity (not raw lastActivityAt): newly-created
        // worktrees get a CREATE_GRACE_MS floor on top of lastActivityAt so
        // ambient PTY bumps in other worktrees don't immediately push them
        // down. See CREATE_GRACE_MS above.
        //
        // Why not sortOrder: sortOrder is a snapshot of the smart-sort
        // ranking that only gets repersisted while the user is in "Smart"
        // mode, so it's frozen in Recent mode and ignores new terminal
        // events, meta edits, etc. lastActivityAt is the real "recency"
        // signal — bumped by bumpWorktreeActivity (PTY spawn, background
        // events) and by meaningful meta edits (comment, isUnread).
        return (
          effectiveRecentActivity(b, now) - effectiveRecentActivity(a, now) ||
          a.displayName.localeCompare(b.displayName)
        )
      case 'repo': {
        const ra = repoMap.get(a.repoId)?.displayName ?? ''
        const rb = repoMap.get(b.repoId)?.displayName ?? ''
        const cmp = ra.localeCompare(rb)
        return cmp !== 0 ? cmp : a.displayName.localeCompare(b.displayName)
      }
      default: {
        const _exhaustive: never = sortBy
        return _exhaustive
      }
    }
  }
}

/**
 * Sort worktrees by weighted smart-score signals, handling the cold-start /
 * warm distinction in one place. On cold start (no live PTYs yet), falls back
 * to persisted `sortOrder` descending with alphabetical `displayName` fallback.
 * Once any PTY is alive, uses the full smart-score comparator.
 *
 * Both the palette and `getVisibleWorktreeIds()` import this to avoid
 * duplicating the cold/warm branching logic.
 */
export function sortWorktreesSmart(
  worktrees: Worktree[],
  tabsByWorktree: Record<string, TerminalTab[]>,
  repoMap: Map<string, Repo>,
  prCache: Record<string, PRCacheEntry> | null,
  agentStatusByPaneKey?: Record<string, AgentStatusEntry>,
  ptyIdsByTabId?: Record<string, string[]> | null
): Worktree[] {
  if (!hasAnyLivePty(tabsByWorktree, ptyIdsByTabId)) {
    // Cold start: use persisted sortOrder snapshot
    return [...worktrees].sort(
      (a, b) => b.sortOrder - a.sortOrder || a.displayName.localeCompare(b.displayName)
    )
  }

  // Why precompute: Array.sort calls the comparator O(N log N) times and the
  // smart-score computation needs to look up explicit-status entries per tab.
  // We apply two layered optimizations:
  //   1. Build the `explicitByTabId` index ONCE up front (O(E) work). Without
  //      it, each per-worktree score would scan the full `agentStatusByPaneKey`
  //      map to find matching entries, which is O(N × E × T) across all
  //      worktrees — the same cost the decorate-sort-undecorate pass was
  //      supposed to avoid.
  //   2. Precompute each worktree's score once (decorate-sort-undecorate) so
  //      the comparator does O(1) map lookups instead of re-scoring per
  //      comparison.
  // Combined cost: O(E) index build + O(N × T) scoring + O(N log N) sort,
  // instead of the prior O(N × E × T + N log N).
  const now = Date.now()
  const explicitByTabId = buildExplicitEntriesByTabId(agentStatusByPaneKey)
  const precomputedScores = new Map<string, number>(
    worktrees.map((w) => [
      w.id,
      computeSmartScore(
        w,
        tabsByWorktree,
        repoMap,
        prCache,
        now,
        agentStatusByPaneKey,
        explicitByTabId,
        ptyIdsByTabId
      )
    ])
  )

  // Why: agentStatusByPaneKey is forwarded so the smart-score comparator can
  // use explicit agent status (OSC 9999) when ranking worktrees by recency.
  // `explicitByTabId` is forwarded too so the comparator's fallback path (used
  // for worktrees covered by smartSortOverrides) avoids rebuilding the index.
  return [...worktrees].sort(
    buildWorktreeComparator(
      'smart',
      tabsByWorktree,
      repoMap,
      prCache,
      now,
      null,
      agentStatusByPaneKey,
      precomputedScores,
      explicitByTabId,
      ptyIdsByTabId
    )
  )
}

/**
 * Compute a recent-work score for a worktree.
 * Higher score = higher in the list.
 *
 * Scoring:
 *   running AI job    → +60
 *   recent activity   → +36 (decays over 24 hours)
 *   needs attention   → +35
 *   unread            → +18
 *   open terminal     → +12
 *   live branch PR    → +10
 *   linked issue      → +6
 */
export function computeSmartScore(
  worktree: Worktree,
  tabsByWorktree: Record<string, TerminalTab[]> | null,
  repoMap: Map<string, Repo> | null,
  prCache: Record<string, PRCacheEntry> | null,
  now: number = Date.now(),
  agentStatusByPaneKey?: Record<string, AgentStatusEntry>,
  explicitByTabId?: Map<string, AgentStatusEntry[]>,
  ptyIdsByTabId?: Record<string, string[]> | null
): number {
  return computeSmartScoreFromSignals(
    worktree,
    tabsByWorktree?.[worktree.id] ?? [],
    // Why: branch-aware PR cache is the freshest signal, but off-screen
    // worktrees may not have fetched it yet. Fall back to persisted linkedPR
    // only while that branch cache entry is still cold so smart sorting stays
    // stable on launch without reviving stale PRs after a cache miss resolves.
    repoMap ? hasRecentPRSignal(worktree, repoMap, prCache) : worktree.linkedPR !== null,
    now,
    agentStatusByPaneKey,
    explicitByTabId,
    ptyIdsByTabId
  )
}
