import React from 'react'
import { ArrowRight, Check, LoaderCircle, RefreshCw, Send } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import CommentMarkdown from '@/components/comment-markdown/CommentMarkdown'
import { formatUiRelativeTimeFromDate } from '@/i18n/relative-time-format'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import type {
  ClickUpComment,
  ClickUpStatusOption,
  ClickUpTask
} from '../../../../../../shared/clickup/clickup-types'
import { formatClickUpDueDate } from '../listing/clickup-task-list'
import {
  ClickUpAssignees,
  ClickUpPriorityLabel,
  ClickUpStatusPill,
  safeClickUpColor
} from '../listing/clickup-task-presentation'

export function ClickUpTaskMetadataBar({
  task,
  statusOptions,
  statusesLoading,
  statusesError,
  retryStatuses,
  pendingStatus,
  onChangeStatus
}: {
  task: ClickUpTask
  statusOptions: readonly ClickUpStatusOption[]
  statusesLoading: boolean
  statusesError: string | null
  retryStatuses: () => void
  pendingStatus: boolean
  onChangeStatus: (status: ClickUpStatusOption) => void
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  const dueLabel = task.dueAt ? formatClickUpDueDate(task.dueAt, intlLocale) : null
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border/60 px-4 py-2.5">
      <Popover>
        <PopoverTrigger asChild>
          <button
            type="button"
            disabled={pendingStatus}
            aria-label={t('taskProviders.clickup.changeStatus', 'Change status')}
            className="inline-flex items-center gap-1 rounded-md transition hover:bg-muted/40 disabled:opacity-50"
          >
            <ClickUpStatusPill status={task.status} />
            {pendingStatus ? <LoaderCircle className="size-3 animate-spin" /> : null}
          </button>
        </PopoverTrigger>
        <PopoverContent className="w-56" align="start">
          {statusesLoading ? (
            <div className="flex items-center justify-center py-3">
              <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
            </div>
          ) : statusesError ? (
            <div className="space-y-2 px-2 py-2">
              <p className="text-xs text-destructive">{statusesError}</p>
              <Button variant="outline" size="xs" onClick={retryStatuses}>
                <RefreshCw className="size-3" />
                {t('taskProviders.clickup.retry', 'Retry')}
              </Button>
            </div>
          ) : statusOptions.length === 0 ? (
            <p className="px-2 py-2 text-xs text-muted-foreground">
              {t('taskProviders.clickup.noStatuses', 'This list has no statuses to choose from.')}
            </p>
          ) : (
            statusOptions.map((status) => {
              const color = safeClickUpColor(status.color)
              const current = status.name === task.status.name
              return (
                <button
                  key={status.name}
                  type="button"
                  onClick={() => onChangeStatus(status)}
                  className={cn(
                    'flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-left text-[12px] hover:bg-accent',
                    current && 'bg-accent/60'
                  )}
                >
                  <span
                    aria-hidden
                    className="size-2 shrink-0 rounded-full bg-muted-foreground/60"
                    style={color ? { backgroundColor: color } : undefined}
                  />
                  <span className="min-w-0 flex-1 truncate">{status.name}</span>
                  {current ? <Check className="size-3.5 shrink-0 text-muted-foreground" /> : null}
                </button>
              )
            })
          )}
        </PopoverContent>
      </Popover>
      <ClickUpPriorityLabel priority={task.priority} />
      {dueLabel ? (
        <span className="text-[11px] text-muted-foreground">
          {t('taskProviders.clickup.dueOn', 'Due {{date}}', { date: dueLabel })}
        </span>
      ) : null}
      {task.assignees.length > 0 ? (
        <ClickUpAssignees assignees={task.assignees} max={5} />
      ) : (
        <span className="text-[11px] text-muted-foreground">
          {t('auto.components.JiraIssueWorkspace.0b6b5646ed', 'Unassigned')}
        </span>
      )}
      {task.tags.map((tag) => (
        <span
          key={tag}
          className="max-w-[160px] truncate rounded-full border border-border/50 bg-muted/35 px-1.5 py-0.5 text-[10px] text-muted-foreground"
        >
          {tag}
        </span>
      ))}
    </div>
  )
}

export function ClickUpTaskContent({
  task,
  taskError,
  comments,
  commentsLoading,
  commentsError,
  retryComments,
  onUse
}: {
  task: ClickUpTask
  taskError: string | null
  comments: readonly ClickUpComment[]
  commentsLoading: boolean
  commentsError: string | null
  retryComments: () => void
  onUse: (task: ClickUpTask) => void
}): React.JSX.Element {
  const t = useTranslate()
  const intlLocale = useIntlLocale()
  return (
    <div className="min-h-0 flex-1 overflow-y-auto scrollbar-sleek">
      {taskError ? (
        <div
          role="alert"
          className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 text-sm text-destructive"
        >
          {taskError}
        </div>
      ) : null}
      <section className="border-b border-border/40 px-4 py-4">
        <Button onClick={() => onUse(task)} className="mb-3 w-full justify-center sm:hidden">
          {t('auto.components.JiraIssueWorkspace.2441be6f9f', 'Start workspace')}
          <ArrowRight className="size-4" />
        </Button>
        {task.descriptionMarkdown.trim() ? (
          <CommentMarkdown
            content={task.descriptionMarkdown}
            variant="document"
            className="text-[14px] leading-relaxed"
          />
        ) : (
          <p className="text-sm italic text-muted-foreground">
            {t('auto.components.JiraIssueWorkspace.c4889a47e4', 'No description provided.')}
          </p>
        )}
      </section>

      <section className="px-4 py-4">
        <div className="mb-3 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium text-foreground">
              {t('auto.components.JiraIssueWorkspace.9a980b06b9', 'Comments')}
            </span>
            {comments.length > 0 ? (
              <span className="text-[12px] text-muted-foreground">{comments.length}</span>
            ) : null}
          </div>
          {commentsError ? (
            <Button variant="outline" size="xs" onClick={retryComments}>
              <RefreshCw className="size-3" />
              {t('taskProviders.clickup.retry', 'Retry')}
            </Button>
          ) : null}
        </div>
        {commentsError ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
            {commentsError}
          </div>
        ) : commentsLoading ? (
          <div className="flex items-center justify-center py-8">
            <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
          </div>
        ) : comments.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            {t('auto.components.JiraIssueWorkspace.9178090e26', 'No comments yet.')}
          </p>
        ) : (
          <div className="flex flex-col gap-3">
            {comments.map((comment) => (
              <div key={comment.id} className="rounded-md border border-border/50 bg-muted/20">
                <div className="flex min-w-0 items-center gap-2 border-b border-border/40 px-3 py-2">
                  {comment.author?.avatarUrl ? (
                    <img
                      src={comment.author.avatarUrl}
                      alt=""
                      className="size-5 shrink-0 rounded-full"
                    />
                  ) : null}
                  <span className="truncate text-[13px] font-semibold text-foreground">
                    {comment.author?.username ??
                      t('auto.components.JiraIssueWorkspace.666cfdd835', 'Unknown')}
                  </span>
                  <span className="shrink-0 text-[12px] text-muted-foreground">
                    {formatUiRelativeTimeFromDate(comment.createdAt, undefined, intlLocale)}
                  </span>
                </div>
                <div className="px-3 py-2">
                  <CommentMarkdown
                    content={comment.body}
                    variant="compact"
                    className="text-[13px] leading-relaxed"
                  />
                </div>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

export function ClickUpTaskCommentComposer({
  commentDraft,
  setCommentDraft,
  commentSubmitting,
  canSubmitComment,
  onSubmit
}: {
  commentDraft: string
  setCommentDraft: (value: string) => void
  commentSubmitting: boolean
  canSubmitComment: boolean
  onSubmit: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex-none border-t border-border/50 bg-background px-3 py-3">
      <div className="flex gap-2">
        <textarea
          value={commentDraft}
          onChange={(event) => setCommentDraft(event.target.value)}
          placeholder={t('taskProviders.clickup.commentPlaceholder', 'Add a ClickUp comment...')}
          rows={2}
          disabled={commentSubmitting}
          className="min-h-10 flex-1 resize-none rounded-md border border-input bg-transparent px-3 py-2 text-sm outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        />
        <Button
          onClick={onSubmit}
          disabled={!canSubmitComment || commentSubmitting}
          className="self-end"
        >
          {commentSubmitting ? (
            <LoaderCircle className="size-4 animate-spin" />
          ) : (
            <Send className="size-4" />
          )}
          {t('auto.components.JiraIssueWorkspace.b0b92666c9', 'Comment')}
        </Button>
      </div>
    </div>
  )
}
