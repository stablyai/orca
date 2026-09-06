import { formatDiffComments } from '@/lib/diff-comments-format'
import { translate } from '@/i18n/i18n'
import type { NotesSendMenuScope } from '../editor/NotesSendMenu'
import type { DecoratedDiffComment } from './decorated-diff-comment'

/** Send-menu scope for a single note, shared by every diff annotation surface. */
export function getSingleCommentSendScopes(
  comment: DecoratedDiffComment,
  formatCommentPrompt?: (comment: DecoratedDiffComment) => string
): NotesSendMenuScope<DecoratedDiffComment>[] {
  return [
    {
      id: 'note',
      label: translate(
        'auto.components.diff.comments.useDiffCommentDecorator.995fa28b50',
        'This note'
      ),
      notes: comment.sentAt ? [] : [comment],
      prompt: formatCommentPrompt ? formatCommentPrompt(comment) : formatDiffComments([comment])
    }
  ]
}
