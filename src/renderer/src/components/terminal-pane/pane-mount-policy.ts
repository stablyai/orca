// STA-1282: pure mount policy for terminal panes. Given the current tab
// visibility/PTY facts and the eviction settings, decide which terminal tabs
// stay mounted (Tier 0 visible / Tier 1 warm) and which are evicted (Tier 2).
//
// This module is intentionally pure — no store, no timers, no DOM — so the
// LRU/dwell/budget/exemption logic is unit-testable at the cheapest layer. The
// event-driven coordinator resolves messy store facts into these clean inputs
// and applies the idle-deferred teardown; this file only classifies.

/** Per-leaf PTY lifecycle rolled up to the tab (the mount unit). */
export type PanePtyState =
  // No PTY has bound yet (spawn in flight) — protects the tab-auto-close TOCTOU.
  | 'newborn'
  // At least one leaf owns a bound, non-exited PTY.
  | 'live'
  // The tab had PTYs and all of them have exited (dead pane).
  | 'dead'

export type PaneMountCandidate = {
  tabId: string
  worktreeId: string
  /** Foreground now: active worktree + active-in-group, OR shown via an
   *  Activity-terminal portal. Visible panes are never evicted. */
  isVisible: boolean
  /** Epoch ms of the last visible→ transition, or null if never visible. */
  lastVisibleAt: number | null
  ptyState: PanePtyState
  /** Suppressed-exit wake hint (mid-restart) — never evict. */
  hasWakeHint: boolean
  /** The tab's transport is currently parked in the evicted registry. */
  isParked: boolean
}

export type PaneMountPolicyInput = {
  candidates: readonly PaneMountCandidate[]
  nowMs: number
  evictionEnabled: boolean
  warmBudget: number
  evictAfterMs: number
}

export type PaneMountClassification =
  // Foreground — always mounted.
  | 'visible'
  // Exempt from eviction (newborn / dead / wake-hint) — always mounted.
  | 'exempt'
  // Hidden but retained in the warm LRU (within budget and dwell).
  | 'warm'
  // Hidden and evicted (or a parked pane not currently visible).
  | 'evict'

export type PaneMountPolicyResult = {
  classifications: Map<string, PaneMountClassification>
  /** Tabs that must have a mounted TerminalPane right now. */
  mountedTabIds: Set<string>
  /** Tabs the policy wants unmounted/parked. */
  evictTabIds: Set<string>
}

function isEvictionEligible(candidate: PaneMountCandidate): boolean {
  // Only live, hidden, non-wake-hint panes are candidates for the LRU. Parked
  // panes are excluded: they are always classified 'evict' regardless of rank,
  // so letting them into the ranking pool would silently consume warm-budget
  // slots and evict live hidden panes earlier than warmBudget intends.
  return (
    !candidate.isVisible &&
    !candidate.isParked &&
    candidate.ptyState === 'live' &&
    !candidate.hasWakeHint
  )
}

function classifyCandidate(
  candidate: PaneMountCandidate,
  input: PaneMountPolicyInput,
  warmRankByTabId: ReadonlyMap<string, number>
): PaneMountClassification {
  if (candidate.isVisible) {
    return 'visible'
  }
  // Why: a parked pane only ever remounts on demand (when it becomes visible),
  // never in a hidden/batch remount — this is what keeps disable-reconcile and
  // exit-while-parked from recreating the mount storm.
  if (candidate.isParked) {
    return 'evict'
  }
  if (!isEvictionEligible(candidate)) {
    // newborn / dead / wake-hint — keep today's mounted behavior.
    return 'exempt'
  }
  if (!input.evictionEnabled) {
    // Kill switch / self-disable: stop evicting. Live hidden panes stay warm;
    // already-parked panes (handled above) remain claimable on demand.
    return 'warm'
  }
  const rank = warmRankByTabId.get(candidate.tabId)
  const withinBudget = rank !== undefined && rank < input.warmBudget
  const withinDwell =
    candidate.lastVisibleAt !== null && input.nowMs - candidate.lastVisibleAt <= input.evictAfterMs
  return withinBudget && withinDwell ? 'warm' : 'evict'
}

/**
 * Classify every candidate tab. LRU rank is by last-visible recency (most
 * recent first); a pane stays warm only while it is within `warmBudget` by
 * recency AND has been hidden no longer than `evictAfterMs`.
 */
export function computePaneMountPolicy(input: PaneMountPolicyInput): PaneMountPolicyResult {
  const eligible = input.candidates.filter(isEvictionEligible)
  // Sort by recency, most-recently-visible first. Null (never visible) sinks to
  // the end so background panes age out first.
  const rankedTabIds = [...eligible]
    .sort((a, b) => (b.lastVisibleAt ?? -Infinity) - (a.lastVisibleAt ?? -Infinity))
    .map((candidate) => candidate.tabId)
  const warmRankByTabId = new Map<string, number>()
  rankedTabIds.forEach((tabId, index) => warmRankByTabId.set(tabId, index))

  const classifications = new Map<string, PaneMountClassification>()
  const mountedTabIds = new Set<string>()
  const evictTabIds = new Set<string>()
  for (const candidate of input.candidates) {
    const classification = classifyCandidate(candidate, input, warmRankByTabId)
    classifications.set(candidate.tabId, classification)
    if (classification === 'evict') {
      evictTabIds.add(candidate.tabId)
    } else {
      mountedTabIds.add(candidate.tabId)
    }
  }
  return { classifications, mountedTabIds, evictTabIds }
}

export type TerminalPaneMountDecisionInput = {
  /** The `experimentalTerminalPaneEviction` setting (NOT the self-disable flag). */
  evictionEnabled: boolean
  /** Foreground now (active worktree + active-in-group, incl. Activity portal). */
  isVisible: boolean
  hasActivityPortal: boolean
  /** The coordinator keeps this hidden pane in the warm set (terminalPaneMountByTabId). */
  isWarm: boolean
  /** The pane's transport is currently parked in the evicted registry. */
  isParked: boolean
}

/**
 * STA-1282 render-seam mount decision for one terminal tab (flag-OFF inertness).
 * With eviction OFF (default) every non-parked tab mounts, byte-identical to the
 * pre-eviction app where hidden tabs stayed mounted. A parked tab stays unmounted
 * even when disabled so a runtime flag flip-OFF does not force a batch remount of
 * the whole parked set — they remain claimable on demand (disable reconciliation).
 * With eviction ON a tab mounts iff it is visible now or the coordinator keeps it
 * warm; evicted/never-visited hidden tabs render no pane (the mount-storm fix).
 */
export function shouldMountTerminalPaneNow(input: TerminalPaneMountDecisionInput): boolean {
  if (input.isVisible || input.hasActivityPortal) {
    return true
  }
  if (!input.evictionEnabled) {
    return !input.isParked
  }
  return input.isWarm
}

/**
 * Soonest epoch-ms at which some currently-warm pane will cross the dwell
 * boundary and become evictable, or null when nothing is dwell-bound. The
 * coordinator arms a single lazy timer at this time instead of polling.
 */
export function nextDwellExpiryAt(
  input: PaneMountPolicyInput,
  // Why: callers that just ran computePaneMountPolicy on the same input pass
  // its classifications to avoid recomputing the whole policy per recompute.
  precomputed?: ReadonlyMap<string, PaneMountClassification>
): number | null {
  if (!input.evictionEnabled) {
    return null
  }
  const classifications = precomputed ?? computePaneMountPolicy(input).classifications
  let soonest: number | null = null
  for (const candidate of input.candidates) {
    if (classifications.get(candidate.tabId) !== 'warm' || candidate.lastVisibleAt === null) {
      continue
    }
    const expiresAt = candidate.lastVisibleAt + input.evictAfterMs
    if (soonest === null || expiresAt < soonest) {
      soonest = expiresAt
    }
  }
  return soonest
}
