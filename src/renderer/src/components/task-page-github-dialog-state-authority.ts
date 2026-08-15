import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../shared/task-source-context'
import {
  deleteLastConfirmedClientValue,
  getLastConfirmedClientValue,
  getTaskPageGitHubMutationQueryKey,
  markTaskPageGitHubFamiliesDirty,
  notifyTaskPageGitHubMutationRegistry,
  setLastConfirmedClientValue,
  taskPageGitHubItemKey
} from './task-page-github-work-item-mutation-registry'

function markStateFamilyDirty(repoId: string, itemId: string): void {
  const queryKey = getTaskPageGitHubMutationQueryKey()
  if (queryKey !== null) {
    markTaskPageGitHubFamiliesDirty(queryKey, taskPageGitHubItemKey(repoId, itemId), ['state'])
  }
}

/**
 * Dialog state edits patch `workItemsCache` directly with no pending op, so a
 * search-lagged list refetch (GitHub search index + `gh` URL cache) silently
 * reverted them in the Tasks list (STA-3343). Record the confirmed state in the
 * mutation registry so the list fetch paths re-assert it until search catches
 * up; quiet adopt releases it on match, so external reverts still win.
 */
export function assertTaskPageGitHubDialogStateAuthority(args: {
  repoId: string
  itemId: string
  state: GitHubWorkItem['state']
  sourceContext?: TaskSourceContext | null
}): { revert: () => boolean } {
  const sourceScope =
    args.sourceContext?.provider === 'github' ? getTaskSourceCacheScope(args.sourceContext) : null
  const previous = getLastConfirmedClientValue(sourceScope, args.repoId, args.itemId, 'state')
  setLastConfirmedClientValue(sourceScope, args.repoId, args.itemId, 'state', args.state)
  markStateFamilyDirty(args.repoId, args.itemId)
  notifyTaskPageGitHubMutationRegistry()
  return {
    revert: () => {
      const current = getLastConfirmedClientValue(sourceScope, args.repoId, args.itemId, 'state')
      // A matching search adopt or newer mutation owns the state now.
      if (current !== args.state) {
        return false
      }
      if (previous === undefined) {
        deleteLastConfirmedClientValue(sourceScope, args.repoId, args.itemId, 'state')
      } else {
        setLastConfirmedClientValue(sourceScope, args.repoId, args.itemId, 'state', previous)
      }
      markStateFamilyDirty(args.repoId, args.itemId)
      notifyTaskPageGitHubMutationRegistry()
      return true
    }
  }
}
