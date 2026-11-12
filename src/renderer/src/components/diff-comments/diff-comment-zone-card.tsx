import type { GitHubImageIntake } from '@/components/github/use-github-image-uploads'
import type { DiffCommentOwner } from '@/store/slices/diff-comments/diff-comment-owner'
import type { RefObject } from 'react'
import type { Root } from 'react-dom/client'
import { formatDiffComments } from '../../../../shared/diff-comments-format'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { DiffCommentDeliverySnapshot } from '@/store/slices/diff-comments/create-diff-comments-slice'
import { DiffCommentCard } from './DiffCommentCard'
import { DiffCommentDraftCard } from './DiffCommentDraftCard'
import type { DecoratedDiffComment } from './decorated-diff-comment'
import {
  NotesSendMenu,
  type NotesSendMenuScope
} from '../editor/review-note-delivery/NotesSendMenu'
import { translate } from '@/i18n/i18n'
import { TranslationScopeProvider } from '@/i18n/translation-scope-provider'
import type { DiffCommentComposerSession, DiffCommentFileSession } from './diff-comment-session'

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
      formatPrompt: () =>
        formatCommentPrompt ? formatCommentPrompt(comment) : formatDiffComments([comment])
    }
  ]
}

// Callbacks arrive as refs so the rendered props keep the decorator's identity semantics.
export type DiffCommentZoneCardContext = {
  owner: DiffCommentOwner | null
  worktreeId: string
  filePath: string
  activeGroupId: string
  formatCommentPrompt?: (comment: DecoratedDiffComment) => string
  resizeZone: (commentId: string) => void
  lifetime?: AbortSignal
  preventScrollOnFocus?: boolean
  session?: DiffCommentFileSession
  onDeleteCommentRef: RefObject<(commentId: string) => void>
  onUpdateCommentRef: RefObject<((commentId: string, body: string) => Promise<boolean>) | undefined>
  clearDeliveredDiffComments: (
    owner: DiffCommentOwner,
    comments: readonly DiffCommentDeliverySnapshot[]
  ) => Promise<boolean>
}

export function renderDiffCommentZoneCard(
  root: Root,
  comment: DecoratedDiffComment,
  {
    owner,
    worktreeId,
    filePath,
    activeGroupId,
    formatCommentPrompt,
    resizeZone,
    lifetime,
    preventScrollOnFocus,
    session,
    onDeleteCommentRef,
    onUpdateCommentRef,
    clearDeliveredDiffComments
  }: DiffCommentZoneCardContext
): void {
  root.render(
    // View zones are separate React roots outside the app root, so App.tsx context providers don't reach them.
    <TranslationScopeProvider>
      <TooltipProvider>
        <DiffCommentCard
          session={session}
          commentId={comment.id}
          lifetime={lifetime}
          preventScrollOnFocus={preventScrollOnFocus}
          lineNumber={comment.lineNumber}
          startLine={comment.startLine}
          body={comment.body}
          sentAt={comment.sentAt}
          author={comment.author}
          createdAtLabel={comment.createdAtLabel}
          url={comment.url}
          onDelete={
            comment.canDelete === false
              ? undefined
              : () => {
                  if (!lifetime?.aborted) {
                    onDeleteCommentRef.current(comment.id)
                  }
                }
          }
          onSubmitEdit={
            onUpdateCommentRef.current && comment.canEdit !== false
              ? (body) => {
                  if (lifetime?.aborted) {
                    return Promise.resolve(false)
                  }
                  const fn = onUpdateCommentRef.current
                  if (!fn) {
                    return Promise.resolve(false)
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
                owner={owner}
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
                onDelivered={(notes) => void (owner && clearDeliveredDiffComments(owner, notes))}
              />
            ) : null
          }
        />
      </TooltipProvider>
    </TranslationScopeProvider>
  )
}

export type DiffCommentDraftCardContext = {
  imageUploadAddress?: GitHubImageIntake['address']
  placeholder?: string
  submitLabel?: string
  submittingLabel?: string
  initialBody?: string
  onBodyChange?: (body: string) => void
  resizeZone: () => void
  onCancel: () => void
  onSubmit: (body: string) => Promise<boolean>
  autoFocus?: boolean
  lifetime?: AbortSignal
  session?: DiffCommentComposerSession
}

export function renderDiffCommentDraftCard(
  root: Root,
  draft: { lineNumber: number; startLine?: number },
  {
    imageUploadAddress,
    placeholder,
    submitLabel,
    submittingLabel,
    initialBody,
    onBodyChange,
    resizeZone,
    onCancel,
    onSubmit,
    autoFocus,
    lifetime,
    session
  }: DiffCommentDraftCardContext
): void {
  root.render(
    <TranslationScopeProvider>
      <TooltipProvider>
        <DiffCommentDraftCard
          session={session}
          autoFocus={autoFocus}
          lifetime={lifetime}
          imageUploadAddress={imageUploadAddress}
          lineNumber={draft.lineNumber}
          startLine={draft.startLine}
          placeholder={placeholder}
          submitLabel={submitLabel}
          submittingLabel={submittingLabel}
          initialBody={initialBody}
          onBodyChange={onBodyChange}
          onCancel={onCancel}
          onSubmit={onSubmit}
          onContentResize={resizeZone}
        />
      </TooltipProvider>
    </TranslationScopeProvider>
  )
}
