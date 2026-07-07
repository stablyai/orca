import type { ParsedExecutionHost } from '../../../shared/execution-host'
import { parseExecutionHostId } from '../../../shared/execution-host'
import type { TaskSourceContext } from '../../../shared/task-source-context'
import { getTaskSourceRuntimeSettings } from '../../../shared/task-source-context'
import type { GlobalSettings } from '../../../shared/types'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { getActiveRuntimeTarget } from '@/runtime/runtime-rpc-client'

// Why: getTaskSourceRuntimeSettings always carries an activeRuntimeEnvironmentId
// key (null for a local source), so spreading it unconditionally over the
// repo-owner settings clobbers a valid owner runtime id and downgrades a
// runtime-owned repo to local IPC (#6957/#7590). Keep the repo owner as the base
// and let the source override win only when it resolves to a real runtime host.
export function resolveGitHubSourceSettings<
  T extends Pick<GlobalSettings, 'activeRuntimeEnvironmentId'>
>(repoOwnerSettings: T, sourceContext: TaskSourceContext | null | undefined): T {
  if (sourceContext?.provider !== 'github') {
    return repoOwnerSettings
  }
  const sourceRuntimeSettings = getTaskSourceRuntimeSettings(sourceContext)
  return sourceRuntimeSettings.activeRuntimeEnvironmentId
    ? ({ ...repoOwnerSettings, ...sourceRuntimeSettings } as T)
    : repoOwnerSettings
}

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
  return getActiveRuntimeTarget(
    getTaskSourceRuntimeSettings(sourceContext?.provider === 'github' ? sourceContext : null)
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
