import React, { useCallback, useEffect, useState } from 'react'
import { ExternalLink, MoreHorizontal, Pencil, Trash } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { isBotPRComment } from '@/lib/pr-comment-audience'
import {
  PR_COMMENT_OPEN_AUTHOR_CLASS,
  PR_COMMENT_RESOLVED_AUTHOR_CLASS,
  PR_COMMENT_RESOLVED_CONTAINER_CLASS
} from '@/lib/pr-comment-groups'
import { translate } from '@/i18n/i18n'
import {
  buildPRCommentCopyText,
  formatLineRange,
  isMutablePRConversationComment
} from './pr-comment-mutation-model'
import { CopyButton, ResolveButton } from './pr-comment-row-controls'
import type { PRComment } from '../../../../shared/types'

function CommentMoreMenu({
  comment,
  onStartEdit,
  onDelete
}: {
  comment: PRComment
  onStartEdit?: () => void
  onDelete?: () => void | Promise<void>
}): React.JSX.Element | null {
  const hasGoToComment = Boolean(comment.url)
  const hasEdit = Boolean(onStartEdit)
  const hasDelete = Boolean(onDelete)
  if (!hasGoToComment && !hasEdit && !hasDelete) {
    return null
  }

  return (
    <DropdownMenu modal={false}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="shrink-0 rounded p-1 text-muted-foreground/40 transition-colors hover:bg-accent hover:text-foreground"
          aria-label={translate(
            'auto.components.right.sidebar.checks.panel.content.74c6885b8a',
            'More comment actions'
          )}
          title={translate('auto.components.right.sidebar.checks.panel.content.1abb17aac9', 'More')}
          onClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontal className="size-3" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" sideOffset={4}>
        {hasGoToComment && (
          <DropdownMenuItem onSelect={() => window.api.shell.openUrl(comment.url)}>
            <ExternalLink />
            {translate(
              'auto.components.right.sidebar.checks.panel.content.d3923d18fe',
              'Go to comment'
            )}
          </DropdownMenuItem>
        )}
        {hasGoToComment && (hasEdit || hasDelete) ? <DropdownMenuSeparator /> : null}
        {hasEdit ? (
          <DropdownMenuItem
            onSelect={(event) => {
              event.preventDefault()
              onStartEdit?.()
            }}
          >
            <Pencil />
            {translate('auto.components.right.sidebar.checks.panel.content.03ca88f623', 'Edit')}
          </DropdownMenuItem>
        ) : null}
        {hasDelete ? (
          <DropdownMenuItem variant="destructive" onSelect={() => void onDelete?.()}>
            <Trash />
            {translate('auto.components.right.sidebar.checks.panel.content.6cc6eace26', 'Delete')}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** A single comment row — used for both root and reply comments. */
export function CommentRow({
  comment,
  isReply,
  showResolve,
  showReply,
  selectionControl,
  resolveSelectionAction,
  replyDisabled,
  replyDisabledReason,
  onResolve,
  onReply,
  onEditComment,
  onDeleteComment
}: {
  comment: PRComment
  isReply: boolean
  showResolve: boolean
  showReply?: boolean
  selectionControl?: React.ReactNode
  resolveSelectionAction?: React.ReactNode
  replyDisabled?: boolean
  replyDisabledReason?: string
  onResolve?: (threadId: string, resolve: boolean) => boolean | Promise<boolean>
  onReply?: (comment: PRComment) => void
  onEditComment?: (comment: PRComment, body: string) => Promise<boolean>
  onDeleteComment?: (comment: PRComment) => void | Promise<void>
}): React.JSX.Element {
  const automated = isBotPRComment(comment)
  const canMutateComment = isMutablePRConversationComment(comment)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(comment.body)
  const [submittingEdit, setSubmittingEdit] = useState(false)

  useEffect(() => {
    if (!editing) {
      setDraft(comment.body)
    }
  }, [comment.body, editing])

  const handleStartEdit = useCallback((): void => {
    setDraft(comment.body)
    setEditing(true)
  }, [comment.body])

  const handleCancelEdit = useCallback(
    (event: React.MouseEvent): void => {
      event.stopPropagation()
      setEditing(false)
      setDraft(comment.body)
    },
    [comment.body]
  )

  const handleSaveEdit = useCallback(
    async (event: React.MouseEvent): Promise<void> => {
      event.stopPropagation()
      const trimmedDraft = draft.trim()
      if (!onEditComment || !trimmedDraft || trimmedDraft === comment.body) {
        setEditing(false)
        return
      }
      setSubmittingEdit(true)
      try {
        const ok = await onEditComment(comment, trimmedDraft)
        if (ok) {
          setEditing(false)
        }
      } finally {
        setSubmittingEdit(false)
      }
    },
    [comment, draft, onEditComment]
  )

  const handleDelete = useCallback((): void => {
    void onDeleteComment?.(comment)
  }, [comment, onDeleteComment])

  const trimmedDraft = draft.trim()
  const canSaveEdit = !submittingEdit && trimmedDraft.length > 0 && trimmedDraft !== comment.body

  return (
    <div
      className={cn(
        'flex items-start gap-2 py-1.5 hover:bg-accent/40 transition-colors group/comment',
        isReply ? 'pl-7 pr-3' : 'px-3',
        comment.isResolved && PR_COMMENT_RESOLVED_CONTAINER_CLASS
      )}
    >
      {selectionControl}
      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-1.5 min-w-0">
          {comment.authorAvatarUrl ? (
            <img
              src={comment.authorAvatarUrl}
              alt={comment.author}
              className={cn('rounded-full shrink-0', isReply ? 'size-3.5' : 'size-4')}
            />
          ) : (
            <div
              className={cn('rounded-full bg-muted shrink-0', isReply ? 'size-3.5' : 'size-4')}
            />
          )}
          <span
            className={cn(
              'text-[11px] font-semibold shrink-0',
              comment.isResolved ? PR_COMMENT_RESOLVED_AUTHOR_CLASS : PR_COMMENT_OPEN_AUTHOR_CLASS
            )}
          >
            {comment.author}
          </span>
          {automated && (
            <span className="shrink-0 rounded border border-border bg-accent/40 px-1 py-px text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
              {translate('auto.components.right.sidebar.checks.panel.content.2ba0a32bdd', 'bot')}
            </span>
          )}
          {!isReply && comment.path && (
            <span className="text-[10px] font-mono text-muted-foreground/60 truncate min-w-0">
              {comment.path.split('/').pop()}
              {formatLineRange(comment) && `:${formatLineRange(comment)}`}
            </span>
          )}
          <div className="flex-1" />
          {!editing && resolveSelectionAction}
          {!editing && (
            <div className="flex items-center gap-0.5 can-hover:opacity-0 group-hover/comment:opacity-100 transition-opacity">
              {showResolve && comment.threadId != null && onResolve && (
                <ResolveButton
                  threadId={comment.threadId}
                  isResolved={comment.isResolved ?? false}
                  onResolve={onResolve}
                />
              )}
              {showReply && onReply && (
                <button
                  className="shrink-0 rounded px-1.5 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                  title={
                    replyDisabled
                      ? replyDisabledReason
                      : translate(
                          'auto.components.right.sidebar.checks.panel.content.c1f6fc006a',
                          'Reply'
                        )
                  }
                  disabled={replyDisabled}
                  onClick={(event) => {
                    event.stopPropagation()
                    onReply(comment)
                  }}
                >
                  {translate(
                    'auto.components.right.sidebar.checks.panel.content.c1f6fc006a',
                    'Reply'
                  )}
                </button>
              )}
              <CopyButton text={buildPRCommentCopyText(comment)} />
              <CommentMoreMenu
                comment={comment}
                onStartEdit={canMutateComment && onEditComment ? handleStartEdit : undefined}
                onDelete={canMutateComment && onDeleteComment ? handleDelete : undefined}
              />
            </div>
          )}
        </div>
        {editing ? (
          <div className={cn('mt-1 flex flex-col gap-1.5', isReply ? 'pl-5' : 'pl-[22px]')}>
            <textarea
              autoFocus
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onClick={(event) => event.stopPropagation()}
              className="min-h-[60px] w-full resize-y rounded-md border border-border bg-background px-2 py-1.5 text-[11px] leading-snug text-foreground"
            />
            <div className="flex justify-end gap-1">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                disabled={submittingEdit}
                onClick={handleCancelEdit}
              >
                {translate(
                  'auto.components.right.sidebar.checks.panel.content.b062f55f29',
                  'Cancel'
                )}
              </Button>
              <Button
                type="button"
                size="xs"
                disabled={!canSaveEdit}
                onClick={(event) => void handleSaveEdit(event)}
              >
                {translate('auto.components.right.sidebar.checks.panel.content.f6a40263ff', 'Save')}
              </Button>
            </div>
          </div>
        ) : (
          <CommentMarkdown
            content={comment.body}
            className={cn(
              'mt-1 text-[11px] leading-snug text-muted-foreground',
              'break-words [&_p]:my-1 [&_pre]:max-h-none [&_pre]:max-w-full [&_pre]:whitespace-pre-wrap [&_table]:w-full [&_table]:max-w-full',
              isReply ? 'pl-5' : 'pl-[22px]'
            )}
          />
        )}
      </div>
    </div>
  )
}
