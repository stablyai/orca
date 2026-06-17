import { LoaderCircle, RefreshCw } from 'lucide-react'
import type { TrelloCard, TrelloComment } from '../../../shared/trello-types'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { Button } from '@/components/ui/button'
import { TrelloAvatar } from '@/components/trello-card-detail-avatar'
import { formatRelativeTime } from '@/components/trello-card-detail-text'

type TrelloCardDetailActivityProps = {
  card: TrelloCard
  comments: TrelloComment[]
  commentsLoading: boolean
  commentsError: string | null
  commentText: string
  commentSubmitting: boolean
  onCommentTextChange: (value: string) => void
  onRetryComments: () => void
  onAddComment: () => void
}

export function TrelloCardDetailActivity({
  card,
  comments,
  commentsLoading,
  commentsError,
  commentText,
  commentSubmitting,
  onCommentTextChange,
  onRetryComments,
  onAddComment
}: TrelloCardDetailActivityProps): React.JSX.Element {
  const activityActor = card.members[0] ?? null
  const activityActorName = activityActor?.fullName || activityActor?.username || 'Someone'

  return (
    <section className="mt-12 border-t border-border/60 pt-9">
      <div className="mb-8 flex items-center justify-between gap-3">
        <h2 className="text-xl font-semibold text-foreground">Activity</h2>
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          <TrelloAvatar
            avatarUrl={activityActor?.avatarUrl}
            name={activityActorName}
            className="size-6"
          />
        </div>
      </div>

      <div className="mb-7 flex items-center gap-3 text-sm text-muted-foreground">
        <TrelloAvatar
          avatarUrl={activityActor?.avatarUrl}
          name={activityActorName}
          className="size-5"
        />
        <span>
          {activityActorName} updated the card · {formatRelativeTime(card.dateLastActivity)}
        </span>
      </div>

      {commentsError ? (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          <span>{commentsError}</span>
          <Button
            variant="outline"
            size="xs"
            onClick={onRetryComments}
            disabled={commentsLoading}
            className="gap-1"
          >
            {commentsLoading ? (
              <LoaderCircle className="size-3 animate-spin" />
            ) : (
              <RefreshCw className="size-3" />
            )}
            Retry
          </Button>
        </div>
      ) : null}

      {commentsLoading && comments.length === 0 ? (
        <div className="mb-5 flex items-center justify-center py-8">
          <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
        </div>
      ) : comments.length > 0 ? (
        <div className="mb-6 flex flex-col gap-5">
          {comments.map((comment) => {
            const authorName =
              comment.memberCreator?.fullName || comment.memberCreator?.username || 'Trello user'
            return (
              <article key={comment.id} className="flex gap-3">
                <TrelloAvatar
                  avatarUrl={comment.memberCreator?.avatarUrl}
                  name={authorName}
                  className="size-7"
                />
                <div className="min-w-0 flex-1">
                  <div className="mb-1 flex min-w-0 items-center gap-2 text-sm">
                    <span className="truncate font-semibold text-foreground">{authorName}</span>
                    <span className="shrink-0 text-muted-foreground">
                      {formatRelativeTime(comment.date)}
                    </span>
                  </div>
                  <div className="rounded-lg border border-border/60 bg-card px-4 py-3">
                    <CommentMarkdown
                      content={comment.text}
                      variant="document"
                      className="text-[14px] leading-7"
                    />
                  </div>
                </div>
              </article>
            )
          })}
        </div>
      ) : null}

      <div className="flex gap-3">
        <TrelloAvatar name="Add comment" className="size-7" />
        <div className="min-w-0 flex-1 rounded-lg border border-border/60 bg-card px-4 py-3">
          <textarea
            value={commentText}
            onChange={(e) => onCommentTextChange(e.target.value)}
            placeholder="Add a comment..."
            rows={4}
            className="w-full resize-none border-none bg-transparent p-0 text-sm outline-none placeholder:text-muted-foreground/45 focus:outline-none focus:ring-0 focus-visible:ring-0"
          />
          <div className="mt-3 flex justify-end">
            <Button
              size="sm"
              onClick={onAddComment}
              disabled={!commentText.trim() || commentSubmitting}
            >
              {commentSubmitting ? <LoaderCircle className="mr-1 size-3.5 animate-spin" /> : null}
              Add comment
            </Button>
          </div>
        </div>
      </div>
    </section>
  )
}
