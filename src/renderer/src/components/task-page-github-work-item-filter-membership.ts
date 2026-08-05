import type { ParsedTaskQuery } from '../../../shared/task-query'
import type { GitHubAssignableUser, GitHubWorkItem } from '../../../shared/types'
import type { StickyHideEntry } from './task-page-github-work-item-mutation-registry'

function includesLogin(users: readonly GitHubAssignableUser[] | undefined, login: string): boolean {
  const target = login.toLowerCase()
  return (users ?? []).some((user) => user.login.toLowerCase() === target)
}

function resolveMeLogin(viewerLogin: string | null): string | null {
  const trimmed = viewerLogin?.trim()
  return trimmed ? trimmed.toLowerCase() : null
}

/**
 * Whether a registry-merged work item should be soft-hidden for the active query.
 * Evaluate every applicable membership signal; hide if any fails (AND of constraints).
 */
export function shouldSoftHideTaskPageGitHubWorkItem(args: {
  item: Pick<GitHubWorkItem, 'state' | 'assignees' | 'reviewRequests'>
  query: ParsedTaskQuery
  viewerLogin: string | null
  /**
   * Per-item: true when this item’s sourceContext resolves to environment/SSH.
   * Never a page-level flag (multi-repo can mix local + remote).
   */
  skipMeQualifiers: boolean
}): boolean {
  const { item, query, skipMeQualifiers } = args
  const viewer = resolveMeLogin(args.viewerLogin)

  // State membership
  if (query.state === 'open') {
    if (item.state === 'closed' || item.state === 'merged') {
      return true
    }
  } else if (query.state === 'closed') {
    // Why: closed-only lists treat merged as out-of-membership for soft-hide.
    if (item.state === 'open' || item.state === 'merged' || item.state === 'draft') {
      return true
    }
  } else if (query.state === 'merged') {
    if (item.state !== 'merged') {
      return true
    }
  }
  // state === null | 'all' → no state-based soft-hide

  // Why: is:draft forces state to 'open', so a draft that turns non-draft still
  // passes the state check; the draft qualifier soft-hides it explicitly.
  if (query.draft && item.state !== 'draft') {
    return true
  }

  // Assignee membership
  if (query.assignee) {
    const assignee = query.assignee.trim()
    if (assignee.toLowerCase() === '@me') {
      if (!skipMeQualifiers && viewer && !includesLogin(item.assignees, viewer)) {
        return true
      }
    } else if (!includesLogin(item.assignees, assignee.replace(/^@/, ''))) {
      return true
    }
  }

  // Review-requested membership
  if (query.reviewRequested) {
    const requested = query.reviewRequested.trim()
    if (requested.toLowerCase() === '@me') {
      if (!skipMeQualifiers && viewer && !includesLogin(item.reviewRequests, viewer)) {
        return true
      }
    } else if (!includesLogin(item.reviewRequests, requested.replace(/^@/, ''))) {
      return true
    }
  }

  // author @me / labels / free text: do not soft-hide from those alone
  return false
}

export function recomputeTaskPageGitHubItemSoftHide(args: {
  item: Pick<GitHubWorkItem, 'state' | 'assignees' | 'reviewRequests'>
  query: ParsedTaskQuery
  viewerLogin: string | null
  skipMeQualifiers: boolean
  queryKey: string
  sticky: ReadonlyMap<string, StickyHideEntry>
  itemKey: string
}): { hide: boolean; sticky: boolean } {
  const membershipHide = shouldSoftHideTaskPageGitHubWorkItem({
    item: args.item,
    query: args.query,
    viewerLogin: args.viewerLogin,
    skipMeQualifiers: args.skipMeQualifiers
  })
  const stickyEntry = args.sticky.get(args.itemKey)
  const stickyActive = Boolean(stickyEntry && stickyEntry.queryKey === args.queryKey)
  // Why: sticky keeps successful membership exits hidden after pending clears;
  // pending membership hide still applies before confirm.
  return {
    hide: membershipHide || stickyActive,
    sticky: stickyActive
  }
}
