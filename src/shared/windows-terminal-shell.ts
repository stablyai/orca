import type { AgentStartupShell } from './tui-agent-startup-shell'

export const WINDOWS_GIT_BASH_SHELL = 'git-bash'

export type BuiltInWindowsTerminalShell =
  | 'powershell.exe'
  | 'cmd.exe'
  | 'wsl.exe'
  | typeof WINDOWS_GIT_BASH_SHELL

/** Choose startup quoting from terminalWindowsShell: Git Bash/WSL use POSIX, cmd.exe uses cmd, others use the PowerShell default. */
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
  // WSL/Git Bash need POSIX quoting/cd; extensionless names resolve through PATHEXT too.
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

/** The shell a command typed into a new pane runs in on its host: the tab's override, then that
 *  host's own Windows shell setting, then the platform default (undefined for a remote host). */
export function resolveHostAgentStartupShell(args: {
  platform: NodeJS.Platform
  isRemote: boolean
  tabShellOverride?: string | null
  /** The executing host's setting: this client's for a local host, the reported one for a remote host. */
  hostTerminalWindowsShell?: string | null
}): AgentStartupShell | undefined {
  if (args.platform !== 'win32') {
    return undefined
  }
  const shell = args.tabShellOverride?.trim() || args.hostTerminalWindowsShell?.trim()
  if (!shell) {
    return args.isRemote ? undefined : resolveWindowsShellStartupFamily(undefined)
  }
  return resolveWindowsShellStartupFamily(canonicalizeWindowsShellOverride(shell) ?? shell)
}

export function resolveLocalWindowsAgentStartupShell(args: {
  platform: NodeJS.Platform
  isRemote: boolean
  terminalWindowsShell?: string | null
}): AgentStartupShell | undefined {
  // Local shell settings cannot describe SSH or paired hosts.
  return resolveHostAgentStartupShell({
    platform: args.platform,
    isRemote: args.isRemote,
    hostTerminalWindowsShell: args.isRemote ? undefined : args.terminalWindowsShell
  })
}

/** Share accepted Windows shell overrides across RPC validation and relay spawn.
 * Canonical .exe/marker names keep exact-match quoting and Git Bash lookup aligned; pwsh and powershell remain distinct binaries. */
const WINDOWS_SHELL_OVERRIDE_CANONICAL_NAMES: ReadonlyMap<string, string> = new Map([
  ['powershell.exe', 'powershell.exe'],
  ['powershell', 'powershell.exe'],
  ['pwsh.exe', 'pwsh.exe'],
  ['pwsh', 'pwsh.exe'],
  ['cmd.exe', 'cmd.exe'],
  ['cmd', 'cmd.exe'],
  ['wsl.exe', 'wsl.exe'],
  ['wsl', 'wsl.exe'],
  // Both bash spellings already work with local/daemon PTYs; keep relay acceptance aligned.
  ['bash.exe', 'bash.exe'],
  ['bash', 'bash.exe'],
  [WINDOWS_GIT_BASH_SHELL, WINDOWS_GIT_BASH_SHELL]
])

/** Canonical spelling for an accepted override (case-insensitive), or undefined when refused. */
export function canonicalizeWindowsShellOverride(shell: string): string | undefined {
  return WINDOWS_SHELL_OVERRIDE_CANONICAL_NAMES.get(shell.toLowerCase())
}

export function isSupportedWindowsShellOverride(shell: string): boolean {
  return canonicalizeWindowsShellOverride(shell) !== undefined
}

/** Sorted for a stable error message; callers list these when refusing a value. */
export function listSupportedWindowsShellOverrides(): string[] {
  return [...WINDOWS_SHELL_OVERRIDE_CANONICAL_NAMES.keys()].sort()
}
