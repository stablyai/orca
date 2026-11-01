import React, { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { formatDiffComments } from '@/lib/diff-comments-format'
import { translate } from '@/i18n/i18n'
import type { DiffComment } from '../../../../../../shared/diff-comment-types'
import type { DiffCommentsClearOptions } from '@/store/slices/diffComments'

export type CombinedDiffNotesActions = {
  clearNotesDialogVisible: boolean
  diffCommentCount: number
  handleConfirmClearNotes: () => Promise<void>
  handleCopyNotes: () => Promise<void>
  isClearingNotes: boolean
  notesCopied: boolean
  previewDiffComments: DiffComment[]
  setClearNotesDialogOpen: React.Dispatch<React.SetStateAction<boolean>>
  setScrollSurfaceMounted: (mounted: boolean) => void
}

export function useCombinedDiffNotesActions({
  clearDiffComments,
  diffCommentsForWorktree,
  markdownReviewNotesEnabled,
  worktreeId
}: {
  clearDiffComments: (worktreeId: string, options?: DiffCommentsClearOptions) => Promise<boolean>
  diffCommentsForWorktree: DiffComment[]
  markdownReviewNotesEnabled: boolean
  worktreeId: string
}): CombinedDiffNotesActions {
  const diffCommentCount = diffCommentsForWorktree.length
  const diffCommentsPrompt = React.useMemo(
    () => formatDiffComments(diffCommentsForWorktree),
    [diffCommentsForWorktree]
  )
  const previewDiffComments = React.useMemo(
    () =>
      [...diffCommentsForWorktree]
        .sort((a, b) => a.filePath.localeCompare(b.filePath) || a.lineNumber - b.lineNumber)
        .slice(0, 4),
    [diffCommentsForWorktree]
  )

  const [clearNotesDialogOpen, setClearNotesDialogOpen] = useState(false)
  const [isClearingNotes, setIsClearingNotes] = useState(false)
  const clearNotesDialogVisible = clearNotesDialogOpen && (diffCommentCount > 0 || isClearingNotes)
  if (clearNotesDialogOpen && !clearNotesDialogVisible) {
    // External note clearing must close the dialog before an empty confirmation can paint.
    setClearNotesDialogOpen(false)
  }
  const [notesCopied, setNotesCopied] = useState(false)
  const mountedRef = useRef(true)
  const notesCopiedResetTimerRef = useRef<number | null>(null)
  // Clipboard IPC may settle after unmount; do not start an orphan feedback timer.
  const notesCopyMountedRef = useRef(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  const clearNotesCopiedResetTimer = useCallback((): void => {
    if (notesCopiedResetTimerRef.current !== null) {
      window.clearTimeout(notesCopiedResetTimerRef.current)
      notesCopiedResetTimerRef.current = null
    }
  }, [])

  const setScrollSurfaceMounted = useCallback(
    (mounted: boolean): void => {
      notesCopyMountedRef.current = mounted
      if (!mounted) {
        // Disable stale copy feedback and cancel its timer at root detach.
        clearNotesCopiedResetTimer()
      }
    },
    [clearNotesCopiedResetTimer]
  )

  const handleCopyNotes = useCallback(async (): Promise<void> => {
    if (diffCommentCount === 0) {
      return
    }
    try {
      await window.api.ui.writeClipboardText(diffCommentsPrompt)
      if (!notesCopyMountedRef.current) {
        return
      }
      clearNotesCopiedResetTimer()
      setNotesCopied(true)
      notesCopiedResetTimerRef.current = window.setTimeout(() => {
        setNotesCopied(false)
        notesCopiedResetTimerRef.current = null
      }, 1500)
    } catch {
      // Why: clipboard writes can fail while the app is unfocused; keep the popover non-blocking.
    }
  }, [clearNotesCopiedResetTimer, diffCommentCount, diffCommentsPrompt])

  const handleConfirmClearNotes = useCallback(async (): Promise<void> => {
    if (diffCommentCount === 0 || isClearingNotes) {
      return
    }
    setIsClearingNotes(true)
    try {
      const ok = await clearDiffComments(worktreeId, {
        keepMarkdownNotes: !markdownReviewNotesEnabled
      })
      if (!mountedRef.current) {
        return
      }
      if (ok) {
        setClearNotesDialogOpen(false)
      } else {
        toast.error(
          translate(
            'auto.components.editor.CombinedDiffViewer.45cf23b418',
            'Failed to clear notes.'
          )
        )
      }
    } finally {
      if (mountedRef.current) {
        setIsClearingNotes(false)
      }
    }
  }, [clearDiffComments, diffCommentCount, isClearingNotes, markdownReviewNotesEnabled, worktreeId])

  return {
    clearNotesDialogVisible,
    diffCommentCount,
    handleConfirmClearNotes,
    handleCopyNotes,
    isClearingNotes,
    notesCopied,
    previewDiffComments,
    setClearNotesDialogOpen,
    setScrollSurfaceMounted
  }
}
