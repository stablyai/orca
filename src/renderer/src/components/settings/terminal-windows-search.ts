import type { SettingsSearchEntry } from './settings-search'

export const TERMINAL_WINDOWS_SHELL_SEARCH_ENTRY: SettingsSearchEntry[] = [
  {
    title: 'Default Shell',
    description: 'Choose the default shell for new terminal panes on Windows.',
    keywords: [
      'terminal',
      'windows',
      'shell',
      'powershell',
      'cmd',
      'command prompt',
      'default',
      'wsl',
      'linux',
      'bash',
      'ubuntu'
    ]
  }
]

export const TERMINAL_WINDOWS_POWERSHELL_IMPLEMENTATION_SEARCH_ENTRY: SettingsSearchEntry[] = [
  {
    title: 'PowerShell Version',
    description:
      'Choose whether the PowerShell shell option launches Windows PowerShell or PowerShell 7+ for new terminal panes.',
    keywords: [
      'terminal',
      'windows',
      'powershell',
      'windows powershell',
      'powershell 7',
      'pwsh',
      'version',
      'advanced'
    ]
  }
]

export const TERMINAL_RIGHT_CLICK_TO_PASTE_SEARCH_ENTRY: SettingsSearchEntry[] = [
  {
    title: 'Right-click to paste',
    description:
      'On Windows, right-click pastes the clipboard into the terminal. Use Ctrl+right-click to open the context menu.',
    keywords: ['terminal', 'windows', 'right click', 'paste', 'context menu']
  }
]

export const TERMINAL_WINDOWS_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  ...TERMINAL_WINDOWS_SHELL_SEARCH_ENTRY,
  ...TERMINAL_WINDOWS_POWERSHELL_IMPLEMENTATION_SEARCH_ENTRY,
  ...TERMINAL_RIGHT_CLICK_TO_PASTE_SEARCH_ENTRY
]
