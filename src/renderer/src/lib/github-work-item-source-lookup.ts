import { callGitHubTargetOperation } from './github-work-item-target-request'
import { requireGitHubWorkItemTargetDetails } from '../../../shared/github/work-item-target'
import type { GitHubWorkItem, GitHubWorkItemDetails } from '../../../shared/github/work-item-types'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import type { GitHubOwnerRepo } from '../../../shared/github/pull-request-types'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import {
  getGitHubRuntimeRepoId,
  getGitHubSourceRuntimeHost,
  getGitHubSourceRuntimeTarget
} from './github-source-runtime-context'

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
  host?: string
  type: 'issue' | 'pr'
  /** One light call for hover cards; older hosts ignore it. */
  preview?: boolean
}

type GitHubWorkItemDetailsLookupArgs = {
  repoPath: string
  repoId: string
  sourceContext?: TaskSourceContext | null
  number: number
  type: 'issue' | 'pr'
  ownerRepo?: GitHubOwnerRepo | null
  target?: RuntimeClientTarget
}

function runtimeRepoId(args: Pick<GitHubWorkItemLookupArgs, 'repoId' | 'sourceContext'>): string {
  return getGitHubRuntimeRepoId(args.sourceContext, args.repoId)
}

export async function lookupGitHubWorkItemForSource(
  args: GitHubWorkItemLookupArgs
): Promise<GitHubWorkItem | null> {
  const target = getGitHubSourceRuntimeTarget(args.sourceContext)
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
  const target = getGitHubSourceRuntimeTarget(args.sourceContext)
  const item =
    target.kind === 'environment'
      ? await callRuntimeRpc<Omit<GitHubWorkItem, 'repoId'> | null>(
          target,
          'github.workItemByOwnerRepo',
          {
            repo: runtimeRepoId(args),
            owner: args.owner,
            ownerRepo: args.repo,
            ...(args.host ? { host: args.host } : {}),
            number: args.number,
            type: args.type,
            ...(args.preview ? { preview: true } : {})
          },
          { timeoutMs: 30_000 }
        )
      : await window.api.gh.workItemByOwnerRepo({
          repoPath: args.repoPath,
          repoId: args.repoId,
          sourceContext: args.sourceContext,
          owner: args.owner,
          repo: args.repo,
          ...(args.host ? { host: args.host } : {}),
          number: args.number,
          type: args.type,
          ...(args.preview ? { preview: true } : {})
        })
  return item ? ({ ...item, repoId: args.repoId } as GitHubWorkItem) : null
}

export async function lookupGitHubWorkItemDetailsForSource(
  args: GitHubWorkItemDetailsLookupArgs
): Promise<GitHubWorkItemDetails | null> {
  const sourceContext = args.sourceContext
  const runtimeHost = getGitHubSourceRuntimeHost(sourceContext)
  const result = await callGitHubTargetOperation<GitHubWorkItemDetails | null>({
    target:
      args.target ??
      (runtimeHost
        ? { kind: 'environment', environmentId: runtimeHost.environmentId }
        : { kind: 'local' }),
    ownerRepo: args.ownerRepo,
    read: true,
    method: 'github.workItemDetails',
    params: {
      repo: getGitHubRuntimeRepoId(sourceContext, args.repoId),
      number: args.number,
      type: args.type
    },
    local: (exact) =>
      window.api.gh.workItemDetails({
        repoPath: args.repoPath,
        repoId: args.repoId,
        sourceContext,
        number: args.number,
        type: args.type,
        ...exact
      })
  })
  if (args.ownerRepo) {
    return requireGitHubWorkItemTargetDetails(result, {
      repository: args.ownerRepo,
      type: args.type,
      number: args.number
    })
  }
  return result
}
