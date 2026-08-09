import { useCallback, useEffect, useRef } from 'react'
import { toast } from 'sonner'
import { useAppStore } from '@/store'
import { getRendererAppPlatform } from '@/lib/renderer-app-platform'
import { joinPath } from '@/lib/path'
import { detectLanguage } from '@/lib/language-detect'
import { getRuntimeGitCommitCompare, type RuntimeGitContext } from '@/runtime/runtime-git-client'
import { translate } from '@/i18n/i18n'
import type { GitHistoryItem } from '../../../../shared/git-history'
import type { GitBranchChangeEntry, GitCommitCompareResult } from '../../../../shared/types'
import {
  isSourceControlSplitOpenModifier,
  shouldOpenSourceControlRowAsPreview,
  type SourceControlRowOpenEvent
} from './source-control-split-open'

const COMMIT_COMPARE_CACHE_MAX = 100

function getCachedCommitCompare(
  cache: Map<string, GitCommitCompareResult>,
  key: string
): GitCommitCompareResult | undefined {
  const value = cache.get(key)
  if (value === undefined) {
    return undefined
  }
  cache.delete(key)
  cache.set(key, value)
  return value
}

function cacheCommitCompare(
  cache: Map<string, GitCommitCompareResult>,
  key: string,
  value: GitCommitCompareResult
): void {
  cache.delete(key)
  cache.set(key, value)
  while (cache.size > COMMIT_COMPARE_CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) {
      break
    }
    cache.delete(oldest)
  }
}

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
  const activeWorktreeId = useAppStore((state) => state.activeWorktreeId)
  const activeGroupIdByWorktree = useAppStore((state) => state.activeGroupIdByWorktree)
  const groupsByWorktree = useAppStore((state) => state.groupsByWorktree)
  const createEmptySplitGroup = useAppStore((state) => state.createEmptySplitGroup)
  const commitCompareCacheRef = useRef<Map<string, GitCommitCompareResult>>(new Map())
  const isMac = getRendererAppPlatform() === 'darwin'

  useEffect(() => {
    commitCompareCacheRef.current = new Map()
  }, [context])

  const resolveSplitTargetGroupId = useCallback(
    (event?: SourceControlRowOpenEvent): string | undefined => {
      if (!event || !activeWorktreeId || !isSourceControlSplitOpenModifier(event, isMac)) {
        return undefined
      }
      const sourceGroupId =
        activeGroupIdByWorktree?.[activeWorktreeId] ?? groupsByWorktree?.[activeWorktreeId]?.[0]?.id
      if (!sourceGroupId) {
        return undefined
      }
      return createEmptySplitGroup(activeWorktreeId, sourceGroupId, 'right') ?? undefined
    },
    [activeGroupIdByWorktree, activeWorktreeId, createEmptySplitGroup, groupsByWorktree, isMac]
  )

  const loadCommitFiles = useCallback(
    async (item: GitHistoryItem): Promise<GitBranchChangeEntry[]> => {
      const cached = getCachedCommitCompare(commitCompareCacheRef.current, item.id)
      if (cached) {
        return cached.entries
      }
      const result = await getRuntimeGitCommitCompare(context, item.id)
      if (result.summary.status !== 'ready') {
        throw new Error(result.summary.errorMessage ?? 'Failed to load commit diff')
      }
      cacheCommitCompare(commitCompareCacheRef.current, item.id, result)
      return result.entries
    },
    [context]
  )

  const openHistoryCommitDiff = useCallback(
    async (item: GitHistoryItem): Promise<void> => {
      try {
        const entries = await loadCommitFiles(item)
        const cached = getCachedCommitCompare(commitCompareCacheRef.current, item.id)
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
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : translate(
                'auto.components.right.sidebar.SourceControl.8a5ba6a988',
                'Failed to load commit diff'
              )
        )
      }
    },
    [diffWorktreeId, loadCommitFiles, openCommitAllDiffs, worktreePath]
  )

  const openCommitFile = useCallback(
    (item: GitHistoryItem, entry: GitBranchChangeEntry, event?: SourceControlRowOpenEvent) => {
      const cached = getCachedCommitCompare(commitCompareCacheRef.current, item.id)
      if (!cached) {
        return
      }
      const targetGroupId = resolveSplitTargetGroupId(event)
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
        detectLanguage(entry.path),
        { targetGroupId, preview: shouldOpenSourceControlRowAsPreview(event, targetGroupId) }
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
    [diffWorktreeId, onOpenVisibleFile, openCommitDiff, resolveSplitTargetGroupId, worktreePath]
  )

  return { loadCommitFiles, openHistoryCommitDiff, openCommitFile }
}
