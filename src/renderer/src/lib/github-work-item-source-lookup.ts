import type { GitHubWorkItem } from '../../../shared/types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { getTaskSourceRuntimeSettings } from '../../../shared/task-source-context'
import { callRuntimeRpc, getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'

type GitHubWorkItemLookupArgs = {
  repoPath: string
  repoId: string
  sourceContext?: TaskSourceContext | null
  number: number
  type?: 'issue' | 'pr'
}

type GitHubWorkItemByOwnerRepoLookupArgs = GitHubWorkItemLookupArgs & {
  owner: string
  repo: string
  type: 'issue' | 'pr'
}

function runtimeRepoId(args: Pick<GitHubWorkItemLookupArgs, 'repoId' | 'sourceContext'>): string {
  return args.sourceContext?.repoId ?? args.repoId
}

export async function lookupGitHubWorkItemForSource(
  args: GitHubWorkItemLookupArgs
): Promise<GitHubWorkItem | null> {
  const target = getActiveRuntimeTarget(getTaskSourceRuntimeSettings(args.sourceContext))
  const item =
    target.kind === 'environment'
      ? await callRuntimeRpc<Omit<GitHubWorkItem, 'repoId'> | null>(
          target,
          'github.workItem',
          {
            repo: runtimeRepoId(args),
            number: args.number,
            type: args.type
          },
          { timeoutMs: 30_000 }
        )
      : await window.api.gh.workItem({
          repoPath: args.repoPath,
          repoId: args.repoId,
          number: args.number,
          type: args.type
        })
  return item ? ({ ...item, repoId: args.repoId } as GitHubWorkItem) : null
}

export async function lookupGitHubWorkItemByOwnerRepoForSource(
  args: GitHubWorkItemByOwnerRepoLookupArgs
): Promise<GitHubWorkItem | null> {
  const target = getActiveRuntimeTarget(getTaskSourceRuntimeSettings(args.sourceContext))
  const item =
    target.kind === 'environment'
      ? await callRuntimeRpc<Omit<GitHubWorkItem, 'repoId'> | null>(
          target,
          'github.workItemByOwnerRepo',
          {
            repo: runtimeRepoId(args),
            owner: args.owner,
            ownerRepo: args.repo,
            number: args.number,
            type: args.type
          },
          { timeoutMs: 30_000 }
        )
      : await window.api.gh.workItemByOwnerRepo({
          repoPath: args.repoPath,
          repoId: args.repoId,
          owner: args.owner,
          repo: args.repo,
          number: args.number,
          type: args.type
        })
  return item ? ({ ...item, repoId: args.repoId } as GitHubWorkItem) : null
}
