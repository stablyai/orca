import { useCallback, useRef, type RefObject } from 'react'
import { detectLanguage } from '../../../../../../shared/editor-language/editor-language-detect'
import { getDiffCommentSource } from '@/lib/diff-comment-compat'
import { joinPath } from '@/lib/path'
import { useAppStore } from '@/store'
import type {
  GitBranchChangeEntry,
  GitBranchCompareSummary
} from '../../../../../../shared/git/diff/git-diff-compare-types'
import type { DiffComment } from '../../../../../../shared/diff-comment-types'
import type { GitStatusEntry } from '../../../../../../shared/git/status/git-status-types'
import type { OpenFileOptions } from '@/store/slices/editor/types/editor-files-slice'
import {
  sourceControlScopeRuntimeEnvironmentId,
  useSourceControlScope
} from '../panel/worktree-scope'
import {
  cancelSourceControlEditorRevealFrames,
  requestSourceControlEditorRevealFrame
} from './editor-reveal-frames'

export type SourceControlNoteOpening = {
  handleOpenComment: (comment: DiffComment) => void
  setSourceControlRoot: (node: HTMLDivElement | null) => void
}

export function useSourceControlNoteOpening({
  activeWorktreeId,
  worktreePath,
  entries,
  branchEntries,
  branchSummary,
  handleOpenDiff,
  openCommittedDiff,
  sourceControlRef
}: {
  activeWorktreeId: string | null
  worktreePath: string | null
  entries: GitStatusEntry[]
  branchEntries: GitBranchChangeEntry[]
  branchSummary: GitBranchCompareSummary | null
  handleOpenDiff: (entry: GitStatusEntry) => void
  openCommittedDiff: (entry: GitBranchChangeEntry) => void
  sourceControlRef: RefObject<HTMLDivElement | null>
}): SourceControlNoteOpening {
  const scope = useSourceControlScope()
  const placementWorkspaceId = scope?.placementWorkspaceId
  const executionHostId = scope?.executionHostId
  const runtimeEnvironmentId = sourceControlScopeRuntimeEnvironmentId(scope)
  const pendingCommentEditorRevealFrameIdsRef = useRef<number[]>([])
  const setSourceControlRoot = useCallback(
    (node: HTMLDivElement | null) => {
      // Cancel surface-owned reveal frames on ref detach instead of waiting for passive effect cleanup.
      if (node === null) {
        cancelSourceControlEditorRevealFrames(pendingCommentEditorRevealFrameIdsRef)
      }
      sourceControlRef.current = node
    },
    [sourceControlRef]
  )

  // Choose the owning diff by relative path: unstaged, then branch, then editor fallback.
  const handleOpenComment = useCallback(
    (comment: DiffComment) => {
      if (!activeWorktreeId || !worktreePath) {
        return
      }
      const filePath = comment.filePath
      const commentId = comment.id
      // A folder section opens the note in its folder's active group; the file stays the child worktree's.
      const placementGroupId = placementWorkspaceId
        ? useAppStore.getState().activeGroupIdByWorktree[placementWorkspaceId]
        : undefined
      const placement: OpenFileOptions | undefined = placementWorkspaceId
        ? {
            placementWorkspaceId,
            executionHostId,
            ...(placementGroupId ? { targetGroupId: placementGroupId } : {})
          }
        : undefined
      const scopedRuntime = runtimeEnvironmentId === undefined ? {} : { runtimeEnvironmentId }
      // Clear any dangling prior scroll request; only the diff branches below re-stamp it.
      cancelSourceControlEditorRevealFrames(pendingCommentEditorRevealFrameIdsRef)
      useAppStore.getState().setScrollToDiffCommentId(null)
      if (getDiffCommentSource(comment) === 'markdown') {
        const absPath = joinPath(worktreePath, filePath)
        const language = detectLanguage(filePath)
        useAppStore.getState().setEditorViewMode(absPath, 'edit')
        useAppStore.getState().setMarkdownViewMode(absPath, 'source')
        useAppStore.getState().openFile(
          {
            filePath: absPath,
            relativePath: filePath,
            worktreeId: activeWorktreeId,
            language,
            mode: 'edit',
            ...scopedRuntime
          },
          placement
        )
        useAppStore.getState().setPendingEditorReveal(null)
        requestSourceControlEditorRevealFrame(pendingCommentEditorRevealFrameIdsRef, () => {
          requestSourceControlEditorRevealFrame(pendingCommentEditorRevealFrameIdsRef, () => {
            useAppStore.getState().setPendingEditorReveal({
              filePath: absPath,
              line: comment.lineNumber,
              column: 1,
              matchLength: 0
            })
            useAppStore.getState().setScrollToDiffCommentId(commentId)
          })
        })
        return
      }
      const matches = entries.filter((e) => e.path === filePath)
      const uncommitted =
        matches.find((e) => e.area === 'unstaged') ??
        matches.find((e) => e.area === 'untracked') ??
        matches[0]
      if (uncommitted) {
        handleOpenDiff(uncommitted)
        if (commentId) {
          useAppStore.getState().setScrollToDiffCommentId(commentId)
        }
        return
      }
      const branchEntry = branchEntries.find((e) => e.path === filePath)
      if (branchEntry && branchSummary?.status === 'ready') {
        openCommittedDiff(branchEntry)
        if (commentId) {
          useAppStore.getState().setScrollToDiffCommentId(commentId)
        }
        return
      }
      // If both diffs lost the file, open changes-mode editor fallback so DiffViewer can consume the reveal request.
      const absPath = joinPath(worktreePath, filePath)
      const language = detectLanguage(filePath)
      useAppStore.getState().openFile(
        {
          filePath: absPath,
          relativePath: filePath,
          worktreeId: activeWorktreeId,
          language,
          mode: 'edit',
          ...scopedRuntime
        },
        placement
      )
      if (commentId) {
        useAppStore.getState().setEditorViewMode(absPath, 'changes')
        useAppStore.getState().setScrollToDiffCommentId(commentId)
      }
    },
    [
      activeWorktreeId,
      branchEntries,
      executionHostId,
      placementWorkspaceId,
      runtimeEnvironmentId,
      branchSummary,
      entries,
      handleOpenDiff,
      openCommittedDiff,
      worktreePath
    ]
  )
  return { handleOpenComment, setSourceControlRoot }
}
