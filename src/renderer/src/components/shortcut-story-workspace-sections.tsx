import React from 'react'
import { LoaderCircle, RefreshCw, Save } from 'lucide-react'

import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { ShortcutIcon } from '@/components/icons/ShortcutIcon'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { ShortcutComment, ShortcutStory } from '../../../shared/shortcut-types'
import { translate } from '@/i18n/i18n'
import { formatUiRelativeTimeFromDate } from '@/i18n/relative-time-format'

export function ShortcutStoryTitleSection({
  titleDraft,
  setTitleDraft,
  labelsDraft,
  setLabelsDraft,
  pendingField,
  onSaveTitle,
  onSaveLabels
}: {
  titleDraft: string
  setTitleDraft: (value: string) => void
  labelsDraft: string
  setLabelsDraft: (value: string) => void
  pendingField: string | null
  onSaveTitle: () => void
  onSaveLabels: () => void
}): React.JSX.Element {
  return (
    <section className="border-b border-border/40 px-4 py-4">
      <div className="grid gap-2">
        <label
          htmlFor="shortcut-story-title"
          className="text-[11px] font-medium text-muted-foreground"
        >
          {translate('auto.components.ShortcutStoryWorkspace.title', 'Title')}
        </label>
        <div className="flex gap-2">
          <Input
            id="shortcut-story-title"
            value={titleDraft}
            onChange={(event) => setTitleDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                event.preventDefault()
                onSaveTitle()
              }
            }}
            className="h-8 text-xs"
          />
          <Button
            size="sm"
            variant="outline"
            onClick={onSaveTitle}
            disabled={pendingField === 'title'}
          >
            {pendingField === 'title' ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <Save className="size-4" />
            )}
          </Button>
        </div>
        <label
          htmlFor="shortcut-story-labels"
          className="mt-2 text-[11px] font-medium text-muted-foreground"
        >
          {translate('auto.components.ShortcutStoryWorkspace.labels', 'Labels')}
        </label>
        <div className="flex gap-2">
          <Input
            id="shortcut-story-labels"
            value={labelsDraft}
            onChange={(event) => setLabelsDraft(event.target.value)}
            placeholder={translate(
              'auto.components.ShortcutStoryWorkspace.labelsPlaceholder',
              'backend, bug'
            )}
            className="h-8 text-xs"
          />
          <Button
            size="sm"
            variant="outline"
            onClick={onSaveLabels}
            disabled={pendingField === 'labels'}
          >
            {pendingField === 'labels' ? (
              <LoaderCircle className="size-4 animate-spin" />
            ) : (
              <Save className="size-4" />
            )}
          </Button>
        </div>
      </div>
    </section>
  )
}

export function ShortcutStoryDescriptionSection({
  story
}: {
  story: ShortcutStory
}): React.JSX.Element {
  const owner = story.owners[0]
  return (
    <section className="border-b border-border/40 px-4 py-4">
      <div className="mb-2 flex items-center gap-2">
        <ShortcutIcon className="size-3 text-muted-foreground" />
        <span className="text-xs font-medium capitalize text-foreground">{story.storyType}</span>
        <span className="text-xs text-muted-foreground">
          {story.team?.name ? `${story.team.name} · ` : ''}
          {owner?.name ??
            translate('auto.components.ShortcutStoryWorkspace.unassigned', 'Unassigned')}
        </span>
      </div>
      {story.description?.trim() ? (
        <CommentMarkdown
          content={story.description}
          variant="document"
          className="text-[14px] leading-relaxed"
        />
      ) : (
        <p className="text-sm italic text-muted-foreground">
          {translate(
            'auto.components.ShortcutStoryWorkspace.noDescription',
            'No description provided.'
          )}
        </p>
      )}
    </section>
  )
}

export function ShortcutStoryCommentsSection({
  comments,
  commentsLoading,
  commentsError,
  onRetry
}: {
  comments: ShortcutComment[]
  commentsLoading: boolean
  commentsError: string | null
  onRetry: () => void
}): React.JSX.Element {
  return (
    <section className="px-4 py-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-medium text-foreground">
            {translate('auto.components.ShortcutStoryWorkspace.comments', 'Comments')}
          </span>
          {comments.length > 0 ? (
            <span className="text-[12px] text-muted-foreground">{comments.length}</span>
          ) : null}
        </div>
        {commentsError ? (
          <Button
            variant="outline"
            size="xs"
            onClick={onRetry}
            disabled={commentsLoading}
            className="gap-1"
          >
            {commentsLoading ? (
              <LoaderCircle className="size-3 animate-spin" />
            ) : (
              <RefreshCw className="size-3" />
            )}
            {translate('auto.components.ShortcutStoryWorkspace.retry', 'Retry')}
          </Button>
        ) : null}
      </div>
      {commentsError ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {commentsError}
        </div>
      ) : commentsLoading && comments.length === 0 ? (
        <div className="flex items-center justify-center py-8">
          <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
        </div>
      ) : comments.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {translate('auto.components.ShortcutStoryWorkspace.noComments', 'No comments yet.')}
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
                  {comment.author?.name ??
                    translate('auto.components.ShortcutStoryWorkspace.unknown', 'Unknown')}
                </span>
                <span className="shrink-0 text-[12px] text-muted-foreground">
                  {formatUiRelativeTimeFromDate(comment.createdAt)}
                </span>
              </div>
              <div className="px-3 py-2">
                <CommentMarkdown
                  content={comment.body}
                  expandImages
                  className="text-[13px] leading-relaxed"
                />
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
