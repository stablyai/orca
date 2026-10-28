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

type PaneWorktreeProjectionCache = {
  runtimeSource: OrchestrationIndexState['runtimeAgentOrchestrationByPaneKey']
  liveSource: OrchestrationIndexState['agentStatusByPaneKey']
  retainedSource: OrchestrationIndexState['retainedAgentsByPaneKey']
  paneWorktreeIds: readonly (string | undefined)[]
}

type OrchestrationIndexCache = {
  runtimeSource: OrchestrationIndexState['runtimeAgentOrchestrationByPaneKey']
  tabsSource: OrchestrationIndexState['tabsByWorktree']
  /** @see projectPaneWorktreeIds — the build's whole view of the live and retained maps. */
  paneWorktreeIds: readonly (string | undefined)[]
  recordsByWorktree: ReadonlyMap<string, RuntimeOrchestrationRecord>
}

// Partial test stores need stable empty slices for source-cache identity.
const EMPTY_SOURCE = {}

// Freeze shared empties so accidental writes cannot corrupt unrelated cards.
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
let paneWorktreeProjectionCache: PaneWorktreeProjectionCache | null = null
let orchestrationIndexCache: OrchestrationIndexCache | null = null
let indexBuildCount = 0

export function releaseWorktreeAgentOrchestrationIndexCache(): void {
  runtimeEntriesCache = null
  tabMembershipCache = null
  paneWorktreeProjectionCache = null
  orchestrationIndexCache = null
}

export function _getWorktreeAgentOrchestrationIndexBuildCountForTest(): number {
  return indexBuildCount
}

/** Key on live/retained attribution for exact runtime pane keys, preserving early SSH rows and ignoring stale entry.paneKey fields. */
function projectPaneWorktreeIds(
  runtimeSource: OrchestrationIndexState['runtimeAgentOrchestrationByPaneKey'],
  runtimeEntries: readonly [string, AgentStatusOrchestrationContext][],
  agentStatusByPaneKey: OrchestrationIndexState['agentStatusByPaneKey'],
  retainedAgentsByPaneKey: OrchestrationIndexState['retainedAgentsByPaneKey']
): readonly (string | undefined)[] {
  // Cache by map identity so all cards share one attribution scan per publication.
  if (
    paneWorktreeProjectionCache?.runtimeSource === runtimeSource &&
    paneWorktreeProjectionCache.liveSource === agentStatusByPaneKey &&
    paneWorktreeProjectionCache.retainedSource === retainedAgentsByPaneKey
  ) {
    return paneWorktreeProjectionCache.paneWorktreeIds
  }
  const paneWorktreeIds: (string | undefined)[] = []
  for (const [paneKey] of runtimeEntries) {
    paneWorktreeIds.push(
      agentStatusByPaneKey[paneKey]?.worktreeId,
      retainedAgentsByPaneKey[paneKey]?.worktreeId
    )
  }
  paneWorktreeProjectionCache = {
    runtimeSource,
    liveSource: agentStatusByPaneKey,
    retainedSource: retainedAgentsByPaneKey,
    paneWorktreeIds
  }
  return paneWorktreeIds
}

function hasSameOrderedValues(
  previous: readonly (string | undefined)[],
  next: readonly (string | undefined)[]
): boolean {
  if (previous === next) {
    return true
  }
  if (previous.length !== next.length) {
    return false
  }
  for (let index = 0; index < next.length; index += 1) {
    if (previous[index] !== next[index]) {
      return false
    }
  }
  return true
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
  // A tab ID can belong to several worktrees; attribute its panes to each.
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
  paneWorktreeIds: readonly (string | undefined)[]
): ReadonlyMap<string, RuntimeOrchestrationRecord> {
  indexBuildCount += 1
  const worktreeIdsByTabId = getWorktreeIdsByTabId(tabsByWorktree)
  const recordsByWorktree = new Map<string, RuntimeOrchestrationRecord>()

  let projectionCursor = 0
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
    // Keep parent links reachable before child tabs hydrate or after their status is retained.
    if (parsedParent) {
      for (const worktreeId of worktreeIdsByTabId.get(parsedParent.tabId) ?? []) {
        targets.add(worktreeId)
      }
    }
    const liveWorktreeId = paneWorktreeIds[projectionCursor]
    const retainedWorktreeId = paneWorktreeIds[projectionCursor + 1]
    projectionCursor += 2
    if (typeof liveWorktreeId === 'string') {
      targets.add(liveWorktreeId)
    }
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

/** Share one worktree index, rebuilding only for context, tab or per-pane attribution changes; unrelated status pings are free. */
export function selectWorktreeAgentOrchestrationIndex(
  state: OrchestrationIndexState
): ReadonlyMap<string, RuntimeOrchestrationRecord> {
  const runtimeAgentOrchestrationByPaneKey =
    state.runtimeAgentOrchestrationByPaneKey ?? EMPTY_SOURCE
  // Cache context entries separately so unrelated live/retained churn cannot force enumeration.
  if (runtimeEntriesCache?.source !== runtimeAgentOrchestrationByPaneKey) {
    runtimeEntriesCache = {
      source: runtimeAgentOrchestrationByPaneKey,
      entries: Object.entries(runtimeAgentOrchestrationByPaneKey)
    }
  }
  const runtimeEntries = runtimeEntriesCache.entries
  // With no contexts, leave unrelated slices unread.
  if (runtimeEntries.length === 0) {
    // Keep empty entries cached to avoid re-enumerating once per card.
    tabMembershipCache = null
    paneWorktreeProjectionCache = null
    orchestrationIndexCache = null
    return EMPTY_WORKTREE_AGENT_ORCHESTRATION_INDEX
  }

  const tabsByWorktree = state.tabsByWorktree ?? EMPTY_SOURCE
  const paneWorktreeIds = projectPaneWorktreeIds(
    runtimeAgentOrchestrationByPaneKey,
    runtimeEntries,
    state.agentStatusByPaneKey ?? EMPTY_SOURCE,
    state.retainedAgentsByPaneKey ?? EMPTY_SOURCE
  )
  if (
    orchestrationIndexCache?.runtimeSource === runtimeAgentOrchestrationByPaneKey &&
    orchestrationIndexCache.tabsSource === tabsByWorktree &&
    hasSameOrderedValues(orchestrationIndexCache.paneWorktreeIds, paneWorktreeIds)
  ) {
    // Adopt the equal projection so later cards compare by identity without walking it.
    orchestrationIndexCache.paneWorktreeIds = paneWorktreeIds
    return orchestrationIndexCache.recordsByWorktree
  }

  // buildIndex reuses the previous build's records, so publish the new cache only after it runs.
  const recordsByWorktree = buildIndex(runtimeEntries, tabsByWorktree, paneWorktreeIds)
  orchestrationIndexCache = {
    runtimeSource: runtimeAgentOrchestrationByPaneKey,
    tabsSource: tabsByWorktree,
    paneWorktreeIds,
    recordsByWorktree
  }
  return recordsByWorktree
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
