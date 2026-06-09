import type { SettingsSearchEntry } from './settings-search'
import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

export const getTerminalWindowsShellSearchEntry = createLocalizedCatalog(() => [
  {
    title: translate(
      'auto.components.settings.terminal.windows.search.13715f9d23',
      'Default Shell'
    ),
    description: translate(
      'auto.components.settings.terminal.windows.search.713c4a2f92',
      'Choose the default shell for new terminal panes on Windows.'
    ),
    keywords: [
      translate('auto.components.settings.terminal.windows.search.e7d2793b03', 'terminal'),
      translate('auto.components.settings.terminal.windows.search.28ff08ed35', 'windows'),
      translate('auto.components.settings.terminal.windows.search.7c7056940a', 'shell'),
      translate('auto.components.settings.terminal.windows.search.2d99cd91be', 'powershell'),
      translate('auto.components.settings.terminal.windows.search.6cd20b9e64', 'cmd'),
      translate('auto.components.settings.terminal.windows.search.12519edb5d', 'command prompt'),
      translate('auto.components.settings.terminal.windows.search.04994f6929', 'default'),
      translate('auto.components.settings.terminal.windows.search.591912177b', 'git bash'),
      translate('auto.components.settings.terminal.windows.search.6e3adf4cba', 'wsl'),
      translate('auto.components.settings.terminal.windows.search.02c772582a', 'linux'),
      translate('auto.components.settings.terminal.windows.search.5a2db98d23', 'bash'),
      translate('auto.components.settings.terminal.windows.search.07ec155fb6', 'bash.exe'),
      translate('auto.components.settings.terminal.windows.search.4ee2579c32', 'ubuntu')
    ]
  }
])

export const getTerminalWindowsPowershellImplementationSearchEntry = createLocalizedCatalog(() => [
  {
    title: translate(
      'auto.components.settings.terminal.windows.search.860e0e6402',
      'PowerShell Version'
    ),
    description: translate(
      'auto.components.settings.terminal.windows.search.41a69bc24d',
      'Choose whether the PowerShell shell option launches Windows PowerShell or PowerShell 7+ for new terminal panes.'
    ),
    keywords: [
      translate('auto.components.settings.terminal.windows.search.e7d2793b03', 'terminal'),
      translate('auto.components.settings.terminal.windows.search.28ff08ed35', 'windows'),
      translate('auto.components.settings.terminal.windows.search.2d99cd91be', 'powershell'),
      translate(
        'auto.components.settings.terminal.windows.search.f9162f0b8e',
        'windows powershell'
      ),
      translate('auto.components.settings.terminal.windows.search.768613e483', 'powershell 7'),
      translate('auto.components.settings.terminal.windows.search.d414022016', 'pwsh'),
      translate('auto.components.settings.terminal.windows.search.4af2f7526e', 'version'),
      translate('auto.components.settings.terminal.windows.search.d57f870938', 'advanced')
    ]
  }
])

export const getTerminalWindowsWslDistroSearchEntry = createLocalizedCatalog(() => [
  {
    title: translate(
      'auto.components.settings.terminal.windows.search.1f402b3651',
      'WSL Distribution'
    ),
    description: translate(
      'auto.components.settings.terminal.windows.search.978457945b',
      'Choose which WSL distribution new WSL terminals and local agent scans use.'
    ),
    keywords: [
      translate('auto.components.settings.terminal.windows.search.e7d2793b03', 'terminal'),
      translate('auto.components.settings.terminal.windows.search.28ff08ed35', 'windows'),
      translate('auto.components.settings.terminal.windows.search.6e3adf4cba', 'wsl'),
      translate('auto.components.settings.terminal.windows.search.02c772582a', 'linux'),
      translate('auto.components.settings.terminal.windows.search.2b4a340ce0', 'distribution'),
      translate('auto.components.settings.terminal.windows.search.5074ad8b5f', 'distro'),
      translate('auto.components.settings.terminal.windows.search.4ee2579c32', 'ubuntu'),
      translate('auto.components.settings.terminal.windows.search.fc564eadaf', 'debian'),
      translate('auto.components.settings.terminal.windows.search.04994f6929', 'default')
    ]
  }
])

export const getTerminalRightClickToPasteSearchEntry = createLocalizedCatalog(() => [
  {
    title: translate(
      'auto.components.settings.terminal.windows.search.f0b8448570',
      'Right-click to paste'
    ),
    description: translate(
      'auto.components.settings.terminal.windows.search.8ba875c132',
      'On Windows, right-click pastes the clipboard into the terminal. Use Ctrl+right-click to open the context menu.'
    ),
    keywords: [
      translate('auto.components.settings.terminal.windows.search.e7d2793b03', 'terminal'),
      translate('auto.components.settings.terminal.windows.search.28ff08ed35', 'windows'),
      translate('auto.components.settings.terminal.windows.search.e55186fe2b', 'right click'),
      translate('auto.components.settings.terminal.windows.search.fcfa53920b', 'paste'),
      translate('auto.components.settings.terminal.windows.search.4d09141a42', 'context menu')
    ]
  }
])

export const getTerminalWindowsSearchEntries = createLocalizedCatalog((): SettingsSearchEntry[] => [
  ...getTerminalWindowsShellSearchEntry(),
  ...getTerminalWindowsWslDistroSearchEntry(),
  ...getTerminalWindowsPowershellImplementationSearchEntry(),
  ...getTerminalRightClickToPasteSearchEntry()
])
