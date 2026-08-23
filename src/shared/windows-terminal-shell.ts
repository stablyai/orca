import type { AgentStartupShell } from './tui-agent-startup-shell'

export const WINDOWS_GIT_BASH_SHELL = 'git-bash'

export type BuiltInWindowsTerminalShell =
  | 'powershell.exe'
  | 'cmd.exe'
  | 'wsl.exe'
  | typeof WINDOWS_GIT_BASH_SHELL

type WindowsShellAttempt = { shellPath: string }

export function enforceRequiredWindowsPowerShellAttempts<T extends WindowsShellAttempt>(args: {
  requiredShell?: 'powershell'
  resolvedShellPath: string
  fallbackAttempts: T[]
}): T[] {
  if (args.requiredShell !== 'powershell') {
    return args.fallbackAttempts
  }
  const isPowerShell = (shellPath: string): boolean => {
    const basename = shellPath.replaceAll('\\', '/').split('/').pop()?.toLowerCase()
    return basename === 'powershell.exe' || basename === 'pwsh.exe'
  }
  if (!isPowerShell(args.resolvedShellPath)) {
    throw new Error('required_shell_unavailable')
  }
  return args.fallbackAttempts.filter((attempt) => isPowerShell(attempt.shellPath))
}

/**
 * Classifies a configured `terminalWindowsShell` value into the startup-shell
 * family used to quote queued commands. Git Bash / wsl.exe run a POSIX shell;
 * cmd.exe needs cmd quoting; everything else (PowerShell, pwsh, unknown) is
 * treated as PowerShell, matching the Windows default.
 */
export function resolveWindowsShellStartupFamily(
  shell: string | null | undefined
): AgentStartupShell {
  const trimmed = shell?.trim()
  if (!trimmed) {
    return 'powershell'
  }
  if (trimmed === WINDOWS_GIT_BASH_SHELL) {
    return 'posix'
  }
  const basename = trimmed.replaceAll('\\', '/').split('/').pop()?.toLowerCase() ?? ''
  if (basename === 'cmd.exe') {
    return 'cmd'
  }
  // Why: wsl.exe and bash.exe (Git for Windows) launch POSIX shells, so queued
  // commands must use POSIX quoting and `cd '<cwd>'` rather than cmd/PowerShell.
  // Extension-less forms reach the same executables through PATHEXT.
  if (
    basename === 'wsl.exe' ||
    basename === 'wsl' ||
    basename === 'bash.exe' ||
    basename === 'bash'
  ) {
    return 'posix'
  }
  return 'powershell'
}

export function resolveLocalWindowsAgentStartupShell(args: {
  platform: NodeJS.Platform
  isRemote: boolean
  terminalWindowsShell?: string | null
}): AgentStartupShell | undefined {
  // Why: terminalWindowsShell describes the local host shell; SSH/remote
  // targets need their own shell signal before we can safely override quoting.
  if (args.platform !== 'win32' || args.isRemote) {
    return undefined
  }
  return resolveWindowsShellStartupFamily(args.terminalWindowsShell)
}

export function resolveLocalWindowsAgentTeamsPowerShell(args: {
  platform: NodeJS.Platform
  isRemote: boolean
  terminalWindowsShell?: string | null
}): string | undefined {
  if (args.platform !== 'win32' || args.isRemote) {
    return undefined
  }
  const trimmed = args.terminalWindowsShell?.trim() || 'powershell.exe'
  const basename = trimmed.replaceAll('\\', '/').split('/').pop()?.toLowerCase()
  return basename === 'powershell.exe' ||
    basename === 'powershell' ||
    basename === 'pwsh.exe' ||
    basename === 'pwsh'
    ? trimmed
    : undefined
}
