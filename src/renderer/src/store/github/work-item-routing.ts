import type { AppState } from '../types'
import type { RuntimeFocusSettings } from '../../../../shared/github/github-cache-key'
import type { Repo } from '../../../../shared/repo-types'
import type { GitHubWorkItem, ListWorkItemsResult } from '../../../../shared/github/work-item-types'
import {
  getTaskSourceCacheScope,
  type TaskSourceContext
} from '../../../../shared/task-source-context'
import {
  getRepoExecutionHostId,
  parseExecutionHostId,
  type ExecutionHostId
} from '../../../../shared/execution-host'
import { classifyGitHubUnavailable } from '../../../../shared/github/api-availability'
import { callRuntimeRpc } from '../../runtime/runtime-rpc-client'
import { RuntimeRpcCallError } from '../../runtime/runtime-rpc-result'
import { getHostlessSourceRepoOwnerEnvironmentId } from '@/lib/repo-runtime-owner'
import {
  runtimeTargetForOwnerEnvironment,
  ipcOrRuntimeTargetForHostId
} from '@/runtime/runtime-client-target'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { workItemsCacheKey } from './cache-identity'
import { findRepoForGitHubOwner, getRuntimeRepoTarget } from './repository-routing'

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
): RuntimeFocusSettings {
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
): RuntimeFocusSettings {
  return settings ? { ...settings, activeRuntimeEnvironmentId } : { activeRuntimeEnvironmentId }
}

function settingsForGitHubTaskSource(
  state: GitHubSourceRoutingState,
  repo: Pick<Repo, 'id'> | undefined,
  sourceContext: TaskSourceContext
): RuntimeFocusSettings {
  const sourceHost = parseExecutionHostId(sourceContext.hostId)
  return withActiveRuntimeEnvironmentId(
    state.settings,
    sourceHost?.kind === 'runtime'
      ? sourceHost.environmentId
      : getHostlessSourceRepoOwnerEnvironmentId(state.repos, repo?.id)
  )
}

export function getWorkItemsCacheKeyForOwner(
  state: Partial<Pick<AppState, 'repos' | 'settings'>>,
  repoId: string,
  limit: number,
  query: string,
  repoPath?: string
): string {
  const repo = findRepoForGitHubOwner(state, repoId, repoPath ?? '')
  // Why canonical: an SSH row may carry only connectionId, and an unstamped row is local, not focus.
  return workItemsCacheKey(repoId, limit, query, repo ? getRepoExecutionHostId(repo) : undefined)
}

export function getGitHubWorkItemSourceHostId(
  repo: Pick<Repo, 'connectionId' | 'executionHostId'> | undefined,
  sourceContext?: TaskSourceContext | null
): ExecutionHostId | undefined {
  if (sourceContext?.provider === 'github') {
    return sourceContext.hostId
  }
  return repo ? getRepoExecutionHostId(repo) : undefined
}

/** The host whose row a fetch read, never the focused server: items carry it to their actions. */
export function getGitHubWorkItemRowHostId(
  state: Partial<Pick<AppState, 'repos'>>,
  repoId: string,
  repoPath: string,
  sourceContext?: TaskSourceContext | null
): ExecutionHostId | undefined {
  const sourceHostId = sourceContext?.provider === 'github' ? sourceContext.hostId : undefined
  const rows = state.repos?.filter((entry) => entry.id === repoId) ?? []
  // Why not by id alone: a twin would resolve to whichever row is listed first.
  const row =
    rows.find((entry) => getRepoExecutionHostId(entry) === sourceHostId) ??
    rows.find((entry) => entry.path === repoPath) ??
    (rows.length === 1 ? rows[0] : undefined)
  return row ? getRepoExecutionHostId(row) : sourceHostId
}

export function getGitHubWorkItemSourceCacheScope(
  repo: Pick<Repo, 'connectionId' | 'executionHostId'> | undefined,
  sourceContext?: TaskSourceContext | null
): string | undefined {
  if (sourceContext?.provider === 'github') {
    return getTaskSourceCacheScope(sourceContext)
  }
  return getGitHubWorkItemSourceHostId(repo, sourceContext)
}

export function getGitHubRepoSourceSettings(
  state: GitHubSourceRoutingState,
  repo: Pick<Repo, 'id' | 'connectionId' | 'executionHostId'> | undefined,
  sourceContext?: TaskSourceContext | null
): RuntimeFocusSettings {
  if (sourceContext?.provider === 'github') {
    return settingsForGitHubTaskSource(state, repo, sourceContext)
  }
  return settingsForGitHubRepoOwner(state.settings, repo)
}

/**
 * Transport for a repo's GitHub request: a row-less task source's host, else the repo's owner.
 * Local and SSH repos use this app's credentials; an unknown repo stays here too (main refuses
 * repos it does not own) instead of following the focused server.
 */
export function getGitHubSourceTarget(
  state: Pick<AppState, 'repos'>,
  repo: Pick<Repo, 'id' | 'connectionId' | 'executionHostId'> | undefined,
  sourceContext?: TaskSourceContext | null
): RuntimeClientTarget {
  if (sourceContext?.provider === 'github') {
    const sourceHost = parseExecutionHostId(sourceContext.hostId)
    return runtimeTargetForOwnerEnvironment(
      sourceHost?.kind === 'runtime'
        ? sourceHost.environmentId
        : getHostlessSourceRepoOwnerEnvironmentId(state.repos, repo?.id)
    )
  }
  return (
    (repo ? ipcOrRuntimeTargetForHostId(getRepoExecutionHostId(repo)) : null) ?? { kind: 'local' }
  )
}

export function getGitHubWorkItemRequestContext(
  state: AppState,
  requestTarget: RuntimeClientTarget,
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
  const runtimeRepo = getRuntimeRepoTarget(state, { repoId, repoPath }, requestTarget)
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
