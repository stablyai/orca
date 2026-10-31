import type { AppState } from '../../types'
import type { BrowserWorkspace } from '../../../../../shared/browser-workspace-types'
import type { TerminalTab } from '../../../../../shared/terminal-tab-types'
import { omitRecordKeys } from '../worktrees/teardown/record-key-omission'
import { getTerminalActivationSpawnSuppression } from '../terminal-activation-spawn-suppression'
import { collapseGroupLayout } from '../../../../../shared/workspace-layout/tab-group-layout-tree'
import {
  createKeptWorktreeSurfacePruners,
  type KeptWorktreeSurfaceRemoval
} from './kept-worktree-surface-pruning'

// Pure lifecycle patches let repo/worktree/SSH callers clear layout and other state in one atomic update.

type WorktreeLayoutPatch = Pick<
  AppState,
  | 'tabsByWorktree'
  | 'terminalLayoutsByTabId'
  | 'ptyIdsByTabId'
  | 'unifiedTabsByWorktree'
  | 'groupsByWorktree'
  | 'layoutByWorktree'
  | 'activeGroupIdByWorktree'
  | 'tabBarOrderByWorktree'
  | 'browserTabsByWorktree'
  | 'openFiles'
  | 'activeTabIdByWorktree'
  | 'activeFileIdByWorktree'
  | 'activeBrowserTabIdByWorktree'
  | 'activeTabTypeByWorktree'
  | 'activeTabId'
  | 'activeFileId'
  | 'activeBrowserTabId'
  | 'activeTabType'
>

/** Collapse kept splits emptied by purge, giving their space/selection to the surviving twin’s group. */
function collapseEmptiedKeptGroups(
  s: Pick<AppState, 'groupsByWorktree' | 'layoutByWorktree' | 'activeGroupIdByWorktree'>,
  groupsByWorktree: AppState['groupsByWorktree'],
  worktreeIds: ReadonlySet<string>
): {
  groups: AppState['groupsByWorktree']
  layout: AppState['layoutByWorktree']
  activeGroups: AppState['activeGroupIdByWorktree']
} {
  let groupsOut = groupsByWorktree
  let layoutOut = s.layoutByWorktree
  let activeOut = s.activeGroupIdByWorktree
  for (const worktreeId of worktreeIds) {
    const before = s.groupsByWorktree[worktreeId] ?? []
    let groups = groupsOut[worktreeId] ?? []
    const emptied = groups.filter(
      (group) =>
        group.tabOrder.length === 0 &&
        (before.find((prior) => prior.id === group.id)?.tabOrder.length ?? 0) > 0
    )
    for (const group of emptied) {
      if (groups.length <= 1 || !layoutOut[worktreeId]) {
        break
      }
      groups = groups.filter((candidate) => candidate.id !== group.id)
      const collapsed = collapseGroupLayout(
        layoutOut,
        activeOut,
        worktreeId,
        group.id,
        groups[0]?.id ?? null
      )
      layoutOut = collapsed.layoutByWorktree
      // Why: only the collapsed group's own focus moves; an untouched active group keeps it.
      const activeGroupId = activeOut[worktreeId]
      activeOut =
        activeGroupId === undefined || activeGroupId === group.id
          ? collapsed.activeGroupIdByWorktree
          : { ...collapsed.activeGroupIdByWorktree, [worktreeId]: activeGroupId }
    }
    if (groups !== (groupsOut[worktreeId] ?? [])) {
      groupsOut = { ...groupsOut, [worktreeId]: groups }
    }
  }
  return { groups: groupsOut, layout: layoutOut, activeGroups: activeOut }
}

/**
 * Drops removed worktrees' tabs, groups and pane layouts, and clears selection that pointed into
 * them. `kept` names surfaces leaving workspaces that stay, whose entries are pruned instead.
 */
export function removeWorktreeLayout(
  s: AppState,
  removed: {
    worktreeIds: ReadonlySet<string>
    tabIds: ReadonlySet<string>
    activeFileCleared: boolean
    kept?: KeptWorktreeSurfaceRemoval
  }
): WorktreeLayoutPatch {
  const { worktreeIds, tabIds, activeFileCleared } = removed
  const omitByWorktree = <T>(m: Record<string, T> | undefined) => omitRecordKeys(m, worktreeIds)
  const omitByTabId = <T>(m: Record<string, T> | undefined) => omitRecordKeys(m, tabIds)
  const removedActiveWorktree = s.activeWorktreeId != null && worktreeIds.has(s.activeWorktreeId)
  const kept = removed.kept ? createKeptWorktreeSurfacePruners(s, removed.kept) : null
  const keep = <T>(value: T, prune: ((value: T) => T) | undefined): T =>
    prune ? prune(value) : value
  const groupLayout = removed.kept
    ? collapseEmptiedKeptGroups(
        s,
        keep(omitByWorktree(s.groupsByWorktree), kept?.groups),
        removed.kept.worktreeIds
      )
    : null
  const remainingFiles = s.openFiles.some((f) => worktreeIds.has(f.worktreeId))
    ? s.openFiles.filter((f) => !worktreeIds.has(f.worktreeId))
    : s.openFiles
  return {
    tabsByWorktree: keep(omitByWorktree(s.tabsByWorktree), kept?.tabs),
    terminalLayoutsByTabId: omitByTabId(s.terminalLayoutsByTabId),
    ptyIdsByTabId: omitByTabId(s.ptyIdsByTabId),
    // Why: split-tab layout/group state is worktree-owned; leaving it makes a deleted worktree look restorable.
    unifiedTabsByWorktree: keep(omitByWorktree(s.unifiedTabsByWorktree), kept?.unifiedTabs),
    groupsByWorktree: groupLayout?.groups ?? omitByWorktree(s.groupsByWorktree),
    layoutByWorktree: omitByWorktree(groupLayout?.layout ?? s.layoutByWorktree),
    activeGroupIdByWorktree: omitByWorktree(groupLayout?.activeGroups ?? s.activeGroupIdByWorktree),
    tabBarOrderByWorktree: keep(omitByWorktree(s.tabBarOrderByWorktree), kept?.tabBarOrder),
    browserTabsByWorktree: keep(omitByWorktree(s.browserTabsByWorktree), kept?.browserTabs),
    // Why guarded: a removed worktree usually has no open file, and an unconditional
    // filter would hand openFiles a new identity anyway.
    openFiles: keep(remainingFiles, kept?.files),
    activeTabIdByWorktree: keep(omitByWorktree(s.activeTabIdByWorktree), kept?.activeTabIds),
    activeFileIdByWorktree: keep(omitByWorktree(s.activeFileIdByWorktree), kept?.activeFileIds),
    activeBrowserTabIdByWorktree: keep(
      omitByWorktree(s.activeBrowserTabIdByWorktree),
      kept?.activeBrowserTabIds
    ),
    activeTabTypeByWorktree: omitByWorktree(s.activeTabTypeByWorktree),
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
  s: AppState,
  oldWorktreeId: string,
  newWorktreeId: string,
  renameBrowserWorkspace: (workspace: BrowserWorkspace) => BrowserWorkspace
): Partial<WorktreeLayoutPatch> {
  const withNewWorktreeId = <T extends { worktreeId: string }>(value: T): T =>
    value.worktreeId === oldWorktreeId ? { ...value, worktreeId: newWorktreeId } : value
  const rekey = <T>(map: Record<string, T> | undefined, mapValue?: (value: T) => T) =>
    rekeyWorktreeEntry(map, oldWorktreeId, newWorktreeId, mapValue)
  const patch: Partial<WorktreeLayoutPatch> = {}
  const assign = <K extends keyof WorktreeLayoutPatch>(
    key: K,
    value: WorktreeLayoutPatch[K] | undefined
  ): void => {
    if (value !== undefined) {
      patch[key] = value
    }
  }
  assign(
    'tabsByWorktree',
    rekey(s.tabsByWorktree, (tabs) => tabs.map(withNewWorktreeId))
  )
  assign(
    'browserTabsByWorktree',
    rekey(s.browserTabsByWorktree, (workspaces) => workspaces.map(renameBrowserWorkspace))
  )
  assign('activeBrowserTabIdByWorktree', rekey(s.activeBrowserTabIdByWorktree))
  assign('activeFileIdByWorktree', rekey(s.activeFileIdByWorktree))
  assign('activeTabTypeByWorktree', rekey(s.activeTabTypeByWorktree))
  assign('activeTabIdByWorktree', rekey(s.activeTabIdByWorktree))
  assign('tabBarOrderByWorktree', rekey(s.tabBarOrderByWorktree))
  assign(
    'unifiedTabsByWorktree',
    rekey(s.unifiedTabsByWorktree, (tabs) => tabs.map(withNewWorktreeId))
  )
  assign(
    'groupsByWorktree',
    rekey(s.groupsByWorktree, (groups) => groups.map(withNewWorktreeId))
  )
  assign('layoutByWorktree', rekey(s.layoutByWorktree))
  assign('activeGroupIdByWorktree', rekey(s.activeGroupIdByWorktree))
  if (s.openFiles?.some((f) => f.worktreeId === oldWorktreeId)) {
    assign('openFiles', s.openFiles.map(withNewWorktreeId))
  }
  return patch
}

/**
 * Tags a worktree's wakeable terminal tabs for an activation spawn, optionally bumping their
 * generation so dead panes remount.
 */
export function markWorktreeTabsForActivationSpawn(
  s: AppState,
  worktreeId: string,
  options: { isWakeable: (tab: TerminalTab) => boolean; bumpGeneration: boolean }
): Pick<AppState, 'tabsByWorktree'> {
  const { isWakeable, bumpGeneration } = options
  return {
    tabsByWorktree: {
      ...s.tabsByWorktree,
      [worktreeId]: (s.tabsByWorktree[worktreeId] ?? []).map((tab) =>
        !isWakeable(tab)
          ? tab
          : {
              ...tab,
              ...(bumpGeneration ? { generation: (tab.generation ?? 0) + 1 } : {}),
              // Why: slept terminal remount/spawn is click-driven wake work; tag its PTY updates so they don't reshuffle Recent.
              pendingActivationSpawn: getTerminalActivationSpawnSuppression(
                s.terminalLayoutsByTabId[tab.id]
              )
            }
      )
    }
  }
}

/** Detaches terminal tabs from their PTYs, leaving the tabs in place to respawn. */
export function unbindTerminalTabPtys(
  s: AppState,
  tabIds: ReadonlySet<string>
): Pick<AppState, 'tabsByWorktree' | 'ptyIdsByTabId'> {
  let nextTabsByWorktree = s.tabsByWorktree
  const nextPtyIdsByTabId = { ...s.ptyIdsByTabId }
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
      nextPtyIdsByTabId[tab.id] = []
    }
    if (nextTabs !== tabs) {
      if (nextTabsByWorktree === s.tabsByWorktree) {
        nextTabsByWorktree = { ...nextTabsByWorktree }
      }
      nextTabsByWorktree[worktreeId] = nextTabs
    }
  }
  return { tabsByWorktree: nextTabsByWorktree, ptyIdsByTabId: nextPtyIdsByTabId }
}
