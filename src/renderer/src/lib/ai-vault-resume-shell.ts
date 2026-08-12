import type { AppState } from '@/store/types'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { resolveLocalWindowsTerminalShellOverrideForTab } from '../../../shared/local-windows-terminal-runtime'
import { resolveWindowsShellStartupFamily } from '../../../shared/windows-terminal-shell'
import {
  resolveLoginShellStartupDialect,
  resolveStartupShell,
  type AgentStartupShell
} from '../../../shared/tui-agent-startup-shell'
import { getClientLoginShell } from '@/lib/client-login-shell'
import { parseWorkspaceKey } from '../../../shared/workspace-scope'
import { parseWslUncPath } from '../../../shared/wsl-paths'

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
  /**
   * True only when this machine's own login shell parses the command. A local
   * session is NOT enough: a locally scanned session carries no executionHostId
   * yet can target an SSH/runtime/WSL worktree, whose shell is unrelated.
   */
  parsedByClientLoginShell?: boolean
}): AgentStartupShell {
  // Why: fish rejects `unset`, so the client's login shell decides the dialect —
  // but only when it is the shell that reads the line; otherwise it stays sh.
  if (args.platform !== 'win32') {
    return args.parsedByClientLoginShell
      ? resolveLoginShellStartupDialect(getClientLoginShell())
      : 'posix'
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
      state.folderWorkspaces.find((workspace) => workspace.id === workspaceScope.folderWorkspaceId)
        ?.folderPath ?? null
    )
  }
  const targetWorktreeId =
    workspaceScope?.type === 'worktree' ? workspaceScope.worktreeId : worktreeId
  return (
    Object.values(state.worktreesByRepo ?? {})
      .flat()
      .find((candidate) => candidate.id === targetWorktreeId)?.path ?? null
  )
}
