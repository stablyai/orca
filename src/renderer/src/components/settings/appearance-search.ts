import type { StatusBarItem } from '../../../../shared/types'
import type { SettingsSearchEntry } from './settings-search'
import { TERMINAL_APPEARANCE_SEARCH_ENTRIES } from './terminal-search'

export const STATUS_BAR_TOGGLES: readonly {
  id: StatusBarItem
  title: string
  description: string
  keywords: string[]
  toggleDescription: string
}[] = [
  {
    id: 'claude',
    title: 'Claude Usage',
    description: 'Show Claude token and cost usage in the status bar.',
    keywords: ['status bar', 'claude', 'usage', 'tokens', 'cost', 'anthropic'],
    toggleDescription: 'Show Claude token and cost usage for the active workspace.'
  },
  {
    id: 'codex',
    title: 'Codex Usage',
    description: 'Show Codex token and cost usage in the status bar.',
    keywords: ['status bar', 'codex', 'usage', 'tokens', 'cost', 'openai'],
    toggleDescription: 'Show Codex token and cost usage for the active workspace.'
  },
  {
    id: 'gemini',
    title: 'Gemini Usage',
    description: 'Show Gemini token and cost usage in the status bar.',
    keywords: ['status bar', 'gemini', 'usage', 'tokens', 'cost', 'google'],
    toggleDescription: 'Show Gemini token and cost usage for the active workspace.'
  },
  {
    id: 'opencode-go',
    title: 'OpenCode Go Usage',
    description: 'Show OpenCode Go token and cost usage in the status bar.',
    keywords: ['status bar', 'opencode', 'opencode-go', 'usage', 'tokens', 'cost'],
    toggleDescription: 'Show OpenCode Go token and cost usage for the active workspace.'
  },
  {
    id: 'kimi',
    title: 'Kimi Usage',
    description: 'Show Kimi subscription usage in the status bar.',
    keywords: ['status bar', 'kimi', 'usage', 'subscription', 'moonshot'],
    toggleDescription: 'Show Kimi subscription usage for the active workspace.'
  },
  {
    id: 'ssh',
    title: 'SSH Status',
    description: 'Show the active SSH connection status in the status bar.',
    keywords: ['status bar', 'ssh', 'remote', 'connection', 'host'],
    toggleDescription:
      'Show the active SSH connection. Only visible once an SSH target is configured.'
  },
  {
    id: 'resource-usage',
    title: 'Resource Manager',
    description: 'Show CPU, memory, terminal sessions, and workspace disk usage in the status bar.',
    keywords: ['status bar', 'resource', 'manager', 'memory', 'cpu', 'terminal', 'disk', 'space'],
    toggleDescription:
      'Show the Resource Manager. Click it for CPU, memory, sessions, daemon controls, and workspace disk scans.'
  },
  {
    id: 'ports',
    title: 'Ports',
    description: 'Show live workspace ports in the status bar.',
    keywords: ['status bar', 'ports', 'localhost', 'server', 'workspace'],
    toggleDescription:
      'Show live workspace ports. Click it for workspace-scoped ports and external listeners.'
  }
]

export const THEME_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Theme',
    description: 'Choose how Orca looks in the app window.',
    keywords: ['dark', 'light', 'system']
  }
]

export const ZOOM_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'UI Zoom',
    description: 'Scale the entire application interface.',
    keywords: ['zoom', 'scale', 'shortcut']
  }
]

export const TYPOGRAPHY_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'IDE Font',
    description: 'Choose the font used by the Orca interface.',
    keywords: ['font', 'typeface', 'typography', 'ide', 'orca', 'interface', 'app', 'ui']
  }
]

export const LAYOUT_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Show Git-Ignored Files',
    description: 'Dim files matched by .gitignore in the file explorer.',
    keywords: ['git', 'gitignore', 'ignored', 'file explorer', 'sidebar', 'hide']
  }
]

export const TITLEBAR_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Titlebar App Name',
    description: 'Show Orca in the titlebar.',
    keywords: ['titlebar', 'orca', 'app', 'name', 'brand']
  }
]

export const STATUS_BAR_ENTRIES: SettingsSearchEntry[] = STATUS_BAR_TOGGLES.map(
  ({ title, description, keywords }) => ({ title, description, keywords })
)

export const SIDEBAR_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Show Tasks Button',
    description: 'Show the Tasks button at the top of the left sidebar.',
    keywords: ['tasks', 'sidebar', 'button', 'hide', 'show', 'github', 'linear']
  },
  {
    title: 'Show Automations Button',
    description: 'Show the Automations button at the top of the left sidebar.',
    keywords: ['automations', 'automation', 'schedule', 'sidebar', 'button', 'hide', 'show']
  },
  {
    title: 'Show Orca Mobile Button',
    description: 'Show the Orca Mobile button at the top of the left sidebar.',
    keywords: ['mobile', 'phone', 'sidebar', 'button', 'hide', 'show', 'toolbox']
  }
]

export const APP_ICON_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'App Icon',
    description: 'Choose the app icon shown in the Dock and window switcher.',
    keywords: ['app icon', 'orca', 'dock', 'window', 'switcher', 'blue', 'watercolor']
  }
]

export const APPEARANCE_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  ...THEME_ENTRIES,
  ...TYPOGRAPHY_ENTRIES,
  ...ZOOM_ENTRIES,
  ...TERMINAL_APPEARANCE_SEARCH_ENTRIES,
  ...LAYOUT_ENTRIES,
  ...TITLEBAR_ENTRIES,
  ...STATUS_BAR_ENTRIES,
  ...SIDEBAR_ENTRIES,
  ...APP_ICON_ENTRIES
]
