import type { BuiltInWindowsTerminalShell } from '../../../../shared/windows-terminal-shell'
import { WINDOWS_GIT_BASH_SHELL } from '../../../../shared/windows-terminal-shell'
import { translate } from '@/i18n/i18n'
import type { getProjectRuntimeShellMenuMode } from './use-tab-bar-runtime-model'

export type WindowsShellMenuEntry = {
  label: string
  shell: BuiltInWindowsTerminalShell
}

export function buildWindowsShellMenuEntries({
  showWindowsShellMenu,
  hasShellLauncher,
  projectRuntimeShellMenuMode,
  defaultWindowsShell,
  gitBashAvailable,
  wslAvailable
}: {
  showWindowsShellMenu: boolean
  hasShellLauncher: boolean
  projectRuntimeShellMenuMode: ReturnType<typeof getProjectRuntimeShellMenuMode>
  defaultWindowsShell: string
  gitBashAvailable: boolean
  wslAvailable: boolean
}): WindowsShellMenuEntry[] | undefined {
  if (!showWindowsShellMenu || !hasShellLauncher) {
    return undefined
  }
  const includeHostShells = projectRuntimeShellMenuMode !== 'wsl'
  const includeWslShell = projectRuntimeShellMenuMode !== 'host'
  const allShells: WindowsShellMenuEntry[] = []
  if (includeHostShells) {
    allShells.push(
      {
        label: translate('auto.components.tab.bar.TabBar.2148f65e04', 'PowerShell'),
        shell: 'powershell.exe'
      },
      {
        label: translate('auto.components.tab.bar.TabBar.1a8af49530', 'CMD Prompt'),
        shell: 'cmd.exe'
      }
    )
    if (gitBashAvailable) {
      allShells.push({
        label: translate('auto.components.tab.bar.TabBar.efb33546ff', 'Git Bash'),
        shell: WINDOWS_GIT_BASH_SHELL
      })
    }
  }
  if (includeWslShell && wslAvailable) {
    allShells.push({
      label: translate('auto.components.tab.bar.TabBar.d1afac112b', 'WSL'),
      shell: 'wsl.exe'
    })
  }
  if (allShells.length === 0) {
    return undefined
  }
  const defaultEntry =
    allShells.find((shell) => shell.shell === defaultWindowsShell) ?? allShells[0]
  return [defaultEntry, ...allShells.filter((shell) => shell.shell !== defaultEntry.shell)].map(
    (entry) => ({ label: entry.label, shell: entry.shell })
  )
}
