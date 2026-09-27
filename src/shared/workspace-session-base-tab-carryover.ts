import type { Tab } from './tab-types'
import type { TerminalTab } from './terminal-tab-types'
import type { WorkspaceSessionState } from './workspace-session-state-types'
import { normalizeWorkspaceSessionKeyToWorkspaceId } from './workspace-scope'

/**
 * Base tabs kept when the host's populated row replaces the base's (#22503, #23390).
 *
 * Kept: not listed or tombstoned by the host, and either still names a PTY or was created after
 * the host's newest evidence for this workspace. Why the time bound: a tab parked on an unresolved
 * host has no PTY yet and leaves no persisted marker; legacy residue is older than the host's rows.
 */
function baseTabsTheHostNeverListed(
  baseTabs: readonly TerminalTab[] | undefined,
  hostTabs: readonly TerminalTab[],
  base: WorkspaceSessionState,
  host: WorkspaceSessionState,
  workspaceKey: string
): TerminalTab[] {
  if (!baseTabs || baseTabs.length === 0) {
    return []
  }
  const listed = new Set(hostTabs.map((tab) => tab.id))
  const closed = (tabId: string): boolean =>
    Object.hasOwn(host.closedTerminalTabTombstonesByTabId ?? {}, tabId) ||
    Object.hasOwn(base.closedTerminalTabTombstonesByTabId ?? {}, tabId)
  const hostSeenUntil = newestHostEvidenceAt(hostTabs, host, workspaceKey)
  return baseTabs.filter(
    (tab) =>
      !listed.has(tab.id) && !closed(tab.id) && (!!tab.ptyId || tab.createdAt > hostSeenUntil)
  )
}

export function newestHostEvidenceAt(
  hostTabs: readonly TerminalTab[],
  host: WorkspaceSessionState,
  workspaceKey: string
): number {
  const workspaceId = normalizeWorkspaceSessionKeyToWorkspaceId(workspaceKey)
  let newest = 0
  for (const tab of hostTabs) {
    newest = Math.max(newest, tab.createdAt)
  }
  for (const tombstone of Object.values(host.closedTerminalTabTombstonesByTabId ?? {})) {
    if (normalizeWorkspaceSessionKeyToWorkspaceId(tombstone.worktreeId) === workspaceId) {
      newest = Math.max(newest, tombstone.closedAt)
    }
  }
  return newest
}

export type HostWonTabRow = {
  tabs: TerminalTab[]
  carried: readonly TerminalTab[]
  /** Base tab ids the host row replaced and did not carry. */
  discardedTabIds: ReadonlySet<string>
}

/** The row a populated host tab row leaves behind once it replaces the base's. */
export function hostWonTabRow(
  baseTabs: readonly TerminalTab[] | undefined,
  hostTabs: TerminalTab[],
  base: WorkspaceSessionState,
  host: WorkspaceSessionState,
  workspaceKey: string
): HostWonTabRow {
  const carried = baseTabsTheHostNeverListed(baseTabs, hostTabs, base, host, workspaceKey)
  const tabs = carried.length > 0 ? [...hostTabs, ...carried] : hostTabs
  const kept = new Set(tabs.map((terminal) => terminal.id))
  const discardedTabIds = new Set(
    (baseTabs ?? []).map((terminal) => terminal.id).filter((id) => !kept.has(id))
  )
  return { tabs, carried, discardedTabIds }
}

/**
 * A base editor file or browser workspace carried into a row the host won. `build` is the entry to
 * add when the base had none of its own; without one the hydration of that kind supplies it.
 */
export type CarriedSurface = {
  contentType: 'editor' | 'browser'
  entityId: string
  build?: (placement: { groupId: string; sortOrder: number }) => Tab
}

/**
 * Line the unified surface up with rows the host won: a unified-format session renders only what is
 * listed there, so a terminal without an entry loses its PTY lease (#23390) and a carried editor
 * draft would restore with no tab to show it; a discarded base tab's entry would keep showing a
 * closed tab when the host supplied no unified row of its own.
 */
export function reconcileHostWonUnifiedRows(
  next: WorkspaceSessionState,
  base: WorkspaceSessionState,
  rowsByKey: ReadonlyMap<string, HostWonTabRow>,
  carriedSurfacesByKey: ReadonlyMap<string, readonly CarriedSurface[]> = new Map()
): void {
  if ((rowsByKey.size === 0 && carriedSurfacesByKey.size === 0) || !next.unifiedTabs) {
    return
  }
  const unifiedTabs = { ...next.unifiedTabs }
  const tabGroups = next.tabGroups ? { ...next.tabGroups } : undefined
  let activeGroupIdByWorktree = next.activeGroupIdByWorktree
  for (const key of new Set([...rowsByKey.keys(), ...carriedSurfacesByKey.keys()])) {
    const hostWon = rowsByKey.get(key)
    const discardedTabIds = hostWon?.discardedTabIds ?? new Set<string>()
    const row = (unifiedTabs[key] ?? []).filter(
      (entry) => entry.contentType !== 'terminal' || !discardedTabIds.has(entry.entityId)
    )
    const groups = tabGroups?.[key] ?? []
    const activeGroupId = next.activeGroupIdByWorktree?.[key]
    // Why only a group that exists: a stale active-group pointer would file the additions under a
    // group no tab strip renders.
    const groupId =
      groups.find((group) => group.id === activeGroupId)?.id ?? groups[0]?.id ?? `carried:${key}`
    const additions = [
      ...terminalAdditions(hostWon, row, base.unifiedTabs?.[key], groupId),
      ...surfaceAdditions(carriedSurfacesByKey.get(key), row, base.unifiedTabs?.[key], groupId)
    ]
    if (additions.length > 0 || row.length !== (unifiedTabs[key]?.length ?? 0)) {
      unifiedTabs[key] = [...row, ...additions]
    }
    if (!tabGroups) {
      // A session without tab groups hydrates in the legacy format, which ignores `unifiedTabs`;
      // inventing groups here would switch every workspace in it to the unified format.
      continue
    }
    const addedIds = additions.map((entry) => entry.id)
    if (groups.length === 0) {
      if (addedIds.length > 0) {
        tabGroups[key] = [
          {
            id: groupId,
            worktreeId: key,
            activeTabId: addedIds[0],
            tabOrder: addedIds,
            recentTabIds: [addedIds[0]]
          }
        ]
        activeGroupIdByWorktree = { ...activeGroupIdByWorktree, [key]: groupId }
      }
      continue
    }
    tabGroups[key] = groups.map((group) => {
      const tabOrder = group.tabOrder.filter((tabId) => !discardedTabIds.has(tabId))
      return group.id === groupId
        ? { ...group, tabOrder: [...tabOrder, ...addedIds] }
        : { ...group, tabOrder }
    })
  }
  next.unifiedTabs = unifiedTabs
  if (tabGroups) {
    next.tabGroups = tabGroups
  }
  if (activeGroupIdByWorktree !== next.activeGroupIdByWorktree) {
    next.activeGroupIdByWorktree = activeGroupIdByWorktree
  }
}

function terminalAdditions(
  hostWon: HostWonTabRow | undefined,
  row: readonly Tab[],
  baseRow: readonly Tab[] | undefined,
  groupId: string
): Tab[] {
  if (!hostWon) {
    return []
  }
  const present = new Set(
    row.filter((entry) => entry.contentType === 'terminal').map((entry) => entry.entityId)
  )
  const carriedIds = new Set(hostWon.carried.map((terminal) => terminal.id))
  const additions: Tab[] = []
  for (const terminal of hostWon.tabs) {
    if (present.has(terminal.id)) {
      continue
    }
    const own = carriedIds.has(terminal.id)
      ? baseRow?.find((entry) => entry.contentType === 'terminal' && entry.entityId === terminal.id)
      : undefined
    additions.push(own ? { ...own, groupId } : unifiedEntryFor(terminal, groupId))
  }
  return additions
}

function surfaceAdditions(
  surfaces: readonly CarriedSurface[] | undefined,
  row: readonly Tab[],
  baseRow: readonly Tab[] | undefined,
  groupId: string
): Tab[] {
  const additions: Tab[] = []
  // Why after every existing entry: unified hydration orders a row by `sortOrder`.
  let sortOrder = Math.max(-1, ...row.map((entry) => entry.sortOrder))
  for (const surface of surfaces ?? []) {
    const names = (entry: Tab): boolean =>
      entry.contentType === surface.contentType && entry.entityId === surface.entityId
    if (row.some(names)) {
      continue
    }
    const own = baseRow?.find(names)
    const entry = own ? { ...own, groupId } : surface.build?.({ groupId, sortOrder: ++sortOrder })
    if (entry) {
      additions.push(entry)
    }
  }
  return additions
}

function unifiedEntryFor(terminal: TerminalTab, groupId: string): Tab {
  return {
    id: terminal.id,
    entityId: terminal.id,
    groupId,
    worktreeId: terminal.worktreeId,
    contentType: 'terminal',
    label: terminal.title,
    customLabel: terminal.customTitle,
    color: terminal.color,
    sortOrder: terminal.sortOrder,
    createdAt: terminal.createdAt
  }
}
