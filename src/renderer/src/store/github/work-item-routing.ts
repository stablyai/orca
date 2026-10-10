import type { AppState } from '../types'
import type { Repo } from '../../../../shared/repo-types'
import type { GitHubWorkItem, ListWorkItemsResult } from '../../../../shared/github/work-item-types'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../../shared/task-source-context'
import {
  getRepoExecutionHostId,
  normalizeExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { classifyGitHubUnavailable } from '../../../../shared/github/api-availability'
import { callRuntimeRpc, RuntimeRpcCallError } from '../../runtime/runtime-rpc-client'
import { getHostlessSourceRepoOwnerEnvironmentId } from '@/lib/repo-runtime-owner'
import { workItemsCacheKey } from './cache-identity'
import {
  findRepoForGitHubOwner,
  getGitHubFocusedRepoOwnerHostId,
  getRuntimeRepoTarget
} from './repository-routing'

export type GitHubWorkItemRequestContext = {
  repoId: string
  repoPath: string
  target: GitHubWorkItemRequestTarget
}

export type GitHubWorkItemRequestTarget =
  | { kind: 'environment'; environmentId: string; runtimeRepoId: string }
  | { kind: 'local' }

type GitHubSourceRoutingState = Pick<AppState, 'settings' | 'repos'>

export type GitHubWorkItemsListArgs = {
  limit: number
  query?: string
  page?: number
  noCache?: true
}

export function settingsForGitHubRepoOwner(
  settings: AppState['settings'],
  repo: Pick<Repo, 'connectionId' | 'executionHostId'> | undefined
): AppState['settings'] {
  if (!repo) {
    return settings
  }
  const parsed = parseExecutionHostId(getRepoExecutionHostId(repo))
  // Why: local and SSH-owned GitHub lookups run on the desktop client; host focus must not redirect them to the selected runtime.
  return withActiveRuntimeEnvironmentId(
    settings,
    parsed?.kind === 'runtime' ? parsed.environmentId : null
  )
}

function withActiveRuntimeEnvironmentId(
  settings: AppState['settings'],
  activeRuntimeEnvironmentId: string | null
): AppState['settings'] {
  return settings
    ? { ...settings, activeRuntimeEnvironmentId }
    : // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: routing readers only consume activeRuntimeEnvironmentId before settings hydrate.
      ({ activeRuntimeEnvironmentId } as AppState['settings'])
}

function settingsForGitHubTaskSource(
  state: GitHubSourceRoutingState,
  repo: Pick<Repo, 'id'> | undefined,
  sourceContext: TaskSourceContext
): AppState['settings'] {
  const sourceHost = parseExecutionHostId(sourceContext.hostId)
  return withActiveRuntimeEnvironmentId(
    state.settings,
    sourceHost?.kind === 'runtime'
      ? sourceHost.environmentId
      : getHostlessSourceRepoOwnerEnvironmentId(state.repos, repo?.id)
  )
}

export function settingsForGitHubFocusedRepoOwner(
  settings: AppState['settings'],
  repo: Pick<Repo, 'connectionId' | 'executionHostId'> | undefined
): AppState['settings'] {
  if (!repo?.executionHostId && !repo?.connectionId) {
    return settings
  }
  return settingsForGitHubRepoOwner(settings, repo)
}
export function getWorkItemsCacheKeyForOwner(
  state: Partial<Pick<AppState, 'repos' | 'settings'>>,
  repoId: string,
  limit: number,
  query: string,
  repoPath?: string
): string {
  const repo = findRepoForGitHubOwner(state, repoId, repoPath ?? '')
  return workItemsCacheKey(
    repoId,
    limit,
    query,
    repo ? getGitHubFocusedRepoOwnerHostId(state.settings ?? null, repo) : undefined
  )
}

export function getGitHubWorkItemSourceHostId(
  state: AppState,
  repo: Pick<Repo, 'connectionId' | 'executionHostId'> | undefined,
  sourceContext?: TaskSourceContext | null
): ExecutionHostId | undefined {
  if (sourceContext?.provider === 'github') {
    return sourceContext.hostId
  }
  return repo
    ? (normalizeExecutionHostId(getGitHubFocusedRepoOwnerHostId(state.settings, repo)) ?? undefined)
    : undefined
}

export function getGitHubWorkItemSourceCacheScope(
  state: AppState,
  repo: Pick<Repo, 'connectionId' | 'executionHostId'> | undefined,
  sourceContext?: TaskSourceContext | null
): string | undefined {
  if (sourceContext?.provider === 'github') {
    return getTaskSourceCacheScope(sourceContext)
  }
  return getGitHubWorkItemSourceHostId(state, repo, sourceContext)
}

export function getGitHubWorkItemSourceSettings(
  state: GitHubSourceRoutingState,
  repo: Pick<Repo, 'id' | 'connectionId' | 'executionHostId'> | undefined,
  sourceContext?: TaskSourceContext | null
): AppState['settings'] {
  if (sourceContext?.provider === 'github') {
    return settingsForGitHubTaskSource(state, repo, sourceContext)
  }
  return settingsForGitHubFocusedRepoOwner(state.settings, repo)
}

export function getGitHubRepoSourceSettings(
  state: GitHubSourceRoutingState,
  repo: Pick<Repo, 'id' | 'connectionId' | 'executionHostId'> | undefined,
  sourceContext?: TaskSourceContext | null
): AppState['settings'] {
  if (sourceContext?.provider === 'github') {
    return settingsForGitHubTaskSource(state, repo, sourceContext)
  }
  return settingsForGitHubRepoOwner(state.settings, repo)
}

export function getGitHubWorkItemRequestContext(
  state: AppState,
  settings: AppState['settings'],
  repoId: string,
  repoPath: string,
  sourceContext?: TaskSourceContext | null
): GitHubWorkItemRequestContext {
  if (sourceContext?.provider === 'github') {
    const parsedHost = parseExecutionHostId(sourceContext.hostId)
    if (parsedHost?.kind === 'runtime') {
      return {
        repoId,
        repoPath,
        target: {
          kind: 'environment',
          environmentId: parsedHost.environmentId,
          runtimeRepoId: sourceContext.repoId ?? repoId
        }
      }
    }
  }
  const runtimeRepo = getRuntimeRepoTarget(state, repoPath, settings)
  return {
    repoId,
    repoPath,
    target: runtimeRepo
      ? {
          kind: 'environment',
          environmentId: runtimeRepo.target.environmentId,
          runtimeRepoId: runtimeRepo.repo.id
        }
      : { kind: 'local' }
  }
}

export function listGitHubWorkItemsForRepo(
  context: GitHubWorkItemRequestContext,
  args: GitHubWorkItemsListArgs
): Promise<ListWorkItemsResult<Omit<GitHubWorkItem, 'repoId'>>> {
  if (context.target.kind === 'environment') {
    return callRuntimeRpc<ListWorkItemsResult<Omit<GitHubWorkItem, 'repoId'>>>(
      { kind: 'environment', environmentId: context.target.environmentId },
      'github.listWorkItems',
      {
        repo: context.target.runtimeRepoId,
        ...args
      },
      { timeoutMs: 30_000 }
    )
  }
  return window.api.gh.listWorkItems({
    repoPath: context.repoPath,
    repoId: context.repoId,
    ...args
  })
}

export function countGitHubWorkItemsForRepo(
  context: GitHubWorkItemRequestContext,
  args: { query?: string }
): Promise<number> {
  if (context.target.kind === 'environment') {
    return callRuntimeRpc<number>(
      { kind: 'environment', environmentId: context.target.environmentId },
      'github.countWorkItems',
      {
        repo: context.target.runtimeRepoId,
        ...args
      },
      { timeoutMs: 30_000 }
    )
  }
  return window.api.gh.countWorkItems({
    repoPath: context.repoPath,
    repoId: context.repoId,
    ...args
  })
}

export function isGitHubUnavailableWorkItemsError(error: unknown): boolean {
  // Why: only `runtime_error` came from the GitHub method; other RPC transport failures ("timed out"/"unavailable") must not be blamed on GitHub.
  if (error instanceof RuntimeRpcCallError && error.code !== 'runtime_error') {
    return false
  }
  const message = error instanceof Error ? error.message : String(error)
  return classifyGitHubUnavailable(message) !== null
}
