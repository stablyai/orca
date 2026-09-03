import type { DiffLineAnnotation } from '@pierre/diffs'
import { getDiffCommentLineLabel } from '@/lib/diff-comment-compat'
import { DiffCommentCard } from '../../diff-comments/DiffCommentCard'
import { DiffCommentPopover } from '../../diff-comments/DiffCommentPopover'
import { getSingleCommentSendScopes } from '../../diff-comments/diff-comment-send-scopes'
import type { DecoratedDiffComment } from '../../diff-comments/decorated-diff-comment'
import type { DiffCommentDeliverySnapshot } from '@/store/slices/diffComments'
import { NotesSendMenu } from '../NotesSendMenu'

/** A saved note, or the draft the gutter affordance just opened. */
export type PierreDiffAnnotationData =
  | { kind: 'comment'; comment: DecoratedDiffComment }
  | { kind: 'draft'; lineNumber: number; startLine?: number }

export type PierreDiffCommentAnnotation = DiffLineAnnotation<PierreDiffAnnotationData>

/**
 * Notes live on the modified side, which Pierre calls `additions`. Pierre
 * measures annotation rows itself, so unlike the Monaco view zones these
 * replace, no height bookkeeping is needed.
 */
export function buildPierreDiffCommentAnnotations(
  comments: readonly DecoratedDiffComment[],
  draft?: { lineNumber: number; startLine?: number } | null
): PierreDiffCommentAnnotation[] {
  const annotations: PierreDiffCommentAnnotation[] = comments.map((comment) => ({
    side: 'additions',
    lineNumber: comment.lineNumber,
    metadata: { kind: 'comment', comment }
  }))
  if (draft) {
    annotations.push({
      side: 'additions',
      lineNumber: draft.lineNumber,
      metadata: { kind: 'draft', lineNumber: draft.lineNumber, startLine: draft.startLine }
    })
  }
  return annotations
}

export function renderPierreDiffCommentAnnotation(
  annotation: PierreDiffCommentAnnotation,
  {
    worktreeId,
    filePath,
    activeGroupId,
    formatCommentPrompt,
    onDeleteComment,
    onUpdateComment,
    clearDeliveredDiffComments,
    draftPlaceholder,
    draftSubmitLabel,
    onCancelDraft,
    onSubmitDraft
  }: {
    worktreeId: string
    filePath: string
    activeGroupId: string
    formatCommentPrompt?: (comment: DecoratedDiffComment) => string
    onDeleteComment: (commentId: string) => void
    onUpdateComment?: (commentId: string, body: string) => Promise<boolean>
    clearDeliveredDiffComments: (
      worktreeId: string,
      comments: readonly DiffCommentDeliverySnapshot[]
    ) => Promise<boolean>
    draftPlaceholder?: string
    draftSubmitLabel?: string
    onCancelDraft?: () => void
    onSubmitDraft?: (body: string) => Promise<void>
  }
): React.ReactNode {
  const data = annotation.metadata
  if (!data) {
    return null
  }
  if (data.kind === 'draft') {
    return onSubmitDraft && onCancelDraft ? (
      <DiffCommentPopover
        lineNumber={data.lineNumber}
        startLine={data.startLine}
        placeholder={draftPlaceholder}
        submitLabel={draftSubmitLabel}
        submittingLabel="Posting…"
        layout="inline"
        onCancel={onCancelDraft}
        onSubmit={onSubmitDraft}
      />
    ) : null
  }
  const comment = data.comment

  return (
    <DiffCommentCard
      lineNumber={comment.lineNumber}
      startLine={comment.startLine}
      label={comment.author ? getDiffCommentLineLabel(comment).toLowerCase() : undefined}
      body={comment.body}
      sentAt={comment.sentAt}
      author={comment.author}
      createdAtLabel={comment.createdAtLabel}
      url={comment.url}
      onDelete={comment.canDelete === false ? undefined : () => onDeleteComment(comment.id)}
      onSubmitEdit={
        onUpdateComment && comment.canEdit !== false
          ? (body) => onUpdateComment(comment.id, body)
          : undefined
      }
      headerActions={
        worktreeId && comment.author === undefined ? (
          <NotesSendMenu
            worktreeId={worktreeId}
            groupId={activeGroupId}
            modeIdParts={['diff-comment-note', worktreeId, filePath, comment.id]}
            scopes={getSingleCommentSendScopes(comment, formatCommentPrompt)}
            targetModeLabel="This note"
            triggerClassName="orca-diff-comment-edit"
            disabledTooltip="Note already sent"
            onDelivered={(notes) => void clearDeliveredDiffComments(worktreeId, notes)}
          />
        ) : undefined
      }
    />
  )
}
