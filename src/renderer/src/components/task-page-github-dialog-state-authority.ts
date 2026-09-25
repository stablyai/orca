import type { GitHubAssignableUser } from '../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../shared/github/work-item-types'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../shared/task-source-context'
import {
  deleteConfirmedListSnapshot,
  deleteLastConfirmedClientValue,
  getConfirmedListSnapshot,
  getLastConfirmedClientValue,
  getTaskPageGitHubMutationQueryKey,
  markTaskPageGitHubFamiliesDirty,
  notifyTaskPageGitHubMutationRegistry,
  setConfirmedListSnapshot,
  setLastConfirmedClientValue,
  taskPageGitHubItemKey
} from './task-page-github-work-item-mutation-registry'

function markFamilyDirty(repoId: string, itemId: string, family: 'state' | 'assignees'): void {
  const queryKey = getTaskPageGitHubMutationQueryKey()
  if (queryKey !== null) {
    markTaskPageGitHubFamiliesDirty(queryKey, taskPageGitHubItemKey(repoId, itemId), [family])
  }
}

function dialogSourceScope(sourceContext: TaskSourceContext | null | undefined): string | null {
  return sourceContext?.provider === 'github' ? getTaskSourceCacheScope(sourceContext) : null
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
  const sourceScope = dialogSourceScope(args.sourceContext)
  const previous = getLastConfirmedClientValue(sourceScope, args.repoId, args.itemId, 'state')
  setLastConfirmedClientValue(sourceScope, args.repoId, args.itemId, 'state', args.state)
  markFamilyDirty(args.repoId, args.itemId, 'state')
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
      markFamilyDirty(args.repoId, args.itemId, 'state')
      notifyTaskPageGitHubMutationRegistry()
      return true
    }
  }
}

/**
 * Same lag hold as state, for dialog assignee toggles: record the confirmed
 * assignee list as the `assignees` snapshot so a search-lagged Tasks refetch
 * keeps showing it; quiet adopt drops the snapshot once search matches.
 */
export function assertTaskPageGitHubDialogAssigneesAuthority(args: {
  repoId: string
  itemId: string
  assignees: readonly GitHubAssignableUser[]
  sourceContext?: TaskSourceContext | null
}): { revert: () => boolean } {
  const sourceScope = dialogSourceScope(args.sourceContext)
  const previous = getConfirmedListSnapshot(sourceScope, args.repoId, args.itemId, 'assignees')
  setConfirmedListSnapshot(sourceScope, args.repoId, args.itemId, 'assignees', args.assignees)
  const recorded = getConfirmedListSnapshot(sourceScope, args.repoId, args.itemId, 'assignees')
  markFamilyDirty(args.repoId, args.itemId, 'assignees')
  notifyTaskPageGitHubMutationRegistry()
  return {
    revert: () => {
      // A matching search adopt or newer mutation owns the snapshot now.
      if (
        getConfirmedListSnapshot(sourceScope, args.repoId, args.itemId, 'assignees') !== recorded
      ) {
        return false
      }
      if (previous === undefined) {
        deleteConfirmedListSnapshot(sourceScope, args.repoId, args.itemId, 'assignees')
      } else {
        setConfirmedListSnapshot(sourceScope, args.repoId, args.itemId, 'assignees', previous)
      }
      markFamilyDirty(args.repoId, args.itemId, 'assignees')
      notifyTaskPageGitHubMutationRegistry()
      return true
    }
  }
}

/** Why: the dialog tracks assignee logins only; reuse known profiles so list rows keep names/avatars. */
export function resolveTaskPageGitHubDialogAssigneeUsers(
  logins: readonly string[],
  knownUsers: readonly GitHubAssignableUser[]
): GitHubAssignableUser[] {
  return logins.map(
    (login) =>
      knownUsers.find((user) => user.login.toLowerCase() === login.toLowerCase()) ?? {
        login,
        name: null,
        avatarUrl: ''
      }
  )
}
