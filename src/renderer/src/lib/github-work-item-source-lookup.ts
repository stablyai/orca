import type { GhAccountBinding } from '../../../shared/github/account-binding'
import { getWorkItemRepo } from './work-item-repo-row'
import type { GitHubWorkItem, GitHubWorkItemDetails } from '../../../shared/github/work-item-types'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import type { GitHubOwnerRepo } from '../../../shared/github/pull-request-types'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { callGitHubTargetOperation } from './github-work-item-target-request'
import {
  GITHUB_EXACT_OPERATION_UNSUPPORTED,
  requireGitHubWorkItemTargetDetails
} from '../../../shared/github/work-item-target'
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
  target?: RuntimeClientTarget
  canonical?: boolean
  expectedGhAccount?: GhAccountBinding | null
  accepts?: () => boolean
  rpcOptions?: Parameters<typeof callRuntimeRpc>[3]
}

function runtimeRepoId(args: Pick<GitHubWorkItemLookupArgs, 'repoId' | 'sourceContext'>): string {
  return getGitHubRuntimeRepoId(args.sourceContext, args.repoId)
}

/** Issue readings feed the shared task records; pull requests never have one, so their lookups skip it. */
async function captureTaskRecords(args: GitHubWorkItemLookupArgs) {
  if (args.type === 'pr') {
    return undefined
  }
  const { useAppStore } = await import('@/store')
  const state = useAppStore.getState()
  const cache = state.githubTaskCache
  const repo = getWorkItemRepo(state.repos ?? [], {
    repoId: args.repoId,
    repoHostId: args.sourceContext?.hostId
  })
  return cache && { cache, binding: cache.capture(repo, args.sourceContext) }
}

export async function lookupGitHubWorkItemForSource(
  args: GitHubWorkItemLookupArgs
): Promise<GitHubWorkItem | null> {
  const records = await captureTaskRecords(args)
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
  const row: GitHubWorkItem | null = item ? { ...item, repoId: args.repoId } : null
  return row && records ? records.cache.acceptSearch([row], records.binding)[0] : row
}

export async function lookupGitHubWorkItemByOwnerRepoForSource(
  args: GitHubWorkItemByOwnerRepoLookupArgs
): Promise<GitHubWorkItem | null> {
  if (args.accepts?.() === false) {
    return null
  }
  const records = await captureTaskRecords(args)
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
              if (args.accepts?.() === false) {
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
  if (args.accepts?.() === false) {
    return null
  }
  const row: GitHubWorkItem | null = item ? { ...item, repoId: args.repoId } : null
  // A canonical verification read publishes through its record, not as a search reading.
  return row && records && !args.accepts
    ? records.cache.acceptSearch([row], records.binding)[0]
    : row
}

export async function lookupGitHubWorkItemDetailsForSource(
  args: GitHubWorkItemDetailsLookupArgs
): Promise<GitHubWorkItemDetails | null> {
  if (args.accepts?.() === false) {
    return null
  }
  const sourceContext = args.sourceContext
  const runtimeHost = getGitHubSourceRuntimeHost(sourceContext)
  let result: GitHubWorkItemDetails | null
  try {
    result = await callGitHubTargetOperation<GitHubWorkItemDetails | null>({
      target:
        args.target ??
        (runtimeHost
          ? { kind: 'environment', environmentId: runtimeHost.environmentId }
          : { kind: 'local' }),
      ownerRepo: args.ownerRepo,
      expectedGhAccount: args.expectedGhAccount,
      canonical: args.canonical ?? false,
      read: true,
      method: 'github.workItemDetails',
      params: {
        repo: getGitHubRuntimeRepoId(sourceContext, args.repoId),
        number: args.number,
        type: args.type
      },
      rpcOptions: {
        ...args.rpcOptions,
        beforeSend: () => {
          args.rpcOptions?.beforeSend?.()
          if (args.accepts?.() === false) {
            throw new Error('Task context changed.')
          }
        }
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
  } catch (error) {
    if (
      args.canonical &&
      error instanceof Error &&
      error.message === GITHUB_EXACT_OPERATION_UNSUPPORTED
    ) {
      return null
    }
    throw error
  }
  if (args.accepts?.() === false) {
    return null
  }
  if (args.ownerRepo) {
    requireGitHubWorkItemTargetDetails(result, {
      repository: args.ownerRepo,
      type: args.type,
      number: args.number
    })
  }
  return args.canonical && result?.item.assignees !== undefined
    ? { ...result, assignees: result.item.assignees.map((user) => user.login) }
    : result
}
