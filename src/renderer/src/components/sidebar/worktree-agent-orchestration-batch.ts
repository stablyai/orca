import type { AppState } from '@/store/types'
import type { AgentStatusOrchestrationContext } from '../../../../shared/agent-status-types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'

type RuntimeOrchestrationState = Pick<
  AppState,
  | 'agentStatusByPaneKey'
  | 'retainedAgentsByPaneKey'
  | 'runtimeAgentOrchestrationByPaneKey'
  | 'tabsByWorktree'
>

type RuntimeOrchestrationMap = RuntimeOrchestrationState['runtimeAgentOrchestrationByPaneKey']
type RuntimeOrchestrationRecord = Record<string, AgentStatusOrchestrationContext>

type RuntimeDomainCache = {
  source: RuntimeOrchestrationMap
  orderedEntries: [string, AgentStatusOrchestrationContext][]
}

type RequestedTabMembershipCache = {
  tabsSource: RuntimeOrchestrationState['tabsByWorktree']
  requestedWorktreeIds: string[]
  requestedIds: Set<string>
  worktreeIdsByTabId: Map<string, Set<string>>
}

type RuntimeBatchCache = {
  runtimeSource: RuntimeOrchestrationMap
  tabsSource: RuntimeOrchestrationState['tabsByWorktree']
  liveSource: RuntimeOrchestrationState['agentStatusByPaneKey']
  retainedSource: RuntimeOrchestrationState['retainedAgentsByPaneKey']
  requestedWorktreeIds: string[]
  recordsByWorktree: ReadonlyMap<string, RuntimeOrchestrationRecord>
}

const EMPTY_RUNTIME_ORCHESTRATION: RuntimeOrchestrationMap = {}
const EMPTY_TABS_BY_WORKTREE: RuntimeOrchestrationState['tabsByWorktree'] = {}
const EMPTY_AGENT_STATUS: RuntimeOrchestrationState['agentStatusByPaneKey'] = {}
const EMPTY_RETAINED_AGENTS: RuntimeOrchestrationState['retainedAgentsByPaneKey'] = {}
const EMPTY_BATCH: ReadonlyMap<string, RuntimeOrchestrationRecord> = new Map()

export const EMPTY_WORKTREE_AGENT_ORCHESTRATION: RuntimeOrchestrationRecord = {}

let runtimeDomainCache: RuntimeDomainCache | null = null
let requestedTabMembershipCache: RequestedTabMembershipCache | null = null
let runtimeBatchCache: RuntimeBatchCache | null = null

export function releaseRuntimeAgentOrchestrationBatchCache(): void {
  runtimeDomainCache = null
  requestedTabMembershipCache = null
  runtimeBatchCache = null
}

function getOrderedRuntimeEntries(
  runtimeAgentOrchestrationByPaneKey: RuntimeOrchestrationMap
): [string, AgentStatusOrchestrationContext][] {
  if (runtimeDomainCache?.source === runtimeAgentOrchestrationByPaneKey) {
    return runtimeDomainCache.orderedEntries
  }
  const orderedEntries = Object.entries(runtimeAgentOrchestrationByPaneKey)
  runtimeDomainCache = { source: runtimeAgentOrchestrationByPaneKey, orderedEntries }
  return orderedEntries
}

function uniqueWorktreeIds(worktreeIds: readonly string[]): string[] {
  const uniqueIds: string[] = []
  const seen = new Set<string>()
  for (const worktreeId of worktreeIds) {
    if (!seen.has(worktreeId)) {
      seen.add(worktreeId)
      uniqueIds.push(worktreeId)
    }
  }
  return uniqueIds
}

function hasSameWorktreeIds(previous: readonly string[], next: readonly string[]): boolean {
  if (previous.length !== next.length) {
    return false
  }
  return previous.every((worktreeId, index) => worktreeId === next[index])
}

function getRequestedTabMembership(
  tabsByWorktree: RuntimeOrchestrationState['tabsByWorktree'],
  requestedWorktreeIds: string[]
): RequestedTabMembershipCache {
  if (
    requestedTabMembershipCache?.tabsSource === tabsByWorktree &&
    hasSameWorktreeIds(requestedTabMembershipCache.requestedWorktreeIds, requestedWorktreeIds)
  ) {
    return requestedTabMembershipCache
  }

  const requestedIds = new Set(requestedWorktreeIds)
  const worktreeIdsByTabId = new Map<string, Set<string>>()
  for (const worktreeId of requestedWorktreeIds) {
    // Why: the batch must not make a singleton dashboard scan unrelated tabs.
    for (const tab of tabsByWorktree[worktreeId] ?? []) {
      const tabId = tab.id
      const existing = worktreeIdsByTabId.get(tabId)
      if (existing) {
        existing.add(worktreeId)
      } else {
        worktreeIdsByTabId.set(tabId, new Set([worktreeId]))
      }
    }
  }
  requestedTabMembershipCache = {
    tabsSource: tabsByWorktree,
    requestedWorktreeIds,
    requestedIds,
    worktreeIdsByTabId
  }
  return requestedTabMembershipCache
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

function buildRuntimeBatch(
  requestedWorktreeIds: string[],
  orderedRuntimeEntries: [string, AgentStatusOrchestrationContext][],
  tabsByWorktree: RuntimeOrchestrationState['tabsByWorktree'],
  agentStatusByPaneKey: RuntimeOrchestrationState['agentStatusByPaneKey'],
  retainedAgentsByPaneKey: RuntimeOrchestrationState['retainedAgentsByPaneKey']
): ReadonlyMap<string, RuntimeOrchestrationRecord> {
  const { requestedIds, worktreeIdsByTabId } = getRequestedTabMembership(
    tabsByWorktree,
    requestedWorktreeIds
  )

  const recordsByWorktree = new Map<string, RuntimeOrchestrationRecord>()
  for (const [paneKey, orchestration] of orderedRuntimeEntries) {
    const targets = new Set<string>()
    const parsed = parsePaneKey(paneKey)
    const parsedParent = orchestration.parentPaneKey
      ? parsePaneKey(orchestration.parentPaneKey)
      : null
    if (parsed) {
      for (const worktreeId of worktreeIdsByTabId.get(parsed.tabId) ?? []) {
        targets.add(worktreeId)
      }
    }
    if (parsedParent) {
      for (const worktreeId of worktreeIdsByTabId.get(parsedParent.tabId) ?? []) {
        targets.add(worktreeId)
      }
    }

    // Why: exact runtime keys preserve early SSH attribution and ignore stale
    // entry.paneKey fields carried by a live or retained row.
    const liveWorktreeId = agentStatusByPaneKey[paneKey]?.worktreeId
    const retainedWorktreeId = retainedAgentsByPaneKey[paneKey]?.worktreeId
    if (typeof liveWorktreeId === 'string' && requestedIds.has(liveWorktreeId)) {
      targets.add(liveWorktreeId)
    }
    if (typeof retainedWorktreeId === 'string' && requestedIds.has(retainedWorktreeId)) {
      targets.add(retainedWorktreeId)
    }

    for (const worktreeId of targets) {
      const existing = recordsByWorktree.get(worktreeId)
      if (existing) {
        existing[paneKey] = orchestration
      } else {
        recordsByWorktree.set(worktreeId, { [paneKey]: orchestration })
      }
    }
  }

  const previousRecords = runtimeBatchCache?.recordsByWorktree
  for (const [worktreeId, record] of recordsByWorktree) {
    recordsByWorktree.set(
      worktreeId,
      reuseRecordIfOrderedEqual(previousRecords?.get(worktreeId), record)
    )
  }
  return recordsByWorktree
}

export function selectRuntimeAgentOrchestrationBatch(
  state: RuntimeOrchestrationState,
  worktreeIds: readonly string[]
): ReadonlyMap<string, RuntimeOrchestrationRecord> {
  const requestedWorktreeIds = uniqueWorktreeIds(worktreeIds)
  if (requestedWorktreeIds.length === 0) {
    releaseRuntimeAgentOrchestrationBatchCache()
    return EMPTY_BATCH
  }

  const runtimeAgentOrchestrationByPaneKey =
    state.runtimeAgentOrchestrationByPaneKey ?? EMPTY_RUNTIME_ORCHESTRATION
  const orderedRuntimeEntries = getOrderedRuntimeEntries(runtimeAgentOrchestrationByPaneKey)
  if (orderedRuntimeEntries.length === 0) {
    releaseRuntimeAgentOrchestrationBatchCache()
    return EMPTY_BATCH
  }

  const tabsByWorktree = state.tabsByWorktree ?? EMPTY_TABS_BY_WORKTREE
  const agentStatusByPaneKey = state.agentStatusByPaneKey ?? EMPTY_AGENT_STATUS
  const retainedAgentsByPaneKey = state.retainedAgentsByPaneKey ?? EMPTY_RETAINED_AGENTS
  if (
    runtimeBatchCache?.runtimeSource === runtimeAgentOrchestrationByPaneKey &&
    runtimeBatchCache.tabsSource === tabsByWorktree &&
    runtimeBatchCache.liveSource === agentStatusByPaneKey &&
    runtimeBatchCache.retainedSource === retainedAgentsByPaneKey &&
    hasSameWorktreeIds(runtimeBatchCache.requestedWorktreeIds, requestedWorktreeIds)
  ) {
    return runtimeBatchCache.recordsByWorktree
  }

  runtimeBatchCache = {
    runtimeSource: runtimeAgentOrchestrationByPaneKey,
    tabsSource: tabsByWorktree,
    liveSource: agentStatusByPaneKey,
    retainedSource: retainedAgentsByPaneKey,
    requestedWorktreeIds,
    recordsByWorktree: buildRuntimeBatch(
      requestedWorktreeIds,
      orderedRuntimeEntries,
      tabsByWorktree,
      agentStatusByPaneKey,
      retainedAgentsByPaneKey
    )
  }
  return runtimeBatchCache.recordsByWorktree
}
