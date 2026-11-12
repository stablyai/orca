import {
  useSourceControlState,
  sourceControlScopeRuntimeEnvironmentId,
  useSourceControlScope
} from '../panel/worktree-scope'
import { useCallback, useMemo } from 'react'
import { detectLanguage } from '../../../../../../shared/editor-language/editor-language-detect'
import { openUncommittedEntry } from './open-uncommitted-entry'
import { useAppStore } from '@/store'
import { openFileIndex } from '@/store/slices/editor/tabs/workspace-editor-files'
import type {
  GitBranchChangeEntry,
  GitBranchCompareSummary
} from '../../../../../../shared/git/diff/git-diff-compare-types'
import type { GitStatusEntry } from '../../../../../../shared/git/status/git-status-types'
import { buildActiveOpenFileSignature, buildActiveOpenRowKeys } from './active-open-file-keys'
import type { FlatEntry } from './use-selection'
import {
  isSourceControlSplitOpenModifier,
  shouldOpenSourceControlRowAsPreview,
  type SourceControlRowOpenEvent
} from './split-open'

export function useSourceControlRowOpening({
  isMac,
  activeWorktreeId,
  worktreePath,
  visibleSelectionEntries,
  visibleBranchRowKeys,
  branchSummary
}: {
  isMac: boolean
  activeWorktreeId: string | null
  worktreePath: string | null
  visibleSelectionEntries: FlatEntry[]
  visibleBranchRowKeys: readonly string[]
  branchSummary: GitBranchCompareSummary | null
}) {
  const scope = useSourceControlScope()
  const executionHostId = scope?.executionHostId
  const placementWorkspaceId = scope?.placementWorkspaceId
  const placementId = placementWorkspaceId ?? activeWorktreeId
  const runtimeEnvironmentId = sourceControlScopeRuntimeEnvironmentId(scope)

  // Modifier-click opens a right split to preserve the current pane.
  const resolveSplitTargetGroupId = useCallback(
    (event?: SourceControlRowOpenEvent): string | undefined => {
      if (!event || !activeWorktreeId || !isSourceControlSplitOpenModifier(event, isMac)) {
        return undefined
      }
      const state = useAppStore.getState()
      const sourceGroupId =
        state.activeGroupIdByWorktree[placementId ?? activeWorktreeId] ??
        state.groupsByWorktree[placementId ?? activeWorktreeId]?.[0]?.id
      if (!sourceGroupId) {
        return undefined
      }
      return (
        state.createEmptySplitGroup(placementId ?? activeWorktreeId, sourceGroupId, 'right') ??
        undefined
      )
    },
    [placementId, activeWorktreeId, isMac]
  )

  // Use a primitive signature so unrelated store writes do not rerender; return null for non-editor tabs.
  const activeOpenFileSignature = useSourceControlState((s) => {
    if (
      !activeWorktreeId ||
      s.activeTabTypeByWorktree?.[placementId ?? activeWorktreeId] !== 'editor'
    ) {
      return null
    }
    const activeFileId = s.activeFileIdByWorktree?.[placementId ?? activeWorktreeId]
    if (!activeFileId) {
      return null
    }
    const activeFile = openFileIndex(s.openFiles).get(activeFileId)
    return activeFile?.worktreeId === activeWorktreeId
      ? buildActiveOpenFileSignature(
          activeFile.diffSource,
          activeFile.relativePath,
          activeFile.branchCompare,
          branchSummary
        )
      : null
  })
  const activeOpenAvailableRowKeys = useMemo(() => {
    const keys = new Set(visibleBranchRowKeys)
    for (const entry of visibleSelectionEntries) {
      keys.add(entry.key)
    }
    return keys
  }, [visibleSelectionEntries, visibleBranchRowKeys])
  const activeOpenRowKeys = useMemo(
    () => buildActiveOpenRowKeys(activeOpenFileSignature, activeOpenAvailableRowKeys),
    [activeOpenAvailableRowKeys, activeOpenFileSignature]
  )

  const handleOpenDiff = useCallback(
    (entry: GitStatusEntry, event?: SourceControlRowOpenEvent) => {
      if (!activeWorktreeId || !worktreePath) {
        return
      }
      const targetGroupId = resolveSplitTargetGroupId(event)
      const openAsPreview = shouldOpenSourceControlRowAsPreview(event, targetGroupId)
      openUncommittedEntry(useAppStore.getState(), activeWorktreeId, worktreePath, entry, {
        targetGroupId,
        preview: openAsPreview,
        placementWorkspaceId,
        executionHostId,
        runtimeEnvironmentId
      })
    },
    [
      placementWorkspaceId,
      executionHostId,
      runtimeEnvironmentId,
      activeWorktreeId,
      worktreePath,
      resolveSplitTargetGroupId
    ]
  )

  const openCommittedDiff = useCallback(
    (entry: GitBranchChangeEntry, event?: SourceControlRowOpenEvent) => {
      if (
        !activeWorktreeId ||
        !worktreePath ||
        !branchSummary ||
        branchSummary.status !== 'ready'
      ) {
        return
      }
      const targetGroupId = resolveSplitTargetGroupId(event)
      useAppStore
        .getState()
        .openBranchDiff(
          activeWorktreeId,
          worktreePath,
          entry,
          branchSummary,
          detectLanguage(entry.path),
          {
            targetGroupId,
            preview: shouldOpenSourceControlRowAsPreview(event, targetGroupId),
            placementWorkspaceId,
            executionHostId,
            runtimeEnvironmentId
          }
        )
    },
    [
      placementWorkspaceId,
      executionHostId,
      runtimeEnvironmentId,
      activeWorktreeId,
      branchSummary,
      resolveSplitTargetGroupId,
      worktreePath
    ]
  )

  return { resolveSplitTargetGroupId, activeOpenRowKeys, handleOpenDiff, openCommittedDiff }
}
