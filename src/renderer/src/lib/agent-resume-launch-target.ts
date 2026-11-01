import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import { REMOTE_RUNTIME_PTY_HONOURS_TAB_SHELL_OVERRIDE } from '@/components/terminal-pane/remote-runtime-pty-shell'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { lastVerifiedRuntimeStatus } from '../../../shared/runtime-host-status'
import { isWslUncPath } from '../../../shared/wsl-paths'
import { isWindowsAbsolutePathLike } from '../../../shared/cross-platform-path'
import { resolveHostAgentStartupShell } from '../../../shared/windows-terminal-shell'
import type { AppState } from '@/store/types'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import type { AgentStartupShell } from '../../../shared/tui-agent-startup-shell'

export type AgentResumeLaunchTarget = {
  platform: NodeJS.Platform
  /** OS that runs the agent; null when its remote host has not reported one. */
  agentHostPlatform: NodeJS.Platform | null
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
  /** OS a paired Orca server reported; null/undefined when unknown. */
  runtimeHostPlatform?: NodeJS.Platform | null
  /** The Windows shell a paired server spawns its terminals in; null/undefined when unreported. */
  runtimeHostTerminalWindowsShell?: string | null
}

function isRemoteResumeTarget(args: AgentResumeLaunchTargetArgs): boolean {
  return Boolean(args.connectionId) || parseExecutionHostId(args.executionHostId)?.kind !== 'local'
}

/** The OS an SSH target reported, else null: a direct `ssh:` host, or one a paired server reaches. */
export function resolveSshHostReportedPlatform(
  state: Pick<AppState, 'sshConnectionStates' | 'sshStateByEnvironment'>,
  executionHostId: string | null,
  /** Paired server that owns the SSH target, when it is not this client's own connection. */
  sshOwnerEnvironmentId: string | null,
  /** A `runtime:` host's nested SSH target, which runs the command instead of the server. */
  nestedTargetId?: string | null
): NodeJS.Platform | null {
  const host = parseExecutionHostId(executionHostId)
  if (host?.kind === 'runtime' && nestedTargetId) {
    return (
      state.sshStateByEnvironment.get(host.environmentId)?.connectionStates.get(nestedTargetId)
        ?.remotePlatform ?? null
    )
  }
  if (host?.kind !== 'ssh') {
    return null
  }
  const sshState = sshOwnerEnvironmentId
    ? state.sshStateByEnvironment.get(sshOwnerEnvironmentId)?.connectionStates.get(host.targetId)
    : state.sshConnectionStates.get(host.targetId)
  return sshState?.remotePlatform ?? null
}

function lastRuntimeHostStatus(
  state: Pick<AppState, 'runtimeStatusByEnvironmentId'>,
  executionHostId: string | null
) {
  const host = parseExecutionHostId(executionHostId)
  return host?.kind === 'runtime'
    ? lastVerifiedRuntimeStatus(state.runtimeStatusByEnvironmentId.get(host.environmentId))
    : null
}

/** OS a paired Orca server last reported, for `runtime:` hosts only. */
export function resolveRuntimeHostReportedPlatform(
  state: Pick<AppState, 'runtimeStatusByEnvironmentId'>,
  executionHostId: string | null
): NodeJS.Platform | null {
  return lastRuntimeHostStatus(state, executionHostId)?.hostPlatform ?? null
}

/** The Windows shell a paired Orca server last reported for its terminals, for `runtime:` hosts only. */
export function resolveRuntimeHostTerminalWindowsShell(
  state: Pick<AppState, 'runtimeStatusByEnvironmentId'>,
  executionHostId: string | null
): string | null {
  return lastRuntimeHostStatus(state, executionHostId)?.terminalWindowsShell ?? null
}

/** The OS a remote host reported: SSH from its connection, a paired server from its status. */
function reportedRemotePlatform(args: AgentResumeLaunchTargetArgs): NodeJS.Platform | null {
  if (args.remotePlatform) {
    return args.remotePlatform
  }
  return !args.connectionId && parseExecutionHostId(args.executionHostId)?.kind === 'runtime'
    ? (args.runtimeHostPlatform ?? null)
    : null
}

function resolveResumeLaunchPlatform(args: AgentResumeLaunchTargetArgs): NodeJS.Platform {
  if (args.projectRuntime?.status === 'repair-required') {
    return args.projectRuntime.repair.preferredRuntime.kind === 'wsl' ? 'linux' : CLIENT_PLATFORM
  }
  if (args.projectRuntime?.status === 'resolved' && args.projectRuntime.runtime.kind === 'wsl') {
    return 'linux'
  }
  const reported = reportedRemotePlatform(args)
  if (reported && isRemoteResumeTarget(args)) {
    // Why: a WSL UNC cwd on a Windows host still launches inside that distro.
    return reported === 'win32' && args.worktreePath && isWslUncPath(args.worktreePath)
      ? 'linux'
      : reported
  }
  const hostKind = parseExecutionHostId(args.executionHostId)?.kind
  // Why: an older server omits its OS, but a drive-letter workspace path still proves Windows.
  if (
    hostKind === 'runtime' &&
    !args.connectionId &&
    args.worktreePath &&
    isWindowsAbsolutePathLike(args.worktreePath) &&
    !isWslUncPath(args.worktreePath)
  ) {
    return 'win32'
  }
  // Why POSIX when a remote host has not reported its OS: such hosts are almost always POSIX, as launches assume.
  if (
    args.connectionId ||
    hostKind === 'ssh' ||
    hostKind === 'runtime' ||
    (args.worktreePath && isWslUncPath(args.worktreePath))
  ) {
    return 'linux'
  }
  return CLIENT_PLATFORM
}

/** Quote for both host platform and live shell; typing PowerShell quotes into cmd.exe passes literal quotes that agent CLIs reject (#12320). */
function resolveResumeAgentHostPlatform(
  args: AgentResumeLaunchTargetArgs,
  platform: NodeJS.Platform
): NodeJS.Platform | null {
  // Why: a remote host that has not reported its OS may be Windows; leave it unknown.
  return !isRemoteResumeTarget(args) || reportedRemotePlatform(args) ? platform : null
}

export function resolveAgentResumeLaunchTarget(
  args: AgentResumeLaunchTargetArgs
): AgentResumeLaunchTarget {
  const platform = resolveResumeLaunchPlatform(args)
  const agentHostPlatform = resolveResumeAgentHostPlatform(args, platform)
  const isRemote = isRemoteResumeTarget(args)
  const spawnsInServerShell =
    !REMOTE_RUNTIME_PTY_HONOURS_TAB_SHELL_OVERRIDE &&
    parseExecutionHostId(args.executionHostId)?.kind === 'runtime'
  return {
    platform,
    agentHostPlatform,
    // Why: a remote host's own shell decides quoting; this client's setting describes only itself.
    shell: resolveHostAgentStartupShell({
      platform,
      isRemote,
      tabShellOverride: spawnsInServerShell ? null : args.tabShellOverride,
      hostTerminalWindowsShell: isRemote
        ? args.connectionId
          ? null
          : args.runtimeHostTerminalWindowsShell
        : args.terminalWindowsShell
    })
  }
}
