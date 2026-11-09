import type { GitHubOwnerRepo } from './pull-request-types'
import type { WorktreeMeta } from '../worktree/meta-types'

export function ownerRepoFromPullRequestUrl(url: string): GitHubOwnerRepo | null {
  const match = url.match(/^https?:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+)\/pull\/\d+/u)
  return match ? { owner: match[2], repo: match[3], host: match[1] } : null
}

export function linkedPRRepository(
  workspace: Pick<WorktreeMeta, 'linkedPR' | 'linkedItems'> | null | undefined
): GitHubOwnerRepo | undefined {
  const item = workspace?.linkedItems?.find(
    (item) =>
      item.provider === 'github' &&
      item.type === 'pr' &&
      item.number === workspace.linkedPR &&
      item.url
  )
  return item?.url ? (ownerRepoFromPullRequestUrl(item.url) ?? undefined) : undefined
}
