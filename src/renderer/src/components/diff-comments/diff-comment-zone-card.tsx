import type { RefObject } from 'react'
import type { Root } from 'react-dom/client'
import { getDiffCommentLineLabel } from '@/lib/diff-comment-compat'
import { formatDiffComments } from '@/lib/diff-comments-format'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { DiffCommentDeliverySnapshot } from '@/store/slices/diffComments'
import { DiffCommentCard } from './DiffCommentCard'
import type { DecoratedDiffComment } from './decorated-diff-comment'
import { NotesSendMenu, type NotesSendMenuScope } from '../editor/NotesSendMenu'
import { translate } from '@/i18n/i18n'

export function getRenderSignature(
  comment: DecoratedDiffComment,
  formatCommentPrompt?: (comment: DecoratedDiffComment) => string
): string {
  return JSON.stringify({
    body: comment.body,
    sentAt: comment.sentAt ?? null,
    author: comment.author ?? null,
    authorAvatarUrl: comment.authorAvatarUrl ?? null,
    createdAtLabel: comment.createdAtLabel ?? null,
    url: comment.url ?? null,
    canDelete: comment.canDelete ?? null,
    canEdit: comment.canEdit ?? null,
    sendPrompt: formatCommentPrompt ? formatCommentPrompt(comment) : null
  })
}

function getSingleCommentSendScopes(
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

// Callbacks arrive as refs so the rendered props keep the decorator's identity semantics.
export type DiffCommentZoneCardContext = {
  worktreeId: string
  filePath: string
  activeGroupId: string
  formatCommentPrompt?: (comment: DecoratedDiffComment) => string
  resizeZone: (commentId: string) => void
  onDeleteCommentRef: RefObject<(commentId: string) => void>
  onUpdateCommentRef: RefObject<((commentId: string, body: string) => Promise<boolean>) | undefined>
  clearDeliveredDiffComments: (
    worktreeId: string,
    comments: readonly DiffCommentDeliverySnapshot[]
  ) => Promise<boolean>
}

export function renderDiffCommentZoneCard(
  root: Root,
  comment: DecoratedDiffComment,
  {
    worktreeId,
    filePath,
    activeGroupId,
    formatCommentPrompt,
    resizeZone,
    onDeleteCommentRef,
    onUpdateCommentRef,
    clearDeliveredDiffComments
  }: DiffCommentZoneCardContext
): void {
  root.render(
    // View zones are separate React roots outside the app root, so App.tsx context providers don't reach them.
    <TooltipProvider delayDuration={400}>
      <DiffCommentCard
        lineNumber={comment.lineNumber}
        startLine={comment.startLine}
        label={comment.author ? getDiffCommentLineLabel(comment).toLowerCase() : undefined}
        body={comment.body}
        sentAt={comment.sentAt}
        author={comment.author}
        createdAtLabel={comment.createdAtLabel}
        url={comment.url}
        onDelete={
          comment.canDelete === false ? undefined : () => onDeleteCommentRef.current(comment.id)
        }
        onSubmitEdit={
          onUpdateCommentRef.current && comment.canEdit !== false
            ? async (body) => {
                const fn = onUpdateCommentRef.current
                if (!fn) {
                  return false
                }
                return fn(comment.id, body)
              }
            : undefined
        }
        onContentResize={() => resizeZone(comment.id)}
        observeRenderedSize
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
          ) : null
        }
      />
    </TooltipProvider>
  )
}
