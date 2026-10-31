import { getWorkItemRepo } from './work-item-repo-row'
import { observeGitHubWorkItem } from './github-task-observation'
import type { GitHubWorkItem, GitHubWorkItemDetails } from '../../../shared/github/work-item-types'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import type { GitHubOwnerRepo } from '../../../shared/github/pull-request-types'
import { callRuntimeRpc, runtimeEnvironmentSupportsCapability } from '@/runtime/runtime-rpc-client'
import { GITHUB_CANONICAL_DETAILS_RUNTIME_CAPABILITY } from '../../../shared/task-source-runtime-capabilities'
import { parseGitHubIssueOrPRLink } from '../../../shared/github/links'
import { githubRepoIdentityKey } from '../../../shared/github/repository-identity-key'
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
  accepts?: () => boolean
  rpcOptions?: Parameters<typeof callRuntimeRpc>[3]
}

type GitHubWorkItemDetailsLookupArgs = {
  repoPath: string
  repoId: string
  sourceContext?: TaskSourceContext | null
  number: number
  type: 'issue' | 'pr'
  ownerRepo?: GitHubOwnerRepo | null
  canonical?: boolean
  accepts?: () => boolean
  rpcOptions?: Parameters<typeof callRuntimeRpc>[3]
}

function runtimeRepoId(args: Pick<GitHubWorkItemLookupArgs, 'repoId' | 'sourceContext'>): string {
  return getGitHubRuntimeRepoId(args.sourceContext, args.repoId)
}

export async function lookupGitHubWorkItemForSource(
  args: GitHubWorkItemLookupArgs
): Promise<GitHubWorkItem | null> {
  const { useAppStore } = await import('@/store')
  const state = useAppStore.getState()
  const cache = state.githubTaskCache
  const binding = cache?.capture(
    getWorkItemRepo(state.repos ?? [], {
      repoId: args.repoId,
      repoHostId: args.sourceContext?.hostId
    }),
    args.sourceContext
  )
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
  if (binding && !cache.current(binding)) {
    return null
  }
  return item ? (cache?.acceptSearch([{ ...item, repoId: args.repoId }], binding)[0] ?? null) : null
}

export async function lookupGitHubWorkItemByOwnerRepoForSource(
  args: GitHubWorkItemByOwnerRepoLookupArgs
): Promise<GitHubWorkItem | null> {
  if (args.accepts?.() === false) {
    return null
  }
  const { useAppStore } = await import('@/store')
  const state = useAppStore.getState()
  const cache = state.githubTaskCache
  const binding = cache?.capture(
    getWorkItemRepo(state.repos ?? [], {
      repoId: args.repoId,
      repoHostId: args.sourceContext?.hostId
    }),
    args.sourceContext
  )
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
          {
            timeoutMs: 30_000,
            ...args.rpcOptions,
            beforeSend: () => {
              if (args.accepts?.() === false || (binding && !cache.current(binding))) {
                throw new Error('Task source changed.')
              }
            }
          }
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
  if (args.accepts?.() === false || (binding && !cache.current(binding))) {
    return null
  }
  return item
    ? args.accepts
      ? observeGitHubWorkItem({ ...item, repoId: args.repoId }, binding?.observation)
      : (cache?.acceptSearch([{ ...item, repoId: args.repoId }], binding)[0] ?? null)
    : null
}

export async function lookupGitHubWorkItemDetailsForSource(
  args: GitHubWorkItemDetailsLookupArgs
): Promise<GitHubWorkItemDetails | null> {
  if (args.accepts?.() === false) {
    return null
  }
  const sourceContext = args.sourceContext
  const runtimeHost = getGitHubSourceRuntimeHost(sourceContext)
  if (
    args.canonical &&
    runtimeHost &&
    !(await runtimeEnvironmentSupportsCapability(
      runtimeHost.environmentId,
      GITHUB_CANONICAL_DETAILS_RUNTIME_CAPABILITY
    ))
  ) {
    throw new Error('Task refresh is unavailable on this server. Update the server and try again.')
  }
  if (args.accepts?.() === false) {
    return null
  }
  const result = await (runtimeHost
    ? callRuntimeRpc<GitHubWorkItemDetails | null>(
        { kind: 'environment', environmentId: runtimeHost.environmentId },
        'github.workItemDetails',
        {
          repo: getGitHubRuntimeRepoId(sourceContext, args.repoId),
          number: args.number,
          type: args.type,
          ...(args.canonical && args.ownerRepo ? { ownerRepo: args.ownerRepo } : {})
        },
        {
          timeoutMs: 30_000,
          ...args.rpcOptions,
          ...(args.accepts
            ? {
                beforeSend: () => {
                  if (!args.accepts?.()) {
                    throw new Error('Task context changed.')
                  }
                }
              }
            : {})
        }
      )
    : window.api.gh.workItemDetails({
        repoPath: args.repoPath,
        repoId: args.repoId,
        sourceContext,
        number: args.number,
        type: args.type,
        ...(args.ownerRepo ? { ownerRepo: args.ownerRepo } : {})
      }))
  if (args.accepts?.() === false) {
    return null
  }
  if (args.canonical && result) {
    const returned = parseGitHubIssueOrPRLink(result.item.url)
    if (
      !returned ||
      !args.ownerRepo ||
      result.item.type !== args.type ||
      result.item.number !== args.number ||
      returned.type !== args.type ||
      returned.number !== args.number ||
      githubRepoIdentityKey(returned.slug) !== githubRepoIdentityKey(args.ownerRepo)
    ) {
      throw new Error('GitHub returned a different task. Refresh this task again.')
    }
    return result.item.assignees === undefined
      ? result
      : { ...result, assignees: result.item.assignees.map((user) => user.login) }
  }
  return result
}
