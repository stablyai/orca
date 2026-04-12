import type { GlobalSettings } from '../../../../shared/types'
import { Label } from '../ui/label'
import { Separator } from '../ui/separator'
import { UIZoomControl } from './UIZoomControl'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch, type SettingsSearchEntry } from './settings-search'
import { useAppStore } from '../../store'

type AppearancePaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  applyTheme: (theme: 'system' | 'dark' | 'light') => void
}

export const APPEARANCE_PANE_SEARCH_ENTRIES: SettingsSearchEntry[] = [
  {
    title: 'Theme',
    description: 'Choose how Orca looks in the app window.',
    keywords: ['dark', 'light', 'system']
  },
  {
    title: 'UI Zoom',
    description: 'Scale the entire application interface.',
    keywords: ['zoom', 'scale', 'shortcut']
  },
  {
    title: 'Open Right Sidebar by Default',
    description: 'Automatically expand the file explorer panel when creating a new worktree.',
    keywords: ['layout', 'file explorer', 'sidebar']
  },
  {
    title: 'Titlebar Agent Activity',
    description: 'Show the number of active agents in the titlebar.',
    keywords: ['titlebar', 'agent', 'badge', 'active', 'count', 'status']
  }
]

export function AppearancePane({
  settings,
  updateSettings,
  applyTheme
}: AppearancePaneProps): React.JSX.Element {
  const searchQuery = useAppStore((state) => state.settingsSearchQuery)
  const isMac = navigator.userAgent.includes('Mac')
  const zoomInLabel = isMac ? '⌘+' : 'Ctrl +'
  const zoomOutLabel = isMac ? '⌘-' : 'Ctrl -'
  const themeEntries = APPEARANCE_PANE_SEARCH_ENTRIES.slice(0, 1)
  const zoomEntries = APPEARANCE_PANE_SEARCH_ENTRIES.slice(1, 2)
  const layoutEntries = APPEARANCE_PANE_SEARCH_ENTRIES.slice(2, 3)
  const titlebarEntries = APPEARANCE_PANE_SEARCH_ENTRIES.slice(3)

  const visibleSections = [
    matchesSettingsSearch(searchQuery, themeEntries) ? (
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
    matchesSettingsSearch(searchQuery, zoomEntries) ? (
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
    matchesSettingsSearch(searchQuery, layoutEntries) ? (
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
    matchesSettingsSearch(searchQuery, titlebarEntries) ? (
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
