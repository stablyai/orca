import { useSourceControlScope } from '../panel/worktree-scope'
import { useCallback, useMemo } from 'react'
import { detectLanguage } from '@/lib/language-detect'
import { openUncommittedEntry } from './open-uncommitted-entry'
import { useAppStore } from '@/store'
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
  const runtimeEnvironmentId = scope
    ? (scope.worktree.runtimeOwnerEnvironmentId ??
      (scope.executionHostId.startsWith('runtime:')
        ? decodeURIComponent(scope.executionHostId.slice(8))
        : null))
    : undefined
  const activeGroupIdByWorktree = useAppStore((s) => s.activeGroupIdByWorktree)
  const groupsByWorktree = useAppStore((s) => s.groupsByWorktree)
  const createEmptySplitGroup = useAppStore((s) => s.createEmptySplitGroup)
  const trackConflictPath = useAppStore((s) => s.trackConflictPath)
  const openConflictFile = useAppStore((s) => s.openConflictFile)
  const openDiff = useAppStore((s) => s.openDiff)
  const openFile = useAppStore((s) => s.openFile)
  const openBranchDiff = useAppStore((s) => s.openBranchDiff)

  // Modifier-click opens a right split to preserve the current pane.
  const resolveSplitTargetGroupId = useCallback(
    (event?: SourceControlRowOpenEvent): string | undefined => {
      if (!event || !activeWorktreeId || !isSourceControlSplitOpenModifier(event, isMac)) {
        return undefined
      }
      const sourceGroupId =
        activeGroupIdByWorktree[placementId ?? activeWorktreeId] ??
        groupsByWorktree[placementId ?? activeWorktreeId]?.[0]?.id
      if (!sourceGroupId) {
        return undefined
      }
      return (
        createEmptySplitGroup(placementId ?? activeWorktreeId, sourceGroupId, 'right') ?? undefined
      )
    },
    [
      placementId,
      activeGroupIdByWorktree,
      activeWorktreeId,
      createEmptySplitGroup,
      groupsByWorktree,
      isMac
    ]
  )

  // Use a primitive signature so unrelated store writes do not rerender; return null for non-editor tabs.
  const activeOpenFileSignature = useAppStore((s) => {
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
    const activeFile = s.openFiles?.find(
      (file) => file.id === activeFileId && file.worktreeId === activeWorktreeId
    )
    return activeFile
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
      openUncommittedEntry(
        { trackConflictPath, openConflictFile, openFile, openDiff },
        activeWorktreeId,
        worktreePath,
        entry,
        {
          targetGroupId,
          preview: openAsPreview,
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
      worktreePath,
      resolveSplitTargetGroupId,
      trackConflictPath,
      openConflictFile,
      openDiff,
      openFile
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
      openBranchDiff(
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
      openBranchDiff,
      resolveSplitTargetGroupId,
      worktreePath
    ]
  )

  return { resolveSplitTargetGroupId, activeOpenRowKeys, handleOpenDiff, openCommittedDiff }
}
