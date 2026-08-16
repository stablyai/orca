import { WINDOWS_GIT_BASH_SHELL } from '../../../../shared/windows-terminal-shell'
export function isWindowsGitBashPaneForShortcut(args: {
  isWindowsTerminalHost: boolean
  sessionShellOverride?: string | null
}): boolean {
  return args.isWindowsTerminalHost && args.sessionShellOverride === WINDOWS_GIT_BASH_SHELL
}
