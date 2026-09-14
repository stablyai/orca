import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { formatDiffComments } from '@/lib/diff-comments-format'
import { useAppStore } from '@/store'
import { selectWorktreeDiffCommentsOrEmpty } from '@/store/worktree-diff-comments-selector'
import {
  countPendingDiffCommentsClear,
  formatPendingDiffCommentsClearDescription,
  resolvePendingDiffCommentsClear,
  type PendingDiffCommentsClear
} from './diff-comments-clear-dialog-state'
import { useCopyFeedbackState } from './copy-feedback'

/**
 * Owns the diff-comment ("notes") shelf state for the active worktree: the comment projection, the
 * clipboard copy affordance and the clear-notes confirmation lifecycle.
 */
export function useSourceControlDiffCommentNotes({
  activeWorktreeId,
  clearDiffComments,
  clearDiffCommentsForFile
}: {
  activeWorktreeId: string | null
  clearDiffComments: (worktreeId: string) => Promise<boolean>
  clearDiffCommentsForFile: (worktreeId: string, filePath: string) => Promise<boolean>
}) {
  // Why: pass activeWorktreeId even when null so the selector returns its stable empty sentinel; an inline [] would break Zustand's Object.is and churn.
  const diffCommentsForActive = useAppStore((s) =>
    selectWorktreeDiffCommentsOrEmpty(s, activeWorktreeId)
  )
  const diffCommentCount = diffCommentsForActive.length
  // Why: compute per-file comment counts once per render so rows don't each re-filter the full list.
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
  // Why: reset during render so a worktree switch never paints the previous confirmation.
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
    } catch {
      // Why: swallow — clipboard write can fail when unfocused; best-effort copy needs no error surface.
    }
  }, [diffCommentsForActive, diffCommentsPrompt, showDiffCommentsCopied])

  const pendingDiffCommentsClearCount = useMemo(() => {
    return countPendingDiffCommentsClear(
      pendingDiffCommentsClear,
      activeWorktreeId,
      diffCommentsForActive
    )
  }, [activeWorktreeId, diffCommentsForActive, pendingDiffCommentsClear])

  const resolvedPendingDiffCommentsClear = resolvePendingDiffCommentsClear({
    activeWorktreeId,
    isClearing: isClearingDiffComments,
    pending: pendingDiffCommentsClear,
    pendingCount: pendingDiffCommentsClearCount
  })
  if (resolvedPendingDiffCommentsClear !== pendingDiffCommentsClear) {
    // Why: the confirmation is local UI state; clear impossible ones before children observe a stale open dialog.
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
    try {
      const ok =
        pending.kind === 'all'
          ? await clearDiffComments(pending.worktreeId)
          : await clearDiffCommentsForFile(pending.worktreeId, pending.filePath)
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
