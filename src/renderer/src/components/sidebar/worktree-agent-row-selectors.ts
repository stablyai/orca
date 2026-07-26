import type { RetainedAgentEntry } from '@/store/slices/agent-status'
import type { PaneForegroundAgentEntry } from '@/store/slices/pane-foreground-agent'
import type { AppState } from '@/store/types'
import type {
  AgentStatusEntry,
  AgentStatusOrchestrationContext,
  MigrationUnsupportedPtyEntry
} from '../../../../shared/agent-status-types'
import { parsePaneKey } from '../../../../shared/stable-pane-id'
import {
  type LiveEntriesByWorktreeCache,
  liveEntryWorktreeId,
  patchLiveEntriesByWorktree,
  recordLiveEntriesFullRebuild
} from './worktree-agent-live-index-patch'
import type { TerminalLayoutSnapshot } from '../../../../shared/types'
import { indexPaneForegroundAgentsByWorktree } from './worktree-pane-foreground-index'

const EMPTY_LIVE_ENTRIES: AgentStatusEntry[] = []
const EMPTY_MIGRATION_UNSUPPORTED_ENTRIES: MigrationUnsupportedPtyEntry[] = []
const EMPTY_RETAINED: RetainedAgentEntry[] = []
const EMPTY_RUNTIME_AGENT_ORCHESTRATION: Record<string, AgentStatusOrchestrationContext> = {}
const EMPTY_PANE_FOREGROUND_AGENTS: Record<string, PaneForegroundAgentEntry> = {}
// Why: selector unit tests often pass partial store mocks; production state
// owns these maps, but missing mock maps should behave like empty slices.
const EMPTY_RECORD = {}

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

// Why exported: WorktreeList reuses this exact-equality identity check to keep
// derived arrays referentially stable across order-preserving epoch bumps so
// memo'd cards can bail out of re-render.
export function reuseArrayIfEqual<T>(previous: T[] | undefined, next: T[]): T[] {
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
  const agentStatusByPaneKey = state.agentStatusByPaneKey ?? EMPTY_RECORD
  const tabsByWorktree = state.tabsByWorktree ?? EMPTY_RECORD
  if (
    liveEntriesByWorktreeCache?.tabsByWorktree === tabsByWorktree &&
    liveEntriesByWorktreeCache.agentStatusByPaneKey === agentStatusByPaneKey
  ) {
    return liveEntriesByWorktreeCache.entriesByWorktree
  }

  const tabIdToWorktreeId = getTabIdToWorktreeId(tabsByWorktree)
  if (liveEntriesByWorktreeCache?.tabsByWorktree === tabsByWorktree) {
    const patched = patchLiveEntriesByWorktree(
      liveEntriesByWorktreeCache,
      agentStatusByPaneKey,
      tabIdToWorktreeId
    )
    if (patched) {
      liveEntriesByWorktreeCache = {
        tabsByWorktree,
        agentStatusByPaneKey,
        entriesByWorktree: patched
      }
      return patched
    }
  }
  recordLiveEntriesFullRebuild()
  const previous = liveEntriesByWorktreeCache?.entriesByWorktree
  const entriesByWorktree = new Map<string, AgentStatusEntry[]>()
  for (const [paneKey, entry] of Object.entries(agentStatusByPaneKey)) {
    const worktreeId = liveEntryWorktreeId(paneKey, entry, tabIdToWorktreeId)
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
    tabsByWorktree,
    agentStatusByPaneKey,
    entriesByWorktree
  }
  return entriesByWorktree
}

function getMigrationUnsupportedByWorktree(
  state: WorktreeAgentRowsState
): Map<string, MigrationUnsupportedPtyEntry[]> {
  const migrationUnsupportedByPtyId = state.migrationUnsupportedByPtyId ?? EMPTY_RECORD
  const tabsByWorktree = state.tabsByWorktree ?? EMPTY_RECORD
  if (
    migrationUnsupportedByWorktreeCache?.tabsByWorktree === tabsByWorktree &&
    migrationUnsupportedByWorktreeCache.migrationUnsupportedByPtyId === migrationUnsupportedByPtyId
  ) {
    return migrationUnsupportedByWorktreeCache.entriesByWorktree
  }

  const tabIdToWorktreeId = getTabIdToWorktreeId(tabsByWorktree)
  const previous = migrationUnsupportedByWorktreeCache?.entriesByWorktree
  const entriesByWorktree = new Map<string, MigrationUnsupportedPtyEntry[]>()
  for (const unsupported of Object.values(migrationUnsupportedByPtyId)) {
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
    tabsByWorktree,
    migrationUnsupportedByPtyId,
    entriesByWorktree
  }
  return entriesByWorktree
}

function getRetainedEntriesByWorktree(
  state: WorktreeAgentRowsState
): Map<string, RetainedAgentEntry[]> {
  const retainedAgentsByPaneKey = state.retainedAgentsByPaneKey ?? EMPTY_RECORD
  if (retainedEntriesByWorktreeCache?.retainedAgentsByPaneKey === retainedAgentsByPaneKey) {
    return retainedEntriesByWorktreeCache.entriesByWorktree
  }

  const previous = retainedEntriesByWorktreeCache?.entriesByWorktree
  const entriesByWorktree = new Map<string, RetainedAgentEntry[]>()
  for (const retained of Object.values(retainedAgentsByPaneKey)) {
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
    retainedAgentsByPaneKey,
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
  const tabs = (state.tabsByWorktree ?? EMPTY_RECORD)[worktreeId] ?? []
  const tabIds = new Set(tabs.map((tab) => tab.id))
  const out: Record<string, AgentStatusOrchestrationContext> = {}
  const runtimeAgentOrchestrationByPaneKey =
    state.runtimeAgentOrchestrationByPaneKey ?? EMPTY_RECORD
  const agentStatusByPaneKey = state.agentStatusByPaneKey ?? EMPTY_RECORD
  const retainedAgentsByPaneKey = state.retainedAgentsByPaneKey ?? EMPTY_RECORD
  for (const [paneKey, orchestration] of Object.entries(runtimeAgentOrchestrationByPaneKey)) {
    const parsed = parsePaneKey(paneKey)
    const parsedParent = orchestration.parentPaneKey
      ? parsePaneKey(orchestration.parentPaneKey)
      : null
    const liveEntry = agentStatusByPaneKey[paneKey]
    const retainedEntry = retainedAgentsByPaneKey[paneKey]
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
  for (const tab of (state.tabsByWorktree ?? EMPTY_RECORD)[worktreeId] ?? []) {
    out[tab.id] = (state.terminalLayoutsByTabId ?? EMPTY_RECORD)[tab.id]
  }
  return out
}

export function selectPaneForegroundAgentEntriesForWorktree(
  state: Pick<AppState, 'tabsByWorktree' | 'paneForegroundAgentByPaneKey'>,
  worktreeId: string
): Record<string, PaneForegroundAgentEntry> {
  const tabsByWorktree = state.tabsByWorktree ?? EMPTY_RECORD
  const paneForegroundAgentByPaneKey = state.paneForegroundAgentByPaneKey ?? EMPTY_RECORD
  return (
    indexPaneForegroundAgentsByWorktree(
      getTabIdToWorktreeId(tabsByWorktree),
      paneForegroundAgentByPaneKey
    ).get(worktreeId) ?? EMPTY_PANE_FOREGROUND_AGENTS
  )
}
