import { useAppStateValue } from '@/store/retained-views/app-state-view'
import { useDiffCommentView } from './use-diff-comment-owner'
import type { DiffCommentOwner } from '@/store/slices/diff-comments/diff-comment-owner'
import type { WorkspaceCopySource } from '@/lib/workspace/ownership/workspace-copy-owner'
import { useMemo } from 'react'
import {
  isMarkdownReviewNotesEnabled,
  withoutMarkdownReviewNotes
} from '@/lib/editor/markdown/review-notes/markdown-review-notes-setting'
import type { DiffComment } from '../../../../shared/diff-comment-types'

const NO_COMMENTS: DiffComment[] = []

export function useVisibleWorktreeDiffComments(
  worktreeId: string | null | undefined,
  source: WorkspaceCopySource
): {
  owner: DiffCommentOwner | null
  comments: DiffComment[]
  /** False while the copy is unknown or not listed: no notes are shown, which is not "none". */
  known: boolean
  markdownReviewNotesEnabled: boolean
} {
  const { owner, comments: listed } = useDiffCommentView(worktreeId, source)
  // Unknown copies still need a stable empty list; inline arrays would churn memoized consumers.
  const allComments = listed ?? NO_COMMENTS
  const markdownReviewNotesEnabled = useAppStateValue((s) =>
    isMarkdownReviewNotesEnabled(s.settings)
  )
  const comments = useMemo(
    () => (markdownReviewNotesEnabled ? allComments : withoutMarkdownReviewNotes(allComments)),
    [allComments, markdownReviewNotesEnabled]
  )
  return { owner, comments, known: listed !== undefined, markdownReviewNotesEnabled }
}
