import {
  getRepoExecutionHostId,
  toRuntimeExecutionHostId,
  parseExecutionHostId
} from '../../../shared/execution-host'
import type { Repo } from '../../../shared/repo-types'
import { findRepoForHost } from '@/store/slices/repo-host-identity'
import type { ExecutionHostId, ParsedExecutionHost } from '../../../shared/execution-host'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/runtime-client-target'
import type { RuntimeClientTarget } from '../../../shared/runtime-client-target'
import { taskSourceRuntimeTarget } from './task-source-runtime-target'
import {
  getExplicitRuntimeOwnerEnvironmentId,
  getHostlessSourceRepoOwnerEnvironmentId,
  type RepoRuntimeOwnerState
} from './repo-runtime-owner'

export type GitHubRuntimeHost = Extract<ParsedExecutionHost, { kind: 'runtime' }>

export function getGitHubSourceRuntimeHost(
  sourceContext: TaskSourceContext | null | undefined
): GitHubRuntimeHost | null {
  if (sourceContext?.provider !== 'github') {
    return null
  }
  const parsedHost = parseExecutionHostId(sourceContext.hostId)
  return parsedHost?.kind === 'runtime' ? parsedHost : null
}

export function getGitHubSourceRuntimeTarget(
  sourceContext: TaskSourceContext | null | undefined
): RuntimeClientTarget {
  return taskSourceRuntimeTarget(sourceContext?.provider === 'github' ? sourceContext : null)
}

// Repo owners govern PR actions; runtime source overrides, local/absent source cannot downgrade. Only unqualified twins fall back to focused runtime (#6957, #7623).
export function getGitHubRepoRoutingTarget(
  state: RepoRuntimeOwnerState,
  repoId: string | null | undefined,
  sourceContext: TaskSourceContext | null | undefined,
  /** The host of the row the caller is showing; picks between twins without a github source. */
  hostId?: ExecutionHostId | null
): RuntimeClientTarget {
  const sourceHost = getGitHubSourceRuntimeHost(sourceContext)
  if (sourceHost) {
    return runtimeTargetForOwnerEnvironment(sourceHost.environmentId)
  }
  return runtimeTargetForOwnerEnvironment(
    sourceContext?.provider === 'github'
      ? getHostlessSourceRepoOwnerEnvironmentId(state.repos, repoId)
      : getExplicitRuntimeOwnerEnvironmentId(state, repoId, hostId)
  )
}

export function canUseGitHubRepoContext(
  repoPath: string | null | undefined,
  sourceContext: TaskSourceContext | null | undefined
): boolean {
  return Boolean(repoPath) || getGitHubSourceRuntimeHost(sourceContext) !== null
}

export function getGitHubRuntimeRepoId(
  sourceContext: TaskSourceContext | null | undefined,
  fallbackRepoId: string
): string
export function getGitHubRuntimeRepoId(
  sourceContext: TaskSourceContext | null | undefined,
  fallbackRepoId: string | null | undefined
): string | undefined
export function getGitHubRuntimeRepoId(
  sourceContext: TaskSourceContext | null | undefined,
  fallbackRepoId: string | null | undefined
): string | undefined {
  const fallback = fallbackRepoId ?? undefined
  return sourceContext?.provider === 'github' ? (sourceContext.repoId ?? fallback) : fallback
}

export function resolveGitHubRepoOperationOwner(
  state: RepoRuntimeOwnerState & { repos?: readonly Repo[] },
  args: {
    repoId?: string | null
    repoPath?: string | null
    sourceContext?: TaskSourceContext | null
    target?: RuntimeClientTarget | null
  }
) {
  const repoId = getGitHubRuntimeRepoId(args.sourceContext, args.repoId)
  const candidates = state.repos ?? []
  const sourceHost = getGitHubSourceRuntimeHost(args.sourceContext)
  const target = sourceHost
    ? runtimeTargetForOwnerEnvironment(sourceHost.environmentId)
    : (args.target ?? getGitHubRepoRoutingTarget(state, repoId, args.sourceContext))
  const hostId =
    target.kind === 'environment' ? toRuntimeExecutionHostId(target.environmentId) : null
  let repo: Repo | null = null
  if (repoId) {
    if (hostId) {
      repo = findRepoForHost(candidates, repoId, { hostId, settings: state.settings })
    } else if (args.sourceContext?.provider === 'github') {
      const matches = candidates.filter((row) => row.id === repoId)
      repo = matches.length === 1 ? matches[0] : null
    } else {
      repo = findRepoForHost(
        args.target?.kind === 'local'
          ? candidates.filter(
              (row) => parseExecutionHostId(getRepoExecutionHostId(row))?.kind !== 'runtime'
            )
          : candidates,
        repoId,
        { settings: state.settings }
      )
    }
  } else if (args.repoPath) {
    const matches = candidates.filter((row) => row.path === args.repoPath)
    const selected = hostId
      ? matches.filter((row) => getRepoExecutionHostId(row) === hostId)
      : matches
    if (selected.length === 1) {
      repo = selected[0]
    }
  }
  // Path-only callers use the same registration policy as ID callers once the row is known.
  return {
    repo,
    target:
      args.target || sourceHost || repoId
        ? target
        : getGitHubRepoRoutingTarget(
            state,
            repo?.id,
            args.sourceContext,
            repo ? getRepoExecutionHostId(repo) : null
          )
  }
}
