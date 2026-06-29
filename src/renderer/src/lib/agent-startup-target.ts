import { isWindowsAbsolutePathLike } from '../../../shared/cross-platform-path'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { resolveLocalWindowsTerminalRuntimeOptions } from '../../../shared/local-windows-terminal-runtime'
import type { ProjectExecutionRuntimeResolution } from '../../../shared/project-execution-runtime'
import { isWslUncPath } from '../../../shared/wsl-paths'
import { CLIENT_PLATFORM } from './new-workspace'
import { resolveStartupShellForTerminal, type AgentStartupShell } from '@/lib/tui-agent-startup'

export type AgentStartupLaunchHost = {
  connectionId?: string | null
  executionHostId?: string | null
  path?: string | null
}

export type AgentStartupTarget = {
  platform: NodeJS.Platform
  shell: AgentStartupShell
}

function inferPathPlatform(path: string): NodeJS.Platform {
  return path && isWindowsAbsolutePathLike(path) && !isWslUncPath(path) ? 'win32' : 'linux'
}

function isNonLocalLaunchHost(host: AgentStartupLaunchHost | null | undefined): boolean {
  const parsedHost = parseExecutionHostId(host?.executionHostId)
  return parsedHost?.kind === 'ssh' || parsedHost?.kind === 'runtime' || Boolean(host?.connectionId)
}

function isLocalLaunchHost(host: AgentStartupLaunchHost | null | undefined): boolean {
  if (!host) {
    return true
  }
  const parsedHost = parseExecutionHostId(host.executionHostId)
  if (parsedHost) {
    return parsedHost.kind === 'local'
  }
  return !host.connectionId?.trim()
}

export function resolveAgentStartupPlatform(args: {
  host?: AgentStartupLaunchHost | null
  worktreePath?: string | null
  projectRuntime?: ProjectExecutionRuntimeResolution
  fallbackPlatform?: NodeJS.Platform
}): NodeJS.Platform {
  const path = (args.worktreePath ?? args.host?.path ?? '').trim()
  if (isNonLocalLaunchHost(args.host)) {
    return inferPathPlatform(path)
  }
  if (args.projectRuntime?.status === 'repair-required') {
    return args.projectRuntime.repair.preferredRuntime.kind === 'wsl'
      ? 'linux'
      : (args.fallbackPlatform ?? CLIENT_PLATFORM)
  }
  if (args.projectRuntime?.status === 'resolved' && args.projectRuntime.runtime.kind === 'wsl') {
    return 'linux'
  }
  if (path && isWslUncPath(path)) {
    return 'linux'
  }
  return args.fallbackPlatform ?? CLIENT_PLATFORM
}

export function resolveAgentStartupTarget(args: {
  platform?: NodeJS.Platform
  host?: AgentStartupLaunchHost | null
  worktreePath?: string | null
  projectRuntime?: ProjectExecutionRuntimeResolution
  terminalWindowsShell?: string | null
  fallbackPlatform?: NodeJS.Platform
}): AgentStartupTarget {
  const platform =
    args.platform ??
    resolveAgentStartupPlatform({
      host: args.host,
      worktreePath: args.worktreePath,
      projectRuntime: args.projectRuntime,
      fallbackPlatform: args.fallbackPlatform
    })

  // Why: terminalWindowsShell is a local desktop preference; SSH/runtime owners
  // must use the target platform's default startup shell.
  if (platform === 'win32' && isLocalLaunchHost(args.host) && args.projectRuntime) {
    const runtimeOptions = resolveLocalWindowsTerminalRuntimeOptions({
      requestedShellOverride: undefined,
      settings: { terminalWindowsShell: args.terminalWindowsShell ?? undefined },
      projectRuntime: args.projectRuntime
    })
    return {
      platform,
      shell: resolveStartupShellForTerminal(platform, runtimeOptions.shellOverride)
    }
  }

  return {
    platform,
    shell: resolveStartupShellForTerminal(
      platform,
      isLocalLaunchHost(args.host) ? args.terminalWindowsShell : undefined
    )
  }
}
