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

function newestHostEvidenceAt(
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
 * Line the unified surface up with a row the host won: a unified-format session renders only the
 * terminals listed there, so a tab without an entry loses its PTY lease (#23390), and a discarded
 * base tab's entry would keep showing a closed tab when the host supplied no unified row of its own.
 */
export function reconcileHostWonUnifiedRows(
  next: WorkspaceSessionState,
  base: WorkspaceSessionState,
  rowsByKey: ReadonlyMap<string, HostWonTabRow>
): void {
  if (rowsByKey.size === 0 || !next.unifiedTabs) {
    return
  }
  const unifiedTabs = { ...next.unifiedTabs }
  const tabGroups = next.tabGroups ? { ...next.tabGroups } : undefined
  for (const [key, { tabs, carried, discardedTabIds }] of rowsByKey) {
    const row = (unifiedTabs[key] ?? []).filter(
      (entry) => entry.contentType !== 'terminal' || !discardedTabIds.has(entry.entityId)
    )
    const present = new Set(row.map((entry) => entry.entityId))
    const groups = tabGroups?.[key]
    const groupId = next.activeGroupIdByWorktree?.[key] ?? groups?.[0]?.id ?? `carried:${key}`
    const carriedIds = new Set(carried.map((terminal) => terminal.id))
    const additions: Tab[] = []
    for (const terminal of tabs) {
      if (present.has(terminal.id)) {
        continue
      }
      const own = carriedIds.has(terminal.id)
        ? base.unifiedTabs?.[key]?.find(
            (entry) => entry.contentType === 'terminal' && entry.entityId === terminal.id
          )
        : undefined
      additions.push(own ? { ...own, groupId } : unifiedEntryFor(terminal, groupId))
    }
    if (additions.length > 0 || row.length !== (unifiedTabs[key]?.length ?? 0)) {
      unifiedTabs[key] = [...row, ...additions]
    }
    if (tabGroups && groups) {
      const addedIds = additions.map((entry) => entry.id)
      tabGroups[key] = groups.map((group) => {
        const tabOrder = group.tabOrder.filter((tabId) => !discardedTabIds.has(tabId))
        return group.id === groupId
          ? { ...group, tabOrder: [...tabOrder, ...addedIds] }
          : { ...group, tabOrder }
      })
    }
  }
  next.unifiedTabs = unifiedTabs
  if (tabGroups) {
    next.tabGroups = tabGroups
  }
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
