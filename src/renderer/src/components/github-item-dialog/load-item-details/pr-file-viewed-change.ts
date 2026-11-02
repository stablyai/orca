import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import type { GhAccountBinding } from '../../../../../shared/github/account-binding'
import { toast } from 'sonner'
import { setPRFileViewedForRepo } from '@/components/github/github-work-item-comment-mutations'
import { resolvePullRequestRepo } from '@/components/github/github-work-item-identity'
import { translate } from '@/i18n/i18n'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../../../shared/task-source-context'
import type { GitHubItemDialogProjectOrigin } from './github-item-dialog-types'
import {
  EMPTY_VIEWED_PATHS,
  patchCachedPRFileViewedState,
  touchWorkItemDetailsCache,
  workItemDetailsCache
} from './work-item-details-cache'

function beginWorkItemViewed(key: string, path: string, viewed: boolean) {
  const entry = workItemDetailsCache.get(key)
  if (!entry?.details) {
    return null
  }
  const owner = entry.viewed ?? { requests: new Map<string, object>(), paths: EMPTY_VIEWED_PATHS }
  if (owner.requests.has(path)) {
    return null
  }
  const request = {}
  owner.requests.set(path, request)
  owner.paths = new Set(owner.requests.keys())
  touchWorkItemDetailsCache(key, { ...entry, viewed: owner })
  const previous = patchCachedPRFileViewedState(key, path, viewed ? 'VIEWED' : 'UNVIEWED')
  const optimisticFile = workItemDetailsCache
    .get(key)
    ?.details?.files?.find((file) => file.path === path)
  const ownsPath = () =>
    workItemDetailsCache.get(key)?.viewed === owner && owner.requests.get(path) === request
  let finished = false
  return {
    ownsPath,
    rollback: () => {
      if (
        previous &&
        ownsPath() &&
        workItemDetailsCache.get(key)?.details?.files?.find((file) => file.path === path) ===
          optimisticFile
      ) {
        patchCachedPRFileViewedState(key, path, previous)
      }
    },
    finish: () => {
      if (finished) {
        return
      }
      finished = true
      if (owner.requests.get(path) !== request) {
        return
      }
      owner.requests.delete(path)
      owner.paths = new Set(owner.requests.keys())
      const current = workItemDetailsCache.get(key)
      if (current?.viewed === owner) {
        touchWorkItemDetailsCache(key, current)
      }
    }
  }
}

export async function syncPRFileViewedState(args: {
  canUseDetailsRepoContext: boolean
  effectiveRepoId?: string | null
  pullRequestId: string | undefined
  workItem: GitHubWorkItem | null
  detailsCacheKey: string | null
  repoPath: string | null
  sourceContext?: TaskSourceContext | null
  projectOrigin?: GitHubItemDialogProjectOrigin
  expectedGhAccount?: GhAccountBinding | null
  target?: RuntimeClientTarget
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
      expectedGhAccount: args.expectedGhAccount,
      target: args.target,
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
