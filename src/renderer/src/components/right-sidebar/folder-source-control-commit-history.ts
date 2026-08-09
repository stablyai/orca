import { useCallback, useRef } from 'react'
import { useAppStore } from '@/store'
import { joinPath } from '@/lib/path'
import { detectLanguage } from '@/lib/language-detect'
import { getRuntimeGitCommitCompare, type RuntimeGitContext } from '@/runtime/runtime-git-client'
import type { GitHistoryItem } from '../../../../shared/git-history'
import type { GitBranchChangeEntry, GitCommitCompareResult } from '../../../../shared/types'
import type { SourceControlRowOpenEvent } from './source-control-split-open'

export function useFolderSourceControlCommitHistory({
  context,
  diffWorktreeId,
  worktreePath,
  onOpenVisibleFile
}: {
  context: RuntimeGitContext
  diffWorktreeId: string
  worktreePath: string
  onOpenVisibleFile?: (fileId: string, label: string) => void
}): {
  loadCommitFiles: (item: GitHistoryItem) => Promise<GitBranchChangeEntry[]>
  openHistoryCommitDiff: (item: GitHistoryItem) => Promise<void>
  openCommitFile: (
    item: GitHistoryItem,
    entry: GitBranchChangeEntry,
    event?: SourceControlRowOpenEvent
  ) => void
} {
  const openCommitDiff = useAppStore((state) => state.openCommitDiff)
  const openCommitAllDiffs = useAppStore((state) => state.openCommitAllDiffs)
  const commitCompareCacheRef = useRef<Map<string, GitCommitCompareResult>>(new Map())

  const loadCommitFiles = useCallback(
    async (item: GitHistoryItem): Promise<GitBranchChangeEntry[]> => {
      const cached = commitCompareCacheRef.current.get(item.id)
      if (cached) {
        return cached.entries
      }
      const result = await getRuntimeGitCommitCompare(context, item.id)
      if (result.summary.status !== 'ready') {
        throw new Error(result.summary.errorMessage ?? 'Failed to load commit diff')
      }
      commitCompareCacheRef.current.set(item.id, result)
      return result.entries
    },
    [context]
  )

  const openHistoryCommitDiff = useCallback(
    async (item: GitHistoryItem): Promise<void> => {
      const entries = await loadCommitFiles(item)
      const cached = commitCompareCacheRef.current.get(item.id)
      if (!cached) {
        return
      }
      openCommitAllDiffs(
        diffWorktreeId,
        worktreePath,
        cached.summary,
        entries,
        item.subject,
        item.message
      )
    },
    [diffWorktreeId, loadCommitFiles, openCommitAllDiffs, worktreePath]
  )

  const openCommitFile = useCallback(
    (item: GitHistoryItem, entry: GitBranchChangeEntry, _event?: SourceControlRowOpenEvent) => {
      const cached = commitCompareCacheRef.current.get(item.id)
      if (!cached) {
        return
      }
      openCommitDiff(
        diffWorktreeId,
        worktreePath,
        entry,
        {
          commitOid: cached.summary.commitOid,
          parentOid: cached.summary.parentOid,
          compareRef: cached.summary.compareRef,
          baseRef: cached.summary.baseRef,
          subject: item.subject,
          message: item.message
        },
        detectLanguage(entry.path)
      )
      const opened = useAppStore
        .getState()
        .openFiles.find(
          (file) =>
            file.filePath === joinPath(worktreePath, entry.path) &&
            file.relativePath === entry.path &&
            file.mode === 'diff'
        )
      if (opened) {
        onOpenVisibleFile?.(opened.id, opened.relativePath)
      }
    },
    [diffWorktreeId, onOpenVisibleFile, openCommitDiff, worktreePath]
  )

  return { loadCommitFiles, openHistoryCommitDiff, openCommitFile }
}
