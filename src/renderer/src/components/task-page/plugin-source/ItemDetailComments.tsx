import { LoaderCircle, Reply } from 'lucide-react'

import { CommentMarkdownAsync } from '@/components/sidebar/comment-markdown-lazy'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { PluginTaskComment } from '../../../../../shared/plugins/plugin-task-source-contract'
import type { PluginTaskSourceLoadError } from '@/store/slices/plugin-task-sources-slice-contract'
import { formatRelativeTime } from '../../task-page-source-context'
import { useCommentReplyDraft } from './comment-reply-draft'
import {
  TaskPagePluginSourceCommentComposer,
  type PluginTaskSourceCommentControl
} from './ItemDetailCommentComposer'

/** Only a body the source declared as markdown is parsed. `'text'` and the
 *  legacy `'html'` render as literal characters, so third-party markup can
 *  never reach the DOM as markup. */
function CommentBody({ comment }: { comment: PluginTaskComment }): React.JSX.Element {
  if (comment.bodyFormat === 'markdown') {
    return (
      <CommentMarkdownAsync
        content={comment.body}
        className="text-[13px] leading-relaxed"
        fallbackClassName="whitespace-pre-wrap"
      />
    )
  }
  return (
    <p className="text-[13px] leading-relaxed whitespace-pre-wrap text-foreground">
      {comment.body}
    </p>
  )
}

function CommentCard({
  comment,
  onReply
}: {
  comment: PluginTaskComment
  onReply: ((comment: PluginTaskComment) => void) | null
}): React.JSX.Element {
  return (
    <article className="rounded-md border border-border/50 bg-muted/20">
      <div className="flex min-w-0 items-center gap-2 border-b border-border/40 px-3 py-2">
        <span className="truncate text-[13px] font-semibold text-foreground">
          {comment.author.displayName}
        </span>
        <span className="shrink-0 text-[12px] text-muted-foreground">
          {formatRelativeTime(comment.createdAt)}
        </span>
        {onReply ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ml-auto"
            onClick={() => onReply(comment)}
            aria-label={translate(
              'auto.components.TaskPage.pluginTaskSourceReplyTo',
              'Reply to {{value0}}',
              { value0: comment.author.displayName }
            )}
          >
            <Reply className="size-3.5" />
            {translate('auto.components.TaskPage.pluginTaskSourceReply', 'Reply')}
          </Button>
        ) : null}
      </div>
      <div className="px-3 py-2">
        <CommentBody comment={comment} />
      </div>
    </article>
  )
}

export function TaskPagePluginSourceItemComments({
  comments,
  loading,
  error,
  postedWhileErrored,
  composer
}: {
  comments: PluginTaskComment[]
  loading: boolean
  error: PluginTaskSourceLoadError | null
  /** True once a post has succeeded while `error` was set and the retry it
   *  triggered still failed — the post itself is not in doubt, only whether
   *  the rest of the list can be shown. */
  postedWhileErrored: boolean
  /** Null when the source did not declare `supports.comment`, so a source that
   *  cannot post shows neither a composer nor a reply action. */
  composer: PluginTaskSourceCommentControl | null
}): React.JSX.Element {
  const { draft, setDraft, textareaRef, quoteReply } = useCommentReplyDraft()

  return (
    <section className="px-4 py-4">
      <div className="mb-3 flex items-center gap-2">
        <h3 className="text-[13px] font-medium text-foreground">
          {translate('auto.components.TaskPage.pluginTaskSourceComments', 'Comments')}
        </h3>
        {comments.length > 0 ? (
          <span className="text-[12px] text-muted-foreground">{comments.length}</span>
        ) : null}
      </div>

      {/* A comment outage is reported on its own, next to a description that
          loaded fine: partial success is the normal case here. */}
      {error ? (
        <div
          role="alert"
          className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
        >
          <p>{error.message}</p>
          {postedWhileErrored ? (
            <p className="mt-1 font-medium">
              {translate(
                'auto.components.TaskPage.pluginTaskSourceCommentPostedWhileErrored',
                'Your comment was posted. The rest of the list is still unavailable.'
              )}
            </p>
          ) : null}
        </div>
      ) : loading ? (
        <div className="flex items-center justify-center py-6">
          <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
        </div>
      ) : comments.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {translate('auto.components.TaskPage.pluginTaskSourceNoComments', 'No comments yet.')}
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {comments.map((comment) => (
            <CommentCard
              key={comment.id}
              comment={comment}
              onReply={composer ? quoteReply : null}
            />
          ))}
        </div>
      )}

      {composer ? (
        <TaskPagePluginSourceCommentComposer
          draft={draft}
          onDraftChange={setDraft}
          textareaRef={textareaRef}
          submit={composer.submit}
        />
      ) : null}
    </section>
  )
}
