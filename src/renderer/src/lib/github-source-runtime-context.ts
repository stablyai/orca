import type { ExecutionHostId, ParsedExecutionHost } from '../../../shared/execution-host'
import { parseExecutionHostId } from '../../../shared/execution-host'
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

// Why: PR reads and actions run on the repo's explicit owner host (#6957, #7623);
// a local or absent source never downgrades a runtime-owned repo to local IPC,
// a runtime source still overrides, and a repo without an explicit owner is a
// local repo. Only a twin with no caller host falls back to the focused runtime.
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
