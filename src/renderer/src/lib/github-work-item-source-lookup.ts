import type { GitHubWorkItem, GitHubWorkItemDetails } from '../../../shared/types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { getTaskSourceRuntimeSettings } from '../../../shared/task-source-context'
import { parseExecutionHostId } from '../../../shared/execution-host'
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

type GitHubWorkItemDetailsLookupArgs = {
  repoPath: string
  repoId: string
  sourceContext?: TaskSourceContext | null
  number: number
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

export function lookupGitHubWorkItemDetailsForSource(
  args: GitHubWorkItemDetailsLookupArgs
): Promise<GitHubWorkItemDetails | null> {
  const sourceContext = args.sourceContext
  const parsedHost =
    sourceContext?.provider === 'github' ? parseExecutionHostId(sourceContext.hostId) : null
  if (parsedHost?.kind === 'runtime') {
    return callRuntimeRpc<GitHubWorkItemDetails | null>(
      { kind: 'environment', environmentId: parsedHost.environmentId },
      'github.workItemDetails',
      {
        repo: sourceContext?.repoId ?? args.repoId,
        number: args.number,
        type: args.type
      },
      { timeoutMs: 30_000 }
    )
  }
  return window.api.gh.workItemDetails({
    repoPath: args.repoPath,
    repoId: args.repoId,
    sourceContext,
    number: args.number,
    type: args.type
  })
}
