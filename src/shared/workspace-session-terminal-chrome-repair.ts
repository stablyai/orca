import type { Tab, TabGroup } from './tab-types'
import type { TerminalTab } from './terminal-tab-types'
import type { WorkspaceSessionState } from './workspace-session-state-types'
import { parsePtySessionId } from './pty-session-id-format'
import { worktreeIdComparisonKey, worktreeIdsEqual } from './worktree/id'

/**
 * Why this exists: a terminal tab that moved between worktrees keeps a session id
 * whose prefix names its spawn worktree, so stale writers can re-mint a second
 * copy of its row there, and stale saves can drop the tab chrome (unifiedTabs /
 * tabGroups) while the PTY-bound row survives. Both leave a live agent with
 * either two rows or nothing to click.
 */

type TabRowOwner = {
  worktreeId: string
  row: TerminalTab
}

function unifiedEntryForTab(entries: readonly Tab[] | undefined, tabId: string): Tab | undefined {
  return entries?.find((entry) => entry.id === tabId || entry.entityId === tabId)
}

function stripUnifiedEntry(entries: readonly Tab[], tabId: string): Tab[] {
  return entries.filter((entry) => entry.id !== tabId && entry.entityId !== tabId)
}

function stripGroupMembership(groups: readonly TabGroup[], tabId: string): TabGroup[] {
  return groups.map((group) => {
    const tabOrder = group.tabOrder.filter((id) => id !== tabId)
    const recentTabIds = group.recentTabIds?.filter((id) => id !== tabId)
    return {
      ...group,
      tabOrder,
      ...(recentTabIds ? { recentTabIds } : {}),
      activeTabId:
        group.activeTabId === tabId
          ? (group.recentTabIds?.findLast((id) => id !== tabId && tabOrder.includes(id)) ??
            tabOrder[0] ??
            null)
          : group.activeTabId
    }
  })
}

function restoreGroupMembership(
  groups: readonly TabGroup[],
  entry: Tab,
  previousGroups: readonly TabGroup[] | undefined
): TabGroup[] {
  const alreadyMember = groups.some(
    (group) => group.id === entry.groupId && group.tabOrder.includes(entry.id)
  )
  if (alreadyMember) {
    return [...groups]
  }
  const target = groups.find((group) => group.id === entry.groupId)
  if (target) {
    const previousGroup = previousGroups?.find((group) => group.id === entry.groupId)
    const previousIndex = previousGroup?.tabOrder.indexOf(entry.id) ?? -1
    const tabOrder =
      previousIndex >= 0
        ? [
            ...target.tabOrder.slice(0, previousIndex),
            entry.id,
            ...target.tabOrder.slice(previousIndex)
          ]
        : [...target.tabOrder, entry.id]
    return groups.map((group) =>
      group.id === entry.groupId
        ? { ...group, tabOrder, recentTabIds: group.recentTabIds ?? [] }
        : group
    )
  }
  // Why: the previous save's group is the only evidence of how this tab was
  // presented; restoring it with the tab is repair, not invention.
  const previousGroup = previousGroups?.find((group) => group.id === entry.groupId)
  return [
    ...groups,
    previousGroup ?? {
      id: entry.groupId,
      worktreeId: entry.worktreeId,
      activeTabId: entry.id,
      tabOrder: [entry.id],
      recentTabIds: [entry.id]
    }
  ]
}

/**
 * Restore tab chrome a save dropped while the row stayed PTY-bound. The previous
 * save is the only source: never invent chrome a row never had, and a row the
 * save closed stays closed.
 */
export function restoreDroppedTerminalTabChrome(
  session: WorkspaceSessionState,
  previous: WorkspaceSessionState
): WorkspaceSessionState {
  let changed = false
  const unifiedTabs = { ...session.unifiedTabs }
  const tabGroups = { ...session.tabGroups }
  for (const [worktreeId, rows] of Object.entries(session.tabsByWorktree ?? {})) {
    for (const row of rows) {
      if (!row.ptyId) {
        continue
      }
      if (unifiedEntryForTab(unifiedTabs[worktreeId], row.id)) {
        continue
      }
      const previousEntry = unifiedEntryForTab(previous.unifiedTabs?.[worktreeId], row.id)
      if (!previousEntry) {
        continue
      }
      changed = true
      unifiedTabs[worktreeId] = [...(unifiedTabs[worktreeId] ?? []), previousEntry]
      tabGroups[worktreeId] = restoreGroupMembership(
        tabGroups[worktreeId] ?? [],
        previousEntry,
        previous.tabGroups?.[worktreeId]
      )
    }
  }
  if (!changed) {
    return session
  }
  return { ...session, unifiedTabs, tabGroups }
}

/**
 * Keep one owner per tab id across worktrees: the visible surface first, then the
 * previous save's owner, then the copy that lives outside its spawn worktree.
 * Ghost copies lose their rows and their chrome together.
 */
export function dedupeGhostTerminalTabRows(
  session: WorkspaceSessionState,
  previous: WorkspaceSessionState | undefined
): WorkspaceSessionState {
  const copiesByTabId = new Map<string, TabRowOwner[]>()
  for (const [worktreeId, rows] of Object.entries(session.tabsByWorktree ?? {})) {
    for (const row of rows) {
      const copies = copiesByTabId.get(row.id) ?? []
      copies.push({ worktreeId, row })
      copiesByTabId.set(row.id, copies)
    }
  }
  const dropped = new Map<string, Set<string>>()
  for (const [tabId, copies] of copiesByTabId) {
    const worktreeKeys = new Set(
      copies.map((copy) => worktreeIdComparisonKey(copy.worktreeId) ?? copy.worktreeId)
    )
    if (worktreeKeys.size < 2) {
      continue
    }
    const ownerWorktreeId = pickTabRowOwnerWorktree(tabId, copies, session, previous)
    for (const copy of copies) {
      if (worktreeIdsEqual(copy.worktreeId, ownerWorktreeId)) {
        continue
      }
      const droppedIds = dropped.get(copy.worktreeId) ?? new Set<string>()
      droppedIds.add(tabId)
      dropped.set(copy.worktreeId, droppedIds)
    }
  }
  if (dropped.size === 0) {
    return session
  }
  const tabsByWorktree = { ...session.tabsByWorktree }
  const unifiedTabs = { ...session.unifiedTabs }
  const tabGroups = { ...session.tabGroups }
  for (const [worktreeId, tabIds] of dropped) {
    tabsByWorktree[worktreeId] = (tabsByWorktree[worktreeId] ?? []).filter(
      (row) => !tabIds.has(row.id)
    )
    if (unifiedTabs[worktreeId]) {
      let entries = unifiedTabs[worktreeId]
      for (const tabId of tabIds) {
        entries = stripUnifiedEntry(entries, tabId)
      }
      unifiedTabs[worktreeId] = entries
    }
    if (tabGroups[worktreeId]) {
      let groups = tabGroups[worktreeId]
      for (const tabId of tabIds) {
        groups = stripGroupMembership(groups, tabId)
      }
      tabGroups[worktreeId] = groups
    }
  }
  return { ...session, tabsByWorktree, unifiedTabs, tabGroups }
}

/**
 * The one worktree allowed to own `tabId`'s row right now (null when no row
 * exists yet). Persisted writers must bind to it instead of a session-id prefix
 * worktree — a moved tab's session id still names its spawn worktree.
 */
export function findTabRowOwnerWorktree(
  session: WorkspaceSessionState,
  tabId: string,
  previous?: WorkspaceSessionState
): string | null {
  const copies: TabRowOwner[] = []
  for (const [worktreeId, rows] of Object.entries(session.tabsByWorktree ?? {})) {
    for (const row of rows) {
      if (row.id === tabId) {
        copies.push({ worktreeId, row })
      }
    }
  }
  if (copies.length === 0) {
    return null
  }
  return pickTabRowOwnerWorktree(tabId, copies, session, previous)
}

function pickTabRowOwnerWorktree(
  tabId: string,
  copies: readonly TabRowOwner[],
  session: WorkspaceSessionState,
  previous: WorkspaceSessionState | undefined
): string {
  for (const copy of copies) {
    if (session.activeTabIdByWorktree?.[copy.worktreeId] === tabId) {
      return copy.worktreeId
    }
    if (
      session.activeWorktreeId &&
      worktreeIdsEqual(session.activeWorktreeId, copy.worktreeId) &&
      session.activeTabId === tabId
    ) {
      return copy.worktreeId
    }
  }
  if (previous?.tabsByWorktree) {
    for (const copy of copies) {
      const priorRows = previous.tabsByWorktree[copy.worktreeId]
      if (priorRows?.some((row) => row.id === tabId)) {
        return copy.worktreeId
      }
    }
  }
  for (const copy of copies) {
    const spawnWorktreeId = copy.row.ptyId ? parsePtySessionId(copy.row.ptyId).worktreeId : null
    if (!spawnWorktreeId || !worktreeIdsEqual(spawnWorktreeId, copy.worktreeId)) {
      return copy.worktreeId
    }
  }
  return copies[0].worktreeId
}

/**
 * Load-time repair for files already damaged: a PTY-bound row without any tab
 * chrome gets minimal chrome back so the running agent stays clickable. Rows the
 * file does not contain are never resurrected.
 */
export function mintMissingTerminalTabChrome(session: WorkspaceSessionState): WorkspaceSessionState {
  let changed = false
  const unifiedTabs = { ...session.unifiedTabs }
  const tabGroups = { ...session.tabGroups }
  for (const [worktreeId, rows] of Object.entries(session.tabsByWorktree ?? {})) {
    for (const row of rows) {
      if (!row.ptyId) {
        continue
      }
      if (unifiedEntryForTab(unifiedTabs[worktreeId], row.id)) {
        continue
      }
      changed = true
      const groups = tabGroups[worktreeId] ?? []
      const target = groups[0] ?? {
        id: `group-${worktreeId}`,
        worktreeId,
        activeTabId: row.id,
        tabOrder: [],
        recentTabIds: []
      }
      const entry: Tab = {
        id: row.id,
        entityId: row.id,
        groupId: target.id,
        worktreeId,
        contentType: 'terminal',
        label: row.title,
        customLabel: row.customTitle,
        color: row.color,
        sortOrder: row.sortOrder,
        createdAt: row.createdAt
      }
      unifiedTabs[worktreeId] = [...(unifiedTabs[worktreeId] ?? []), entry]
      tabGroups[worktreeId] = groups.some((group) => group.id === target.id)
        ? groups.map((group) =>
            group.id === target.id
              ? {
                  ...group,
                  tabOrder: [...group.tabOrder, entry.id],
                  recentTabIds: [...(group.recentTabIds ?? []), entry.id]
                }
              : group
          )
        : [{ ...target, tabOrder: [entry.id], recentTabIds: [entry.id] }]
    }
  }
  if (!changed) {
    return session
  }
  return { ...session, unifiedTabs, tabGroups }
}
