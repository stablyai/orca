import type { AppState } from '@/store/types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { parseWslUncPath } from '../../../shared/wsl-paths'
import {
  deriveGlobalWindowsRuntimeDefaultFromLegacySettings,
  getWorkspaceRuntimePreference,
  resolveProjectExecutionRuntime,
  type ProjectExecutionRuntimeResolution
} from '../../../shared/project-execution-runtime'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { projectMatchesRepo } from '../../../shared/project-repo-match'
import { getIndexedRepoMap } from '@/store/worktree-repo-index'
import { defaultScopeHost } from './default-creation-host'
import { getLocalProjectRuntimeWorkspace } from './local-project-runtime-workspace'
import { getActiveWorkspaceOwnerTarget } from './resolved-worktree-execution-host'
import { getEnvironmentRuntimeContextKey } from './provider-runtime-context'
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
> &
  Partial<Pick<AppState, 'folderWorkspaces' | 'projectGroups'>>

// Reuse fallback identities so WeakMap slice indexes hit instead of rebuilding on every read.
const EMPTY_REPOS: AppState['repos'] = []

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
  if (appPlatform !== 'win32' || worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    return undefined
  }
  const worktree = getLocalProjectRuntimeWorkspace(state, worktreeId)
  if (
    !worktree &&
    parseWorkspaceKey(worktreeId ?? state.activeWorktreeId ?? '')?.type === 'folder'
  ) {
    return undefined
  }
  const repo = getLocalRuntimeRepoForWorktree(state, worktree)
  if (!isLocalRuntimeRepo(repo) || !isLocalRuntimeWorktree(worktree)) {
    return undefined
  }
  const projectId = getLocalPreflightProjectId(state, worktreeId)
  const project = getLocalRuntimeProject(state, projectId, repo.id)
  const projectRuntimePreference = getWorkspaceRuntimePreference(
    project?.localWindowsRuntimePreference,
    worktree?.path ?? repo?.path
  )

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

export function getGlobalWindowsExecutionRuntimeContext(
  state: LocalProjectRuntimeState,
  worktreeId?: string | null,
  appPlatform: NodeJS.Platform = getRendererAppPlatform(),
  wslContext: LocalProjectRuntimeWslContext = {}
): ProjectExecutionRuntimeResolution | undefined {
  if (
    appPlatform !== 'win32' ||
    worktreeId ||
    state.activeRepoId ||
    state.activeWorktreeId ||
    !state.settings?.localWindowsRuntimeDefault
  ) {
    return undefined
  }
  return resolveProjectExecutionRuntime({
    appPlatform: 'win32',
    projectId: getLocalPreflightProjectId(state, worktreeId),
    projectRuntimePreference: { kind: 'inherit-global' },
    globalWindowsRuntimeDefault: state.settings.localWindowsRuntimeDefault,
    ...wslContext
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

  const repo = getIndexedRepoMap(state.repos ?? EMPTY_REPOS).get(repoId)
  if (!isLocalRuntimeRepo(repo)) {
    return undefined
  }
  const project = getLocalRuntimeProject(state, repoId, repo.id)
  const projectId = project?.id ?? repoId
  const projectRuntimePreference = getWorkspaceRuntimePreference(
    project?.localWindowsRuntimePreference,
    repo?.path
  )

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
  // Why: forge CLIs are checked on the focused workspace's owner, else the default scope host.
  const host = getActiveWorkspaceOwnerTarget(state) ?? defaultScopeHost(state.settings)
  if (host.kind === 'environment') {
    return { runtimeContextKey: getEnvironmentRuntimeContextKey(host.environmentId) }
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
  // Why: Floating owns native host authority and must not inherit any agent runtime fallback.
  if (worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
    return undefined
  }
  const projectRuntime = getLocalProjectExecutionRuntimeContext(
    state,
    worktreeId,
    appPlatform,
    wslContext
  )
  if (projectRuntime) {
    return getProjectRuntimePreflightContext(projectRuntime)
  }

  // Global Agents settings can precede project activation; respect local Windows/WSL defaults independently of remote focus (#18837).
  const globalRuntime = getGlobalWindowsExecutionRuntimeContext(
    !worktreeId && isActiveWorkspaceOnAnotherHost(state)
      ? { ...state, activeRepoId: null, activeWorktreeId: null }
      : state,
    worktreeId,
    appPlatform,
    wslContext
  )
  if (globalRuntime) {
    return getProjectRuntimePreflightContext(globalRuntime)
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

function isActiveWorkspaceOnAnotherHost(state: AppState): boolean {
  const activeWorktree = getLocalProjectRuntimeWorkspace(state, undefined)
  const repo = getLocalRuntimeRepoForWorktree(state, activeWorktree)
  return Boolean(repo) && (!isLocalRuntimeRepo(repo) || !isLocalRuntimeWorktree(activeWorktree))
}

function getCachedLocalProjectRuntimeWslContext(): LocalProjectRuntimeWslContext {
  // Synchronous selectors may reuse capabilities but must not launch WSL probes during store reads.
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
  const activeWorktree = getLocalProjectRuntimeWorkspace(state, worktreeId)
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
  if (!worktree && parseWorkspaceKey(state.activeWorktreeId ?? '')?.type === 'folder') {
    return undefined
  }
  const repoId = worktree?.repoId ?? state.activeRepoId
  return repoId ? getIndexedRepoMap(state.repos ?? EMPTY_REPOS).get(repoId) : undefined
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
    (entry) => entry.id === projectId || projectMatchesRepo(entry, repoId)
  )
}

function getLocalPreflightProjectId(
  state: LocalProjectRuntimeState,
  worktreeId?: string | null
): string {
  const activeWorktree = getLocalProjectRuntimeWorkspace(state, worktreeId)
  return (
    activeWorktree?.projectId ?? activeWorktree?.repoId ?? state.activeRepoId ?? 'local-project'
  )
}
