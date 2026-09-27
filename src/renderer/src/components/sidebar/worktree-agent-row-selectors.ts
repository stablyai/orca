export {
  EMPTY_TERMINAL_LAYOUTS,
  selectTerminalLayoutsForWorktree
} from './worktree-terminal-layout-selector'
import {
  combineWorktreeAgentRowMembership,
  reuseWorktreeMembership
} from './worktree-agent-row-membership'
import type { RetainedAgentEntry } from '@/store/slices/agent-status'
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
import { selectWorktreeAgentOrchestration } from './worktree-agent-orchestration-index'

// Why frozen and exported: card hooks return these from their inactive branch,
// so the identity has to be shared app-wide and safe from stray writes.
export const EMPTY_LIVE_ENTRIES = Object.freeze([]) as unknown as AgentStatusEntry[]
export const EMPTY_MIGRATION_UNSUPPORTED_ENTRIES = Object.freeze(
  []
) as unknown as MigrationUnsupportedPtyEntry[]
export const EMPTY_RETAINED = Object.freeze([]) as unknown as RetainedAgentEntry[]
// Why: selector unit tests often pass partial store mocks; production state
// owns these maps, but missing mock maps should behave like empty slices.
const EMPTY_RECORD = {}

type WorktreeAgentRowsState = Pick<
  AppState,
  | 'agentStatusByPaneKey'
  | 'migrationUnsupportedByPtyId'
  | 'retainedAgentsByPaneKey'
  | 'tabsByWorktree'
> & {
  unifiedTabsByWorktree?: AppState['unifiedTabsByWorktree']
}

type TabWorktreeIndexCache = {
  tabsByWorktree: WorktreeAgentRowsState['tabsByWorktree']
  tabIdToWorktreeId: Map<string, string>
  worktreeIds: ReadonlySet<string>
}

type LiveTabWorktreeIndexCache = Omit<TabWorktreeIndexCache, 'worktreeIds'> & {
  unifiedTabsByWorktree: WorktreeAgentRowsState['unifiedTabsByWorktree']
}

type MigrationUnsupportedByWorktreeCache = {
  tabsByWorktree: WorktreeAgentRowsState['tabsByWorktree']
  migrationUnsupportedByPtyId: WorktreeAgentRowsState['migrationUnsupportedByPtyId']
  entriesByWorktree: Map<string, MigrationUnsupportedPtyEntry[]>
  worktreeIds: ReadonlySet<string>
}

type RetainedEntriesByWorktreeCache = {
  retainedAgentsByPaneKey: WorktreeAgentRowsState['retainedAgentsByPaneKey']
  entriesByWorktree: Map<string, RetainedAgentEntry[]>
  worktreeIds: ReadonlySet<string>
}

type LiveWorktreeEntriesCache = LiveEntriesByWorktreeCache & { worktreeIds: ReadonlySet<string> }

let tabWorktreeIndexCache: TabWorktreeIndexCache | null = null
let liveTabWorktreeIndexCache: LiveTabWorktreeIndexCache | null = null
let liveEntriesByWorktreeCache: LiveWorktreeEntriesCache | null = null
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

// Why exported: the Settings -> Repositories runtime summary needs the same
// tab -> worktree index, and rebuilding it there would re-walk every tab bucket
// on each store write.
export function getTabIdToWorktreeId(
  tabsByWorktree: WorktreeAgentRowsState['tabsByWorktree']
): Map<string, string> {
  if (tabWorktreeIndexCache?.tabsByWorktree === tabsByWorktree) {
    return tabWorktreeIndexCache.tabIdToWorktreeId
  }
  const tabIdToWorktreeId = new Map<string, string>()
  const worktreeIds = new Set<string>()
  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    if (tabs.length > 0) {
      worktreeIds.add(worktreeId)
    }
    for (const tab of tabs) {
      tabIdToWorktreeId.set(tab.id, worktreeId)
    }
  }
  tabWorktreeIndexCache = {
    tabsByWorktree,
    tabIdToWorktreeId,
    worktreeIds: reuseWorktreeMembership(tabWorktreeIndexCache?.worktreeIds, worktreeIds)
  }
  return tabIdToWorktreeId
}

function getLiveTabIdToWorktreeId(
  tabsByWorktree: WorktreeAgentRowsState['tabsByWorktree'],
  unifiedTabsByWorktree: WorktreeAgentRowsState['unifiedTabsByWorktree']
): Map<string, string> {
  if (
    liveTabWorktreeIndexCache?.tabsByWorktree === tabsByWorktree &&
    liveTabWorktreeIndexCache.unifiedTabsByWorktree === unifiedTabsByWorktree
  ) {
    return liveTabWorktreeIndexCache.tabIdToWorktreeId
  }
  const tabIdToWorktreeId = new Map(getTabIdToWorktreeId(tabsByWorktree))
  for (const [worktreeId, tabs] of Object.entries(unifiedTabsByWorktree ?? {})) {
    for (const tab of tabs) {
      if (tab.contentType === 'agent-session') {
        tabIdToWorktreeId.set(tab.id, worktreeId)
      }
    }
  }
  liveTabWorktreeIndexCache = { tabsByWorktree, unifiedTabsByWorktree, tabIdToWorktreeId }
  return tabIdToWorktreeId
}

function getLiveEntriesByWorktree(state: WorktreeAgentRowsState): Map<string, AgentStatusEntry[]> {
  const agentStatusByPaneKey = state.agentStatusByPaneKey ?? EMPTY_RECORD
  const tabsByWorktree = state.tabsByWorktree ?? EMPTY_RECORD
  const unifiedTabsByWorktree = state.unifiedTabsByWorktree
  if (
    liveEntriesByWorktreeCache?.tabsByWorktree === tabsByWorktree &&
    liveEntriesByWorktreeCache.unifiedTabsByWorktree === unifiedTabsByWorktree &&
    liveEntriesByWorktreeCache.agentStatusByPaneKey === agentStatusByPaneKey
  ) {
    return liveEntriesByWorktreeCache.entriesByWorktree
  }

  const tabIdToWorktreeId = getLiveTabIdToWorktreeId(tabsByWorktree, unifiedTabsByWorktree)
  if (
    liveEntriesByWorktreeCache?.tabsByWorktree === tabsByWorktree &&
    liveEntriesByWorktreeCache.unifiedTabsByWorktree === unifiedTabsByWorktree
  ) {
    const patched = patchLiveEntriesByWorktree(
      liveEntriesByWorktreeCache,
      agentStatusByPaneKey,
      tabIdToWorktreeId
    )
    if (patched) {
      liveEntriesByWorktreeCache = {
        tabsByWorktree,
        unifiedTabsByWorktree,
        agentStatusByPaneKey,
        worktreeIds: liveEntriesByWorktreeCache.worktreeIds,
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
    unifiedTabsByWorktree,
    agentStatusByPaneKey,
    worktreeIds: reuseWorktreeMembership(
      liveEntriesByWorktreeCache?.worktreeIds,
      entriesByWorktree.keys()
    ),
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
    worktreeIds: reuseWorktreeMembership(
      migrationUnsupportedByWorktreeCache?.worktreeIds,
      entriesByWorktree.keys()
    ),
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
    worktreeIds: reuseWorktreeMembership(
      retainedEntriesByWorktreeCache?.worktreeIds,
      entriesByWorktree.keys()
    ),
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

// Why: reads a shared worktree-keyed index instead of rescanning every
// orchestration context. Zustand re-runs each mounted card's selector on every
// publication, so the old per-card scan was O(cards x contexts) on unrelated
// traffic; only the first card through a given store version now pays a build.
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
  return selectWorktreeAgentOrchestration(state, worktreeId)
}

export function selectWorktreeAgentRowCandidateIds(
  state: WorktreeAgentRowsState
): ReadonlySet<string> {
  getTabIdToWorktreeId(state.tabsByWorktree ?? EMPTY_RECORD)
  getLiveEntriesByWorktree(state)
  getMigrationUnsupportedByWorktree(state)
  getRetainedEntriesByWorktree(state)
  return combineWorktreeAgentRowMembership(
    tabWorktreeIndexCache!.worktreeIds,
    liveEntriesByWorktreeCache!.worktreeIds,
    migrationUnsupportedByWorktreeCache!.worktreeIds,
    retainedEntriesByWorktreeCache!.worktreeIds
  )
}
