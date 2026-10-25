import type { ParsedTaskQuery } from '../../../../../shared/task-query'
import type { GitHubAssignableUser } from '../../../../../shared/github/pull-request-types'
import type { GitHubWorkItem } from '../../../../../shared/github/work-item-types'
import type { StickyHideEntry } from './task-page-github-work-item-registry-types'

function includesLogin(users: readonly GitHubAssignableUser[] | undefined, login: string): boolean {
  const target = login.toLowerCase()
  return (users ?? []).some((user) => user.login.toLowerCase() === target)
}

function resolveMeLogin(viewerLogin: string | null): string | null {
  const trimmed = viewerLogin?.trim()
  return trimmed ? trimmed.toLowerCase() : null
}

/** Soft-hide when any applicable query membership constraint fails. */
export function shouldSoftHideTaskPageGitHubWorkItem(args: {
  item: Pick<GitHubWorkItem, 'state' | 'assignees' | 'reviewRequests'>
  query: ParsedTaskQuery
  viewerLogin: string | null
  /** Resolve environment/SSH per item; a multi-repo page can mix local and remote sources. */
  skipMeQualifiers: boolean
}): boolean {
  const { item, query, skipMeQualifiers } = args
  const viewer = resolveMeLogin(args.viewerLogin)

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

  // is:draft forces open state, so a separate draft check must hide items that become non-draft.
  if (query.draft && item.state !== 'draft') {
    return true
  }

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
  // Sticky hides retain confirmed membership exits after pending operations clear.
  return {
    hide: membershipHide || stickyActive,
    sticky: stickyActive
  }
}
