import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import type { AppState } from '@/store/types'
import type {
  AgentStatusEntry,
  AgentStatusOrchestrationContext,
  MigrationUnsupportedPtyEntry
} from '../../../../shared/agent-status-types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import type { TerminalLayoutSnapshot } from '../../../../shared/types'

const EMPTY_LIVE_ENTRIES: AgentStatusEntry[] = []
const EMPTY_MIGRATION_UNSUPPORTED_ENTRIES: MigrationUnsupportedPtyEntry[] = []
const EMPTY_RETAINED: RetainedAgentEntry[] = []
const EMPTY_RUNTIME_AGENT_ORCHESTRATION: Record<string, AgentStatusOrchestrationContext> = {}

type WorktreeAgentRowsState = Pick<
  AppState,
  | 'agentStatusByPaneKey'
  | 'migrationUnsupportedByPtyId'
  | 'retainedAgentsByPaneKey'
  | 'tabsByWorktree'
>

type TabWorktreeIndexCache = {
  tabsByWorktree: WorktreeAgentRowsState['tabsByWorktree']
  tabIdToWorktreeId: Map<string, string>
}

type LiveEntriesByWorktreeCache = {
  tabsByWorktree: WorktreeAgentRowsState['tabsByWorktree']
  agentStatusByPaneKey: WorktreeAgentRowsState['agentStatusByPaneKey']
  entriesByWorktree: Map<string, AgentStatusEntry[]>
}

type MigrationUnsupportedByWorktreeCache = {
  tabsByWorktree: WorktreeAgentRowsState['tabsByWorktree']
  migrationUnsupportedByPtyId: WorktreeAgentRowsState['migrationUnsupportedByPtyId']
  entriesByWorktree: Map<string, MigrationUnsupportedPtyEntry[]>
}

type RetainedEntriesByWorktreeCache = {
  retainedAgentsByPaneKey: WorktreeAgentRowsState['retainedAgentsByPaneKey']
  entriesByWorktree: Map<string, RetainedAgentEntry[]>
}

let tabWorktreeIndexCache: TabWorktreeIndexCache | null = null
let liveEntriesByWorktreeCache: LiveEntriesByWorktreeCache | null = null
let migrationUnsupportedByWorktreeCache: MigrationUnsupportedByWorktreeCache | null = null
let retainedEntriesByWorktreeCache: RetainedEntriesByWorktreeCache | null = null

function reuseArrayIfEqual<T>(previous: T[] | undefined, next: T[]): T[] {
  if (!previous || previous.length !== next.length) {
    return next
  }
  for (let i = 0; i < next.length; i += 1) {
    if (previous[i] !== next[i]) {
      return next
    }
  }
  return previous
}

function getTabIdToWorktreeId(
  tabsByWorktree: WorktreeAgentRowsState['tabsByWorktree']
): Map<string, string> {
  if (tabWorktreeIndexCache?.tabsByWorktree === tabsByWorktree) {
    return tabWorktreeIndexCache.tabIdToWorktreeId
  }
  const tabIdToWorktreeId = new Map<string, string>()
  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    for (const tab of tabs) {
      tabIdToWorktreeId.set(tab.id, worktreeId)
    }
  }
  tabWorktreeIndexCache = { tabsByWorktree, tabIdToWorktreeId }
  return tabIdToWorktreeId
}

function getLiveEntriesByWorktree(state: WorktreeAgentRowsState): Map<string, AgentStatusEntry[]> {
  if (
    liveEntriesByWorktreeCache?.tabsByWorktree === state.tabsByWorktree &&
    liveEntriesByWorktreeCache.agentStatusByPaneKey === state.agentStatusByPaneKey
  ) {
    return liveEntriesByWorktreeCache.entriesByWorktree
  }

  const tabIdToWorktreeId = getTabIdToWorktreeId(state.tabsByWorktree)
  const previous = liveEntriesByWorktreeCache?.entriesByWorktree
  const entriesByWorktree = new Map<string, AgentStatusEntry[]>()
  for (const [paneKey, entry] of Object.entries(state.agentStatusByPaneKey)) {
    const parsed = parsePaneKey(paneKey)
    if (!parsed) {
      continue
    }
    const worktreeId = tabIdToWorktreeId.get(parsed.tabId) ?? entry.worktreeId
    if (!worktreeId) {
      continue
    }
    const bucket = entriesByWorktree.get(worktreeId)
    if (bucket) {
      bucket.push(entry)
    } else {
      entriesByWorktree.set(worktreeId, [entry])
    }
  }
  for (const [worktreeId, entries] of entriesByWorktree) {
    entriesByWorktree.set(worktreeId, reuseArrayIfEqual(previous?.get(worktreeId), entries))
  }
  liveEntriesByWorktreeCache = {
    tabsByWorktree: state.tabsByWorktree,
    agentStatusByPaneKey: state.agentStatusByPaneKey,
    entriesByWorktree
  }
  return entriesByWorktree
}

function getMigrationUnsupportedByWorktree(
  state: WorktreeAgentRowsState
): Map<string, MigrationUnsupportedPtyEntry[]> {
  if (
    migrationUnsupportedByWorktreeCache?.tabsByWorktree === state.tabsByWorktree &&
    migrationUnsupportedByWorktreeCache.migrationUnsupportedByPtyId ===
      state.migrationUnsupportedByPtyId
  ) {
    return migrationUnsupportedByWorktreeCache.entriesByWorktree
  }

  const tabIdToWorktreeId = getTabIdToWorktreeId(state.tabsByWorktree)
  const previous = migrationUnsupportedByWorktreeCache?.entriesByWorktree
  const entriesByWorktree = new Map<string, MigrationUnsupportedPtyEntry[]>()
  for (const unsupported of Object.values(state.migrationUnsupportedByPtyId)) {
    if (!unsupported.paneKey) {
      continue
    }
    const parsed = parsePaneKey(unsupported.paneKey)
    const worktreeId = parsed ? tabIdToWorktreeId.get(parsed.tabId) : undefined
    if (!worktreeId) {
      continue
    }
    const bucket = entriesByWorktree.get(worktreeId)
    if (bucket) {
      bucket.push(unsupported)
    } else {
      entriesByWorktree.set(worktreeId, [unsupported])
    }
  }
  for (const [worktreeId, entries] of entriesByWorktree) {
    entriesByWorktree.set(worktreeId, reuseArrayIfEqual(previous?.get(worktreeId), entries))
  }
  migrationUnsupportedByWorktreeCache = {
    tabsByWorktree: state.tabsByWorktree,
    migrationUnsupportedByPtyId: state.migrationUnsupportedByPtyId,
    entriesByWorktree
  }
  return entriesByWorktree
}

function getRetainedEntriesByWorktree(
  state: WorktreeAgentRowsState
): Map<string, RetainedAgentEntry[]> {
  if (retainedEntriesByWorktreeCache?.retainedAgentsByPaneKey === state.retainedAgentsByPaneKey) {
    return retainedEntriesByWorktreeCache.entriesByWorktree
  }

  const previous = retainedEntriesByWorktreeCache?.entriesByWorktree
  const entriesByWorktree = new Map<string, RetainedAgentEntry[]>()
  for (const retained of Object.values(state.retainedAgentsByPaneKey)) {
    const bucket = entriesByWorktree.get(retained.worktreeId)
    if (bucket) {
      bucket.push(retained)
    } else {
      entriesByWorktree.set(retained.worktreeId, [retained])
    }
  }
  for (const [worktreeId, entries] of entriesByWorktree) {
    entriesByWorktree.set(worktreeId, reuseArrayIfEqual(previous?.get(worktreeId), entries))
  }
  retainedEntriesByWorktreeCache = {
    retainedAgentsByPaneKey: state.retainedAgentsByPaneKey,
    entriesByWorktree
  }
  return entriesByWorktree
}

export function selectLiveAgentStatusEntriesForWorktree(
  state: WorktreeAgentRowsState,
  worktreeId: string
): AgentStatusEntry[] {
  return getLiveEntriesByWorktree(state).get(worktreeId) ?? EMPTY_LIVE_ENTRIES
}

export function selectMigrationUnsupportedEntriesForWorktree(
  state: WorktreeAgentRowsState,
  worktreeId: string
): MigrationUnsupportedPtyEntry[] {
  return (
    getMigrationUnsupportedByWorktree(state).get(worktreeId) ?? EMPTY_MIGRATION_UNSUPPORTED_ENTRIES
  )
}

export function selectRetainedAgentEntriesForWorktree(
  state: WorktreeAgentRowsState,
  worktreeId: string
): RetainedAgentEntry[] {
  return getRetainedEntriesByWorktree(state).get(worktreeId) ?? EMPTY_RETAINED
}

export function selectRuntimeAgentOrchestrationForWorktree(
  state: Pick<
    AppState,
    | 'agentStatusByPaneKey'
    | 'retainedAgentsByPaneKey'
    | 'runtimeAgentOrchestrationByPaneKey'
    | 'tabsByWorktree'
  >,
  worktreeId: string
): Record<string, AgentStatusOrchestrationContext> {
  const tabs = state.tabsByWorktree[worktreeId] ?? []
  const tabIds = new Set(tabs.map((tab) => tab.id))
  const out: Record<string, AgentStatusOrchestrationContext> = {}
  for (const [paneKey, orchestration] of Object.entries(state.runtimeAgentOrchestrationByPaneKey)) {
    const parsed = parsePaneKey(paneKey)
    const parsedParent = orchestration.parentPaneKey
      ? parsePaneKey(orchestration.parentPaneKey)
      : null
    const liveEntry = state.agentStatusByPaneKey[paneKey]
    const retainedEntry = state.retainedAgentsByPaneKey[paneKey]
    // Why: child agent terminals can be attributed to a worktree before their
    // tab reaches this renderer, or after the row has been retained as done.
    // The parent link must still reach that worktree card.
    if (
      (parsed && tabIds.has(parsed.tabId)) ||
      (parsedParent && tabIds.has(parsedParent.tabId)) ||
      liveEntry?.worktreeId === worktreeId ||
      retainedEntry?.worktreeId === worktreeId
    ) {
      out[paneKey] = orchestration
    }
  }
  return Object.keys(out).length > 0 ? out : EMPTY_RUNTIME_AGENT_ORCHESTRATION
}

export function selectTerminalLayoutsForWorktree(
  state: Pick<AppState, 'tabsByWorktree' | 'terminalLayoutsByTabId'>,
  worktreeId: string
): Record<string, TerminalLayoutSnapshot | undefined> {
  const out: Record<string, TerminalLayoutSnapshot | undefined> = {}
  for (const tab of state.tabsByWorktree[worktreeId] ?? []) {
    out[tab.id] = state.terminalLayoutsByTabId[tab.id]
  }
  return out
}
