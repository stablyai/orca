import type { StoreApi } from 'zustand'
import { shallow } from 'zustand/shallow'
import type { Tab, TabGroup } from '../../../../shared/tab-types'
import type { AppState } from '../types'
import type { OpenFile } from './editor'
import { sanitizeRecentTabIds, selectHydratedActiveGroupId } from './tab-group-state'
import { pruneTabGroupLayoutForGroups } from './tabs-hydration'

type RecoveryStore = Pick<StoreApi<AppState>, 'setState'>
type Row = { id: string }
type Rows<T extends Row> = Record<string, T[]>
type GroupLayout = Pick<AppState, 'layoutByWorktree' | 'activeGroupIdByWorktree'>

function addedRows<T extends Row>(
  before: readonly T[] | undefined,
  staged: readonly T[] | undefined
): T[] {
  const existing = new Set((before ?? []).map((row) => row.id))
  return (staged ?? []).filter((row) => !existing.has(row.id))
}

function isStillStaged<T extends Row>(current: readonly T[] | undefined, staged: T): boolean {
  return current?.find((row) => row.id === staged.id) === staged
}

function withoutDiskBaseline({ lastKnownDiskSignature: _baseline, ...file }: OpenFile) {
  return file
}

// Why: loading a clean tab stamps its disk baseline, which is bookkeeping rather than a user edit.
function isFileStillStaged(current: readonly OpenFile[], staged: OpenFile): boolean {
  const file = current.find((row) => row.id === staged.id)
  return file !== undefined && shallow(withoutDiskBaseline(file), withoutDiskBaseline(staged))
}

// Why: an entry changed since staging holds a newer edit, so only still-staged values revert.
function revertEntries<T>(
  current: Record<string, T>,
  before: Record<string, T>,
  staged: Record<string, T>,
  keys: Iterable<string>
): Record<string, T> {
  let next = current
  for (const key of keys) {
    if (current[key] !== staged[key] || before[key] === staged[key]) {
      continue
    }
    next = next === current ? { ...current } : next
    if (before[key] === undefined) {
      delete next[key]
    } else {
      next[key] = before[key]
    }
  }
  return next
}

function revertValue<T>(current: T, before: T, staged: T): T {
  return current === staged ? before : current
}

function revertRows<T extends Row>(
  current: Rows<T>,
  before: Rows<T>,
  staged: Rows<T>,
  worktreeId: string,
  dropped: ReadonlySet<string>
): Rows<T> {
  const rows = current[worktreeId] ?? []
  const kept = rows.filter((row) => !dropped.has(row.id))
  const stagedIds = new Set((staged[worktreeId] ?? []).map((row) => row.id))
  const replaced = (before[worktreeId] ?? []).filter(
    (row) => !stagedIds.has(row.id) && !kept.some((candidate) => candidate.id === row.id)
  )
  if (kept.length === rows.length && replaced.length === 0) {
    return current
  }
  const next = { ...current, [worktreeId]: [...replaced, ...kept] }
  if (next[worktreeId].length === 0 && before[worktreeId] === undefined) {
    delete next[worktreeId]
  }
  return next
}

function withoutTabs(groups: readonly TabGroup[], dropped: ReadonlySet<string>): TabGroup[] {
  return groups.map((group) => {
    if (!group.tabOrder.some((id) => dropped.has(id))) {
      return group
    }
    const tabOrder = group.tabOrder.filter((id) => !dropped.has(id))
    const recentTabIds = sanitizeRecentTabIds(group.recentTabIds, tabOrder)
    const activeTabId =
      group.activeTabId && dropped.has(group.activeTabId)
        ? (recentTabIds.at(-1) ?? tabOrder[0] ?? null)
        : group.activeTabId
    return { ...group, tabOrder, recentTabIds, activeTabId }
  })
}

function withEntry<T>(record: Record<string, T>, key: string, value: T | undefined) {
  if (record[key] === value) {
    return record
  }
  const next = { ...record }
  if (value === undefined) {
    delete next[key]
  } else {
    next[key] = value
  }
  return next
}

// Why: the split view renders every layout leaf, so a removed group's leaf would stay an empty pane.
function withLayoutOfGroups(
  { layoutByWorktree, activeGroupIdByWorktree }: GroupLayout,
  worktreeId: string,
  groups: TabGroup[]
): GroupLayout {
  const groupIds = new Set(groups.map((group) => group.id))
  const layout = layoutByWorktree[worktreeId]
  const activeGroupId = activeGroupIdByWorktree[worktreeId]
  return {
    layoutByWorktree: withEntry(
      layoutByWorktree,
      worktreeId,
      (layout && pruneTabGroupLayoutForGroups(layout, groupIds)) ?? undefined
    ),
    activeGroupIdByWorktree: withEntry(
      activeGroupIdByWorktree,
      worktreeId,
      activeGroupId && groupIds.has(activeGroupId)
        ? activeGroupId
        : selectHydratedActiveGroupId(groups)
    )
  }
}

function droppedImportRows(before: AppState, staged: AppState, current: AppState, id: string) {
  const ownedTabs = addedRows(before.unifiedTabsByWorktree[id], staged.unifiedTabsByWorktree[id])
  const stagedTabs = new Set(ownedTabs)
  // Why: a tab opened or edited since staging keeps the terminal, file or browser it shows.
  const adopted = new Set(
    (current.unifiedTabsByWorktree[id] ?? []).flatMap((tab) =>
      stagedTabs.has(tab) ? [] : [tab.entityId]
    )
  )
  const untouchedIds = <T extends Row>(rows: T[], untouched: (row: T) => boolean): Set<string> =>
    new Set(rows.flatMap((row) => (!adopted.has(row.id) && untouched(row) ? [row.id] : [])))
  const terminals = untouchedIds(
    addedRows(before.tabsByWorktree[id], staged.tabsByWorktree[id]),
    (tab) =>
      isStillStaged(current.tabsByWorktree[id], tab) &&
      current.terminalLayoutsByTabId[tab.id] === staged.terminalLayoutsByTabId[tab.id]
  )
  const files = untouchedIds(
    addedRows(before.openFiles, staged.openFiles).filter((file) => file.worktreeId === id),
    (file) =>
      isFileStillStaged(current.openFiles, file) &&
      current.editorDrafts[file.id] === staged.editorDrafts[file.id]
  )
  const browsers = untouchedIds(
    addedRows(before.browserTabsByWorktree[id], staged.browserTabsByWorktree[id]),
    (browser) =>
      isStillStaged(current.browserTabsByWorktree[id], browser) &&
      current.browserPagesByWorkspace[browser.id] === staged.browserPagesByWorkspace[browser.id]
  )
  const entityDropped = (tab: Tab): boolean => {
    switch (tab.contentType) {
      case 'terminal':
        return terminals.has(tab.entityId)
      case 'browser':
        return browsers.has(tab.entityId)
      case 'agent-session':
      case 'simulator':
        return true
      case 'editor':
      case 'diff':
      case 'conflict-review':
      case 'check-details':
        return files.has(tab.entityId)
    }
  }
  const tabs = new Set(
    ownedTabs.flatMap((tab) =>
      isStillStaged(current.unifiedTabsByWorktree[id], tab) && entityDropped(tab) ? [tab.id] : []
    )
  )
  return { terminals, files, browsers, tabs }
}

/**
 * Removes what a failed initial import staged in one worktree. Rows the user changed since staging
 * (edited, dirtied, drafted, split) stay, together with the tab and group that show them.
 */
export function rollbackImportedWorkspace(
  store: RecoveryStore,
  worktreeId: string,
  before: AppState,
  staged: AppState
): void {
  store.setState((current) => {
    const id = worktreeId
    const entries = <T>(pick: (s: AppState) => Record<string, T>, keys: Iterable<string>) =>
      revertEntries(pick(current), pick(before), pick(staged), keys)
    const rows = <T extends Row>(pick: (s: AppState) => Rows<T>, dropped: ReadonlySet<string>) =>
      revertRows(pick(current), pick(before), pick(staged), id, dropped)
    const value = <T>(pick: (s: AppState) => T): T =>
      revertValue(pick(current), pick(before), pick(staged))
    const dropped = droppedImportRows(before, staged, current, id)
    const ownedGroupIds = new Set(
      addedRows(before.groupsByWorktree[id], staged.groupsByWorktree[id]).map((group) => group.id)
    )
    const strippedGroups = withoutTabs(current.groupsByWorktree[id] ?? [], dropped.tabs)
    const emptiedGroupIds = new Set(
      strippedGroups.flatMap((group) =>
        ownedGroupIds.has(group.id) && group.tabOrder.length === 0 ? [group.id] : []
      )
    )
    const keptGroups = strippedGroups.filter((group) => !emptiedGroupIds.has(group.id))
    // Why: while a user-adopted import group survives, the layout and active group stay on it.
    const importGroupsGone = !keptGroups.some((group) => ownedGroupIds.has(group.id))
    const worktreeKeys = [id]
    const tabKeys = [...dropped.terminals]
    const groupsByWorktree = importGroupsGone
      ? revertRows(
          { ...current.groupsByWorktree, [id]: strippedGroups },
          before.groupsByWorktree,
          staged.groupsByWorktree,
          id,
          emptiedGroupIds
        )
      : { ...current.groupsByWorktree, [id]: keptGroups }
    const groupLayout: GroupLayout = importGroupsGone
      ? {
          layoutByWorktree: entries((s) => s.layoutByWorktree, worktreeKeys),
          activeGroupIdByWorktree: entries((s) => s.activeGroupIdByWorktree, worktreeKeys)
        }
      : {
          layoutByWorktree: current.layoutByWorktree,
          activeGroupIdByWorktree: current.activeGroupIdByWorktree
        }
    return {
      tabsByWorktree: rows((s) => s.tabsByWorktree, dropped.terminals),
      unifiedTabsByWorktree: rows((s) => s.unifiedTabsByWorktree, dropped.tabs),
      groupsByWorktree,
      ...(emptiedGroupIds.size > 0
        ? withLayoutOfGroups(groupLayout, id, groupsByWorktree[id] ?? [])
        : groupLayout),
      openFiles:
        dropped.files.size > 0
          ? current.openFiles.filter((file) => !dropped.files.has(file.id))
          : current.openFiles,
      browserTabsByWorktree: rows((s) => s.browserTabsByWorktree, dropped.browsers),
      browserPagesByWorkspace: entries((s) => s.browserPagesByWorkspace, dropped.browsers),
      terminalLayoutsByTabId: entries((s) => s.terminalLayoutsByTabId, tabKeys),
      ptyIdsByTabId: entries((s) => s.ptyIdsByTabId, tabKeys),
      localOnlyScrollbackByTabId: entries((s) => s.localOnlyScrollbackByTabId, tabKeys),
      pendingReconnectPtyIdByTabId: entries((s) => s.pendingReconnectPtyIdByTabId, tabKeys),
      automaticAgentResumeClaimsByTabId: entries(
        (s) => s.automaticAgentResumeClaimsByTabId,
        tabKeys
      ),
      activeTabIdByWorktree: entries((s) => s.activeTabIdByWorktree, worktreeKeys),
      activeFileIdByWorktree: entries((s) => s.activeFileIdByWorktree, worktreeKeys),
      activeBrowserTabIdByWorktree: entries((s) => s.activeBrowserTabIdByWorktree, worktreeKeys),
      activeTabTypeByWorktree: entries((s) => s.activeTabTypeByWorktree, worktreeKeys),
      pendingReconnectTabByWorktree: entries((s) => s.pendingReconnectTabByWorktree, worktreeKeys),
      lastVisitedAtByWorktreeId: entries((s) => s.lastVisitedAtByWorktreeId, worktreeKeys),
      defaultTerminalTabsAppliedByWorktreeId: entries(
        (s) => s.defaultTerminalTabsAppliedByWorktreeId,
        worktreeKeys
      ),
      recoveryImportKeyByWorktreeId: entries((s) => s.recoveryImportKeyByWorktreeId, worktreeKeys),
      activeRepoId: value((s) => s.activeRepoId),
      activeWorktreeId: value((s) => s.activeWorktreeId),
      activeWorkspaceKey: value((s) => s.activeWorkspaceKey),
      activeWorkspaceExecutionHostId: value((s) => s.activeWorkspaceExecutionHostId),
      activeTabId: value((s) => s.activeTabId)
    }
  })
}
