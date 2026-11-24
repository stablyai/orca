import type { BuiltInWindowsTerminalShell } from '../../../../../shared/shell/launch/windows-terminal-shell'
import { WINDOWS_GIT_BASH_SHELL } from '../../../../../shared/shell/launch/windows-terminal-shell'
import { WINDOWS_NIUBASH_SHELL } from '../../../../../shared/niubash-shell'
import { listWindowsTerminalShellChoices } from '../../../../../shared/shell/launch/windows-terminal-shell-choices'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import type { getProjectRuntimeShellMenuMode } from '../model/use-tab-bar-runtime-model'

export type WindowsShellMenuEntry = {
  label: string
  shell: BuiltInWindowsTerminalShell
}

export function buildWindowsShellMenuEntries(
  {
    showWindowsShellMenu,
    hasShellLauncher,
    projectRuntimeShellMenuMode,
    defaultWindowsShell,
    gitBashAvailable,
    niubashAvailable = false,
    wslAvailable
  }: {
    showWindowsShellMenu: boolean
    hasShellLauncher: boolean
    projectRuntimeShellMenuMode: ReturnType<typeof getProjectRuntimeShellMenuMode>
    defaultWindowsShell: string
    gitBashAvailable: boolean
    niubashAvailable?: boolean
    wslAvailable: boolean
  },
  t: Translate = translate
): WindowsShellMenuEntry[] | undefined {
  if (!showWindowsShellMenu || !hasShellLauncher) {
    return undefined
  }
  const labels: Record<BuiltInWindowsTerminalShell, string> = {
    'powershell.exe': t('auto.components.tab.bar.TabBar.2148f65e04', 'PowerShell'),
    'cmd.exe': t('auto.components.tab.bar.TabBar.1a8af49530', 'CMD Prompt'),
    [WINDOWS_GIT_BASH_SHELL]: t('auto.components.tab.bar.TabBar.efb33546ff', 'Git Bash'),
    [WINDOWS_NIUBASH_SHELL]: t('auto.components.tab.bar.TabBar.niubash', 'Niubash'),
    'wsl.exe': t('auto.components.tab.bar.TabBar.d1afac112b', 'WSL')
  }
  const shells = listWindowsTerminalShellChoices({
    defaultWindowsShell,
    gitBashAvailable,
    niubashAvailable,
    wslAvailable,
    includeHostShells: projectRuntimeShellMenuMode !== 'wsl',
    includeWslShell: projectRuntimeShellMenuMode !== 'host'
  })
  return shells.length === 0 ? undefined : shells.map((shell) => ({ label: labels[shell], shell }))
}
