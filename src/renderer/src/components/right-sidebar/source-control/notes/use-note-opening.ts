import { useCallback, useRef, type RefObject } from 'react'
import { detectLanguage } from '@/lib/language-detect'
import { getDiffCommentSource } from '@/lib/diff-comment-compat'
import { joinPath } from '@/lib/path'
import { useAppStore } from '@/store'
import type {
  GitBranchChangeEntry,
  GitBranchCompareSummary
} from '../../../../../../shared/git-diff-compare-types'
import type { DiffComment } from '../../../../../../shared/diff-comment-types'
import type { GitStatusEntry } from '../../../../../../shared/git-status-types'
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
  const openFile = useAppStore((s) => s.openFile)
  const setEditorViewMode = useAppStore((s) => s.setEditorViewMode)
  const setMarkdownViewMode = useAppStore((s) => s.setMarkdownViewMode)
  const setPendingEditorReveal = useAppStore((s) => s.setPendingEditorReveal)
  const setScrollToDiffCommentId = useAppStore((s) => s.setScrollToDiffCommentId)
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
      // Clear any dangling prior scroll request; only the diff branches below re-stamp it.
      cancelSourceControlEditorRevealFrames(pendingCommentEditorRevealFrameIdsRef)
      setScrollToDiffCommentId(null)
      if (getDiffCommentSource(comment) === 'markdown') {
        const absPath = joinPath(worktreePath, filePath)
        const language = detectLanguage(filePath)
        setEditorViewMode(absPath, 'edit')
        setMarkdownViewMode(absPath, 'source')
        openFile({
          filePath: absPath,
          relativePath: filePath,
          worktreeId: activeWorktreeId,
          language,
          mode: 'edit'
        })
        setPendingEditorReveal(null)
        requestSourceControlEditorRevealFrame(pendingCommentEditorRevealFrameIdsRef, () => {
          requestSourceControlEditorRevealFrame(pendingCommentEditorRevealFrameIdsRef, () => {
            setPendingEditorReveal({
              filePath: absPath,
              line: comment.lineNumber,
              column: 1,
              matchLength: 0
            })
            setScrollToDiffCommentId(commentId)
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
          setScrollToDiffCommentId(commentId)
        }
        return
      }
      const branchEntry = branchEntries.find((e) => e.path === filePath)
      if (branchEntry && branchSummary?.status === 'ready') {
        openCommittedDiff(branchEntry)
        if (commentId) {
          setScrollToDiffCommentId(commentId)
        }
        return
      }
      // If both diffs lost the file, open changes-mode editor fallback so DiffViewer can consume the reveal request.
      const absPath = joinPath(worktreePath, filePath)
      const language = detectLanguage(filePath)
      openFile({
        filePath: absPath,
        relativePath: filePath,
        worktreeId: activeWorktreeId,
        language,
        mode: 'edit'
      })
      if (commentId) {
        setEditorViewMode(absPath, 'changes')
        setScrollToDiffCommentId(commentId)
      }
    },
    [
      activeWorktreeId,
      branchEntries,
      branchSummary,
      entries,
      handleOpenDiff,
      openCommittedDiff,
      openFile,
      setEditorViewMode,
      setScrollToDiffCommentId,
      setMarkdownViewMode,
      setPendingEditorReveal,
      worktreePath
    ]
  )
  return { handleOpenComment, setSourceControlRoot }
}
