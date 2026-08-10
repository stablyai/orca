import type { TerminalTab, WorkspaceSessionPatch, WorkspaceSessionState } from './types'

/** Adopt orphaned terminal state while preserving base authority and tombstones. */

export type WorkspaceSessionPartitionAdoption = {
  session: WorkspaceSessionState
  /** Tab ids adopted per worktree; empty when the base was returned unchanged. */
  adoptedTabIdsByWorktreeId: Record<string, string[]>
  /** Tab ids fenced by a tombstone on either side — retired, never adopted. */
  retiredTabIds: string[]
}

function tombstonedTabIds(session: WorkspaceSessionState): Set<string> {
  const tabIds = new Set<string>()
  for (const tombstone of Object.values(session.terminalSurfaceTombstonesByPaneKey ?? {})) {
    tabIds.add(tombstone.parentTabId)
  }
  return tabIds
}

function pickTabKeyed<T>(
  record: Record<string, T> | undefined,
  tabIds: ReadonlySet<string>
): Record<string, T> {
  return Object.fromEntries(Object.entries(record ?? {}).filter(([tabId]) => tabIds.has(tabId)))
}

function adoptWorktreeKeyed<T>(
  base: Record<string, T> | undefined,
  partition: Record<string, T> | undefined,
  worktreeIds: readonly string[]
): Record<string, T> {
  const adopted = { ...base }
  for (const worktreeId of worktreeIds) {
    if (Object.hasOwn(adopted, worktreeId)) {
      continue
    }
    const entry = partition?.[worktreeId]
    if (entry !== undefined) {
      adopted[worktreeId] = entry
    }
  }
  return adopted
}

export function adoptOrphanedWorkspaceSessionPartition(
  base: WorkspaceSessionState,
  partition: WorkspaceSessionState | null | undefined
): WorkspaceSessionPartitionAdoption {
  if (!partition) {
    return { session: base, adoptedTabIdsByWorktreeId: {}, retiredTabIds: [] }
  }
  const retiredTabIds = new Set([...tombstonedTabIds(base), ...tombstonedTabIds(partition)])
  const adoptedTabsByWorktreeId: Record<string, TerminalTab[]> = {}
  const adoptedTabIdsByWorktreeId: Record<string, string[]> = {}
  for (const [worktreeId, tabs] of Object.entries(partition.tabsByWorktree ?? {})) {
    if ((base.tabsByWorktree?.[worktreeId] ?? []).length > 0) {
      continue
    }
    const liveTabs = (tabs ?? []).filter((tab) => !retiredTabIds.has(tab.id))
    if (liveTabs.length === 0) {
      continue
    }
    adoptedTabsByWorktreeId[worktreeId] = liveTabs
    adoptedTabIdsByWorktreeId[worktreeId] = liveTabs.map((tab) => tab.id)
  }
  const adoptedWorktreeIds = Object.keys(adoptedTabsByWorktreeId)
  if (adoptedWorktreeIds.length === 0) {
    return { session: base, adoptedTabIdsByWorktreeId: {}, retiredTabIds: [...retiredTabIds] }
  }
  const adoptedTabIds = new Set(Object.values(adoptedTabIdsByWorktreeId).flat())

  const session: WorkspaceSessionState = {
    ...base,
    tabsByWorktree: { ...base.tabsByWorktree, ...adoptedTabsByWorktreeId },
    // Why: base entries spread last so an id collision never lets a stale
    // partition record replace live state; only records of adopted tabs enter.
    terminalLayoutsByTabId: {
      ...pickTabKeyed(partition.terminalLayoutsByTabId, adoptedTabIds),
      ...base.terminalLayoutsByTabId
    },
    activeTabIdByWorktree: adoptWorktreeKeyed(
      base.activeTabIdByWorktree,
      partition.activeTabIdByWorktree,
      adoptedWorktreeIds
    ),
    lastVisitedAtByWorktreeId: adoptWorktreeKeyed(
      base.lastVisitedAtByWorktreeId,
      partition.lastVisitedAtByWorktreeId,
      adoptedWorktreeIds
    ),
    defaultTerminalTabsAppliedByWorktreeId: adoptWorktreeKeyed(
      base.defaultTerminalTabsAppliedByWorktreeId,
      partition.defaultTerminalTabsAppliedByWorktreeId,
      adoptedWorktreeIds
    )
  }
  const adoptedRemoteSessionIds = pickTabKeyed(partition.remoteSessionIdsByTabId, adoptedTabIds)
  if (Object.keys(adoptedRemoteSessionIds).length > 0 || base.remoteSessionIdsByTabId) {
    session.remoteSessionIdsByTabId = {
      ...adoptedRemoteSessionIds,
      ...base.remoteSessionIdsByTabId
    }
  }
  return { session, adoptedTabIdsByWorktreeId, retiredTabIds: [...retiredTabIds] }
}

/** Remove only tabs the owner transaction accepted or rejected. */
export function pruneAdoptedWorkspaceSessionPartitionEntries(
  partition: WorkspaceSessionState,
  adoptedTabIdsByWorktreeId: Record<string, string[]>,
  retiredTabIds: readonly string[] = []
): WorkspaceSessionPatch | null {
  if (Object.keys(adoptedTabIdsByWorktreeId).length === 0) {
    return null
  }
  const shed = new Set([...Object.values(adoptedTabIdsByWorktreeId).flat(), ...retiredTabIds])
  const droppedTabIds = new Set<string>()
  const tabsByWorktree: Record<string, TerminalTab[]> = {}
  for (const [worktreeId, tabs] of Object.entries(partition.tabsByWorktree ?? {})) {
    if (!Object.hasOwn(adoptedTabIdsByWorktreeId, worktreeId)) {
      tabsByWorktree[worktreeId] = tabs
      continue
    }
    // Why: a tab the source gained after the adoption read was never moved —
    // dropping the whole entry would delete it with no copy on the owner side.
    const retained: TerminalTab[] = []
    for (const tab of tabs ?? []) {
      if (shed.has(tab.id)) {
        droppedTabIds.add(tab.id)
      } else {
        retained.push(tab)
      }
    }
    if (retained.length > 0) {
      tabsByWorktree[worktreeId] = retained
    }
  }
  const patch: WorkspaceSessionPatch = {
    tabsByWorktree,
    terminalLayoutsByTabId: Object.fromEntries(
      Object.entries(partition.terminalLayoutsByTabId ?? {}).filter(
        ([tabId]) => !droppedTabIds.has(tabId)
      )
    )
  }
  if (partition.remoteSessionIdsByTabId) {
    patch.remoteSessionIdsByTabId = Object.fromEntries(
      Object.entries(partition.remoteSessionIdsByTabId).filter(
        ([tabId]) => !droppedTabIds.has(tabId)
      )
    )
  }
  return patch
}
