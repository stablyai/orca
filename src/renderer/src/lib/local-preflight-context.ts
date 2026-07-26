import type { AppState } from '@/store/types'
import { parseWslUncPath } from '../../../shared/wsl-paths'
import {
  deriveGlobalWindowsRuntimeDefaultFromLegacySettings,
  resolveProjectExecutionRuntime,
  type ProjectExecutionRuntimeResolution
} from '../../../shared/project-execution-runtime'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { Repo, Worktree } from '../../../shared/types'
import { getProviderRuntimeContextKey } from './provider-runtime-context'
import { getRendererAppPlatform } from './renderer-app-platform'
import {
  getCachedWindowsTerminalCapabilities,
  hasCachedWindowsTerminalCapabilities
} from './windows-terminal-capabilities'
import {
  getProjectRuntimePreflightContext,
  getWslPreflightContext,
  type LocalPreflightContext
} from './local-preflight-context-cache'

export { localPreflightContextKey } from './local-preflight-context-key'
export type { LocalPreflightContext } from './local-preflight-context-cache'
export {
  _getProjectRuntimePreflightContextCacheSizeForTest,
  _getWslPreflightContextCacheSizeForTest,
  _hasProjectRuntimePreflightContextCacheEntryForTest,
  _hasWslPreflightContextCacheEntryForTest,
  resetLocalPreflightContextCachesForTests
} from './local-preflight-context-cache'

type LocalProjectRuntimeState = Pick<
  AppState,
  'activeRepoId' | 'activeWorktreeId' | 'projects' | 'repos' | 'settings' | 'worktreesByRepo'
>

type LocalProjectRuntimeWslContext = {
  wslAvailable?: boolean
  availableWslDistros?: readonly string[] | null
}

export function getWslDistroFromPath(path?: string | null): string | null {
  return path ? (parseWslUncPath(path)?.distro ?? null) : null
}

export function getLocalProjectExecutionRuntimeContext(
  state: LocalProjectRuntimeState,
  worktreeId?: string | null,
  appPlatform: NodeJS.Platform = getRendererAppPlatform(),
  wslContext: LocalProjectRuntimeWslContext = {}
): ProjectExecutionRuntimeResolution | undefined {
  if (appPlatform !== 'win32') {
    return undefined
  }

  const worktree = getLocalWorktree(state, worktreeId)
  const repo = getLocalRuntimeRepoForWorktree(state, worktree)
  if (!isLocalRuntimeRepo(repo) || !isLocalRuntimeWorktree(worktree)) {
    return undefined
  }
  const projectId = getLocalPreflightProjectId(state, worktreeId)
  const project = getLocalRuntimeProject(state, projectId, repo.id)
  const localPath = worktree?.path ?? repo?.path
  const worktreeWslDistro = getWslDistroFromPath(localPath)
  const projectRuntimePreference =
    project?.localWindowsRuntimePreference ??
    (worktreeWslDistro ? { kind: 'wsl', distro: worktreeWslDistro } : { kind: 'inherit-global' })

  return resolveProjectExecutionRuntime({
    appPlatform,
    projectId,
    projectRuntimePreference,
    globalWindowsRuntimeDefault:
      state.settings?.localWindowsRuntimeDefault ??
      deriveGlobalWindowsRuntimeDefaultFromLegacySettings(state.settings).defaultRuntime,
    wslAvailable: wslContext.wslAvailable,
    availableWslDistros: wslContext.availableWslDistros
  })
}

export function getLocalRepoProjectExecutionRuntimeContext(
  state: LocalProjectRuntimeState,
  repoId: string | null | undefined,
  appPlatform: NodeJS.Platform = getRendererAppPlatform(),
  wslContext: LocalProjectRuntimeWslContext = {}
): ProjectExecutionRuntimeResolution | undefined {
  if (appPlatform !== 'win32' || !repoId) {
    return undefined
  }

  const repo = (state.repos ?? []).find((entry) => entry.id === repoId)
  if (!isLocalRuntimeRepo(repo)) {
    return undefined
  }
  const project = getLocalRuntimeProject(state, repoId, repo.id)
  const projectId = project?.id ?? repoId
  const repoWslDistro = getWslDistroFromPath(repo?.path)
  const projectRuntimePreference =
    project?.localWindowsRuntimePreference ??
    (repoWslDistro ? { kind: 'wsl', distro: repoWslDistro } : { kind: 'inherit-global' })

  return resolveProjectExecutionRuntime({
    appPlatform,
    projectId,
    projectRuntimePreference,
    globalWindowsRuntimeDefault:
      state.settings?.localWindowsRuntimeDefault ??
      deriveGlobalWindowsRuntimeDefaultFromLegacySettings(state.settings).defaultRuntime,
    wslAvailable: wslContext.wslAvailable,
    availableWslDistros: wslContext.availableWslDistros
  })
}

export function getLocalPreflightContext(
  state: AppState,
  appPlatform: NodeJS.Platform = getRendererAppPlatform(),
  wslContext: LocalProjectRuntimeWslContext = getCachedLocalProjectRuntimeWslContext()
): LocalPreflightContext {
  if (state.settings?.activeRuntimeEnvironmentId?.trim()) {
    return { runtimeContextKey: getProviderRuntimeContextKey(state.settings) }
  }
  const projectRuntime = getLocalProjectExecutionRuntimeContext(
    state,
    undefined,
    appPlatform,
    wslContext
  )
  if (projectRuntime) {
    return getProjectRuntimePreflightContext(projectRuntime)
  }
  const wslDistro = getLocalPreflightWslDistro(state)
  return wslDistro ? getWslPreflightContext(wslDistro) : undefined
}

export function getLocalAgentPreflightContext(
  state: AppState,
  appPlatform: NodeJS.Platform = getRendererAppPlatform(),
  wslContext: LocalProjectRuntimeWslContext = getCachedLocalProjectRuntimeWslContext(),
  worktreeId?: string | null
): LocalPreflightContext {
  const projectRuntime = getLocalProjectExecutionRuntimeContext(
    state,
    worktreeId,
    appPlatform,
    wslContext
  )
  if (projectRuntime) {
    return getProjectRuntimePreflightContext(projectRuntime)
  }

  if (
    appPlatform === 'win32' &&
    !worktreeId &&
    !state.activeRepoId &&
    !state.activeWorktreeId &&
    state.settings?.localWindowsRuntimeDefault
  ) {
    // Why: Settings -> Agents is global and can mount before any project is
    // active; still respect the Windows/WSL runtime default for PATH detection.
    return getProjectRuntimePreflightContext(
      resolveProjectExecutionRuntime({
        appPlatform: 'win32',
        projectId: getLocalPreflightProjectId(state, worktreeId),
        projectRuntimePreference: { kind: 'inherit-global' },
        globalWindowsRuntimeDefault: state.settings.localWindowsRuntimeDefault,
        ...wslContext
      })
    )
  }

  const explicitAgentRuntime = appPlatform === 'win32' ? state.settings?.localAgentRuntime : null
  if (explicitAgentRuntime === 'host') {
    return getProjectRuntimePreflightContext(
      resolveProjectExecutionRuntime({
        appPlatform: 'win32',
        projectId: getLocalPreflightProjectId(state, worktreeId),
        projectRuntimePreference: { kind: 'windows-host' },
        globalWindowsRuntimeDefault: deriveGlobalWindowsRuntimeDefaultFromLegacySettings(
          state.settings
        ).defaultRuntime
      })
    )
  }
  if (explicitAgentRuntime === 'wsl') {
    const explicitDistro = state.settings?.localAgentWslDistro?.trim()
    if (explicitDistro) {
      return getProjectRuntimePreflightContext(
        resolveProjectExecutionRuntime({
          appPlatform: 'win32',
          projectId: getLocalPreflightProjectId(state, worktreeId),
          projectRuntimePreference: { kind: 'wsl', distro: explicitDistro },
          globalWindowsRuntimeDefault: deriveGlobalWindowsRuntimeDefaultFromLegacySettings(
            state.settings
          ).defaultRuntime
        })
      )
    }
    return getProjectRuntimePreflightContext(
      resolveProjectExecutionRuntime({
        appPlatform: 'win32',
        projectId: getLocalPreflightProjectId(state, worktreeId),
        projectRuntimePreference: { kind: 'inherit-global' },
        globalWindowsRuntimeDefault: deriveGlobalWindowsRuntimeDefaultFromLegacySettings(
          state.settings
        ).defaultRuntime
      })
    )
  }

  const wslDistro = getLocalPreflightWslDistro(state, worktreeId)
  if (wslDistro) {
    return getWslPreflightContext(wslDistro)
  }
  return undefined
}

function getCachedLocalProjectRuntimeWslContext(): LocalProjectRuntimeWslContext {
  // Why: preflight selectors are synchronous. Reuse an existing capability
  // answer when available without spawning WSL probes from store reads.
  if (!hasCachedWindowsTerminalCapabilities()) {
    return {}
  }
  const capabilities = getCachedWindowsTerminalCapabilities()
  return {
    wslAvailable: capabilities.wslAvailable,
    availableWslDistros: capabilities.wslDistros
  }
}

function getLocalPreflightWslDistro(state: AppState, worktreeId?: string | null): string | null {
  const activeWorktree = getLocalWorktree(state, worktreeId)
  const repo = getLocalRuntimeRepoForWorktree(state, activeWorktree)
  if (!isLocalRuntimeRepo(repo) || !isLocalRuntimeWorktree(activeWorktree)) {
    return null
  }
  const activePath = activeWorktree?.path ?? repo.path
  return getWslDistroFromPath(activePath)
}

function getLocalRuntimeRepoForWorktree(
  state: LocalProjectRuntimeState,
  worktree?: Pick<Worktree, 'repoId'> | null
): Pick<Repo, 'id' | 'path' | 'connectionId' | 'executionHostId'> | undefined {
  const repoId = worktree?.repoId ?? state.activeRepoId
  return repoId ? (state.repos ?? []).find((repo) => repo.id === repoId) : undefined
}

function isLocalRuntimeRepo(
  repo?: Pick<Repo, 'connectionId' | 'executionHostId'> | null
): repo is Pick<Repo, 'id' | 'path' | 'connectionId' | 'executionHostId'> {
  if (!repo) {
    return false
  }
  return getRepoExecutionHostId(repo) === LOCAL_EXECUTION_HOST_ID
}

function isLocalRuntimeWorktree(worktree?: Pick<Worktree, 'hostId'> | null): boolean {
  return !worktree?.hostId || worktree.hostId === LOCAL_EXECUTION_HOST_ID
}

function getLocalRuntimeProject(
  state: LocalProjectRuntimeState,
  projectId: string,
  repoId: string
) {
  return state.projects?.find(
    (entry) =>
      entry.id === projectId || entry.id === repoId || entry.sourceRepoIds?.includes(repoId)
  )
}

function getLocalWorktree(
  state: LocalProjectRuntimeState,
  worktreeId?: string | null
): Pick<Worktree, 'id' | 'repoId' | 'projectId' | 'path' | 'hostId'> | null {
  const targetWorktreeId = worktreeId ?? state.activeWorktreeId
  return targetWorktreeId
    ? (Object.values(state.worktreesByRepo ?? {})
        .flat()
        .find((worktree) => worktree.id === targetWorktreeId) ?? null)
    : null
}

function getLocalPreflightProjectId(
  state: LocalProjectRuntimeState,
  worktreeId?: string | null
): string {
  const activeWorktree = getLocalWorktree(state, worktreeId)
  return (
    activeWorktree?.projectId ?? activeWorktree?.repoId ?? state.activeRepoId ?? 'local-project'
  )
}
