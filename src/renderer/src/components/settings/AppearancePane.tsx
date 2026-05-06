import type { GlobalSettings, StatusBarItem } from '../../../../shared/types'
import { Label } from '../ui/label'
import { Separator } from '../ui/separator'
import { UIZoomControl } from './UIZoomControl'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch, type SettingsSearchEntry } from './settings-search'
import { useAppStore } from '../../store'
import { FontAutocomplete } from './SettingsFormControls'
import { DEFAULT_APP_FONT_FAMILY } from '../../../../shared/constants'

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
    title: 'Resource Usage',
    description: 'Show CPU, memory, and terminal session indicators in the status bar.',
    keywords: [
      'status bar',
      'resource',
      'usage',
      'memory',
      'ram',
      'cpu',
      'terminal',
      'sessions',
      'pty',
      'monitoring',
      'performance'
    ],
    toggleDescription:
      'Show CPU, memory, and terminal session counts. Click it for a per-workspace breakdown and daemon controls.'
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
  }
]

const TITLEBAR_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Titlebar Agent Activity',
    description: 'Show the number of active agents in the titlebar.',
    keywords: ['titlebar', 'agent', 'badge', 'active', 'count', 'status']
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

export function AppearancePane({
  settings,
  updateSettings,
  applyTheme,
  fontSuggestions
}: AppearancePaneProps): React.JSX.Element {
  const searchQuery = useAppStore((state) => state.settingsSearchQuery)
  const isMac = navigator.userAgent.includes('Mac')
  const zoomInLabel = isMac ? '⌘+' : 'Ctrl +'
  const zoomOutLabel = isMac ? '⌘-' : 'Ctrl -'
  const statusBarItems = useAppStore((state) => state.statusBarItems)
  const toggleStatusBarItem = useAppStore((state) => state.toggleStatusBarItem)

  const visibleSections = [
    matchesSettingsSearch(searchQuery, THEME_ENTRIES) ? (
      <section key="theme" className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">Theme</h3>
          <p className="text-xs text-muted-foreground">Choose how Orca looks in the app window.</p>
        </div>

        <SearchableSetting
          title="Theme"
          description="Choose how Orca looks in the app window."
          keywords={['dark', 'light', 'system']}
        >
          <div className="flex w-fit gap-1 rounded-md border border-border/50 p-1">
            {(['system', 'dark', 'light'] as const).map((option) => (
              <button
                key={option}
                onClick={() => {
                  updateSettings({ theme: option })
                  applyTheme(option)
                }}
                className={`rounded-sm px-3 py-1 text-sm capitalize transition-colors ${
                  settings.theme === option
                    ? 'bg-accent font-medium text-accent-foreground'
                    : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {option}
              </button>
            ))}
          </div>
        </SearchableSetting>
      </section>
    ) : null,
    matchesSettingsSearch(searchQuery, ZOOM_ENTRIES) ? (
      <section key="zoom" className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">UI Zoom</h3>
          <p className="text-xs text-muted-foreground">
            Scale the entire application interface. Use{' '}
            <kbd className="rounded border px-1 py-0.5 text-[10px]">{zoomInLabel}</kbd> /{' '}
            <kbd className="rounded border px-1 py-0.5 text-[10px]">{zoomOutLabel}</kbd> when not in
            a terminal pane.
          </p>
        </div>

        <SearchableSetting
          title="UI Zoom"
          description="Scale the entire application interface."
          keywords={['zoom', 'scale', 'shortcut']}
        >
          <UIZoomControl />
        </SearchableSetting>
      </section>
    ) : null,
    matchesSettingsSearch(searchQuery, TYPOGRAPHY_ENTRIES) ? (
      <section key="typography" className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">Typography</h3>
          <p className="text-xs text-muted-foreground">
            Choose the font used by the Orca interface.
          </p>
        </div>

        <SearchableSetting
          title="IDE Font"
          description="Choose the font used by the Orca interface."
          keywords={['font', 'typeface', 'typography', 'ide', 'orca', 'interface', 'app', 'ui']}
          className="space-y-2"
        >
          <Label>IDE Font</Label>
          <FontAutocomplete
            value={settings.appFontFamily}
            suggestions={fontSuggestions}
            placeholder={DEFAULT_APP_FONT_FAMILY}
            onChange={(value) =>
              updateSettings({ appFontFamily: value.trim() || DEFAULT_APP_FONT_FAMILY })
            }
          />
        </SearchableSetting>
      </section>
    ) : null,
    matchesSettingsSearch(searchQuery, LAYOUT_ENTRIES) ? (
      <section key="layout" className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">Layout</h3>
          <p className="text-xs text-muted-foreground">
            Default layout when creating new worktrees.
          </p>
        </div>

        <SearchableSetting
          title="Open Right Sidebar by Default"
          description="Automatically expand the file explorer panel when creating a new worktree."
          keywords={['layout', 'file explorer', 'sidebar']}
          className="flex items-center justify-between gap-4 px-1 py-2"
        >
          <div className="space-y-0.5">
            <Label>Open Right Sidebar by Default</Label>
            <p className="text-xs text-muted-foreground">
              Automatically expand the file explorer panel when creating a new worktree.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={settings.rightSidebarOpenByDefault}
            onClick={() =>
              updateSettings({
                rightSidebarOpenByDefault: !settings.rightSidebarOpenByDefault
              })
            }
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
              settings.rightSidebarOpenByDefault ? 'bg-foreground' : 'bg-muted-foreground/30'
            }`}
          >
            <span
              className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
                settings.rightSidebarOpenByDefault ? 'translate-x-4' : 'translate-x-0.5'
              }`}
            />
          </button>
        </SearchableSetting>
      </section>
    ) : null,
    matchesSettingsSearch(searchQuery, TITLEBAR_ENTRIES) ? (
      <section key="titlebar" className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">Titlebar</h3>
          <p className="text-xs text-muted-foreground">
            Control what appears in the application titlebar.
          </p>
        </div>

        <SearchableSetting
          title="Titlebar Agent Activity"
          description="Show the number of active agents in the titlebar."
          keywords={['titlebar', 'agent', 'badge', 'active', 'count', 'status']}
          className="flex items-center justify-between gap-4 px-1 py-2"
        >
          <div className="space-y-0.5">
            <Label>Titlebar Agent Activity</Label>
            <p className="text-xs text-muted-foreground">
              Show the number of active agents in the titlebar.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={settings.showTitlebarAgentActivity}
            onClick={() =>
              updateSettings({
                showTitlebarAgentActivity: !settings.showTitlebarAgentActivity
              })
            }
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
              settings.showTitlebarAgentActivity ? 'bg-foreground' : 'bg-muted-foreground/30'
            }`}
          >
            <span
              className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
                settings.showTitlebarAgentActivity ? 'translate-x-4' : 'translate-x-0.5'
              }`}
            />
          </button>
        </SearchableSetting>
      </section>
    ) : null,
    matchesSettingsSearch(searchQuery, STATUS_BAR_ENTRIES) ? (
      <section key="status-bar" className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">Status Bar</h3>
          <p className="text-xs text-muted-foreground">
            Choose which indicators appear at the bottom of the window. You can also right-click the
            status bar for the same toggles.
          </p>
        </div>

        {STATUS_BAR_TOGGLES.map((toggle) => {
          const enabled = statusBarItems.includes(toggle.id)
          return (
            <SearchableSetting
              key={toggle.id}
              title={toggle.title}
              description={toggle.description}
              keywords={toggle.keywords}
              className="flex items-center justify-between gap-4 px-1 py-2"
            >
              <div className="space-y-0.5">
                <Label>{toggle.title}</Label>
                <p className="text-xs text-muted-foreground">{toggle.toggleDescription}</p>
              </div>
              <button
                type="button"
                role="switch"
                aria-label={toggle.title}
                aria-checked={enabled}
                onClick={() => toggleStatusBarItem(toggle.id)}
                className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
                  enabled ? 'bg-foreground' : 'bg-muted-foreground/30'
                }`}
              >
                <span
                  className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
                    enabled ? 'translate-x-4' : 'translate-x-0.5'
                  }`}
                />
              </button>
            </SearchableSetting>
          )
        })}
      </section>
    ) : null,
    matchesSettingsSearch(searchQuery, SIDEBAR_ENTRIES) ? (
      <section key="sidebar" className="space-y-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">Sidebar</h3>
        </div>

        <SearchableSetting
          title="Show Tasks Button"
          description="Show the Tasks button at the top of the left sidebar."
          keywords={['tasks', 'sidebar', 'button', 'hide', 'show', 'github', 'linear']}
          className="flex items-center justify-between gap-4 px-1 py-2"
        >
          <div className="space-y-0.5">
            <Label>Show Tasks Button</Label>
            <p className="text-xs text-muted-foreground">
              Show the Tasks button at the top of the left sidebar.
            </p>
          </div>
          <button
            role="switch"
            aria-checked={settings.showTasksButton}
            onClick={() =>
              updateSettings({
                showTasksButton: !settings.showTasksButton
              })
            }
            className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
              settings.showTasksButton ? 'bg-foreground' : 'bg-muted-foreground/30'
            }`}
          >
            <span
              className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
                settings.showTasksButton ? 'translate-x-4' : 'translate-x-0.5'
              }`}
            />
          </button>
        </SearchableSetting>
      </section>
    ) : null
  ].filter(Boolean)

  return (
    <div className="space-y-8">
      {visibleSections.map((section, index) => (
        <div key={index} className="space-y-8">
          {index > 0 ? <Separator /> : null}
          {section}
        </div>
      ))}
    </div>
  )
}
