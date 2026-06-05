/* eslint-disable max-lines -- Why: AppearancePane keeps theme, typography, zoom, and status-bar
   visibility settings together so the searchable settings rows share one filtered surface. */
import type React from 'react'
import type { GlobalSettings } from '../../../../shared/types'
import { Separator } from '../ui/separator'
import { UIZoomControl } from './UIZoomControl'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch } from './settings-search'
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
import { normalizeAppIconId } from '../../../../shared/app-icon'
import { useAvailableStatusBarToggles } from '../status-bar/use-available-status-bar-toggles'
import {
  APP_ICON_ENTRIES,
  APPEARANCE_PANE_SEARCH_ENTRIES,
  LAYOUT_ENTRIES,
  SIDEBAR_ENTRIES,
  STATUS_BAR_ENTRIES,
  STATUS_BAR_TOGGLES,
  THEME_ENTRIES,
  TITLEBAR_ENTRIES,
  TYPOGRAPHY_ENTRIES,
  ZOOM_ENTRIES
} from './appearance-search'
import { TERMINAL_APPEARANCE_SEARCH_ENTRIES } from './terminal-search'
import { TerminalAppearanceSection } from './TerminalAppearanceSection'
import type { UseGhosttyImportReturn } from './useGhosttyImport'
import { AppIconSelector } from './AppIconSelector'
export { APPEARANCE_PANE_SEARCH_ENTRIES }

type AppearancePaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  applyTheme: (theme: 'system' | 'dark' | 'light') => void
  fontSuggestions: string[]
  terminalFontSuggestions: string[]
  systemPrefersDark: boolean
  ghostty: UseGhosttyImportReturn
}

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
  fontSuggestions,
  terminalFontSuggestions,
  systemPrefersDark,
  ghostty
}: AppearancePaneProps): React.JSX.Element {
  const searchQuery = useAppStore((state) => state.settingsSearchQuery)
  const zoomInKeyCombos = useShortcutKeyCombos('zoom.in')
  const zoomOutKeyCombos = useShortcutKeyCombos('zoom.out')
  const statusBarItems = useAppStore((state) => state.statusBarItems)
  const toggleStatusBarItem = useAppStore((state) => state.toggleStatusBarItem)
  const recordFeatureInteraction = useAppStore((state) => state.recordFeatureInteraction)
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
    matchesSettingsSearch(searchQuery, TERMINAL_APPEARANCE_SEARCH_ENTRIES) ? (
      <TerminalAppearanceSection
        key="terminal-appearance"
        settings={settings}
        updateSettings={updateSettings}
        systemPrefersDark={systemPrefersDark}
        terminalFontSuggestions={terminalFontSuggestions}
        ghostty={ghostty}
      />
    ) : null,
    matchesSettingsSearch(searchQuery, LAYOUT_ENTRIES) ? (
      <section key="layout" className="space-y-3">
        <SettingsSubsectionHeader title="File Explorer" />

        <div className="divide-y divide-border/40">
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
                  onChange={() => {
                    if (toggle.id === 'resource-usage') {
                      recordFeatureInteraction('resource-manager')
                    } else if (toggle.id === 'ports') {
                      recordFeatureInteraction('ports')
                    } else if (toggle.id === 'ssh') {
                      recordFeatureInteraction('ssh')
                    } else if (
                      toggle.id === 'claude' ||
                      toggle.id === 'codex' ||
                      toggle.id === 'gemini' ||
                      toggle.id === 'opencode-go'
                    ) {
                      recordFeatureInteraction('usage-tracking')
                    }
                    toggleStatusBarItem(toggle.id)
                  }}
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
              checked={settings.showTasksButton !== false}
              onChange={() =>
                updateSettings({ showTasksButton: !(settings.showTasksButton !== false) })
              }
            />
          </SearchableSetting>

          <SearchableSetting
            title="Show Automations Button"
            description="Show the Automations button at the top of the left sidebar."
            keywords={[
              'automations',
              'automation',
              'schedule',
              'sidebar',
              'button',
              'hide',
              'show'
            ]}
          >
            <SettingsSwitchRow
              label="Show Automations Button"
              description="Show the Automations button at the top of the left sidebar."
              checked={settings.showAutomationsButton !== false}
              onChange={() =>
                updateSettings({
                  showAutomationsButton: !(settings.showAutomationsButton !== false)
                })
              }
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
    ) : null,
    matchesSettingsSearch(searchQuery, APP_ICON_ENTRIES) ? (
      <section key="app-icon" className="space-y-3">
        <SearchableSetting
          title="App Icon"
          description="Choose the app icon shown in the Dock and window switcher."
          keywords={APP_ICON_ENTRIES.flatMap((entry) => [
            entry.title,
            entry.description ?? '',
            ...(entry.keywords ?? [])
          ])}
          className="max-w-none py-2"
        >
          <AppIconSelector
            value={normalizeAppIconId(settings.appIcon)}
            onChange={(appIcon) => updateSettings({ appIcon })}
          />
        </SearchableSetting>
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
