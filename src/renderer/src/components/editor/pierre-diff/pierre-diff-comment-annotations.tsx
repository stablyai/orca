import { translate } from '@/i18n/i18n'
import type { AppState } from '@/store/types'
import type { DiffCommentOwner } from '@/store/slices/diff-comments/diff-comment-owner'
import type { GitHubImageIntake } from '@/components/github/use-github-image-uploads'
import type { DiffLineAnnotation } from '@pierre/diffs'
import { getDiffCommentLineLabel } from '@/lib/source-control/review/comments/diff-comment-compat'
import { DiffCommentCard } from '../../diff-comments/DiffCommentCard'
import { DiffCommentDraftCard } from '../../diff-comments/DiffCommentDraftCard'
import { getSingleCommentSendScopes } from '../../diff-comments/diff-comment-send-scopes'
import type { DecoratedDiffComment } from '../../diff-comments/decorated-diff-comment'
import { NotesSendMenu } from '@/components/editor/review-note-delivery/NotesSendMenu'

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
  filePath: string,
  draft?: { lineNumber: number; startLine?: number } | null,
  lineCount: number = Infinity
): PierreDiffCommentAnnotation[] {
  const annotations: PierreDiffCommentAnnotation[] = comments
    .filter((comment) => comment.filePath === filePath)
    .map((comment) => ({
      side: 'additions',
      lineNumber: Math.max(1, Math.min(comment.lineNumber, lineCount)),
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
    commentOwner,
    imageUploadAddress,
    filePath,
    activeGroupId,
    formatCommentPrompt,
    onDeleteComment,
    onUpdateComment,
    clearDeliveredDiffComments,
    draftPlaceholder,
    draftSubmitLabel,
    onCancelDraft,
    onSubmitDraft,
    retainKey
  }: {
    worktreeId: string
    commentOwner?: DiffCommentOwner | null
    imageUploadAddress?: GitHubImageIntake['address']
    filePath: string
    activeGroupId: string
    formatCommentPrompt?: (comment: DecoratedDiffComment) => string
    onDeleteComment: (commentId: string) => void
    onUpdateComment?: (commentId: string, body: string) => Promise<boolean>
    clearDeliveredDiffComments: AppState['clearDeliveredDiffComments']
    draftPlaceholder?: string
    draftSubmitLabel?: string
    onCancelDraft?: () => void
    onSubmitDraft?: (body: string) => Promise<boolean>
    /** Scope for drafts that must outlive this row; omit to keep them only while mounted. */
    retainKey?: string
  }
): React.ReactNode {
  const data = annotation.metadata
  if (!data) {
    return null
  }
  if (data.kind === 'draft') {
    return onSubmitDraft && onCancelDraft ? (
      <DiffCommentDraftCard
        lineNumber={data.lineNumber}
        startLine={data.startLine}
        placeholder={draftPlaceholder}
        submitLabel={draftSubmitLabel}
        imageUploadAddress={imageUploadAddress}
        retainKey={
          retainKey &&
          `${retainKey}:compose:${data.startLine ?? data.lineNumber}-${data.lineNumber}`
        }
        onCancel={onCancelDraft}
        onSubmit={onSubmitDraft}
      />
    ) : null
  }
  const comment = data.comment

  return (
    <DiffCommentCard
      commentId={comment.id}
      lineNumber={comment.lineNumber}
      startLine={comment.startLine}
      label={comment.author ? getDiffCommentLineLabel(comment).toLowerCase() : undefined}
      body={comment.body}
      sentAt={comment.sentAt}
      author={comment.author}
      createdAtLabel={comment.createdAtLabel}
      url={comment.url}
      retainKey={retainKey && `${retainKey}:edit:${comment.id}`}
      onDelete={comment.canDelete === false ? undefined : () => onDeleteComment(comment.id)}
      onSubmitEdit={
        onUpdateComment && comment.canEdit !== false
          ? (body) => onUpdateComment(comment.id, body)
          : undefined
      }
      headerActions={
        worktreeId && comment.author === undefined ? (
          <NotesSendMenu
            owner={commentOwner ?? null}
            worktreeId={worktreeId}
            groupId={activeGroupId}
            modeIdParts={['diff-comment-note', worktreeId, filePath, comment.id]}
            scopes={getSingleCommentSendScopes(comment, formatCommentPrompt)}
            targetModeLabel={translate(
              'auto.components.diff.comments.useDiffCommentDecorator.995fa28b50',
              'This note'
            )}
            triggerClassName="orca-diff-comment-edit"
            disabledTooltip={translate(
              'auto.components.diff.comments.diffCommentZoneCard.noteAlreadySent',
              'Note already sent'
            )}
            onDelivered={(notes) =>
              void (commentOwner && clearDeliveredDiffComments(commentOwner, notes))
            }
          />
        ) : undefined
      }
    />
  )
}
