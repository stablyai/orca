import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { resolveWindowsShellOverride } from '@/lib/pane-manager/windows-pty-compatibility'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { isWslUncPath } from '../../../shared/wsl-paths'
import {
  canonicalizeWindowsShellOverride,
  resolveLocalWindowsAgentStartupShell,
  resolveWindowsShellStartupFamily
} from '../../../shared/windows-terminal-shell'
import type { AppState } from '@/store/types'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import type { AgentStartupShell } from '../../../shared/tui-agent-startup-shell'

export type AgentResumeLaunchTarget = {
  platform: NodeJS.Platform
  /** undefined keeps the platform default: PowerShell on win32, POSIX elsewhere. */
  shell: AgentStartupShell | undefined
}

export type AgentResumeLaunchTargetArgs = {
  projectRuntime: ProjectExecutionRuntimeResolution | undefined
  /** SSH connection owning the workspace, if any. */
  connectionId: string | null | undefined
  /** Pane/workspace execution owner; only a 'local' host is the one `terminalWindowsShell` describes. */
  executionHostId: string | null
  worktreePath: string | null | undefined
  terminalWindowsShell: string | null | undefined
  /** Per-tab Windows shell override, which beats the global setting at spawn time. */
  tabShellOverride?: string | null
  /** OS the SSH execution host reported; null/undefined when unknown. */
  remotePlatform?: NodeJS.Platform | null
}

function isRemoteResumeTarget(args: AgentResumeLaunchTargetArgs): boolean {
  return Boolean(args.connectionId) || parseExecutionHostId(args.executionHostId)?.kind !== 'local'
}

/**
 * The OS an SSH execution host reported, else null. Why SSH only: a paired Orca server applies its
 * own Windows shell setting, which this client cannot see, so its resumes keep the old quoting.
 */
export function resolveSshHostReportedPlatform(
  state: Pick<AppState, 'sshConnectionStates' | 'sshStateByEnvironment'>,
  executionHostId: string | null,
  /** Paired server that owns the SSH target, when it is not this client's own connection. */
  sshOwnerEnvironmentId: string | null
): NodeJS.Platform | null {
  const host = parseExecutionHostId(executionHostId)
  if (host?.kind !== 'ssh') {
    return null
  }
  const sshState = sshOwnerEnvironmentId
    ? state.sshStateByEnvironment.get(sshOwnerEnvironmentId)?.connectionStates.get(host.targetId)
    : state.sshConnectionStates.get(host.targetId)
  return sshState?.remotePlatform ?? null
}

function resolveResumeLaunchPlatform(args: AgentResumeLaunchTargetArgs): NodeJS.Platform {
  if (args.projectRuntime?.status === 'repair-required') {
    return args.projectRuntime.repair.preferredRuntime.kind === 'wsl' ? 'linux' : CLIENT_PLATFORM
  }
  if (args.projectRuntime?.status === 'resolved' && args.projectRuntime.runtime.kind === 'wsl') {
    return 'linux'
  }
  if (args.remotePlatform && isRemoteResumeTarget(args)) {
    // Why: a WSL UNC cwd on a Windows host still launches inside that distro.
    return args.remotePlatform === 'win32' && args.worktreePath && isWslUncPath(args.worktreePath)
      ? 'linux'
      : args.remotePlatform
  }
  if (args.connectionId || (args.worktreePath && isWslUncPath(args.worktreePath))) {
    return 'linux'
  }
  return CLIENT_PLATFORM
}

/**
 * Platform *and* live shell family a queued agent-resume command must be quoted for.
 * Why the shell half matters: resume lines are typed into a real terminal, so on a
 * cmd.exe tab the win32 PowerShell default sends literal quotes and the agent CLI
 * rejects the resume argv ("unexpected argument ''<uuid>'' found", #12320).
 */
export function resolveAgentResumeLaunchTarget(
  args: AgentResumeLaunchTargetArgs
): AgentResumeLaunchTarget {
  const platform = resolveResumeLaunchPlatform(args)
  const isRemote = isRemoteResumeTarget(args)
  if (isRemote && platform === 'win32' && args.remotePlatform === 'win32') {
    // Why: the client's Windows shell setting doesn't describe a remote host, but a remote tab's
    // own shell override is what the host spawned, so cmd.exe tabs need cmd quoting.
    const override = args.tabShellOverride
      ? canonicalizeWindowsShellOverride(args.tabShellOverride.trim())
      : undefined
    return {
      platform,
      shell: override ? resolveWindowsShellStartupFamily(override) : undefined
    }
  }
  return {
    platform,
    shell: resolveLocalWindowsAgentStartupShell({
      platform,
      isRemote,
      terminalWindowsShell: resolveWindowsShellOverride(
        args.tabShellOverride,
        args.terminalWindowsShell
      )
    })
  }
}
