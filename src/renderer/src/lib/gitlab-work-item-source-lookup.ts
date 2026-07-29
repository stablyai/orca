import type { GitLabWorkItem, ListMergeRequestsResult } from '../../../shared/types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { getTaskSourceRuntimeSettings } from '../../../shared/task-source-context'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'

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

function runtimeRepoId(args: Pick<GitLabSourceLookupArgs, 'repoId' | 'sourceContext'>): string {
  return args.sourceContext?.repoId ?? args.repoId
}

function withRendererRepoId(item: Omit<GitLabWorkItem, 'repoId'> | GitLabWorkItem, repoId: string) {
  return { ...item, repoId } as GitLabWorkItem
}

export async function lookupGitLabWorkItemByPathForSource(
  args: GitLabWorkItemByPathLookupArgs
): Promise<GitLabWorkItem | null> {
  const target = getActiveRuntimeTarget(getTaskSourceRuntimeSettings(args.sourceContext))
  const item =
    target.kind === 'environment'
      ? await callRuntimeRpc<Omit<GitLabWorkItem, 'repoId'> | null>(
          target,
          'gitlab.workItemByPath',
          {
            repo: runtimeRepoId(args),
            host: args.host,
            path: args.path,
            iid: args.iid,
            type: args.type
          },
          { timeoutMs: 30_000 }
        )
      : ((await window.api.gl.workItemByPath({
          repoPath: args.repoPath,
          repoId: args.repoId,
          sourceContext: args.sourceContext,
          host: args.host,
          path: args.path,
          iid: args.iid,
          type: args.type
        })) as Omit<GitLabWorkItem, 'repoId'> | GitLabWorkItem | null)
  return item ? withRendererRepoId(item, args.repoId) : null
}

export async function listGitLabMRsForSource(
  args: GitLabMRListLookupArgs
): Promise<ListMergeRequestsResult> {
  const target = getActiveRuntimeTarget(getTaskSourceRuntimeSettings(args.sourceContext))
  const result =
    target.kind === 'environment'
      ? await callRuntimeRpc<ListMergeRequestsResult>(
          target,
          'gitlab.listMRs',
          {
            repo: runtimeRepoId(args),
            state: args.state,
            page: args.page,
            perPage: args.perPage,
            query: args.query
          },
          { timeoutMs: 30_000 }
        )
      : ((await window.api.gl.listMRs({
          repoPath: args.repoPath,
          repoId: args.repoId,
          sourceContext: args.sourceContext,
          state: args.state,
          page: args.page,
          perPage: args.perPage,
          query: args.query
        })) as ListMergeRequestsResult)
  return {
    ...result,
    items: result.items.map((item) => withRendererRepoId(item, args.repoId))
  }
}
