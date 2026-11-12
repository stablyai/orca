import { getLocalProjectExecutionRuntimeContext } from '@/runtime/hosts/preflight/local-preflight-context'
import '../../../workspace/ownership/folder-workspace-connection'
import { findFolderWorkspaceCandidateRepos } from '../../../../../../shared/folder-workspaces/folder-workspace-execution-host'
import { getAiVaultResumeWorkspaceExecutionHostId } from './ai-vault-resume-target'
import {
  findAiVaultHistoryWorktree,
  type AiVaultHistoryWorktreeState
} from './ai-vault-history-worktrees'
import {
  LOCAL_EXECUTION_HOST_ID,
  type ExecutionHostId
} from '../../../../../../shared/execution-host'
import { CLIENT_PLATFORM } from '@/lib/workspace/creation/new-workspace'
import { resolveLocalWindowsTerminalShellOverrideForTab } from '../../../../../../shared/local-windows-terminal-runtime'
import { resolveWindowsShellStartupFamily } from '../../../../../../shared/windows-terminal-shell'
import { resolveStartupShell } from '../../../../../../shared/agent-launch/startup/tui-agent-startup-shell'
import type { AgentStartupShell } from '../../../../../../shared/agent-launch/startup/tui-agent-startup-shell'
import { parseWorkspaceKey } from '../../../../../../shared/workspace-scope'
import { parseWslUncPath } from '../../../../../../shared/wsl-paths'
import {
  selectFolderWorkspaces,
  selectWorktreesByRepo,
  selectDetectedWorktreesByRepo
} from '@/store/workspaces/catalog/workspace-record-fields'
import type { AppState } from '@/store/types'
import { findIndexedRepoOwnerForHost } from '@/lib/workspace/ownership/repo-owner-index'

type AiVaultResumeShellState = Pick<
  AppState,
  | 'activeRepoId'
  | 'activeWorktreeId'
  | 'folderWorkspaces'
  | 'projects'
  | 'repos'
  | 'settings'
  | 'worktreesByRepo'
> &
  Partial<Pick<AppState, 'detectedWorktreesByRepo'>>

export function getAiVaultResumeProjectRuntime(
  state: AiVaultResumeShellState,
  worktreeId?: string | null,
  executionHostId?: ExecutionHostId | null
): ReturnType<typeof getLocalProjectExecutionRuntimeContext> {
  const worktree = worktreeId
    ? findAiVaultHistoryWorktree(state, worktreeId, executionHostId)
    : undefined
  const repo =
    worktree && executionHostId === LOCAL_EXECUTION_HOST_ID
      ? findIndexedRepoOwnerForHost(state.repos, worktree.repoId, executionHostId)
      : null
  return getLocalProjectExecutionRuntimeContext(
    state,
    worktreeId,
    CLIENT_PLATFORM,
    {},
    worktree && repo ? { worktree, repo } : undefined
  )
}

export function resolveAiVaultResumeStartupShell(args: {
  state: AiVaultResumeShellState
  worktreeId?: string | null
  platform: NodeJS.Platform
  executionHostId?: ExecutionHostId | null
}): AgentStartupShell {
  // No login-shell probe: quoting and env clearing are deliberately valid in both sh and fish.
  if (args.platform !== 'win32') {
    return 'posix'
  }
  const projectRuntime = getAiVaultResumeProjectRuntime(
    args.state,
    args.worktreeId,
    args.executionHostId
  )
  const workspacePath = getAiVaultResumeWorkspacePath(
    args.state,
    args.worktreeId ?? args.state.activeWorktreeId,
    args.executionHostId
  )
  const shellOverride = resolveLocalWindowsTerminalShellOverrideForTab({
    explicitShellOverride: undefined,
    defaultWindowsShell: args.state.settings?.terminalWindowsShell,
    isWslWorktree: Boolean(workspacePath && parseWslUncPath(workspacePath)),
    projectRuntime
  })
  const shell = shellOverride ? resolveWindowsShellStartupFamily(shellOverride) : undefined
  return resolveStartupShell(args.platform, shell)
}

export function getAiVaultResumeWorkspacePath(
  state: AiVaultHistoryWorktreeState & Pick<AppState, 'folderWorkspaces'>,
  worktreeId: string | null | undefined,
  executionHostId?: ExecutionHostId | null
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
  return findAiVaultHistoryWorktree(state, targetWorktreeId, executionHostId)?.path ?? null
}

export function getAiVaultResumeWorkspaceWslDistro(
  state: Pick<AppState, 'folderWorkspaces' | 'repos' | 'worktreesByRepo'> &
    Partial<
      Pick<
        AppState,
        | 'activeRepoId'
        | 'activeWorktreeId'
        | 'projects'
        | 'settings'
        | 'projectGroups'
        | 'detectedWorktreesByRepo'
      >
    >,
  workspaceId: string | null | undefined,
  executionHostId?: ExecutionHostId | null
): string | null | undefined {
  const workspacePath = getAiVaultResumeWorkspacePath(state, workspaceId, executionHostId)
  const workspaceKey = workspaceId ? parseWorkspaceKey(workspaceId) : null
  const runtimeState = {
    activeRepoId: state.activeRepoId ?? null,
    activeWorktreeId: state.activeWorktreeId ?? null,
    projects: state.projects ?? [],
    settings: state.settings ?? null,
    folderWorkspaces: selectFolderWorkspaces(state),
    projectGroups: state.projectGroups ?? [],
    repos: state.repos,
    worktreesByRepo: selectWorktreesByRepo(state),
    detectedWorktreesByRepo: selectDetectedWorktreesByRepo(state)
  }
  if (workspaceKey?.type === 'folder') {
    if (
      getAiVaultResumeWorkspaceExecutionHostId(
        runtimeState,
        workspaceId ?? null,
        executionHostId
      ) !== LOCAL_EXECUTION_HOST_ID
    ) {
      return null
    }
    if (
      findFolderWorkspaceCandidateRepos(runtimeState, workspaceKey.folderWorkspaceId).length > 1
    ) {
      return undefined
    }
  }
  const runtime = getAiVaultResumeProjectRuntime(
    runtimeState,
    workspaceKey?.type === 'worktree' ? workspaceKey.worktreeId : workspaceId,
    executionHostId
  )
  if (runtime?.status === 'repair-required') {
    return undefined
  }
  if (runtime?.status === 'resolved') {
    return runtime.runtime.kind === 'wsl' ? runtime.runtime.distro : null
  }
  return workspacePath ? (parseWslUncPath(workspacePath)?.distro ?? null) : null
}
