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
    return { session: base, adoptedTabIdsByWorktreeId: {} }
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
    return { session: base, adoptedTabIdsByWorktreeId: {} }
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
  return { session, adoptedTabIdsByWorktreeId }
}

/**
 * Build the owner-partition patch that lands every adopted field durably.
 * `ownerSession` must be a fresh read of the owning partition — the patch
 * replaces whole fields, so building it from a stale snapshot would clobber
 * writes that landed in between. Returns null when nothing was adopted.
 */
export function buildAdoptedWorkspaceSessionOwnerPatch(
  ownerSession: WorkspaceSessionState,
  adoptedSession: WorkspaceSessionState,
  adoptedTabIdsByWorktreeId: Record<string, string[]>
): WorkspaceSessionPatch | null {
  const adoptedWorktreeIds = Object.keys(adoptedTabIdsByWorktreeId)
  if (adoptedWorktreeIds.length === 0) {
    return null
  }
  const adoptedTabIds = new Set(Object.values(adoptedTabIdsByWorktreeId).flat())
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
  return patch
}

/**
 * Build the partition patch that completes an adoption as a move. Leaving the
 * adopted entries behind would re-adopt them on every read once the base's own
 * copy empties again — resurrecting tabs the user deliberately closed.
 * Returns null when nothing was adopted. Only the adopted worktree entries and
 * the adopted tabs' records are dropped; everything else stays untouched.
 */
export function pruneAdoptedWorkspaceSessionPartitionEntries(
  partition: WorkspaceSessionState,
  adoptedTabIdsByWorktreeId: Record<string, string[]>
): WorkspaceSessionPatch | null {
  const adoptedWorktreeIds = new Set(Object.keys(adoptedTabIdsByWorktreeId))
  if (adoptedWorktreeIds.size === 0) {
    return null
  }
  const adoptedTabIds = new Set(Object.values(adoptedTabIdsByWorktreeId).flat())
  const patch: WorkspaceSessionPatch = {
    tabsByWorktree: Object.fromEntries(
      Object.entries(partition.tabsByWorktree ?? {}).filter(
        ([worktreeId]) => !adoptedWorktreeIds.has(worktreeId)
      )
    ),
    terminalLayoutsByTabId: Object.fromEntries(
      Object.entries(partition.terminalLayoutsByTabId ?? {}).filter(
        ([tabId]) => !adoptedTabIds.has(tabId)
      )
    )
  }
  if (partition.remoteSessionIdsByTabId) {
    patch.remoteSessionIdsByTabId = Object.fromEntries(
      Object.entries(partition.remoteSessionIdsByTabId).filter(
        ([tabId]) => !adoptedTabIds.has(tabId)
      )
    )
  }
  return patch
}
