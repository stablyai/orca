import type { AppState } from '@/store/types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import { parseWslUncPath } from '../../../shared/wsl-paths'
import {
  deriveGlobalWindowsRuntimeDefaultFromLegacySettings,
  resolveProjectExecutionRuntime,
  type LocalWindowsRuntimePreference,
  type ProjectExecutionRuntimeResolution
} from '../../../shared/project-execution-runtime'
import { getRepoExecutionHostId, LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import type { Repo } from '../../../shared/repo-types'
import type { Worktree } from '../../../shared/worktree/types'
import { getIndexedRepoMap, getIndexedWorktreeById } from '@/store/worktree-repo-index'
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

// Why: the shared indexes are WeakMap-keyed on slice identity, so a fresh `{}`
// or `[]` fallback would miss the cache on every read.
const EMPTY_WORKTREES_BY_REPO: AppState['worktreesByRepo'] = {}
const EMPTY_REPOS: AppState['repos'] = []
// Why: the global Windows default is one runtime regardless of which remote
// workspace is active, so every non-owned caller shares this cache key.
const GLOBAL_LOCAL_PROJECT_ID = 'local-project'

type LocalProjectRuntimeWslContext = {
  wslAvailable?: boolean
  availableWslDistros?: readonly string[] | null
}

/** Extracts a WSL distribution name from supported UNC path forms. */
export function getWslDistroFromPath(path?: string | null): string | null {
  return path ? (parseWslUncPath(path)?.distro ?? null) : null
}

/** Resolves the owning local project's Windows runtime for project-scoped targets. */
export function getLocalProjectExecutionRuntimeContext(
  state: LocalProjectRuntimeState,
  worktreeId?: string | null,
  appPlatform: NodeJS.Platform = getRendererAppPlatform(),
  wslContext: LocalProjectRuntimeWslContext = {}
): ProjectExecutionRuntimeResolution | undefined {
  if (appPlatform !== 'win32') {
    return undefined
  }

  if (worktreeId === FLOATING_TERMINAL_WORKTREE_ID) {
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

/** Resolves the Windows default only when no local project can own the runtime. */
export function getGlobalWindowsExecutionRuntimeContext(
  state: LocalProjectRuntimeState,
  worktreeId?: string | null,
  appPlatform: NodeJS.Platform = getRendererAppPlatform(),
  wslContext: LocalProjectRuntimeWslContext = {}
): ProjectExecutionRuntimeResolution | undefined {
  // Why: Floating keeps native host authority even when it is the active
  // worktree and the caller did not name it (useActiveProjectSkillRuntime).
  if (
    appPlatform !== 'win32' ||
    (worktreeId ?? state.activeWorktreeId) === FLOATING_TERMINAL_WORKTREE_ID ||
    !state.settings?.localWindowsRuntimeDefault
  ) {
    return undefined
  }
  // Why: an SSH/runtime workspace (or a stale active id) cannot own the local
  // Windows runtime, and the local CLIs still live where the default says.
  // Only a local project owner may displace the global default.
  const worktree = getLocalWorktree(state, worktreeId)
  const repo = getLocalRuntimeRepoForWorktree(state, worktree)
  if (isLocalRuntimeRepo(repo) && isLocalRuntimeWorktree(worktree)) {
    return undefined
  }
  const resolution = resolveProjectExecutionRuntime({
    appPlatform: 'win32',
    projectId: GLOBAL_LOCAL_PROJECT_ID,
    projectRuntimePreference: { kind: 'inherit-global' },
    globalWindowsRuntimeDefault: state.settings.localWindowsRuntimeDefault,
    ...wslContext
  })
  // Why: main rejects detection for a repair-required runtime. A workspace that
  // cannot own the local runtime has no per-project repair surface, so it keeps
  // the host fallback; without a workspace, Settings still surfaces the repair.
  const hasWorkspaceTarget = Boolean(worktreeId || state.activeWorktreeId || state.activeRepoId)
  if (resolution.status === 'repair-required' && hasWorkspaceTarget) {
    return undefined
  }
  return resolution
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

  // Why: Settings -> Agents is global and can mount before any project is
  // active; still respect the Windows/WSL runtime default for PATH detection.
  const globalRuntime = getGlobalWindowsExecutionRuntimeContext(
    state,
    worktreeId,
    appPlatform,
    wslContext
  )
  if (globalRuntime) {
    return getProjectRuntimePreflightContext(globalRuntime)
  }

  const explicitAgentRuntime = appPlatform === 'win32' ? state.settings?.localAgentRuntime : null
  if (explicitAgentRuntime === 'host') {
    return getLegacyAgentRuntimeContext(state, worktreeId, { kind: 'windows-host' })
  }
  if (explicitAgentRuntime === 'wsl') {
    const explicitDistro = state.settings?.localAgentWslDistro?.trim()
    return getLegacyAgentRuntimeContext(
      state,
      worktreeId,
      explicitDistro ? { kind: 'wsl', distro: explicitDistro } : { kind: 'inherit-global' }
    )
  }

  const wslDistro = getLocalPreflightWslDistro(state, worktreeId)
  if (wslDistro) {
    return getWslPreflightContext(wslDistro)
  }
  return undefined
}

/** Resolves the legacy `localAgentRuntime` setting against the migrated global default. */
function getLegacyAgentRuntimeContext(
  state: LocalProjectRuntimeState,
  worktreeId: string | null | undefined,
  projectRuntimePreference: LocalWindowsRuntimePreference
): LocalPreflightContext {
  return getProjectRuntimePreflightContext(
    resolveProjectExecutionRuntime({
      appPlatform: 'win32',
      projectId: getLocalPreflightProjectId(state, worktreeId),
      projectRuntimePreference,
      globalWindowsRuntimeDefault: deriveGlobalWindowsRuntimeDefaultFromLegacySettings(
        state.settings
      ).defaultRuntime
    })
  )
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
    (entry) =>
      entry.id === projectId || entry.id === repoId || entry.sourceRepoIds?.includes(repoId)
  )
}

function getLocalWorktree(
  state: LocalProjectRuntimeState,
  worktreeId?: string | null
): Pick<Worktree, 'id' | 'repoId' | 'projectId' | 'path' | 'hostId'> | null {
  const targetWorktreeId = worktreeId ?? state.activeWorktreeId
  if (!targetWorktreeId) {
    return null
  }
  return (
    getIndexedWorktreeById(state.worktreesByRepo ?? EMPTY_WORKTREES_BY_REPO, targetWorktreeId) ??
    null
  )
}

function getLocalPreflightProjectId(
  state: LocalProjectRuntimeState,
  worktreeId?: string | null
): string {
  const activeWorktree = getLocalWorktree(state, worktreeId)
  return (
    activeWorktree?.projectId ??
    activeWorktree?.repoId ??
    state.activeRepoId ??
    GLOBAL_LOCAL_PROJECT_ID
  )
}
