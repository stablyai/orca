import { toast } from 'sonner'
import { setPRFileViewedForRepo } from '@/components/github/github-work-item-comment-mutations'
import { resolvePullRequestRepo } from '@/components/github/github-work-item-identity'
import { translate } from '@/i18n/i18n'
import type { GitHubPRFileViewedState } from '../../../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type { PullRequestPageProjectOrigin } from '../page-types'
import { patchCachedPRFileViewedState } from '../cache/work-item-details'

export async function syncPullRequestFileViewed(args: {
  canUseDetailsRepoContext: boolean
  pullRequestId: string | undefined
  workItem: GitHubWorkItem | null
  effectiveRepoId: string | null
  path: string
  viewed: boolean
  detailsCacheKey: string | null
  repoPath: string | null
  sourceContext?: TaskSourceContext | null
  projectOrigin: PullRequestPageProjectOrigin | undefined
  setPendingViewedPaths: (updater: (prev: Set<string>) => Set<string>) => void
}): Promise<boolean> {
  if (
    !args.canUseDetailsRepoContext ||
    !args.pullRequestId ||
    !args.workItem ||
    args.workItem.type !== 'pr'
  ) {
    toast.error(
      translate(
        'auto.components.PullRequestPage.996a1897d2',
        'Unable to sync viewed state for this pull request.'
      )
    )
    return false
  }
  args.setPendingViewedPaths((prev) => new Set(prev).add(args.path))
  const nextState: GitHubPRFileViewedState = args.viewed ? 'VIEWED' : 'UNVIEWED'
  const previousState = args.detailsCacheKey
    ? patchCachedPRFileViewedState(args.detailsCacheKey, args.path, nextState)
    : undefined
  const rollbackWithError = (): false => {
    if (args.detailsCacheKey && previousState) {
      patchCachedPRFileViewedState(args.detailsCacheKey, args.path, previousState)
    }
    toast.error(
      translate(
        'auto.components.PullRequestPage.5a01ca7253',
        'Failed to sync viewed state with GitHub.'
      )
    )
    return false
  }
  try {
    const ok = await setPRFileViewedForRepo({
      repoId: args.effectiveRepoId ?? args.workItem.repoId,
      repoPath: args.repoPath ?? '',
      sourceContext: args.sourceContext,
      prNumber: args.workItem.number,
      prRepo: resolvePullRequestRepo(args.workItem, args.projectOrigin),
      pullRequestId: args.pullRequestId,
      path: args.path,
      viewed: args.viewed
    })
    if (!ok) {
      return rollbackWithError()
    }
    return true
  } catch {
    return rollbackWithError()
  } finally {
    args.setPendingViewedPaths((prev) => {
      const next = new Set(prev)
      next.delete(args.path)
      return next
    })
  }
}
