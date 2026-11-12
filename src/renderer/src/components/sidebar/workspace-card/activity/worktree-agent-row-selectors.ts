import type { AppState } from '@/store/types'
import type { AgentStatusEntry } from '../../../../../../shared/agent-status/contracts/agent-status-types'
import type { MigrationUnsupportedPtyEntry } from '../../../../../../shared/agent-status/contracts/agent-status-ipc-payload'
import { parsePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { createWorktreeRecordSelector } from '@/store/terminals/worktree-terminal-record-selector'
import type { TerminalLayoutSnapshot } from '../../../../../../shared/workspace-layout/terminal-tab-types'

// Why frozen and exported: card hooks return these from their inactive branch,
// so the identity has to be shared app-wide and safe from stray writes.
export const EMPTY_LIVE_ENTRIES = Object.freeze([]) as unknown as AgentStatusEntry[]
export const EMPTY_MIGRATION_UNSUPPORTED_ENTRIES = Object.freeze(
  []
) as unknown as MigrationUnsupportedPtyEntry[]
export const EMPTY_TERMINAL_LAYOUTS: Record<string, TerminalLayoutSnapshot | undefined> =
  Object.freeze({})
// Partial test stores need missing maps to behave as stable empty slices.
const EMPTY_RECORD = {}

type WorktreeAgentRowsState = Pick<
  AppState,
  'agentStatusByPaneKey' | 'migrationUnsupportedByPtyId' | 'tabsByWorktree'
> & {
  unifiedTabsByWorktree?: AppState['unifiedTabsByWorktree']
}

type TabWorktreeIndexCache = {
  tabsByWorktree: WorktreeAgentRowsState['tabsByWorktree']
  tabIdToWorktreeId: Map<string, string>
}

type MigrationUnsupportedByWorktreeCache = {
  tabsByWorktree: WorktreeAgentRowsState['tabsByWorktree']
  migrationUnsupportedByPtyId: WorktreeAgentRowsState['migrationUnsupportedByPtyId']
  entriesByWorktree: Map<string, MigrationUnsupportedPtyEntry[]>
}

let tabWorktreeIndexCache: TabWorktreeIndexCache | null = null
let migrationUnsupportedByWorktreeCache: MigrationUnsupportedByWorktreeCache | null = null

// Share exact array reuse with WorktreeList so equal epoch-derived rows do not rerender cards.
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

// Settings reuses this tab index to avoid rescanning every bucket on each store write.
export function getTabIdToWorktreeId(
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

const liveOutputs = new WeakMap<
  WorktreeAgentRowsState['agentStatusByPaneKey']['projection'],
  Map<string, { revision: number; entries: AgentStatusEntry[] }>
>()

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

export function selectLiveAgentStatusEntriesForWorktree(
  state: WorktreeAgentRowsState,
  worktreeId: string
): AgentStatusEntry[] {
  const projection = state.agentStatusByPaneKey.projection
  let outputs = liveOutputs.get(projection)
  if (!outputs) {
    liveOutputs.set(projection, (outputs = new Map()))
  }
  const revision = projection.revision(worktreeId),
    previous = outputs.get(worktreeId)
  if (previous?.revision === revision) {
    return previous.entries
  }
  const entries = projection.entries(worktreeId, state.agentStatusByPaneKey)
  outputs.set(worktreeId, { revision, entries })
  return entries
}

export function selectMigrationUnsupportedEntriesForWorktree(
  state: WorktreeAgentRowsState,
  worktreeId: string
): MigrationUnsupportedPtyEntry[] {
  return (
    getMigrationUnsupportedByWorktree(state).get(worktreeId) ?? EMPTY_MIGRATION_UNSUPPORTED_ENTRIES
  )
}

export const selectTerminalLayoutsForWorktree = createWorktreeRecordSelector<
  Pick<AppState, 'tabsByWorktree' | 'terminalLayoutsByTabId'>,
  Record<string, TerminalLayoutSnapshot | undefined>
>({
  readSources: (state) => [
    state.tabsByWorktree ?? EMPTY_RECORD,
    state.terminalLayoutsByTabId ?? EMPTY_RECORD
  ],
  empty: EMPTY_TERMINAL_LAYOUTS,
  build: (state, worktreeId) => {
    const out: Record<string, TerminalLayoutSnapshot | undefined> = {}
    for (const tab of (state.tabsByWorktree ?? EMPTY_RECORD)[worktreeId] ?? []) {
      out[tab.id] = (state.terminalLayoutsByTabId ?? EMPTY_RECORD)[tab.id]
    }
    return out
  }
})
