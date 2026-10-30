import type { GitLabPagedResult, GitLabWorkItem } from '../../../shared/gitlab-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { gitLabApiFor } from '@/runtime/gitlab-owner-api'

type GitLabSourceLookupArgs = {
  repoPath: string
  repoId: string
  sourceContext?: TaskSourceContext | null
}

type GitLabWorkItemByPathLookupArgs = GitLabSourceLookupArgs & {
  host: string
  path: string
  iid: number
  type: 'issue' | 'mr'
}

type GitLabWorkItemListLookupArgs = GitLabSourceLookupArgs & {
  state?: 'opened' | 'merged' | 'closed' | 'all'
  page?: number
  perPage?: number
  query?: string
}

function withRendererRepoId(item: Omit<GitLabWorkItem, 'repoId'> | GitLabWorkItem, repoId: string) {
  return { ...item, repoId } as GitLabWorkItem
}

export async function lookupGitLabWorkItemByPathForSource(
  args: GitLabWorkItemByPathLookupArgs
): Promise<GitLabWorkItem | null> {
  const item = await gitLabApiFor(args).workItemByPath(args)
  return item ? withRendererRepoId(item, args.repoId) : null
}

export async function listGitLabWorkItemsForSource(
  args: GitLabWorkItemListLookupArgs
): Promise<GitLabPagedResult<GitLabWorkItem>> {
  const result = await gitLabApiFor(args).listWorkItems(args)
  return {
    ...result,
    items: result.items.map((item) => withRendererRepoId(item, args.repoId))
  }
}
