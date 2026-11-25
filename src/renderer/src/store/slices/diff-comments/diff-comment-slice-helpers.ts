import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { AppState } from '../../types'
import type { DiffComment } from '../../../../../shared/file-review/diff-comment-types'
import type { DiffCommentOwner } from './diff-comment-owner'
import type { DiffCommentDeliverySnapshot } from './create-diff-comments-slice'
import { admitFolderNoteAction } from './folder-note-protection'

export function deliverySnapshotMatches(
  comment: DiffComment,
  snapshot: DiffCommentDeliverySnapshot
): boolean {
  return (
    comment.id === snapshot.id &&
    comment.body === snapshot.body &&
    comment.filePath === snapshot.filePath &&
    comment.lineNumber === snapshot.lineNumber &&
    comment.startLine === snapshot.startLine &&
    comment.selectedText === snapshot.selectedText &&
    comment.source === snapshot.source
  )
}

// Why: best-effort telemetry runs only after the note is on disk, so a throw here must not report a failed save.
export function recordReviewNoteInteraction(get: () => AppState): void {
  try {
    get().recordFeatureInteraction?.('review-notes')
  } catch (err) {
    console.error('Failed to record review-notes interaction:', err)
  }
}

// Why: refused before the change is shown, so a full recovery backlog never displays a note it won't send.
export function backlogFull(owner: DiffCommentOwner): boolean {
  if (admitFolderNoteAction(owner)) {
    return false
  }
  console.error('Review notes were not changed: too many unsaved changes are still waiting.')
  return true
}

// Why: a copy gone since the user acted fails once, never on another copy. Add and clear callers already report their failures.
export function reportLostDiffCommentOwner(action: 'save' | 'clear'): void {
  console.error('Review notes were not changed: the workspace copy they belong to is gone.')
  toast.error(
    action === 'save'
      ? translate('auto.components.editor.diffCommentSaveFailed', 'Failed to save comment')
      : translate(
          'auto.components.right.sidebar.SourceControl.eae7a1da5f',
          'Failed to clear notes.'
        )
  )
}
