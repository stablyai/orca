import {
  retirePendingWorkspaceTabs,
  hasPendingEntityTab
} from '@/runtime/layout-owner-pending-tabs'
import { editorPlacementsInContentOwners } from '@/lib/workspace/persistence/workspace-session-unified-tabs'
import { isEditorTabContentType } from '../editor/tabs/editor-tab-content-type'
import { buildActiveSurfacePatch } from './tabs-surface'
import type { AppState } from '../../types'
export { renameWorktreeLayoutKeys } from './rename-worktree-layout'
import type { TerminalTab } from '../../../../../shared/workspace-layout/terminal-tab-types'
import { omitRecordKeys } from '../worktrees/teardown/record-key-omission'
import { getTerminalActivationSpawnSuppression } from '../terminal-activation-spawn-suppression'
import { collapseEmptiedKeptGroups } from './collapse-emptied-kept-groups'
import {
  createKeptWorktreeSurfacePruners,
  type KeptWorktreeSurfaceRemoval
} from './kept-worktree-surface-pruning'

// Pure lifecycle patches let repo/worktree/SSH callers clear layout and other state in one atomic update.

export type WorktreeLayoutPatch = Pick<
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
  | 'recentlyClosedEditorTabsByWorktree'
  | 'recentlyClosedTabKindsByWorktree'
>

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
  const removedContentIds = new Set(
    s.openFiles.filter((file) => worktreeIds.has(file.worktreeId)).map((file) => file.id)
  )
  retirePendingWorkspaceTabs(worktreeIds, removedContentIds)
  const placements = keep(omitByWorktree(s.unifiedTabsByWorktree), kept?.unifiedTabs)
  const referenced = new Set(
    Object.values(placements).flatMap((tabs) =>
      tabs.filter((tab) => !removedContentIds.has(tab.entityId)).map((tab) => tab.entityId)
    )
  )
  const removedViewEntities = new Set(
    [...worktreeIds].flatMap((id) =>
      (s.unifiedTabsByWorktree[id] ?? [])
        .filter((tab) => isEditorTabContentType(tab.contentType))
        .map((tab) => tab.entityId)
    )
  )
  const remainingFiles = s.openFiles.filter(
    (file) =>
      !removedContentIds.has(file.id) &&
      (!removedViewEntities.has(file.id) ||
        referenced.has(file.id) ||
        hasPendingEntityTab(null, file.id) ||
        file.mode === 'edit')
  )
  const transferred = editorPlacementsInContentOwners(
    remainingFiles,
    s.unifiedTabsByWorktree,
    groupLayout?.groups ?? s.groupsByWorktree,
    worktreeIds
  )
  const transferredPlacements = keep(omitByWorktree(transferred.sourceTabs), kept?.unifiedTabs)
  const survivingIds = new Set(remainingFiles.map((file) => file.id))
  const unifiedTabs = Object.fromEntries(
    Object.entries(transferredPlacements).map(([id, tabs]) => [
      id,
      tabs.filter(
        (tab) => !isEditorTabContentType(tab.contentType) || survivingIds.has(tab.entityId)
      )
    ])
  )
  const liveTabIds = new Set(
    Object.values(unifiedTabs).flatMap((tabs) => tabs.map((tab) => tab.id))
  )
  const removedPlacementIds = new Set(
    Object.values(s.unifiedTabsByWorktree).flatMap((tabs) =>
      tabs.filter((tab) => !liveTabIds.has(tab.id)).map((tab) => tab.id)
    )
  )
  const affectedWorkspaces = new Set(
    Object.entries(s.unifiedTabsByWorktree)
      .filter(([, tabs]) => tabs.some((tab) => removedPlacementIds.has(tab.id)))
      .map(([id]) => id)
  )
  const cleanGroups = Object.fromEntries(
    Object.entries(omitByWorktree(transferred.sourceGroups)).map(([id, groups]) => [
      id,
      affectedWorkspaces.has(id)
        ? groups.map((group) => {
            const tabOrder = group.tabOrder.filter((id) => !removedPlacementIds.has(id))
            return {
              ...group,
              tabOrder,
              recentTabIds: group.recentTabIds?.filter((id) => !removedPlacementIds.has(id)),
              activeTabId:
                group.activeTabId && !removedPlacementIds.has(group.activeTabId)
                  ? group.activeTabId
                  : (tabOrder[0] ?? null)
            }
          })
        : groups
    ])
  )
  const collapsed = collapseEmptiedKeptGroups(
    {
      ...s,
      layoutByWorktree: groupLayout?.layout ?? s.layoutByWorktree,
      activeGroupIdByWorktree: groupLayout?.activeGroups ?? s.activeGroupIdByWorktree
    },
    cleanGroups,
    affectedWorkspaces
  )
  const recentEditors = Object.fromEntries(
    Object.entries(omitByWorktree(s.recentlyClosedEditorTabsByWorktree)).map(([id, rows]) => [
      id,
      rows.filter((row) => !worktreeIds.has(row.worktreeId))
    ])
  )
  const recentKinds = Object.fromEntries(
    Object.entries(omitByWorktree(s.recentlyClosedTabKindsByWorktree)).map(([id, kinds]) => {
      let editorIndex = 0
      const snapshots = s.recentlyClosedEditorTabsByWorktree[id] ?? []
      return [
        id,
        kinds.filter(
          (kind) =>
            kind !== 'editor' || !worktreeIds.has(snapshots[editorIndex++]?.worktreeId ?? '')
        )
      ]
    })
  )
  const activeFiles = Object.fromEntries(
    Object.entries(keep(omitByWorktree(s.activeFileIdByWorktree), kept?.activeFileIds)).map(
      ([id, selected]) => [id, selected && survivingIds.has(selected) ? selected : null]
    )
  )
  const ownerLayouts = { ...collapsed.layout }
  const ownerActiveGroups = { ...collapsed.activeGroups }
  const ownerOrders = { ...keep(omitByWorktree(s.tabBarOrderByWorktree), kept?.tabBarOrder) }
  const ownerActiveTypes = { ...omitByWorktree(s.activeTabTypeByWorktree) }
  for (const tab of transferred.movedTabs) {
    affectedWorkspaces.add(tab.worktreeId)
    ownerLayouts[tab.worktreeId] ??= { type: 'leaf', groupId: tab.groupId }
    ownerActiveGroups[tab.worktreeId] ??= tab.groupId
    ownerOrders[tab.worktreeId] = [...(ownerOrders[tab.worktreeId] ?? []), tab.entityId]
    activeFiles[tab.worktreeId] ??= tab.entityId
    ownerActiveTypes[tab.worktreeId] ??= 'editor'
  }
  const patch: WorktreeLayoutPatch = {
    tabsByWorktree: keep(omitByWorktree(s.tabsByWorktree), kept?.tabs),
    terminalLayoutsByTabId: omitByTabId(s.terminalLayoutsByTabId),
    ptyIdsByTabId: omitByTabId(s.ptyIdsByTabId),
    // Why: split-tab layout/group state is worktree-owned; leaving it makes a deleted worktree look restorable.
    unifiedTabsByWorktree: unifiedTabs,
    groupsByWorktree: collapsed.groups,
    layoutByWorktree: omitByWorktree(ownerLayouts),
    activeGroupIdByWorktree: omitByWorktree(ownerActiveGroups),
    tabBarOrderByWorktree: Object.fromEntries(
      Object.entries(ownerOrders).map(([id, order]) => [
        id,
        order.filter((item) => !removedContentIds.has(item) && !removedPlacementIds.has(item))
      ])
    ),
    browserTabsByWorktree: keep(omitByWorktree(s.browserTabsByWorktree), kept?.browserTabs),
    // Why guarded: a removed worktree usually has no open file, and an unconditional
    // filter would hand openFiles a new identity anyway.
    openFiles: keep(remainingFiles, kept?.files),
    activeTabIdByWorktree: keep(omitByWorktree(s.activeTabIdByWorktree), kept?.activeTabIds),
    activeFileIdByWorktree: activeFiles,
    activeBrowserTabIdByWorktree: keep(
      omitByWorktree(s.activeBrowserTabIdByWorktree),
      kept?.activeBrowserTabIds
    ),
    activeTabTypeByWorktree: ownerActiveTypes,
    recentlyClosedEditorTabsByWorktree: recentEditors,
    recentlyClosedTabKindsByWorktree: recentKinds,
    activeTabId: s.activeTabId && tabIds.has(s.activeTabId) ? null : s.activeTabId,
    activeFileId:
      activeFileCleared || (s.activeFileId && !survivingIds.has(s.activeFileId))
        ? null
        : s.activeFileId,
    activeBrowserTabId: removedActiveWorktree ? null : s.activeBrowserTabId,
    activeTabType: removedActiveWorktree || activeFileCleared ? 'terminal' : s.activeTabType
  }
  if (
    s.activeWorktreeId &&
    !removedActiveWorktree &&
    (affectedWorkspaces.has(s.activeWorktreeId) ||
      removed.kept?.worktreeIds.has(s.activeWorktreeId))
  ) {
    Object.assign(
      patch,
      buildActiveSurfacePatch(
        { ...s, ...patch },
        s.activeWorktreeId,
        patch.activeGroupIdByWorktree[s.activeWorktreeId] ?? null
      )
    )
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
