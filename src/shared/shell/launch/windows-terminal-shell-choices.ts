import { WINDOWS_NIUBASH_SHELL } from '../../niubash-shell'
import { WINDOWS_GIT_BASH_SHELL, type BuiltInWindowsTerminalShell } from './windows-terminal-shell'

/** The shells a new terminal on a Windows host can start in, the host's default first. */
export function listWindowsTerminalShellChoices({
  defaultWindowsShell,
  gitBashAvailable,
  niubashAvailable = false,
  wslAvailable,
  includeHostShells = true,
  includeWslShell = true
}: {
  defaultWindowsShell: string | null | undefined
  gitBashAvailable: boolean
  niubashAvailable?: boolean
  wslAvailable: boolean
  includeHostShells?: boolean
  includeWslShell?: boolean
}): BuiltInWindowsTerminalShell[] {
  const shells: BuiltInWindowsTerminalShell[] = []
  if (includeHostShells) {
    shells.push('powershell.exe', 'cmd.exe')
    if (gitBashAvailable) {
      shells.push(WINDOWS_GIT_BASH_SHELL)
    }
    if (niubashAvailable) {
      shells.push(WINDOWS_NIUBASH_SHELL)
    }
  }
  if (includeWslShell && wslAvailable) {
    shells.push('wsl.exe')
  }
  const first = shells.find((shell) => shell === defaultWindowsShell) ?? shells[0]
  return first === undefined ? [] : [first, ...shells.filter((shell) => shell !== first)]
}
