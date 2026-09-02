import { toast } from 'sonner'
import {
  attachPRReviewReplyParent,
  canPostPRReviewThreadReply
} from '@/components/right-sidebar/pr-comments-ai-launch-ack'
import { buildPRCommentConversationReplyBody } from '@/components/right-sidebar/pr-comment-fixing-reply-body'
import {
  addIssueCommentForRepo,
  addPRReviewCommentReplyForRepo
} from '@/components/github/github-work-item-comment-mutations'
import { translate } from '@/i18n/i18n'
import type { GitHubOwnerRepo } from '../../../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { PRComment } from '../../../../../shared/github/comment-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'

export async function postConversationReply(args: {
  canUseRepoMutationContext: boolean
  item: GitHubWorkItem
  repoPath: string | null
  sourceContext?: TaskSourceContext | null
  prRepo: GitHubOwnerRepo | null
  comment: PRComment
  replyBody: string
  onCommentAdded: (comment: PRComment) => void
  onReplied: () => void
}): Promise<boolean> {
  if (!args.canUseRepoMutationContext) {
    toast.error(
      translate(
        'auto.components.PullRequestPage.6885c619e7',
        'Unable to reply without a repository path.'
      )
    )
    return false
  }
  // Why: nest under review threads (path/threadId/discussion_r); never post a
  // separate top-level conversation comment for those.
  const isReviewThreadReply = args.item.type === 'pr' && canPostPRReviewThreadReply(args.comment)
  const result = isReviewThreadReply
    ? await addPRReviewCommentReplyForRepo({
        repoPath: args.repoPath ?? '',
        repoId: args.item.repoId,
        sourceContext: args.sourceContext,
        prNumber: args.item.number,
        prRepo: args.prRepo,
        commentId: args.comment.id,
        body: args.replyBody,
        threadId: args.comment.threadId,
        path: args.comment.path,
        line: args.comment.line
      })
    : await addIssueCommentForRepo({
        repoPath: args.repoPath ?? '',
        repoId: args.item.repoId,
        sourceContext: args.sourceContext,
        number: args.item.number,
        // Why: a GitHub App login carries a [bot] suffix that never resolves as a mention.
        body: buildPRCommentConversationReplyBody(args.comment.author, args.replyBody),
        type: args.item.type,
        prRepo: args.prRepo
      })

  if (!result.ok) {
    toast.error(
      result.error ||
        translate('auto.components.PullRequestPage.5821aab360', 'Failed to post reply.')
    )
    return false
  }
  args.onCommentAdded(
    isReviewThreadReply ? attachPRReviewReplyParent(result.comment, args.comment) : result.comment
  )
  args.onReplied()
  toast.success(translate('auto.components.PullRequestPage.11505c7a71', 'Reply posted.'))
  return true
}
