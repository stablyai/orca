import type { AppState } from '@/store/types'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { getFolderWorkspaceCandidateRepos } from './folder-workspace-connection'
import { getAiVaultResumeWorkspaceExecutionHostId } from './ai-vault-resume-target'
import { LOCAL_EXECUTION_HOST_ID } from '../../../shared/execution-host'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { resolveLocalWindowsTerminalShellOverrideForTab } from '../../../shared/local-windows-terminal-runtime'
import { resolveWindowsShellStartupFamily } from '../../../shared/windows-terminal-shell'
import {
  resolveStartupShell,
  type AgentStartupShell
} from '../../../shared/tui-agent-startup-shell'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { parseWslUncPath } from '../../../shared/wsl-paths'
import { selectFolderWorkspaces, selectWorktreesByRepo } from '@/store/workspace-record-selectors'

type AiVaultResumeShellState = Pick<
  AppState,
  | 'activeRepoId'
  | 'activeWorktreeId'
  | 'folderWorkspaces'
  | 'projects'
  | 'repos'
  | 'settings'
  | 'worktreesByRepo'
>

export function resolveAiVaultResumeStartupShell(args: {
  state: AiVaultResumeShellState
  worktreeId?: string | null
  platform: NodeJS.Platform
  isLocalSession: boolean
}): AgentStartupShell {
  // No login-shell probe: quoting and env clearing are deliberately valid in both sh and fish.
  if (args.platform !== 'win32') {
    return 'posix'
  }
  const projectRuntime = args.isLocalSession
    ? getLocalProjectExecutionRuntimeContext(args.state, args.worktreeId, CLIENT_PLATFORM)
    : undefined
  const workspacePath = getAiVaultResumeWorkspacePath(
    args.state,
    args.worktreeId ?? args.state.activeWorktreeId
  )
  const shellOverride = args.isLocalSession
    ? resolveLocalWindowsTerminalShellOverrideForTab({
        explicitShellOverride: undefined,
        defaultWindowsShell: args.state.settings?.terminalWindowsShell,
        isWslWorktree: Boolean(workspacePath && parseWslUncPath(workspacePath)),
        projectRuntime
      })
    : undefined
  const shell = shellOverride ? resolveWindowsShellStartupFamily(shellOverride) : undefined
  return resolveStartupShell(args.platform, shell)
}

export function getAiVaultResumeWorkspacePath(
  state: Pick<AppState, 'folderWorkspaces' | 'worktreesByRepo'>,
  worktreeId: string | null | undefined
): string | null {
  if (!worktreeId) {
    return null
  }
  const workspaceScope = parseWorkspaceKey(worktreeId)
  if (workspaceScope?.type === 'folder') {
    return (
      selectFolderWorkspaces(state).find(
        (workspace) => workspace.id === workspaceScope.folderWorkspaceId
      )?.folderPath ?? null
    )
  }
  const targetWorktreeId =
    workspaceScope?.type === 'worktree' ? workspaceScope.worktreeId : worktreeId
  return (
    Object.values(selectWorktreesByRepo(state) ?? {})
      .flat()
      .find((candidate) => candidate.id === targetWorktreeId)?.path ?? null
  )
}

export function getAiVaultResumeWorkspaceWslDistro(
  state: Pick<AppState, 'folderWorkspaces' | 'repos' | 'worktreesByRepo'> &
    Partial<
      Pick<
        AppState,
        'activeRepoId' | 'activeWorktreeId' | 'projects' | 'settings' | 'projectGroups'
      >
    >,
  workspaceId: string | null | undefined
): string | null | undefined {
  const workspacePath = getAiVaultResumeWorkspacePath(state, workspaceId)
  const workspaceKey = workspaceId ? parseWorkspaceKey(workspaceId) : null
  const runtimeState = {
    activeRepoId: state.activeRepoId ?? null,
    activeWorktreeId: state.activeWorktreeId ?? null,
    projects: state.projects ?? [],
    settings: state.settings ?? null,
    folderWorkspaces: selectFolderWorkspaces(state),
    projectGroups: state.projectGroups ?? [],
    repos: state.repos,
    worktreesByRepo: selectWorktreesByRepo(state)
  }
  if (workspaceKey?.type === 'folder') {
    if (
      getAiVaultResumeWorkspaceExecutionHostId(runtimeState, workspaceId ?? null) !==
      LOCAL_EXECUTION_HOST_ID
    ) {
      return null
    }
    if (getFolderWorkspaceCandidateRepos(runtimeState, workspaceKey.folderWorkspaceId).length > 1) {
      return undefined
    }
  }
  const runtime = getLocalProjectExecutionRuntimeContext(
    runtimeState,
    workspaceKey?.type === 'worktree' ? workspaceKey.worktreeId : workspaceId,
    CLIENT_PLATFORM
  )
  if (runtime?.status === 'repair-required') {
    return undefined
  }
  if (runtime?.status === 'resolved') {
    return runtime.runtime.kind === 'wsl' ? runtime.runtime.distro : null
  }
  return workspacePath ? (parseWslUncPath(workspacePath)?.distro ?? null) : null
}
