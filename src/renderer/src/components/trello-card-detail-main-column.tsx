import { LoaderCircle } from 'lucide-react'
import type { TrelloCard, TrelloComment } from '../../../shared/trello-types'
import type { RichMarkdownImageSrcResolver } from '@/components/editor/rich-markdown-extensions'
import { LinearIssueMarkdownDescriptionEditor } from '@/components/LinearIssueMarkdownDescriptionEditor'
import { getScreenSubmitShortcutLabel } from '@/lib/screen-submit-shortcut'
import { Button } from '@/components/ui/button'
import { TrelloCardDetailActivity } from '@/components/trello-card-detail-activity'

type TrelloCardDetailMainColumnProps = {
  card: TrelloCard
  title: string
  description: string
  dirty: boolean
  saving: boolean
  error: string | null
  comments: TrelloComment[]
  commentsLoading: boolean
  commentsError: string | null
  commentText: string
  commentSubmitting: boolean
  resolveTrelloImageSrc: RichMarkdownImageSrcResolver
  onTitleChange: (value: string) => void
  onDescriptionChange: (value: string) => void
  onDescriptionSave: (value: string) => void
  onSave: () => void
  onArchiveToggle: () => void
  onCommentTextChange: (value: string) => void
  onRetryComments: () => void
  onAddComment: () => void
}

export function TrelloCardDetailMainColumn({
  card,
  title,
  description,
  dirty,
  saving,
  error,
  comments,
  commentsLoading,
  commentsError,
  commentText,
  commentSubmitting,
  resolveTrelloImageSrc,
  onTitleChange,
  onDescriptionChange,
  onDescriptionSave,
  onSave,
  onArchiveToggle,
  onCommentTextChange,
  onRetryComments,
  onAddComment
}: TrelloCardDetailMainColumnProps): React.JSX.Element {
  return (
    <main className="min-w-0">
      {error ? (
        <p className="mb-5 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}

      <section className="space-y-5">
        <input
          value={title}
          onChange={(event) => onTitleChange(event.target.value)}
          placeholder="Card title"
          disabled={saving}
          className="w-full border-none bg-transparent p-0 text-3xl font-semibold leading-tight text-foreground outline-none placeholder:text-muted-foreground/40 focus:outline-none focus:ring-0 focus-visible:ring-0 disabled:opacity-50"
        />
        <LinearIssueMarkdownDescriptionEditor
          value={description}
          onChange={onDescriptionChange}
          onSave={(nextValue) => onDescriptionSave(nextValue)}
          density="page"
          disabled={saving}
          submitShortcutLabel={getScreenSubmitShortcutLabel()}
          resolveImageSrc={resolveTrelloImageSrc}
        />
        <div className="flex flex-wrap items-center gap-2 border-t border-border/40 pt-4">
          <Button size="sm" onClick={onSave} disabled={!dirty || saving}>
            {saving ? <LoaderCircle className="mr-1 size-3.5 animate-spin" /> : null}
            Save changes
          </Button>
          <Button variant="outline" size="sm" onClick={onArchiveToggle} disabled={saving}>
            {card.closed ? 'Unarchive' : 'Archive'}
          </Button>
        </div>
      </section>

      <TrelloCardDetailActivity
        card={card}
        comments={comments}
        commentsLoading={commentsLoading}
        commentsError={commentsError}
        commentText={commentText}
        commentSubmitting={commentSubmitting}
        onCommentTextChange={onCommentTextChange}
        onRetryComments={onRetryComments}
        onAddComment={onAddComment}
      />
    </main>
  )
}
