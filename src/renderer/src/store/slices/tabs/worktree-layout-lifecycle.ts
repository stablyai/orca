import type { SessionSourceEdit, OrdinarySourcePartial } from '../../session-source-edits'
import type { AppState } from '../../types'
import type { BrowserWorkspace } from '../../../../../shared/browser-workspace-types'
import type { TerminalTab } from '../../../../../shared/terminal-tab-types'
import { omitRecordKeys } from '../worktrees/teardown/record-key-omission'
import { getTerminalActivationSpawnSuppression } from '../terminal-activation-spawn-suppression'
import { collapseGroupLayoutEdit } from './tab-group-layout-edits'
import {
  createKeptWorktreeSurfacePruners,
  type KeptWorktreeSurfaceRemoval
} from './kept-worktree-surface-pruning'

// Pure lifecycle patches let repo/worktree/SSH callers clear layout and other state in one atomic update.

/** Collapse kept splits emptied by purge, giving their space/selection to the surviving twin’s group. */
function collapseEmptiedKeptGroups(
  edit: SessionSourceEdit<AppState>,
  priorGroups: AppState['groupsByWorktree'],
  worktreeIds: ReadonlySet<string>
): void {
  for (const worktreeId of worktreeIds) {
    const before = priorGroups[worktreeId] ?? []
    let groups = edit.entry('groupsByWorktree', worktreeId) ?? []
    const emptied = groups.filter(
      (group) =>
        group.tabOrder.length === 0 &&
        (before.find((prior) => prior.id === group.id)?.tabOrder.length ?? 0) > 0
    )
    for (const group of emptied) {
      if (groups.length <= 1 || !edit.entry('layoutByWorktree', worktreeId)) {
        break
      }
      groups = groups.filter((candidate) => candidate.id !== group.id)
      const activeGroupId = edit.entry('activeGroupIdByWorktree', worktreeId)
      collapseGroupLayoutEdit(edit, worktreeId, group.id, groups[0]?.id ?? null)
      if (activeGroupId !== undefined && activeGroupId !== group.id) {
        edit.set('activeGroupIdByWorktree', worktreeId, activeGroupId)
      }
    }
    if (groups !== (edit.entry('groupsByWorktree', worktreeId) ?? [])) {
      edit.set('groupsByWorktree', worktreeId, groups)
    }
  }
}

/**
 * Drops removed worktrees' tabs, groups and pane layouts, and clears selection that pointed into
 * them. `kept` names surfaces leaving workspaces that stay, whose entries are pruned instead.
 */
export function removeWorktreeLayout(
  edit: SessionSourceEdit<AppState>,
  removed: {
    worktreeIds: ReadonlySet<string>
    tabIds: ReadonlySet<string>
    activeFileCleared: boolean
    kept?: KeptWorktreeSurfaceRemoval
  }
): OrdinarySourcePartial<AppState> {
  const s = edit.view()
  const { worktreeIds, tabIds, activeFileCleared } = removed
  const removedActiveWorktree = s.activeWorktreeId != null && worktreeIds.has(s.activeWorktreeId)
  for (const id of worktreeIds) {
    edit.remove('tabsByWorktree', id)
    edit.remove('unifiedTabsByWorktree', id)
    edit.remove('groupsByWorktree', id)
    edit.remove('layoutByWorktree', id)
    edit.remove('activeGroupIdByWorktree', id)
    edit.remove('browserTabsByWorktree', id)
    edit.remove('activeTabIdByWorktree', id)
    edit.remove('activeFileIdByWorktree', id)
    edit.remove('activeBrowserTabIdByWorktree', id)
    edit.remove('activeTabTypeByWorktree', id)
  }
  for (const id of tabIds) {
    edit.remove('terminalLayoutsByTabId', id)
    edit.remove('ptyIdsByTabId', id)
  }
  let tabBarOrderByWorktree = omitRecordKeys(s.tabBarOrderByWorktree, worktreeIds)
  const kept = removed.kept ? createKeptWorktreeSurfacePruners(s, removed.kept) : null
  if (removed.kept && kept) {
    for (const id of removed.kept.worktreeIds) {
      if (edit.has('tabsByWorktree', id)) {
        const value = kept.tabs(edit.entry('tabsByWorktree', id)!)
        if (value === undefined) {
          edit.remove('tabsByWorktree', id)
        } else {
          edit.set('tabsByWorktree', id, value)
        }
      }
      if (edit.has('unifiedTabsByWorktree', id)) {
        const value = kept.unifiedTabs(edit.entry('unifiedTabsByWorktree', id)!)
        if (value === undefined) {
          edit.remove('unifiedTabsByWorktree', id)
        } else {
          edit.set('unifiedTabsByWorktree', id, value)
        }
      }
      if (edit.has('groupsByWorktree', id)) {
        const value = kept.groups(edit.entry('groupsByWorktree', id)!)
        if (value === undefined) {
          edit.remove('groupsByWorktree', id)
        } else {
          edit.set('groupsByWorktree', id, value)
        }
      }
      if (edit.has('browserTabsByWorktree', id)) {
        const value = kept.browserTabs(edit.entry('browserTabsByWorktree', id)!)
        if (value === undefined) {
          edit.remove('browserTabsByWorktree', id)
        } else {
          edit.set('browserTabsByWorktree', id, value)
        }
      }
      if (edit.has('activeTabIdByWorktree', id)) {
        const prior = edit.entry('activeTabIdByWorktree', id)
        const value = kept.activeTabIds(prior!)
        if (value !== prior) {
          if (value === undefined) {
            edit.remove('activeTabIdByWorktree', id)
          } else {
            edit.set('activeTabIdByWorktree', id, value)
          }
        }
      }
      if (edit.has('activeFileIdByWorktree', id)) {
        const prior = edit.entry('activeFileIdByWorktree', id)
        const value = kept.activeFileIds(prior!)
        if (value !== prior) {
          if (value === undefined) {
            edit.remove('activeFileIdByWorktree', id)
          } else {
            edit.set('activeFileIdByWorktree', id, value)
          }
        }
      }
      if (edit.has('activeBrowserTabIdByWorktree', id)) {
        const prior = edit.entry('activeBrowserTabIdByWorktree', id)
        const value = kept.activeBrowserTabIds(prior!)
        if (value !== prior) {
          if (value === undefined) {
            edit.remove('activeBrowserTabIdByWorktree', id)
          } else {
            edit.set('activeBrowserTabIdByWorktree', id, value)
          }
        }
      }
      const order = tabBarOrderByWorktree[id]
      if (order) {
        const next = kept.tabBarOrder(order)
        if (next !== order) {
          tabBarOrderByWorktree = { ...tabBarOrderByWorktree, [id]: next }
        }
      }
    }
    collapseEmptiedKeptGroups(edit, s.groupsByWorktree, removed.kept.worktreeIds)
  }
  if (
    s.openFiles.some(
      (file) => worktreeIds.has(file.worktreeId) || removed.kept?.fileIds.has(file.id)
    )
  ) {
    edit
      .sequence('openFiles')
      .filter((file) => !worktreeIds.has(file.worktreeId) && !removed.kept?.fileIds.has(file.id))
  }
  return {
    tabBarOrderByWorktree,
    activeTabId: s.activeTabId && tabIds.has(s.activeTabId) ? null : s.activeTabId,
    activeFileId: activeFileCleared ? null : s.activeFileId,
    activeBrowserTabId: removedActiveWorktree ? null : s.activeBrowserTabId,
    activeTabType: removedActiveWorktree || activeFileCleared ? 'terminal' : s.activeTabType
  }
}

function rekeyWorktreeEntry<T>(
  map: Record<string, T> | undefined,
  oldWorktreeId: string,
  newWorktreeId: string,
  mapValue: (value: T) => T = (value) => value
): Record<string, T> | undefined {
  if (!map || !(oldWorktreeId in map)) {
    return undefined
  }
  const next = { ...map }
  next[newWorktreeId] = mapValue(map[oldWorktreeId])
  delete next[oldWorktreeId]
  return next
}

/** Moves a renamed worktree's tabs, groups, pane layouts and selection to its new id. */
export function renameWorktreeLayoutKeys(
  edit: SessionSourceEdit<AppState>,
  oldWorktreeId: string,
  newWorktreeId: string,
  renameBrowserWorkspace: (workspace: BrowserWorkspace) => BrowserWorkspace
): OrdinarySourcePartial<AppState> {
  const s = edit.view()
  const withNewWorktreeId = <T extends { worktreeId: string }>(value: T): T =>
    value.worktreeId === oldWorktreeId ? { ...value, worktreeId: newWorktreeId } : value
  if (edit.has('tabsByWorktree', oldWorktreeId)) {
    const value = edit.entry('tabsByWorktree', oldWorktreeId)!
    edit.set('tabsByWorktree', newWorktreeId, value.map(withNewWorktreeId))
    edit.remove('tabsByWorktree', oldWorktreeId)
  }
  if (edit.has('browserTabsByWorktree', oldWorktreeId)) {
    const value = edit.entry('browserTabsByWorktree', oldWorktreeId)!
    edit.set('browserTabsByWorktree', newWorktreeId, value.map(renameBrowserWorkspace))
    edit.remove('browserTabsByWorktree', oldWorktreeId)
  }
  if (edit.has('activeBrowserTabIdByWorktree', oldWorktreeId)) {
    const value = edit.entry('activeBrowserTabIdByWorktree', oldWorktreeId)!
    edit.set('activeBrowserTabIdByWorktree', newWorktreeId, value)
    edit.remove('activeBrowserTabIdByWorktree', oldWorktreeId)
  }
  if (edit.has('activeFileIdByWorktree', oldWorktreeId)) {
    const value = edit.entry('activeFileIdByWorktree', oldWorktreeId)!
    edit.set('activeFileIdByWorktree', newWorktreeId, value)
    edit.remove('activeFileIdByWorktree', oldWorktreeId)
  }
  if (edit.has('activeTabTypeByWorktree', oldWorktreeId)) {
    const value = edit.entry('activeTabTypeByWorktree', oldWorktreeId)!
    edit.set('activeTabTypeByWorktree', newWorktreeId, value)
    edit.remove('activeTabTypeByWorktree', oldWorktreeId)
  }
  if (edit.has('activeTabIdByWorktree', oldWorktreeId)) {
    const value = edit.entry('activeTabIdByWorktree', oldWorktreeId)!
    edit.set('activeTabIdByWorktree', newWorktreeId, value)
    edit.remove('activeTabIdByWorktree', oldWorktreeId)
  }
  if (edit.has('unifiedTabsByWorktree', oldWorktreeId)) {
    const value = edit.entry('unifiedTabsByWorktree', oldWorktreeId)!
    edit.set('unifiedTabsByWorktree', newWorktreeId, value.map(withNewWorktreeId))
    edit.remove('unifiedTabsByWorktree', oldWorktreeId)
  }
  if (edit.has('groupsByWorktree', oldWorktreeId)) {
    const value = edit.entry('groupsByWorktree', oldWorktreeId)!
    edit.set('groupsByWorktree', newWorktreeId, value.map(withNewWorktreeId))
    edit.remove('groupsByWorktree', oldWorktreeId)
  }
  if (edit.has('layoutByWorktree', oldWorktreeId)) {
    const value = edit.entry('layoutByWorktree', oldWorktreeId)!
    edit.set('layoutByWorktree', newWorktreeId, value)
    edit.remove('layoutByWorktree', oldWorktreeId)
  }
  if (edit.has('activeGroupIdByWorktree', oldWorktreeId)) {
    const value = edit.entry('activeGroupIdByWorktree', oldWorktreeId)!
    edit.set('activeGroupIdByWorktree', newWorktreeId, value)
    edit.remove('activeGroupIdByWorktree', oldWorktreeId)
  }
  if (s.openFiles?.some((file) => file.worktreeId === oldWorktreeId)) {
    edit.sequence('openFiles').map(withNewWorktreeId)
  }
  const order = rekeyWorktreeEntry(s.tabBarOrderByWorktree, oldWorktreeId, newWorktreeId)
  return order === undefined ? {} : { tabBarOrderByWorktree: order }
}

/**
 * Tags a worktree's wakeable terminal tabs for an activation spawn, optionally bumping their
 * generation so dead panes remount.
 */
export function markWorktreeTabsForActivationSpawn(
  edit: SessionSourceEdit<AppState>,
  worktreeId: string,
  options: { isWakeable: (tab: TerminalTab) => boolean; bumpGeneration: boolean }
): void {
  const s = edit.view()
  const { isWakeable, bumpGeneration } = options
  edit.set(
    'tabsByWorktree',
    worktreeId,
    (s.tabsByWorktree[worktreeId] ?? []).map((tab) =>
      !isWakeable(tab)
        ? tab
        : {
            ...tab,
            ...(bumpGeneration ? { generation: (tab.generation ?? 0) + 1 } : {}),
            pendingActivationSpawn: getTerminalActivationSpawnSuppression(
              s.terminalLayoutsByTabId[tab.id]
            )
          }
    )
  )
}

/** Detaches terminal tabs from their PTYs, leaving the tabs in place to respawn. */
export function unbindTerminalTabPtys(
  edit: SessionSourceEdit<AppState>,
  tabIds: ReadonlySet<string>
): void {
  const s = edit.view()
  for (const [worktreeId, tabs] of Object.entries(s.tabsByWorktree)) {
    let nextTabs = tabs
    for (const [index, tab] of tabs.entries()) {
      if (!tabIds.has(tab.id)) {
        continue
      }
      if (nextTabs === tabs) {
        nextTabs = [...tabs]
      }
      const { pendingActivationSpawn: _pendingActivationSpawn, ...tabWithoutActivationSpawn } = tab
      void _pendingActivationSpawn
      nextTabs[index] = { ...tabWithoutActivationSpawn, ptyId: null }
      edit.set('ptyIdsByTabId', tab.id, [])
    }
    if (nextTabs !== tabs) {
      edit.set('tabsByWorktree', worktreeId, nextTabs)
    }
  }
}
