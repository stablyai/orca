import type { AppState } from '@/store/types'
import type { AgentStatusOrchestrationContext } from '../../../../shared/agent-status-types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'

type OrchestrationIndexState = Pick<
  AppState,
  | 'agentStatusByPaneKey'
  | 'retainedAgentsByPaneKey'
  | 'runtimeAgentOrchestrationByPaneKey'
  | 'tabsByWorktree'
>

type RuntimeOrchestrationRecord = Record<string, AgentStatusOrchestrationContext>

type RuntimeEntriesCache = {
  source: OrchestrationIndexState['runtimeAgentOrchestrationByPaneKey']
  entries: [string, AgentStatusOrchestrationContext][]
}

type TabMembershipCache = {
  tabsSource: OrchestrationIndexState['tabsByWorktree']
  worktreeIdsByTabId: Map<string, Set<string>>
}

type OrchestrationIndexCache = {
  runtimeSource: OrchestrationIndexState['runtimeAgentOrchestrationByPaneKey']
  tabsSource: OrchestrationIndexState['tabsByWorktree']
  liveSource: OrchestrationIndexState['agentStatusByPaneKey']
  retainedSource: OrchestrationIndexState['retainedAgentsByPaneKey']
  recordsByWorktree: ReadonlyMap<string, RuntimeOrchestrationRecord>
}

// Why: selector unit tests pass partial store mocks; a missing map must behave
// like an empty slice while keeping a stable identity for the source cache.
const EMPTY_SOURCE = {}

// Why frozen: these are shared by every card, so an accidental write would
// corrupt unrelated worktrees rather than fail locally.
export const EMPTY_WORKTREE_AGENT_ORCHESTRATION: RuntimeOrchestrationRecord = Object.freeze({})
export const EMPTY_WORKTREE_AGENT_ORCHESTRATION_INDEX: ReadonlyMap<
  string,
  RuntimeOrchestrationRecord
> = new Map()

// Why null-prototype: a pane key of `__proto__` is a plain data key here. On a
// normal object the first write silently vanishes into the prototype setter,
// which both drops the entry and repoints the record's prototype.
function createRecord(): RuntimeOrchestrationRecord {
  return Object.create(null) as RuntimeOrchestrationRecord
}

let runtimeEntriesCache: RuntimeEntriesCache | null = null
let tabMembershipCache: TabMembershipCache | null = null
let orchestrationIndexCache: OrchestrationIndexCache | null = null

export function releaseWorktreeAgentOrchestrationIndexCache(): void {
  runtimeEntriesCache = null
  tabMembershipCache = null
  orchestrationIndexCache = null
}

function reuseRecordIfOrderedEqual(
  previous: RuntimeOrchestrationRecord | undefined,
  next: RuntimeOrchestrationRecord
): RuntimeOrchestrationRecord {
  if (!previous) {
    return next
  }
  const previousEntries = Object.entries(previous)
  const nextEntries = Object.entries(next)
  if (previousEntries.length !== nextEntries.length) {
    return next
  }
  for (let index = 0; index < nextEntries.length; index += 1) {
    if (
      previousEntries[index]?.[0] !== nextEntries[index]?.[0] ||
      previousEntries[index]?.[1] !== nextEntries[index]?.[1]
    ) {
      return next
    }
  }
  return previous
}

function getWorktreeIdsByTabId(
  tabsByWorktree: OrchestrationIndexState['tabsByWorktree']
): Map<string, Set<string>> {
  if (tabMembershipCache?.tabsSource === tabsByWorktree) {
    return tabMembershipCache.worktreeIdsByTabId
  }
  // Why a Set per tab: the same tab id can appear under more than one worktree,
  // and each of those worktrees must still see the pane's orchestration.
  const worktreeIdsByTabId = new Map<string, Set<string>>()
  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    for (const tab of tabs ?? []) {
      const tabId = tab.id
      const existing = worktreeIdsByTabId.get(tabId)
      if (existing) {
        existing.add(worktreeId)
      } else {
        worktreeIdsByTabId.set(tabId, new Set([worktreeId]))
      }
    }
  }
  tabMembershipCache = { tabsSource: tabsByWorktree, worktreeIdsByTabId }
  return worktreeIdsByTabId
}

function buildIndex(
  runtimeEntries: [string, AgentStatusOrchestrationContext][],
  tabsByWorktree: OrchestrationIndexState['tabsByWorktree'],
  agentStatusByPaneKey: OrchestrationIndexState['agentStatusByPaneKey'],
  retainedAgentsByPaneKey: OrchestrationIndexState['retainedAgentsByPaneKey']
): ReadonlyMap<string, RuntimeOrchestrationRecord> {
  const worktreeIdsByTabId = getWorktreeIdsByTabId(tabsByWorktree)
  const recordsByWorktree = new Map<string, RuntimeOrchestrationRecord>()

  for (const [paneKey, orchestration] of runtimeEntries) {
    const parsed = parsePaneKey(paneKey)
    const parsedParent = orchestration.parentPaneKey
      ? parsePaneKey(orchestration.parentPaneKey)
      : null
    const targets = new Set<string>()
    if (parsed) {
      for (const worktreeId of worktreeIdsByTabId.get(parsed.tabId) ?? []) {
        targets.add(worktreeId)
      }
    }
    // Why: child agent terminals can be attributed to a worktree before their
    // tab reaches this renderer, or after the row has been retained as done.
    // The parent link must still reach that worktree card.
    if (parsedParent) {
      for (const worktreeId of worktreeIdsByTabId.get(parsedParent.tabId) ?? []) {
        targets.add(worktreeId)
      }
    }
    // Why exact runtime keys: this preserves early SSH attribution and ignores
    // stale entry.paneKey fields carried by a live or retained row.
    const liveWorktreeId = agentStatusByPaneKey[paneKey]?.worktreeId
    if (typeof liveWorktreeId === 'string') {
      targets.add(liveWorktreeId)
    }
    const retainedWorktreeId = retainedAgentsByPaneKey[paneKey]?.worktreeId
    if (typeof retainedWorktreeId === 'string') {
      targets.add(retainedWorktreeId)
    }

    for (const worktreeId of targets) {
      let record = recordsByWorktree.get(worktreeId)
      if (!record) {
        record = createRecord()
        recordsByWorktree.set(worktreeId, record)
      }
      record[paneKey] = orchestration
    }
  }

  const previousRecords = orchestrationIndexCache?.recordsByWorktree
  for (const [worktreeId, record] of recordsByWorktree) {
    recordsByWorktree.set(
      worktreeId,
      reuseRecordIfOrderedEqual(previousRecords?.get(worktreeId), record)
    )
  }
  return recordsByWorktree
}

/**
 * Worktree-keyed index of runtime agent orchestration contexts, rebuilt only
 * when one of its four source maps changes identity.
 *
 * Why: every mounted worktree card subscribes to its own orchestration slice,
 * and Zustand re-runs every subscriber's selector on every store publication.
 * Scanning the whole context map per card made that O(cards x contexts). What
 * this removes is the per-card multiplier, not the rebuild itself: an agent
 * ping replaces the live map, so the index still rebuilds once per publication.
 * The first caller through a given store version pays O(tabs + contexts); the
 * rest are a Map lookup.
 */
export function selectWorktreeAgentOrchestrationIndex(
  state: OrchestrationIndexState
): ReadonlyMap<string, RuntimeOrchestrationRecord> {
  const runtimeAgentOrchestrationByPaneKey =
    state.runtimeAgentOrchestrationByPaneKey ?? EMPTY_SOURCE
  // Why cached separately from the index: enumerating the context map is the
  // per-publication cost this index exists to remove, and the entry list stays
  // valid even when a churning live/retained slice forces an index rebuild.
  if (runtimeEntriesCache?.source !== runtimeAgentOrchestrationByPaneKey) {
    runtimeEntriesCache = {
      source: runtimeAgentOrchestrationByPaneKey,
      entries: Object.entries(runtimeAgentOrchestrationByPaneKey)
    }
  }
  const runtimeEntries = runtimeEntriesCache.entries
  // Why here rather than before the enumeration: with no contexts the index is
  // empty whatever the other slices hold, and callers rely on them staying unread.
  if (runtimeEntries.length === 0) {
    // Why the entries cache survives: dropping it would re-enumerate the empty
    // map once per card, which is the per-publication cost this index removes.
    tabMembershipCache = null
    orchestrationIndexCache = null
    return EMPTY_WORKTREE_AGENT_ORCHESTRATION_INDEX
  }

  const tabsByWorktree = state.tabsByWorktree ?? EMPTY_SOURCE
  const agentStatusByPaneKey = state.agentStatusByPaneKey ?? EMPTY_SOURCE
  const retainedAgentsByPaneKey = state.retainedAgentsByPaneKey ?? EMPTY_SOURCE
  if (
    orchestrationIndexCache?.runtimeSource === runtimeAgentOrchestrationByPaneKey &&
    orchestrationIndexCache.tabsSource === tabsByWorktree &&
    orchestrationIndexCache.liveSource === agentStatusByPaneKey &&
    orchestrationIndexCache.retainedSource === retainedAgentsByPaneKey
  ) {
    return orchestrationIndexCache.recordsByWorktree
  }

  orchestrationIndexCache = {
    runtimeSource: runtimeAgentOrchestrationByPaneKey,
    tabsSource: tabsByWorktree,
    liveSource: agentStatusByPaneKey,
    retainedSource: retainedAgentsByPaneKey,
    recordsByWorktree: buildIndex(
      runtimeEntries,
      tabsByWorktree,
      agentStatusByPaneKey,
      retainedAgentsByPaneKey
    )
  }
  return orchestrationIndexCache.recordsByWorktree
}

export function selectWorktreeAgentOrchestration(
  state: OrchestrationIndexState,
  worktreeId: string
): RuntimeOrchestrationRecord {
  return (
    selectWorktreeAgentOrchestrationIndex(state).get(worktreeId) ??
    EMPTY_WORKTREE_AGENT_ORCHESTRATION
  )
}
