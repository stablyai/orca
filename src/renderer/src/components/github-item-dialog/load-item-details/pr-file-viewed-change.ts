import { toast } from 'sonner'
import { setPRFileViewedForRepo } from '@/components/github/github-work-item-comment-mutations'
import { resolvePullRequestRepo } from '@/components/github/github-work-item-identity'
import { translate } from '@/i18n/i18n'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type { GitHubItemDialogProjectOrigin } from './github-item-dialog-types'
import { beginWorkItemViewed } from './work-item-details-cache'

export async function syncPRFileViewedState(args: {
  canUseDetailsRepoContext: boolean
  effectiveRepoId?: string | null
  pullRequestId: string | undefined
  workItem: GitHubWorkItem | null
  detailsCacheKey: string | null
  repoPath: string | null
  sourceContext?: TaskSourceContext | null
  projectOrigin?: GitHubItemDialogProjectOrigin
  path: string
  viewed: boolean
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
    viewed
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
  const claim = detailsCacheKey ? beginWorkItemViewed(detailsCacheKey, path, viewed) : null
  if (!claim) {
    return false
  }
  try {
    const ok = await setPRFileViewedForRepo({
      repoId: args.effectiveRepoId ?? workItem.repoId,
      repoPath: repoPath ?? '',
      sourceContext,
      prNumber: workItem.number,
      prRepo: resolvePullRequestRepo(workItem, projectOrigin),
      pullRequestId,
      path,
      viewed
    })
    if (!ok) {
      claim.rollback()
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
    claim.rollback()
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
    claim.finish()
  }
}
