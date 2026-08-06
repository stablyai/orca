import type { TerminalTab, WorkspaceSessionPatch, WorkspaceSessionState } from './types'

/**
 * Adopt terminal-session state that exists only in another host partition.
 *
 * The main-process runtime persists SSH-owned worktree session state into
 * `ssh:<targetId>` partitions (persistence.ts workspaceSessionsByHostId), while
 * renderer persistence keeps SSH worktrees in the 'local' partition
 * (workspace-session-host-persistence.ts buildHostIdByWorktreeId). Readers that
 * only consult one side see the other side's worktrees as empty — and both the
 * boot hydration merge and the remote-workspace export treat "empty" as
 * authoritative, which turns the invisible copy into a permanent deletion once
 * a remote snapshot round-trips it.
 *
 * Adoption is the read-side bridge: a worktree whose base entry holds no tabs
 * takes the partition's populated entry, together with the tab-scoped records
 * of exactly the adopted tabs. Entries the base already populates always win —
 * the partition copy may be a stale fork. Tabs fenced by a surface tombstone on
 * either side stay retired. Nothing is ever removed from the base.
 *
 * The adopted field set deliberately mirrors the terminal-session surface of
 * remote-workspace-session-projection.ts — when a worktree/tab-scoped field is
 * added there it must be considered here too.
 */

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

export type AdoptedWorkspaceSessionOwnerPatch = {
  patch: WorkspaceSessionPatch
  /** Tab ids the patch lands, per worktree — the exact set the source may shed. */
  landedTabIdsByWorktreeId: Record<string, string[]>
}

/**
 * Build the owner-partition patch that lands every adopted field durably.
 * `ownerSession` must be a fresh read of the owning partition — the patch
 * replaces whole fields, so building it from a stale snapshot would clobber
 * writes that landed in between. Worktrees the fresh read already populates
 * drop out of the patch, so only what this patch lands may later be pruned
 * from the source. Returns null when nothing is left to land.
 */
export function buildAdoptedWorkspaceSessionOwnerPatch(
  ownerSession: WorkspaceSessionState,
  adoptedSession: WorkspaceSessionState,
  adoptedTabIdsByWorktreeId: Record<string, string[]>
): AdoptedWorkspaceSessionOwnerPatch | null {
  // Why: base-wins holds against the fresh read too — a concurrent write can
  // populate an adopted worktree after the boot snapshot, and this patch
  // replaces the whole field, so keeping the snapshot would drop those tabs.
  const adoptedWorktreeIds = Object.keys(adoptedTabIdsByWorktreeId).filter(
    (worktreeId) => (ownerSession.tabsByWorktree?.[worktreeId] ?? []).length === 0
  )
  if (adoptedWorktreeIds.length === 0) {
    return null
  }
  const landedTabIdsByWorktreeId = Object.fromEntries(
    adoptedWorktreeIds.map((worktreeId) => [
      worktreeId,
      adoptedTabIdsByWorktreeId[worktreeId] ?? []
    ])
  )
  const adoptedTabIds = new Set(Object.values(landedTabIdsByWorktreeId).flat())
  const adoptedTabsByWorktree = Object.fromEntries(
    adoptedWorktreeIds.map((worktreeId) => [
      worktreeId,
      adoptedSession.tabsByWorktree[worktreeId] ?? []
    ])
  )
  const patch: WorkspaceSessionPatch = {
    tabsByWorktree: { ...ownerSession.tabsByWorktree, ...adoptedTabsByWorktree },
    terminalLayoutsByTabId: {
      ...ownerSession.terminalLayoutsByTabId,
      ...pickTabKeyed(adoptedSession.terminalLayoutsByTabId, adoptedTabIds)
    }
  }
  const adoptedRemoteSessionIds = pickTabKeyed(
    adoptedSession.remoteSessionIdsByTabId,
    adoptedTabIds
  )
  if (Object.keys(adoptedRemoteSessionIds).length > 0) {
    patch.remoteSessionIdsByTabId = {
      ...ownerSession.remoteSessionIdsByTabId,
      ...adoptedRemoteSessionIds
    }
  }
  const scalarFields = [
    'activeTabIdByWorktree',
    'lastVisitedAtByWorktreeId',
    'defaultTerminalTabsAppliedByWorktreeId'
  ] as const
  for (const field of scalarFields) {
    ;(patch as Record<string, unknown>)[field] = adoptWorktreeKeyed(
      ownerSession[field] as Record<string, unknown> | undefined,
      adoptedSession[field] as Record<string, unknown> | undefined,
      adoptedWorktreeIds
    )
  }
  return { patch, landedTabIdsByWorktreeId }
}

/**
 * Build the partition patch that completes an adoption as a move. Leaving the
 * adopted tabs behind would re-adopt them on every read once the base's own
 * copy empties again — resurrecting tabs the user deliberately closed.
 * `partition` must be a fresh read of the source. Returns null when nothing was
 * adopted. An adopted worktree sheds the tabs the owner took plus the ones a
 * tombstone retired; every other tab stays, including one a concurrent write
 * added to that worktree after the adoption read.
 */
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
