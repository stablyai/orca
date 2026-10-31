import type { ProjectExecutionRuntimeResolution } from './project-execution-runtime'
import { isWindowsAbsolutePathLike } from './cross-platform-path'
import type { LocalWindowsTerminalRuntimeOptions } from './local-windows-terminal-runtime'
import { resolveStartupShell, type AgentStartupShell } from './tui-agent-startup-shell'
import { resolveLocalWindowsAgentStartupShell } from './windows-terminal-shell'
import { isWslUncPath } from './wsl-paths'

/** Resolve command platform and actual PTY shell once on the execution host; in-memory only. */
export type AgentLaunchRuntime = {
  /** `linux` for a WSL runtime. */
  platform: NodeJS.Platform
  /** The spawn's own PTY options; empty for a remote host, which picks its own shell. */
  pty: LocalWindowsTerminalRuntimeOptions
}

export function agentLaunchQuotingShell(runtime: AgentLaunchRuntime): AgentStartupShell {
  return resolveStartupShell(
    runtime.platform,
    resolveLocalWindowsAgentStartupShell({
      platform: runtime.platform,
      // A remote fact names no shell, which quotes for its platform's default.
      isRemote: false,
      terminalWindowsShell: runtime.pty.shellOverride
    })
  )
}

/** A local workspace's platform: its project runtime, else a `\\wsl$` path is Linux, else the host. */
export function executionRuntimePlatform(
  projectRuntime: ProjectExecutionRuntimeResolution | undefined,
  workspacePath: string | null | undefined,
  hostPlatform: NodeJS.Platform
): NodeJS.Platform {
  const kind =
    projectRuntime?.status === 'repair-required'
      ? projectRuntime.repair.preferredRuntime.kind
      : projectRuntime?.runtime.kind
  if (kind) {
    return kind === 'wsl' ? 'linux' : hostPlatform
  }
  return workspacePath && isWslUncPath(workspacePath) ? 'linux' : hostPlatform
}

/** A remote workspace is quoted for its own path's family; its host picks the shell. */
export function remoteExecutionPlatform(workspacePath: string): NodeJS.Platform {
  return isWindowsAbsolutePathLike(workspacePath) ? 'win32' : 'linux'
}
