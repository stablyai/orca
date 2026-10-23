import React, { useMemo } from 'react'
import { MessageSquare } from 'lucide-react'
import CommentMarkdown from '@/components/sidebar/CommentMarkdown'
import { canUseGitHubRepoContext } from '@/lib/github-source-runtime-context'
import { translate } from '@/i18n/i18n'
import type { PRComment } from '../../../../../shared/github/comment-types'
import type { GitHubAssignableUser } from '../../../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import { GHCommentComposer } from '../comments/composer'
import { buildMentionOptions } from '../mentions/options'

type Props = Omit<
  React.ComponentProps<typeof GHCommentComposer>,
  'mentionOptions' | 'layout' | 'className' | 'repoPath'
> & {
  repoPath: string | null
  item: GitHubWorkItem
  comments: PRComment[]
  participants: GitHubAssignableUser[]
  canComment: boolean
}

/** Keep general PR discussion and a spacious composer beside the changes being reviewed. */
export function PRFilesCommentPanel({
  item,
  comments,
  participants,
  repoPath,
  canComment,
  ...composerProps
}: Props): React.JSX.Element {
  const mentionOptions = useMemo(
    () => buildMentionOptions({ item, comments, participants, assignableUsers: [] }),
    [item, comments, participants]
  )
  const conversationComments = comments.filter((comment) => !comment.path)
  const heading = translate('auto.components.PullRequestPage.3463d10a63', 'Comments')

  return (
    <aside
      aria-label={heading}
      className="flex max-h-[45%] min-h-0 w-full shrink-0 flex-col border-t border-border bg-sidebar @[56rem]:max-h-none @[56rem]:w-80 @[56rem]:border-l @[56rem]:border-t-0"
    >
      <h2 className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-3 text-sm font-medium">
        <MessageSquare className="size-4 text-muted-foreground" />
        {heading}
      </h2>
      <div className="scrollbar-sleek min-h-0 flex-1 overflow-y-auto">
        {conversationComments.length > 0 ? (
          <div className="divide-y divide-border">
            {conversationComments.map((comment) => (
              <article key={comment.id} className="min-w-0 space-y-2 px-3 py-3">
                <div className="truncate text-xs font-medium">{comment.author}</div>
                <CommentMarkdown content={comment.body} githubRepo={composerProps.prRepo} />
              </article>
            ))}
          </div>
        ) : null}
        {canComment && canUseGitHubRepoContext(repoPath, composerProps.sourceContext) ? (
          <div className="sticky bottom-0 border-t border-border bg-sidebar p-3">
            <GHCommentComposer
              {...composerProps}
              repoPath={repoPath ?? ''}
              mentionOptions={mentionOptions}
              layout="panel"
            />
          </div>
        ) : null}
      </div>
    </aside>
  )
}
