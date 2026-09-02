import { toast } from 'sonner'
import { addPRReviewCommentForRepo } from '@/components/github/github-work-item-comment-mutations'
import { translate } from '@/i18n/i18n'
import type { DiffSection } from '@/components/editor/diff-section-types'
import type { GitHubOwnerRepo } from '../../../../../shared/github/pull-request-types'
import type { PRComment } from '../../../../../shared/github/comment-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'

export async function addPullRequestLineComment(args: {
  headSha: string | undefined
  section: DiffSection
  lineNumber: number
  startLine?: number
  body: string
  repoPath: string
  repoId: string
  sourceContext?: TaskSourceContext | null
  prNumber: number
  prRepo?: GitHubOwnerRepo | null
  onCommentAdded: (comment: PRComment) => void
}): Promise<boolean> {
  if (!args.headSha) {
    toast.error(
      translate(
        'auto.components.PullRequestPage.d8c3ba91c4',
        'Unable to comment without the PR head SHA.'
      )
    )
    return false
  }
  let result: Awaited<ReturnType<typeof addPRReviewCommentForRepo>>
  try {
    result = await addPRReviewCommentForRepo({
      repoPath: args.repoPath,
      repoId: args.repoId,
      sourceContext: args.sourceContext,
      prNumber: args.prNumber,
      prRepo: args.prRepo,
      commitId: args.headSha,
      path: args.section.path,
      line: args.lineNumber,
      startLine: args.startLine,
      body: args.body
    })
  } catch (error) {
    toast.error(
      error instanceof Error
        ? error.message
        : translate('auto.components.PullRequestPage.19628e058d', 'Failed to add review comment.')
    )
    return false
  }
  if (!result.ok) {
    toast.error(
      result.error ||
        translate('auto.components.PullRequestPage.19628e058d', 'Failed to add review comment.')
    )
    return false
  }
  args.onCommentAdded(result.comment)
  toast.success(translate('auto.components.PullRequestPage.eff839f438', 'Review comment added.'))
  return true
}
