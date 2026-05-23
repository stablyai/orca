import type React from 'react'
import type { GlobalSettings, StatusBarItem } from '../../../../shared/types'
import { Separator } from '../ui/separator'
import { UIZoomControl } from './UIZoomControl'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch, type SettingsSearchEntry } from './settings-search'
import { useAppStore } from '../../store'
import { useShortcutKeyCombos } from '@/hooks/useShortcutLabel'
import { ShortcutKeyCombo } from '../ShortcutKeyCombo'
import {
  FontAutocomplete,
  SettingsRow,
  SettingsSegmentedControl,
  SettingsSubsectionHeader,
  SettingsSwitchRow
} from './SettingsFormControls'
import { DEFAULT_APP_FONT_FAMILY } from '../../../../shared/constants'
import { useAvailableStatusBarToggles } from '../status-bar/use-available-status-bar-toggles'

type AppearancePaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  applyTheme: (theme: 'system' | 'dark' | 'light') => void
  fontSuggestions: string[]
}

const STATUS_BAR_TOGGLES: readonly {
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

const THEME_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Theme',
    description: 'Choose how Orca looks in the app window.',
    keywords: ['dark', 'light', 'system']
  }
]

const ZOOM_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'UI Zoom',
    description: 'Scale the entire application interface.',
    keywords: ['zoom', 'scale', 'shortcut']
  }
]

const TYPOGRAPHY_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'IDE Font',
    description: 'Choose the font used by the Orca interface.',
    keywords: ['font', 'typeface', 'typography', 'ide', 'orca', 'interface', 'app', 'ui']
  }
]

const LAYOUT_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Open Right Sidebar by Default',
    description: 'Automatically expand the file explorer panel when creating a new worktree.',
    keywords: ['layout', 'file explorer', 'sidebar']
  },
  {
    title: 'Show Git-Ignored Files',
    description: 'Dim files matched by .gitignore in the file explorer.',
    keywords: ['git', 'gitignore', 'ignored', 'file explorer', 'sidebar', 'hide']
  }
]

const TITLEBAR_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Titlebar App Name',
    description: 'Show Orca in the titlebar.',
    keywords: ['titlebar', 'orca', 'app', 'name', 'brand']
  }
]

const STATUS_BAR_ENTRIES: SettingsSearchEntry[] = STATUS_BAR_TOGGLES.map(
  ({ title, description, keywords }) => ({ title, description, keywords })
)

const SIDEBAR_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Show Tasks Button',
    description: 'Show the Tasks button at the top of the left sidebar.',
    keywords: ['tasks', 'sidebar', 'button', 'hide', 'show', 'github', 'linear']
  },
  {
    title: 'Show Orca Mobile Button',
    description: 'Show the Orca Mobile button at the top of the left sidebar.',
    keywords: ['mobile', 'phone', 'sidebar', 'button', 'hide', 'show', 'toolbox']
  }
]

export const APPEARANCE_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  ...THEME_ENTRIES,
  ...TYPOGRAPHY_ENTRIES,
  ...ZOOM_ENTRIES,
  ...LAYOUT_ENTRIES,
  ...TITLEBAR_ENTRIES,
  ...STATUS_BAR_ENTRIES,
  ...SIDEBAR_ENTRIES
]

function ShortcutHintList({ combos }: { combos: string[][] }): React.JSX.Element {
  if (combos.length === 0) {
    return <span className="text-xs text-muted-foreground">Unassigned</span>
  }

  return (
    <span className="inline-flex flex-wrap items-center gap-1 align-middle">
      {combos.map((keys) => (
        <ShortcutKeyCombo
          key={keys.join('-')}
          keys={keys}
          className="inline-flex gap-0.5"
          separatorClassName="text-[10px] text-muted-foreground"
        />
      ))}
    </span>
  )
}

export function AppearancePane({
  settings,
  updateSettings,
  applyTheme,
  fontSuggestions
}: AppearancePaneProps): React.JSX.Element {
  const searchQuery = useAppStore((state) => state.settingsSearchQuery)
  const zoomInKeyCombos = useShortcutKeyCombos('zoom.in')
  const zoomOutKeyCombos = useShortcutKeyCombos('zoom.out')
  const statusBarItems = useAppStore((state) => state.statusBarItems)
  const toggleStatusBarItem = useAppStore((state) => state.toggleStatusBarItem)
  const visibleStatusBarToggles = useAvailableStatusBarToggles(STATUS_BAR_TOGGLES)

  const visibleSections = [
    matchesSettingsSearch(searchQuery, THEME_ENTRIES) ||
    matchesSettingsSearch(searchQuery, ZOOM_ENTRIES) ||
    matchesSettingsSearch(searchQuery, TYPOGRAPHY_ENTRIES) ? (
      <section key="interface" className="divide-y divide-border/40">
        {matchesSettingsSearch(searchQuery, THEME_ENTRIES) ? (
          <SearchableSetting
            title="Theme"
            description="Choose how Orca looks in the app window."
            keywords={['dark', 'light', 'system']}
          >
            <SettingsRow
              label="Theme"
              description="Choose how Orca looks in the app window."
              control={
                <SettingsSegmentedControl
                  ariaLabel="Theme"
                  value={settings.theme}
                  onChange={(option) => {
                    updateSettings({ theme: option })
                    applyTheme(option)
                  }}
                  options={[
                    { value: 'system', label: 'System' },
                    { value: 'dark', label: 'Dark' },
                    { value: 'light', label: 'Light' }
                  ]}
                />
              }
            />
          </SearchableSetting>
        ) : null}

        {matchesSettingsSearch(searchQuery, ZOOM_ENTRIES) ? (
          <SearchableSetting
            title="UI Zoom"
            description="Scale the entire application interface."
            keywords={['zoom', 'scale', 'shortcut']}
          >
            <SettingsRow
              label="UI Zoom"
              description={
                <>
                  Scale the entire application interface. Use{' '}
                  <ShortcutHintList combos={zoomInKeyCombos} /> /{' '}
                  <ShortcutHintList combos={zoomOutKeyCombos} /> when not in a terminal pane.
                </>
              }
              control={<UIZoomControl />}
            />
          </SearchableSetting>
        ) : null}

        {matchesSettingsSearch(searchQuery, TYPOGRAPHY_ENTRIES) ? (
          <SearchableSetting
            title="IDE Font"
            description="Choose the font used by the Orca interface."
            keywords={['font', 'typeface', 'typography', 'ide', 'orca', 'interface', 'app', 'ui']}
          >
            <SettingsRow
              alignTop
              label="IDE Font"
              description="Choose the font used by the Orca interface."
              control={
                <FontAutocomplete
                  value={settings.appFontFamily}
                  suggestions={fontSuggestions}
                  placeholder={DEFAULT_APP_FONT_FAMILY}
                  onChange={(value) =>
                    updateSettings({ appFontFamily: value.trim() || DEFAULT_APP_FONT_FAMILY })
                  }
                />
              }
            />
          </SearchableSetting>
        ) : null}
      </section>
    ) : null,
    matchesSettingsSearch(searchQuery, LAYOUT_ENTRIES) ? (
      <section key="layout" className="space-y-3">
        <SettingsSubsectionHeader
          title="Layout"
          description="Default layout when creating new worktrees."
        />

        <div className="divide-y divide-border/40">
          <SearchableSetting
            title="Open Right Sidebar by Default"
            description="Automatically expand the file explorer panel when creating a new worktree."
            keywords={['layout', 'file explorer', 'sidebar']}
          >
            <SettingsSwitchRow
              label="Open Right Sidebar by Default"
              description="Automatically expand the file explorer panel when creating a new worktree."
              checked={settings.rightSidebarOpenByDefault}
              onChange={() =>
                updateSettings({ rightSidebarOpenByDefault: !settings.rightSidebarOpenByDefault })
              }
            />
          </SearchableSetting>

          <SearchableSetting
            title="Show Git-Ignored Files"
            description="Show files matched by .gitignore in the file explorer."
            keywords={['git', 'gitignore', 'ignored', 'file explorer', 'sidebar', 'hide']}
          >
            <SettingsSwitchRow
              label="Show Git-Ignored Files"
              description="Turn off to hide files matched by .gitignore from the file explorer."
              checked={settings.showGitIgnoredFiles ?? true}
              onChange={() =>
                updateSettings({ showGitIgnoredFiles: !(settings.showGitIgnoredFiles ?? true) })
              }
            />
          </SearchableSetting>
        </div>
      </section>
    ) : null,
    matchesSettingsSearch(searchQuery, TITLEBAR_ENTRIES) ? (
      <section key="titlebar" className="space-y-3">
        <SettingsSubsectionHeader
          title="Titlebar"
          description="Control what appears in the application titlebar."
        />

        <div className="divide-y divide-border/40">
          <SearchableSetting
            title="Titlebar App Name"
            description="Show Orca in the titlebar."
            keywords={['titlebar', 'orca', 'app', 'name', 'brand']}
          >
            <SettingsSwitchRow
              label="Titlebar App Name"
              description="Show Orca in the titlebar."
              checked={settings.showTitlebarAppName}
              onChange={() =>
                updateSettings({ showTitlebarAppName: !settings.showTitlebarAppName })
              }
            />
          </SearchableSetting>
        </div>
      </section>
    ) : null,
    matchesSettingsSearch(searchQuery, STATUS_BAR_ENTRIES) ? (
      <section key="status-bar" className="space-y-3">
        <SettingsSubsectionHeader
          title="Status Bar"
          description="Choose which indicators appear at the bottom of the window. You can also right-click the status bar for the same toggles."
        />

        <div className="divide-y divide-border/40">
          {visibleStatusBarToggles.map((toggle) => {
            const enabled = statusBarItems.includes(toggle.id)
            return (
              <SearchableSetting
                key={toggle.id}
                title={toggle.title}
                description={toggle.description}
                keywords={toggle.keywords}
              >
                <SettingsSwitchRow
                  label={toggle.title}
                  description={toggle.toggleDescription}
                  checked={enabled}
                  onChange={() => toggleStatusBarItem(toggle.id)}
                  ariaLabel={toggle.title}
                />
              </SearchableSetting>
            )
          })}
        </div>
      </section>
    ) : null,
    matchesSettingsSearch(searchQuery, SIDEBAR_ENTRIES) ? (
      <section key="sidebar" className="space-y-3">
        <SettingsSubsectionHeader title="Sidebar" />

        <div className="divide-y divide-border/40">
          <SearchableSetting
            title="Show Tasks Button"
            description="Show the Tasks button at the top of the left sidebar."
            keywords={['tasks', 'sidebar', 'button', 'hide', 'show', 'github', 'linear']}
          >
            <SettingsSwitchRow
              label="Show Tasks Button"
              description="Show the Tasks button at the top of the left sidebar."
              checked={settings.showTasksButton}
              onChange={() => updateSettings({ showTasksButton: !settings.showTasksButton })}
            />
          </SearchableSetting>

          <SearchableSetting
            title="Show Orca Mobile Button"
            description="Show the Orca Mobile button at the top of the left sidebar."
            keywords={['mobile', 'phone', 'sidebar', 'button', 'hide', 'show', 'toolbox']}
          >
            <SettingsSwitchRow
              label="Show Orca Mobile Button"
              description="Show the Orca Mobile shortcut in the sidebar. It remains available from Toolbox."
              checked={settings.showMobileButton !== false}
              onChange={() =>
                updateSettings({ showMobileButton: !(settings.showMobileButton !== false) })
              }
            />
          </SearchableSetting>
        </div>
      </section>
    ) : null
  ].filter(Boolean)

  return (
    <div className="space-y-6">
      {visibleSections.map((section, index) => (
        <div key={index} className="space-y-6">
          {index > 0 ? <Separator /> : null}
          {section}
        </div>
      ))}
    </div>
  )
}
