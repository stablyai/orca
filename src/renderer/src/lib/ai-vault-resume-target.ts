import {
  getRepoExecutionHostId,
  LOCAL_EXECUTION_HOST_ID,
  normalizeExecutionHostId,
  parseExecutionHostId,
  toSshExecutionHostId,
  type ExecutionHostId
} from '../../../shared/execution-host'
import type { Repo } from '../../../shared/repo-types'
import { getRepoIdFromWorktreeId } from '../../../shared/worktree/id'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { isWslUncPath, parseWslUncPath } from '../../../shared/wsl-paths'
import type { AppState } from '@/store/types'
import { getIndexedWorktreeMap } from '@/store/worktree-repo-index'
import { getFolderWorkspaceCandidateRepos } from './folder-workspace-connection'
import { getAiVaultResumeWorkspacePath } from './ai-vault-resume-shell'
import { getLocalProjectExecutionRuntimeContext } from './local-preflight-context'
import { CLIENT_PLATFORM } from './new-workspace'

export type AiVaultResumeTargetStatus = 'local' | 'ssh' | 'runtime' | 'unknown'

type AiVaultResumeRepoOwner = Pick<Repo, 'connectionId' | 'executionHostId'>

export function getAiVaultResumeRepoTargetStatus(
  repo: AiVaultResumeRepoOwner | null | undefined
): AiVaultResumeTargetStatus {
  if (!repo) {
    return 'unknown'
  }
  // Why: SSH and WSL targets use the normal PTY startup path. Runtime-owned
  // repos intentionally keep connectionId null, so check the execution host.
  return getAiVaultResumeExecutionHostTargetStatus(getRepoExecutionHostId(repo))
}

export function isSupportedAiVaultResumeTargetStatus(status: AiVaultResumeTargetStatus): boolean {
  return status === 'local' || status === 'ssh' || status === 'runtime'
}

export function isWslStoredAiVaultSessionFile(sessionFilePath: string | null | undefined): boolean {
  return Boolean(sessionFilePath && isWslUncPath(sessionFilePath))
}

/** Where a local resume executes on a Windows client; null off Windows or when it cannot be resolved. */
export type AiVaultLocalResumeRuntime =
  | { kind: 'windows-host' }
  | { kind: 'wsl'; distro: string | null }

type AiVaultLocalResumeRuntimeState = Pick<
  AppState,
  'folderWorkspaces' | 'repos' | 'worktreesByRepo'
> &
  Partial<Pick<AppState, 'activeRepoId' | 'activeWorktreeId' | 'projects' | 'settings'>>

const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/

export function resolveAiVaultLocalResumeRuntime(
  state: AiVaultLocalResumeRuntimeState,
  worktreeId: string | null | undefined
): AiVaultLocalResumeRuntime | null {
  if (CLIENT_PLATFORM !== 'win32') {
    return null
  }
  const workspacePath = getAiVaultResumeWorkspacePath(
    state,
    worktreeId ?? state.activeWorktreeId ?? null
  )
  const wslPath = workspacePath ? parseWslUncPath(workspacePath) : null
  // Why: a Windows-path project can still be set to run in WSL, so without its settings the runtime is unknown.
  if (!state.projects || !state.settings) {
    return wslPath ? { kind: 'wsl', distro: wslPath.distro } : null
  }
  const projectRuntime = getLocalProjectExecutionRuntimeContext(
    {
      activeRepoId: state.activeRepoId ?? null,
      activeWorktreeId: state.activeWorktreeId ?? null,
      projects: state.projects,
      repos: state.repos,
      settings: state.settings,
      worktreesByRepo: state.worktreesByRepo
    },
    worktreeId,
    CLIENT_PLATFORM
  )
  if (projectRuntime?.status === 'repair-required') {
    return { kind: 'wsl', distro: projectRuntime.repair.preferredRuntime.distro }
  }
  if (projectRuntime?.status === 'resolved' && projectRuntime.runtime.kind === 'wsl') {
    return { kind: 'wsl', distro: projectRuntime.runtime.distro }
  }
  if (projectRuntime?.status === 'resolved' && projectRuntime.runtime.kind === 'windows-host') {
    return { kind: 'windows-host' }
  }
  return wslPath ? { kind: 'wsl', distro: wslPath.distro } : { kind: 'windows-host' }
}

/**
 * Why: a transcript only resumes under the runtime that wrote it — a WSL-stored one inside its own distro, a
 * Windows-drive one on the Windows host (inside WSL the agent reads another home and finds nothing).
 */
export function isAiVaultSessionRuntimeCompatible(
  sessionFilePath: string | null | undefined,
  targetRuntime: AiVaultLocalResumeRuntime | null | undefined
): boolean {
  if (!targetRuntime || !sessionFilePath) {
    return true
  }
  const sessionWsl = parseWslUncPath(sessionFilePath)
  if (sessionWsl) {
    return (
      targetRuntime.kind === 'wsl' &&
      (!targetRuntime.distro ||
        targetRuntime.distro.toLowerCase() === sessionWsl.distro.toLowerCase())
    )
  }
  return !(targetRuntime.kind === 'wsl' && WINDOWS_DRIVE_PATH.test(sessionFilePath))
}

export function canResumeAiVaultSessionOnTarget(args: {
  sessionFilePath: string | null | undefined
  sessionExecutionHostId?: ExecutionHostId | null
  targetStatus: AiVaultResumeTargetStatus
  targetExecutionHostId?: ExecutionHostId | null
  /** Only consulted for local targets; omit when the caller cannot resolve it. */
  targetRuntime?: AiVaultLocalResumeRuntime | null
}): boolean {
  if (
    args.targetStatus === 'local' &&
    !isAiVaultSessionRuntimeCompatible(args.sessionFilePath, args.targetRuntime)
  ) {
    return false
  }
  const sessionExecutionHostId = normalizeExecutionHostId(args.sessionExecutionHostId)
  const targetExecutionHostId = normalizeExecutionHostId(args.targetExecutionHostId)
  if (args.targetStatus === 'runtime') {
    // Runtime session stores live on one paired server; only queue resumes back
    // onto that exact server host.
    return Boolean(
      sessionExecutionHostId &&
      targetExecutionHostId &&
      sessionExecutionHostId === targetExecutionHostId
    )
  }
  if (!isSupportedAiVaultResumeTargetStatus(args.targetStatus)) {
    return false
  }
  if (sessionExecutionHostId) {
    if (targetExecutionHostId) {
      if (sessionExecutionHostId === targetExecutionHostId) {
        return true
      }
      // Why: SSH-to-local-WSL setups (#6270) tag the session 'local' but the
      // file lives under a WSL UNC path reachable from any SSH shell into this
      // machine, so we bypass the exact host-id match for that case.
      return (
        sessionExecutionHostId === LOCAL_EXECUTION_HOST_ID &&
        args.targetStatus === 'ssh' &&
        isWslStoredAiVaultSessionFile(args.sessionFilePath)
      )
    }
    if (sessionExecutionHostId !== LOCAL_EXECUTION_HOST_ID) {
      return false
    }
  }
  // Why: vault sessions are scanned from this machine's disk (host home dirs
  // plus local WSL homes). An SSH shell can only reach the WSL-stored ones
  // (SSH-to-local-WSL setups, #6270); host-stored session files do not exist
  // on a remote filesystem, so queuing a resume there is guaranteed to fail.
  if (args.targetStatus === 'ssh') {
    return isWslStoredAiVaultSessionFile(args.sessionFilePath)
  }
  return true
}

export function getAiVaultResumeWorkspaceExecutionHostId(
  state: Pick<AppState, 'folderWorkspaces' | 'projectGroups' | 'repos' | 'worktreesByRepo'>,
  workspaceId: string | null
): ExecutionHostId | null {
  if (!workspaceId) {
    return null
  }

  const workspaceKey = parseWorkspaceKey(workspaceId)
  if (workspaceKey?.type === 'folder') {
    return getAiVaultResumeFolderExecutionHostId(state, workspaceKey.folderWorkspaceId)
  }

  const worktreeId = workspaceKey?.type === 'worktree' ? workspaceKey.worktreeId : workspaceId
  const worktree = getIndexedWorktreeMap(state.worktreesByRepo ?? {}).get(worktreeId)
  const worktreeHostId = normalizeExecutionHostId(worktree?.hostId)
  if (worktreeHostId) {
    return worktreeHostId
  }
  const repoId = worktree?.repoId ?? getRepoIdFromWorktreeId(worktreeId)
  const repo = state.repos.find((candidate) => candidate.id === repoId)
  return repo ? getRepoExecutionHostId(repo) : null
}

export function getAiVaultResumeWorkspaceTargetStatus(
  state: Pick<AppState, 'folderWorkspaces' | 'projectGroups' | 'repos' | 'worktreesByRepo'>,
  workspaceId: string | null
): AiVaultResumeTargetStatus {
  if (!workspaceId) {
    return 'unknown'
  }

  const workspaceKey = parseWorkspaceKey(workspaceId)
  if (workspaceKey?.type === 'folder') {
    return getAiVaultResumeFolderTargetStatus(state, workspaceKey.folderWorkspaceId)
  }

  const worktreeId = workspaceKey?.type === 'worktree' ? workspaceKey.worktreeId : workspaceId
  const worktree = getIndexedWorktreeMap(state.worktreesByRepo ?? {}).get(worktreeId)
  const worktreeHost = getAiVaultResumeExecutionHostTargetStatus(worktree?.hostId)
  if (worktreeHost !== 'unknown') {
    return worktreeHost
  }
  const repoId = worktree?.repoId ?? getRepoIdFromWorktreeId(worktreeId)
  return getAiVaultResumeRepoTargetStatus(state.repos.find((repo) => repo.id === repoId))
}

function getAiVaultResumeFolderTargetStatus(
  state: Pick<AppState, 'folderWorkspaces' | 'projectGroups' | 'repos'>,
  folderWorkspaceId: string
): AiVaultResumeTargetStatus {
  const workspace = state.folderWorkspaces.find((entry) => entry.id === folderWorkspaceId)
  if (!workspace) {
    return 'unknown'
  }

  const group = state.projectGroups.find((entry) => entry.id === workspace.projectGroupId)
  const groupHostId = normalizeExecutionHostId(workspace.executionHostId ?? group?.executionHostId)
  if (groupHostId) {
    return getAiVaultResumeExecutionHostTargetStatus(groupHostId)
  }
  const explicitConnectionId = (workspace.connectionId ?? group?.connectionId ?? '').trim()
  if (explicitConnectionId) {
    return getAiVaultResumeExecutionHostTargetStatus(toSshExecutionHostId(explicitConnectionId))
  }

  return mergeAiVaultResumeExecutionHostTargetStatuses(
    getFolderWorkspaceCandidateRepos(state, folderWorkspaceId).map(getRepoExecutionHostId)
  )
}

function getAiVaultResumeFolderExecutionHostId(
  state: Pick<AppState, 'folderWorkspaces' | 'projectGroups' | 'repos'>,
  folderWorkspaceId: string
): ExecutionHostId | null {
  const workspace = state.folderWorkspaces.find((entry) => entry.id === folderWorkspaceId)
  if (!workspace) {
    return null
  }

  const group = state.projectGroups.find((entry) => entry.id === workspace.projectGroupId)
  const groupHostId = normalizeExecutionHostId(workspace.executionHostId ?? group?.executionHostId)
  if (groupHostId) {
    return groupHostId
  }
  const explicitConnectionId = (workspace.connectionId ?? group?.connectionId ?? '').trim()
  if (explicitConnectionId) {
    return toSshExecutionHostId(explicitConnectionId)
  }
  return mergeAiVaultResumeExecutionHostIds(
    getFolderWorkspaceCandidateRepos(state, folderWorkspaceId).map(getRepoExecutionHostId)
  )
}

function getAiVaultResumeExecutionHostTargetStatus(
  hostId: ExecutionHostId | null | undefined
): AiVaultResumeTargetStatus {
  const parsed = parseExecutionHostId(hostId)
  if (!parsed) {
    return 'unknown'
  }
  if (parsed.kind === 'local') {
    return 'local'
  }
  return parsed.kind
}

function mergeAiVaultResumeExecutionHostTargetStatuses(
  hostIds: readonly ExecutionHostId[]
): AiVaultResumeTargetStatus {
  if (hostIds.length === 0) {
    return 'local'
  }
  const statuses = hostIds.map(getAiVaultResumeExecutionHostTargetStatus)
  const uniqueStatuses = new Set(statuses)
  if (uniqueStatuses.has('runtime')) {
    return 'runtime'
  }
  return new Set(hostIds).size === 1 ? (statuses[0] ?? 'unknown') : 'unknown'
}

function mergeAiVaultResumeExecutionHostIds(
  hostIds: readonly ExecutionHostId[]
): ExecutionHostId | null {
  if (hostIds.length === 0) {
    return LOCAL_EXECUTION_HOST_ID
  }
  const uniqueHostIds = new Set(hostIds)
  return uniqueHostIds.size === 1 ? (hostIds[0] ?? null) : null
}
