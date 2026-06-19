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

type LocalProjectRuntimeState = Pick<
  AppState,
  'activeRepoId' | 'activeWorktreeId' | 'projects' | 'repos' | 'settings' | 'worktreesByRepo'
>

type LocalProjectRuntimeWslContext = {
  wslAvailable?: boolean
  availableWslDistros?: readonly string[] | null
}

export type LocalPreflightContext =
  | {
      wslDistro?: string | null
      wslDefault?: boolean
      runtimeContextKey?: string
      projectRuntime?: ProjectExecutionRuntimeResolution
    }
  | undefined

const wslPreflightContextsByDistro = new Map<string, NonNullable<LocalPreflightContext>>()
const projectRuntimePreflightContextsByKey = new Map<string, NonNullable<LocalPreflightContext>>()

export function getWslDistroFromPath(path?: string | null): string | null {
  return path ? (parseWslUncPath(path)?.distro ?? null) : null
}

function getWslPreflightContext(wslDistro: string): NonNullable<LocalPreflightContext> {
  const cached = wslPreflightContextsByDistro.get(wslDistro)
  if (cached) {
    return cached
  }

  // Why: React/Zustand selectors must return a cached snapshot. A fresh object
  // here triggers a useSyncExternalStore loop when Settings observes WSL repos.
  const context = Object.freeze({ wslDistro })
  wslPreflightContextsByDistro.set(wslDistro, context)
  return context
}

function getProjectRuntimeCacheKey(resolution: ProjectExecutionRuntimeResolution): string {
  return resolution.status === 'resolved' ? resolution.runtime.cacheKey : resolution.repair.cacheKey
}

function getProjectRuntimeContextObjectCacheKey(
  resolution: ProjectExecutionRuntimeResolution
): string {
  if (resolution.status === 'resolved') {
    return `${resolution.runtime.cacheKey}:${resolution.runtime.reason}`
  }
  return `${resolution.repair.cacheKey}:${resolution.repair.source}`
}

function getProjectRuntimePreflightContext(
  resolution: ProjectExecutionRuntimeResolution
): NonNullable<LocalPreflightContext> {
  const cacheKey = getProjectRuntimeContextObjectCacheKey(resolution)
  const cached = projectRuntimePreflightContextsByKey.get(cacheKey)
  if (cached) {
    return cached
  }

  const wslDistro =
    resolution.status === 'resolved' && resolution.runtime.kind === 'wsl'
      ? resolution.runtime.distro
      : undefined
  // Why: selectors compare by reference; cache each resolved runtime context so
  // adding projectRuntime does not reintroduce useSyncExternalStore churn.
  const context = Object.freeze({
    ...(wslDistro ? { wslDistro } : {}),
    projectRuntime: resolution
  })
  projectRuntimePreflightContextsByKey.set(cacheKey, context)
  return context
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
  wslContext: LocalProjectRuntimeWslContext = getCachedLocalProjectRuntimeWslContext()
): LocalPreflightContext {
  const projectRuntime = getLocalProjectExecutionRuntimeContext(
    state,
    undefined,
    appPlatform,
    wslContext
  )
  if (projectRuntime) {
    return getProjectRuntimePreflightContext(projectRuntime)
  }

  const explicitAgentRuntime = appPlatform === 'win32' ? state.settings?.localAgentRuntime : null
  if (explicitAgentRuntime === 'host') {
    return getProjectRuntimePreflightContext(
      resolveProjectExecutionRuntime({
        appPlatform: 'win32',
        projectId: getLocalPreflightProjectId(state),
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
          projectId: getLocalPreflightProjectId(state),
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
        projectId: getLocalPreflightProjectId(state),
        projectRuntimePreference: { kind: 'inherit-global' },
        globalWindowsRuntimeDefault: deriveGlobalWindowsRuntimeDefaultFromLegacySettings(
          state.settings
        ).defaultRuntime
      })
    )
  }

  const wslDistro = getLocalPreflightWslDistro(state)
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

function getLocalPreflightWslDistro(state: AppState): string | null {
  const activeWorktree = getLocalWorktree(state)
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

export function localPreflightContextKey(context: LocalPreflightContext): string {
  if (context?.projectRuntime) {
    return getProjectRuntimeCacheKey(context.projectRuntime)
  }
  if (context?.runtimeContextKey) {
    return context.runtimeContextKey
  }
  if (context?.wslDistro) {
    return `wsl:${context.wslDistro}`
  }
  return context?.wslDefault ? 'wsl:default' : 'host'
}
