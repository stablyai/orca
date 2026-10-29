import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { GitHubOwnerRepo } from '../../../../../shared/github/pull-request-types'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../../../shared/task-source-context'
import {
  deleteLastConfirmedClientValue,
  getLastConfirmedClientValue
} from './task-page-github-confirmed-client-values'
import {
  getTaskPageGitHubMutationQueryKey,
  notifyTaskPageGitHubMutationRegistry,
  setLastConfirmedClientValue
} from './task-page-github-work-item-mutation-registry'
import { markTaskPageGitHubFamiliesDirty } from './task-page-github-work-item-quiet-state'
import { taskPageGitHubItemKey } from './task-page-github-work-item-mutation-keys'

function markStateFamilyDirty(repoId: string, itemId: string): void {
  const queryKey = getTaskPageGitHubMutationQueryKey()
  if (queryKey !== null) {
    markTaskPageGitHubFamiliesDirty(queryKey, taskPageGitHubItemKey(repoId, itemId), ['state'])
  }
}

/** Hold confirmed dialog state in the registry until search catches up; matching quiet adoption releases it so external reverts can win. */
export function assertTaskPageGitHubDialogStateAuthority(args: {
  repoId: string
  itemId: string
  state: GitHubWorkItem['state']
  sourceContext?: TaskSourceContext | null
  ownerRepo?: GitHubOwnerRepo | null
}): { revert: () => boolean } {
  const sourceScope =
    args.sourceContext?.provider === 'github' ? getTaskSourceCacheScope(args.sourceContext) : null
  const previous = getLastConfirmedClientValue(
    sourceScope,
    args.repoId,
    args.itemId,
    'state',
    args.ownerRepo
  )
  setLastConfirmedClientValue(
    sourceScope,
    args.repoId,
    args.itemId,
    'state',
    args.state,
    args.ownerRepo
  )
  markStateFamilyDirty(args.repoId, args.itemId)
  notifyTaskPageGitHubMutationRegistry()
  return {
    revert: () => {
      const current = getLastConfirmedClientValue(
        sourceScope,
        args.repoId,
        args.itemId,
        'state',
        args.ownerRepo
      )
      // A matching search adopt or newer mutation owns the state now.
      if (current !== args.state) {
        return false
      }
      if (previous === undefined) {
        deleteLastConfirmedClientValue(
          sourceScope,
          args.repoId,
          args.itemId,
          'state',
          args.ownerRepo
        )
      } else {
        setLastConfirmedClientValue(
          sourceScope,
          args.repoId,
          args.itemId,
          'state',
          previous,
          args.ownerRepo
        )
      }
      markStateFamilyDirty(args.repoId, args.itemId)
      notifyTaskPageGitHubMutationRegistry()
      return true
    }
  }
}
