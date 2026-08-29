import { toast } from 'sonner'
import { setPRFileViewedForRepo } from '@/components/github/github-work-item-comment-mutations'
import { resolvePullRequestRepo } from '@/components/github/github-work-item-identity'
import { translate } from '@/i18n/i18n'
import type { GitHubPRFileViewedState } from '../../../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type { GitHubItemDialogProjectOrigin } from './github-item-dialog-types'
import { patchCachedPRFileViewedState } from './work-item-details-cache'

export async function syncPRFileViewedState(args: {
  canUseDetailsRepoContext: boolean
  pullRequestId: string | undefined
  workItem: GitHubWorkItem | null
  detailsCacheKey: string | null
  repoPath: string | null
  sourceContext?: TaskSourceContext | null
  projectOrigin?: GitHubItemDialogProjectOrigin
  path: string
  viewed: boolean
  setPendingViewedPaths: (updater: (prev: Set<string>) => Set<string>) => void
}): Promise<boolean> {
  const {
    canUseDetailsRepoContext,
    pullRequestId,
    workItem,
    detailsCacheKey,
    repoPath,
    sourceContext,
    projectOrigin,
    path,
    viewed,
    setPendingViewedPaths
  } = args
  if (!canUseDetailsRepoContext || !pullRequestId || !workItem || workItem.type !== 'pr') {
    toast.error(
      translate(
        'auto.components.GitHubItemDialog.c0253318d6',
        'Unable to sync viewed state for this pull request.'
      )
    )
    return false
  }
  setPendingViewedPaths((prev) => new Set(prev).add(path))
  const nextState: GitHubPRFileViewedState = viewed ? 'VIEWED' : 'UNVIEWED'
  const previousState = detailsCacheKey
    ? patchCachedPRFileViewedState(detailsCacheKey, path, nextState)
    : undefined
  try {
    const ok = await setPRFileViewedForRepo({
      repoId: workItem.repoId,
      repoPath: repoPath ?? '',
      sourceContext,
      prNumber: workItem.number,
      prRepo: resolvePullRequestRepo(workItem, projectOrigin),
      pullRequestId,
      path,
      viewed
    })
    if (!ok) {
      if (detailsCacheKey && previousState) {
        patchCachedPRFileViewedState(detailsCacheKey, path, previousState)
      }
      toast.error(
        translate(
          'auto.components.GitHubItemDialog.b7bf31b8de',
          'Failed to sync viewed state with GitHub.'
        )
      )
      return false
    }
    return true
  } catch (err) {
    // Why: an RPC timeout or IPC throw must roll the optimistic patch back, else the shared cache keeps claiming the file is viewed.
    if (detailsCacheKey && previousState) {
      patchCachedPRFileViewedState(detailsCacheKey, path, previousState)
    }
    toast.error(
      err instanceof Error
        ? err.message
        : translate(
            'auto.components.GitHubItemDialog.b7bf31b8de',
            'Failed to sync viewed state with GitHub.'
          )
    )
    return false
  } finally {
    setPendingViewedPaths((prev) => {
      const next = new Set(prev)
      next.delete(path)
      return next
    })
  }
}
