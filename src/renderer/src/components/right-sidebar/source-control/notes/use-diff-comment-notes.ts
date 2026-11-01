import { useAppStore, type AppState } from '@/store'
import { readOwnedDiffComments } from '@/store/diff-comment-owner'
import { withoutMarkdownReviewNotes } from '@/lib/markdown-review-notes-setting'
import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { formatDiffComments } from '@/lib/diff-comments-format'
import { describeClipboardWriteFailure } from '@/lib/clipboard-write-failure'
import { useVisibleWorktreeDiffComments } from '../../../diff-comments/use-visible-worktree-diff-comments'
import {
  countPendingDiffCommentsClear,
  formatPendingDiffCommentsClearDescription,
  resolvePendingDiffCommentsClear,
  type PendingDiffCommentsClear
} from './diff-comments-clear-dialog-state'
import { useCopyFeedbackState } from './copy-feedback'

export function useSourceControlDiffCommentNotes({
  activeWorktreeId,
  clearDiffComments,
  clearDiffCommentsForFile
}: {
  activeWorktreeId: string | null
  clearDiffComments: AppState['clearDiffComments']
  clearDiffCommentsForFile: AppState['clearDiffCommentsForFile']
}) {
  const { comments: diffCommentsForActive, markdownReviewNotesEnabled } =
    useVisibleWorktreeDiffComments(activeWorktreeId)
  const diffCommentCount = diffCommentsForActive.length
  // Index counts once so each row need not refilter every comment.
  const diffCommentCountByPath = useMemo(() => {
    const map = new Map<string, number>()
    for (const c of diffCommentsForActive) {
      map.set(c.filePath, (map.get(c.filePath) ?? 0) + 1)
    }
    return map
  }, [diffCommentsForActive])
  const diffCommentsPrompt = useMemo(
    () => formatDiffComments(diffCommentsForActive),
    [diffCommentsForActive]
  )
  const [diffCommentsExpanded, setDiffCommentsExpanded] = useState(false)
  const [diffCommentsCopied, showDiffCommentsCopied] = useCopyFeedbackState(false)
  const [pendingDiffCommentsClear, setPendingDiffCommentsClear] =
    useState<PendingDiffCommentsClear | null>(null)
  const [isClearingDiffComments, setIsClearingDiffComments] = useState(false)
  // Reset during render so workspace switches cannot paint the old confirmation.
  const [notesWorktreeId, setNotesWorktreeId] = useState(activeWorktreeId)
  if (notesWorktreeId !== activeWorktreeId) {
    setNotesWorktreeId(activeWorktreeId)
    setPendingDiffCommentsClear(null)
    setIsClearingDiffComments(false)
  }
  const handleCopyDiffComments = useCallback(async (): Promise<void> => {
    if (diffCommentsForActive.length === 0) {
      return
    }
    try {
      await window.api.ui.writeClipboardText(diffCommentsPrompt)
      showDiffCommentsCopied(true)
    } catch (error) {
      // Report rejected writes (sender/size guards) so failed copies cannot look successful until paste.
      toast.error(
        translate(
          'auto.components.right.sidebar.SourceControl.diffCommentNotesCopyFailed',
          'Failed to copy notes'
        ),
        { description: describeClipboardWriteFailure(error) }
      )
    }
  }, [diffCommentsForActive, diffCommentsPrompt, showDiffCommentsCopied])

  // Count the captured copy's notes, whichever twin is selected now; a copy gone since opening keeps its count so confirming reports the failure.
  const ownedComments = useAppStore((s) =>
    pendingDiffCommentsClear ? readOwnedDiffComments(s, pendingDiffCommentsClear.owner) : undefined
  )
  const pendingDiffCommentsClearCount = useMemo(() => {
    if (!pendingDiffCommentsClear || pendingDiffCommentsClear.worktreeId !== activeWorktreeId) {
      return 0
    }
    if (!ownedComments) {
      return pendingDiffCommentsClear.count
    }
    return countPendingDiffCommentsClear(
      pendingDiffCommentsClear,
      activeWorktreeId,
      markdownReviewNotesEnabled ? ownedComments : withoutMarkdownReviewNotes(ownedComments)
    )
  }, [activeWorktreeId, markdownReviewNotesEnabled, ownedComments, pendingDiffCommentsClear])

  const resolvedPendingDiffCommentsClear = resolvePendingDiffCommentsClear({
    activeWorktreeId,
    isClearing: isClearingDiffComments,
    pending: pendingDiffCommentsClear,
    pendingCount: pendingDiffCommentsClearCount
  })
  if (resolvedPendingDiffCommentsClear !== pendingDiffCommentsClear) {
    // Clear impossible local confirmations before children see a stale dialog.
    setPendingDiffCommentsClear(resolvedPendingDiffCommentsClear)
  }

  const pendingDiffCommentsClearDescription = formatPendingDiffCommentsClearDescription(
    resolvedPendingDiffCommentsClear,
    pendingDiffCommentsClearCount
  )

  const handleConfirmDiffCommentsClear = useCallback(async (): Promise<void> => {
    const pending = resolvedPendingDiffCommentsClear
    if (!pending || isClearingDiffComments || pending.worktreeId !== activeWorktreeId) {
      return
    }
    if (pendingDiffCommentsClearCount === 0) {
      setPendingDiffCommentsClear(null)
      return
    }
    setIsClearingDiffComments(true)
    const clearOptions = { keepMarkdownNotes: !markdownReviewNotesEnabled }
    try {
      const ok =
        pending.kind === 'all'
          ? await clearDiffComments(pending.owner, clearOptions)
          : await clearDiffCommentsForFile(pending.owner, pending.filePath, clearOptions)
      if (ok) {
        setPendingDiffCommentsClear(null)
      } else {
        toast.error(
          translate(
            'auto.components.right.sidebar.SourceControl.eae7a1da5f',
            'Failed to clear notes.'
          )
        )
      }
    } finally {
      setIsClearingDiffComments(false)
    }
  }, [
    activeWorktreeId,
    clearDiffComments,
    clearDiffCommentsForFile,
    isClearingDiffComments,
    markdownReviewNotesEnabled,
    resolvedPendingDiffCommentsClear,
    pendingDiffCommentsClearCount
  ])

  return {
    diffCommentCount,
    diffCommentCountByPath,
    diffCommentsCopied,
    diffCommentsExpanded,
    diffCommentsForActive,
    handleConfirmDiffCommentsClear,
    handleCopyDiffComments,
    isClearingDiffComments,
    pendingDiffCommentsClearCount,
    pendingDiffCommentsClearDescription,
    resolvedPendingDiffCommentsClear,
    setDiffCommentsExpanded,
    setPendingDiffCommentsClear
  }
}

export type SourceControlDiffCommentNotes = ReturnType<typeof useSourceControlDiffCommentNotes>
