import type { ActiveWorktreeStateTransition } from '../../worktree-helpers'
import type { TabGroup } from '../../../../../../shared/tab-types'
import { parseExecutionHostId } from '../../../../../../shared/execution-host'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { sanitizeRecentTabIds } from '../../tab-group-state'
import {
  nextActiveIdAfterRemoval,
  removeEmptyEditorGroups,
  removeTabIdsFromGroup,
  rekeyFileIdRecord
} from '../file-ids/open-file-path-rekey'
import type {
  RestoredEditorOwnerMigration,
  RestoredEditorOwnerResult
} from '../types/restored-editor-owner'
import { resolveRestoredEditorOwnerDestination } from './restored-editor-owner-destination'

export function buildRestoredEditorOwnerTransition(
  args: RestoredEditorOwnerMigration,
  assignResult: (result: RestoredEditorOwnerResult) => void
): ActiveWorktreeStateTransition {
  return (s) => {
    const destination = resolveRestoredEditorOwnerDestination(s, args)
    if (!destination.ok) {
      assignResult({ ok: false, reason: destination.reason })
      return destination.reason === 'stale'
        ? { patch: {}, activate: false }
        : { patch: destination.patch, activate: false }
    }
    const { source, newFileId, previewIdMigrations, operationProvenance } = destination
    const parsedHost = parseExecutionHostId(args.targetExecutionHostId)
    const externalSshTargetId =
      parsedHost?.kind === 'ssh' && args.targetRuntimeEnvironmentId === null
        ? parsedHost.targetId
        : undefined
    const migrations = new Map([[source.id, newFileId], ...previewIdMigrations])
    const movedFileIds = new Set(migrations.keys())
    const sourceWorktreeId = source.worktreeId
    const targetWorktreeId = args.targetWorktreeId
    const movedTabs = (s.unifiedTabsByWorktree[sourceWorktreeId] ?? []).filter((tab) =>
      movedFileIds.has(tab.entityId)
    )
    const movedTabIds = new Set(movedTabs.map((tab) => tab.id))
    const tabIdMigration = new Map(
      movedTabs.map((tab) => [tab.id, migrations.get(tab.id) ?? tab.id])
    )
    const mappedMovedTabIds = movedTabs.map((tab) => tabIdMigration.get(tab.id) ?? tab.id)
    const mappedMovedTabIdSet = new Set(mappedMovedTabIds)
    const mappedMovedTabBarIds = movedTabs.map(
      (tab) => migrations.get(tab.entityId) ?? tab.entityId
    )
    const targetGroups = s.groupsByWorktree[targetWorktreeId] ?? []
    const targetGroupId =
      s.activeGroupIdByWorktree[targetWorktreeId] ?? targetGroups[0]?.id ?? createBrowserUuid()
    const targetGroup = targetGroups.find((group) => group.id === targetGroupId) ?? {
      id: targetGroupId,
      worktreeId: targetWorktreeId,
      activeTabId: null,
      tabOrder: []
    }

    const previousSourceGroups = s.groupsByWorktree[sourceWorktreeId] ?? []
    const updatedSourceGroups = previousSourceGroups.map((group) => {
      const tabOrder = group.tabOrder.filter((id) => !movedTabIds.has(id))
      const activeTabId =
        group.activeTabId && movedTabIds.has(group.activeTabId)
          ? nextActiveIdAfterRemoval(group.tabOrder, group.recentTabIds, movedTabIds)
          : group.activeTabId
      return {
        ...group,
        activeTabId,
        tabOrder,
        recentTabIds: sanitizeRecentTabIds(
          (group.recentTabIds ?? []).filter((id) => !movedTabIds.has(id)),
          tabOrder
        )
      }
    })
    const sourceGroupState = removeEmptyEditorGroups(
      previousSourceGroups,
      updatedSourceGroups,
      movedTabIds,
      s.layoutByWorktree[sourceWorktreeId]
    )
    const destinationOrder = [
      ...targetGroup.tabOrder.filter((id) => !mappedMovedTabIds.includes(id)),
      ...mappedMovedTabIds
    ]
    const updatedTargetGroup: TabGroup = {
      ...targetGroup,
      activeTabId: mappedMovedTabIds.at(-1) ?? targetGroup.activeTabId,
      tabOrder: destinationOrder,
      recentTabIds: sanitizeRecentTabIds(
        [...(targetGroup.recentTabIds ?? []), ...mappedMovedTabIds],
        destinationOrder
      )
    }
    // Why: the migrated ids land in targetGroup only, so any sibling group holding the same id is left dangling.
    const nextTargetGroups = targetGroups.some((group) => group.id === targetGroupId)
      ? targetGroups.map((group) =>
          group.id === targetGroupId
            ? updatedTargetGroup
            : removeTabIdsFromGroup(group, mappedMovedTabIdSet)
        )
      : [
          ...targetGroups.map((group) => removeTabIdsFromGroup(group, mappedMovedTabIdSet)),
          updatedTargetGroup
        ]

    const nextUnifiedTabsByWorktree = { ...s.unifiedTabsByWorktree }
    nextUnifiedTabsByWorktree[sourceWorktreeId] = (
      nextUnifiedTabsByWorktree[sourceWorktreeId] ?? []
    ).filter((tab) => !movedTabIds.has(tab.id))
    nextUnifiedTabsByWorktree[targetWorktreeId] = [
      // Why: a leftover target tab carrying a migrated id would duplicate the id that destinationOrder keeps only once.
      ...(nextUnifiedTabsByWorktree[targetWorktreeId] ?? []).filter(
        (tab) => !mappedMovedTabIdSet.has(tab.id)
      ),
      ...movedTabs.map((tab) => ({
        ...tab,
        id: tabIdMigration.get(tab.id) ?? tab.id,
        entityId: migrations.get(tab.entityId) ?? tab.entityId,
        groupId: targetGroupId
      }))
    ]

    const nextGroupsByWorktree = {
      ...s.groupsByWorktree,
      [sourceWorktreeId]: sourceGroupState.groups,
      [targetWorktreeId]: nextTargetGroups
    }
    const nextLayoutByWorktree = { ...s.layoutByWorktree }
    if (sourceGroupState.layout) {
      nextLayoutByWorktree[sourceWorktreeId] = sourceGroupState.layout
    } else {
      delete nextLayoutByWorktree[sourceWorktreeId]
    }
    if (targetGroups.length === 0 || !nextLayoutByWorktree[targetWorktreeId]) {
      nextLayoutByWorktree[targetWorktreeId] = { type: 'leaf', groupId: targetGroupId }
    }

    const nextActiveFileIdByWorktree = { ...s.activeFileIdByWorktree }
    const sourceActiveFileId = nextActiveFileIdByWorktree[sourceWorktreeId]
    if (sourceActiveFileId && movedFileIds.has(sourceActiveFileId)) {
      nextActiveFileIdByWorktree[sourceWorktreeId] =
        s.openFiles.find(
          (file) => !movedFileIds.has(file.id) && file.worktreeId === sourceWorktreeId
        )?.id ?? null
    }
    nextActiveFileIdByWorktree[targetWorktreeId] = newFileId
    const nextTabBarOrderByWorktree = { ...s.tabBarOrderByWorktree }
    nextTabBarOrderByWorktree[sourceWorktreeId] = (
      nextTabBarOrderByWorktree[sourceWorktreeId] ?? []
    ).filter((id) => !movedFileIds.has(id) && !movedTabIds.has(id))
    nextTabBarOrderByWorktree[targetWorktreeId] = [
      ...(nextTabBarOrderByWorktree[targetWorktreeId] ?? []).filter(
        (id) => !mappedMovedTabBarIds.includes(id)
      ),
      ...mappedMovedTabBarIds
    ]
    const nextActiveGroupIdByWorktree = { ...s.activeGroupIdByWorktree }
    if (sourceGroupState.groups.length > 0) {
      const previousActiveGroupId = nextActiveGroupIdByWorktree[sourceWorktreeId]
      nextActiveGroupIdByWorktree[sourceWorktreeId] = sourceGroupState.groups.some(
        (group) => group.id === previousActiveGroupId
      )
        ? previousActiveGroupId
        : sourceGroupState.groups[0].id
    } else {
      delete nextActiveGroupIdByWorktree[sourceWorktreeId]
    }
    nextActiveGroupIdByWorktree[targetWorktreeId] = targetGroupId

    assignResult({ ok: true, fileId: newFileId })
    return {
      patch: {
        openFiles: s.openFiles.map((file) =>
          file.id === source.id
            ? {
                ...file,
                id: newFileId,
                worktreeId: targetWorktreeId,
                relativePath: args.targetRelativePath,
                runtimeEnvironmentId: args.targetRuntimeEnvironmentId,
                externalSshTargetId,
                operationProvenance,
                pendingOwnerMigration: undefined,
                mirroredFromRuntimeSession: undefined
              }
            : file.markdownPreviewSourceFileId === source.id
              ? {
                  ...file,
                  id: previewIdMigrations.get(file.id) ?? file.id,
                  worktreeId: targetWorktreeId,
                  relativePath: args.targetRelativePath,
                  runtimeEnvironmentId: args.targetRuntimeEnvironmentId,
                  externalSshTargetId,
                  operationProvenance,
                  markdownPreviewSourceFileId: newFileId,
                  pendingOwnerMigration: undefined,
                  mirroredFromRuntimeSession: undefined
                }
              : file
        ),
        editorDrafts: rekeyFileIdRecord(s.editorDrafts, migrations),
        editorCursorLine: rekeyFileIdRecord(s.editorCursorLine, migrations),
        markdownViewMode: rekeyFileIdRecord(s.markdownViewMode, migrations),
        editorViewMode: rekeyFileIdRecord(s.editorViewMode, migrations),
        markdownFrontmatterVisible: rekeyFileIdRecord(s.markdownFrontmatterVisible, migrations),
        markdownTableOfContentsVisible: rekeyFileIdRecord(
          s.markdownTableOfContentsVisible,
          migrations
        ),
        activeFileId: s.activeFileId ? (migrations.get(s.activeFileId) ?? s.activeFileId) : null,
        activeFileIdByWorktree: nextActiveFileIdByWorktree,
        activeTabTypeByWorktree: {
          ...s.activeTabTypeByWorktree,
          [targetWorktreeId]: 'editor'
        },
        unifiedTabsByWorktree: nextUnifiedTabsByWorktree,
        groupsByWorktree: nextGroupsByWorktree,
        layoutByWorktree: nextLayoutByWorktree,
        activeGroupIdByWorktree: nextActiveGroupIdByWorktree,
        tabBarOrderByWorktree: nextTabBarOrderByWorktree,
        ...(s.pendingEditorReveal?.fileId && migrations.has(s.pendingEditorReveal.fileId)
          ? {
              pendingEditorReveal: {
                ...s.pendingEditorReveal,
                fileId: migrations.get(s.pendingEditorReveal.fileId)!,
                filePath: source.filePath
              }
            }
          : {}),
        ...(s.pendingEditorFocusRequest?.fileId &&
        migrations.has(s.pendingEditorFocusRequest.fileId)
          ? {
              pendingEditorFocusRequest: {
                ...s.pendingEditorFocusRequest,
                fileId: migrations.get(s.pendingEditorFocusRequest.fileId)!,
                worktreeId: targetWorktreeId
              }
            }
          : {}),
        ...(s.pendingExplorerReveal?.filePath === source.filePath &&
        s.pendingExplorerReveal.worktreeId === sourceWorktreeId
          ? {
              pendingExplorerReveal: {
                ...s.pendingExplorerReveal,
                worktreeId: targetWorktreeId
              }
            }
          : {})
      },
      activate: true,
      preferredActiveUnifiedTabId: mappedMovedTabIds.at(-1)
    }
  }
}
