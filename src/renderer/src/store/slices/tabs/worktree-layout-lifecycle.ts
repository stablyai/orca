import {
  retirePendingWorkspaceTabs,
  hasPendingEntityTab
} from '@/runtime/workspace-layout/intents/layout-owner-pending-tabs'
import { editorPlacementsInContentOwners } from '@/lib/workspace/persistence/workspace-session-unified-tabs'
import { isEditorTabContentType } from '../editor/tabs/editor-tab-content-type'
import { buildActiveSurfacePatch } from './tabs-surface'
import type { AppState } from '../../types'
export { renameWorktreeLayoutKeys } from './rename-worktree-layout'
import { omitRecordKeys } from '../worktrees/teardown/record-key-omission'
import { recordDraft, tabBucketDraft } from '../../keyed-record-transitions'
import { collapseEmptiedKeptGroups, type GroupLayoutDrafts } from './collapse-emptied-kept-groups'
import {
  createKeptWorktreeSurfacePruners,
  pruneKeptEntries,
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
  // Seam records are built once each, through the same operations, in the order this teardown applies them.
  const tabs = tabBucketDraft(s.tabsByWorktree ?? {})
  const unifiedTabs = tabBucketDraft(s.unifiedTabsByWorktree)
  const drafts: GroupLayoutDrafts = {
    groups: recordDraft(s.groupsByWorktree ?? {}),
    layout: recordDraft(s.layoutByWorktree ?? {}),
    activeGroups: recordDraft(s.activeGroupIdByWorktree ?? {})
  }
  for (const worktreeId of worktreeIds) {
    tabs.delete(worktreeId)
    unifiedTabs.delete(worktreeId)
    drafts.groups.delete(worktreeId)
  }
  if (removed.kept && kept) {
    pruneKeptEntries(tabs, removed.kept.worktreeIds, kept.entries.tabs)
    pruneKeptEntries(drafts.groups, removed.kept.worktreeIds, kept.entries.groups)
    collapseEmptiedKeptGroups(s.groupsByWorktree, drafts, removed.kept.worktreeIds)
  }
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
  // Removed workspaces' entries are source-only here, so the kept groups stand in for the pruned record.
  const keptGroups = removed.kept
    ? Object.fromEntries(
        [...removed.kept.worktreeIds].flatMap((id) => {
          const groups = drafts.groups.get(id)
          return groups ? [[id, groups]] : []
        })
      )
    : null
  const transferred = editorPlacementsInContentOwners(
    remainingFiles,
    s.unifiedTabsByWorktree,
    keptGroups ? { ...s.groupsByWorktree, ...keptGroups } : s.groupsByWorktree,
    worktreeIds
  )
  const survivingIds = new Set(remainingFiles.map((file) => file.id))
  for (const [id, sourceTabs] of Object.entries(transferred.sourceTabs)) {
    if (worktreeIds.has(id)) {
      continue
    }
    const pruned =
      kept && removed.kept?.worktreeIds.has(id) ? kept.entries.unifiedTabs(sourceTabs) : sourceTabs
    const live = pruned.filter(
      (tab) => !isEditorTabContentType(tab.contentType) || survivingIds.has(tab.entityId)
    )
    unifiedTabs.set(id, live.length === pruned.length ? pruned : live)
  }
  const nextUnifiedTabs = unifiedTabs.finish()
  const liveTabIds = new Set(
    Object.values(nextUnifiedTabs).flatMap((tabs) => tabs.map((tab) => tab.id))
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
  for (const [id, groups] of Object.entries(transferred.sourceGroups)) {
    if (worktreeIds.has(id)) {
      continue
    }
    drafts.groups.set(
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
    )
  }
  // Removed worktrees' entries stay deleted; collapsing them would write an empty group list back.
  collapseEmptiedKeptGroups(
    s.groupsByWorktree,
    drafts,
    new Set([...affectedWorkspaces].filter((id) => !worktreeIds.has(id)))
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
  const ownerOrders = { ...keep(omitByWorktree(s.tabBarOrderByWorktree), kept?.tabBarOrder) }
  const ownerActiveTypes = { ...omitByWorktree(s.activeTabTypeByWorktree) }
  for (const tab of transferred.movedTabs) {
    affectedWorkspaces.add(tab.worktreeId)
    if (drafts.layout.get(tab.worktreeId) == null) {
      drafts.layout.set(tab.worktreeId, { type: 'leaf', groupId: tab.groupId })
    }
    if (drafts.activeGroups.get(tab.worktreeId) == null) {
      drafts.activeGroups.set(tab.worktreeId, tab.groupId)
    }
    ownerOrders[tab.worktreeId] = [...(ownerOrders[tab.worktreeId] ?? []), tab.entityId]
    activeFiles[tab.worktreeId] ??= tab.entityId
    ownerActiveTypes[tab.worktreeId] ??= 'editor'
  }
  for (const worktreeId of worktreeIds) {
    drafts.layout.delete(worktreeId)
    drafts.activeGroups.delete(worktreeId)
  }
  const patch: WorktreeLayoutPatch = {
    tabsByWorktree: tabs.finish(),
    terminalLayoutsByTabId: omitByTabId(s.terminalLayoutsByTabId),
    ptyIdsByTabId: omitByTabId(s.ptyIdsByTabId),
    // Why: split-tab layout/group state is worktree-owned; leaving it makes a deleted worktree look restorable.
    unifiedTabsByWorktree: nextUnifiedTabs,
    groupsByWorktree: drafts.groups.finish(),
    layoutByWorktree: drafts.layout.finish(),
    activeGroupIdByWorktree: drafts.activeGroups.finish(),
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
