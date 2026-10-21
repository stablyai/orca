import type { GitLabWorkItem, ListMergeRequestsResult } from '../../../shared/gitlab-types'
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

type GitLabMRListLookupArgs = GitLabSourceLookupArgs & {
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

export async function listGitLabMRsForSource(
  args: GitLabMRListLookupArgs
): Promise<ListMergeRequestsResult> {
  const result = await gitLabApiFor(args).listMRs(args)
  return {
    ...result,
    items: result.items.map((item) => withRendererRepoId(item, args.repoId))
  }
}
