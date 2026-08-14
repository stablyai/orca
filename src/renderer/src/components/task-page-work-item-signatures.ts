import type { GitHubWorkItem } from '../../../shared/github/work-item-types'

export function taskPageWorkItemKey(item: GitHubWorkItem): string {
  return `${item.repoId}\u0000${item.id}`
}

export function sortedStrings(values: readonly string[] | undefined): string {
  return [...(values ?? [])].sort().join('\u0000')
}

function sortedLogins(users: readonly { login: string | null | undefined }[] | undefined): string {
  return [...(users ?? [])]
    .map((user) => user.login ?? '')
    .sort()
    .join('\u0000')
}

export function taskPageWorkItemStatusSignature(item: GitHubWorkItem): string {
  return JSON.stringify([
    item.type,
    item.number,
    item.title,
    item.state,
    item.url,
    item.author,
    item.branchName ?? null,
    item.baseRefName ?? null,
    sortedStrings(item.labels),
    sortedLogins(item.assignees),
    sortedLogins(item.reviewRequests),
    item.reviewDecision ?? null,
    item.checksSummary?.state ?? null,
    item.checksSummary?.total ?? null,
    item.checksSummary?.failed ?? null,
    item.checksSummary?.pending ?? null,
    item.checksSummary?.neutral ?? null,
    item.mergeable ?? null,
    item.autoMergeEnabled ?? null,
    item.autoMergeAllowed ?? null,
    item.mergeQueueRequired ?? null,
    item.mergeStateStatus ?? null,
    item.updatedAt
  ])
}

export function taskPageWorkItemKeyOrderSignature(items: readonly GitHubWorkItem[]): string {
  return items.map(taskPageWorkItemKey).join('\u0000')
}

export function taskPageWorkItemPaginationBoundary(
  items: readonly GitHubWorkItem[]
): string | null {
  return items.at(-1)?.updatedAt ?? null
}
