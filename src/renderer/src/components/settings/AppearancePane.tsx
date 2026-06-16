/* eslint-disable max-lines -- Why: AppearancePane keeps theme, typography, zoom, and status-bar
   visibility settings together so the searchable settings rows share one filtered surface. */
import type React from 'react'

import type { GlobalSettings } from '../../../../shared/types'

import { Separator } from '../ui/separator'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
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
  getAppIconEntries,
  getAppearancePaneSearchEntries,
  getLanguageEntries,
  getLayoutEntries,
  getLeftSidebarAppearanceEntry,
  getSidebarEntries,
  getStatusBarEntries,
  getStatusBarToggles,
  getThemeEntries,
  getTitlebarEntries,
  getTypographyEntries,
  getZoomEntries
} from './appearance-search'
import { getTerminalAppearanceSearchEntries } from './terminal-search'
import { TerminalAppearanceSection } from './TerminalAppearanceSection'
import type { UseGhosttyImportReturn } from './useGhosttyImport'
import type { UseWarpThemeImportReturn } from './useWarpThemeImport'
import { AppIconSelector } from './AppIconSelector'
import { isWebClientLocation } from '@/hooks/useSettingsNavigationMetadata'
import {
  getUiLanguageChoiceLabel,
  SHOW_UI_LANGUAGE_SETTING,
  UI_LANGUAGE_CHOICES
} from '@/i18n/supported-languages'
import { translate } from '@/i18n/i18n'
import type { UiLanguage } from '../../../../shared/ui-language'
import { LeftSidebarAppearanceSetting } from './LeftSidebarAppearanceSetting'
import { getWorkspaceCardLayoutEntry } from './appearance-sidebar-search'
export { getAppearancePaneSearchEntries }

type AppearancePaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  applyTheme: (theme: 'system' | 'dark' | 'light') => void
  fontSuggestions: string[]
  terminalFontSuggestions: string[]
  systemPrefersDark: boolean
  ghostty: UseGhosttyImportReturn
  warpThemes: UseWarpThemeImportReturn
}

function ShortcutHintList({ combos }: { combos: string[][] }): React.JSX.Element {
  if (combos.length === 0) {
    return (
      <span className="text-xs text-muted-foreground">
        {translate('auto.components.settings.AppearancePane.3057983501', 'Unassigned')}
      </span>
    )
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
  ghostty,
  warpThemes
}: AppearancePaneProps): React.JSX.Element {
  const searchQuery = useAppStore((state) => state.settingsSearchQuery)
  const zoomInKeyCombos = useShortcutKeyCombos('zoom.in')
  const zoomOutKeyCombos = useShortcutKeyCombos('zoom.out')
  const statusBarItems = useAppStore((state) => state.statusBarItems)
  const toggleStatusBarItem = useAppStore((state) => state.toggleStatusBarItem)
  const recordFeatureInteraction = useAppStore((state) => state.recordFeatureInteraction)
  const visibleStatusBarToggles = useAvailableStatusBarToggles(getStatusBarToggles())
  const terminalAppearanceSearchEntries = getTerminalAppearanceSearchEntries({
    showWarpImport: !isWebClientLocation()
  })
  const leftSidebarAppearanceEntry = getLeftSidebarAppearanceEntry()
  const workspaceCardLayoutEntry = getWorkspaceCardLayoutEntry()
  const visibleSections = [
    matchesSettingsSearch(searchQuery, getThemeEntries()) ||
    (SHOW_UI_LANGUAGE_SETTING && matchesSettingsSearch(searchQuery, getLanguageEntries())) ||
    matchesSettingsSearch(searchQuery, getZoomEntries()) ||
    matchesSettingsSearch(searchQuery, getTypographyEntries()) ? (
      <section key="interface" className="divide-y divide-border/40">
        {matchesSettingsSearch(searchQuery, getThemeEntries()) ? (
          <SearchableSetting
            title={translate('auto.components.settings.AppearancePane.932ff1fbff', 'Theme')}
            description={translate(
              'auto.components.settings.AppearancePane.0f28e7b30c',
              'Choose how Orca looks in the app window.'
            )}
            keywords={getThemeEntries()[0]?.keywords ?? ['dark', 'light', 'system']}
          >
            <SettingsRow
              label={translate('auto.components.settings.AppearancePane.932ff1fbff', 'Theme')}
              description={translate(
                'auto.components.settings.AppearancePane.0f28e7b30c',
                'Choose how Orca looks in the app window.'
              )}
              control={
                <SettingsSegmentedControl
                  ariaLabel={translate(
                    'auto.components.settings.AppearancePane.932ff1fbff',
                    'Theme'
                  )}
                  value={settings.theme}
                  onChange={(option) => {
                    updateSettings({ theme: option })
                    applyTheme(option)
                  }}
                  options={[
                    {
                      value: 'system',
                      label: translate(
                        'auto.components.settings.AppearancePane.fb0e0b4453',
                        'System'
                      )
                    },
                    {
                      value: 'dark',
                      label: translate('auto.components.settings.AppearancePane.7d26ccabe8', 'Dark')
                    },
                    {
                      value: 'light',
                      label: translate(
                        'auto.components.settings.AppearancePane.fd89b5487c',
                        'Light'
                      )
                    }
                  ]}
                />
              }
            />
          </SearchableSetting>
        ) : null}

        {SHOW_UI_LANGUAGE_SETTING && matchesSettingsSearch(searchQuery, getLanguageEntries()) ? (
          <SearchableSetting
            title={translate('settings.appearance.language.title', 'Language')}
            description={translate(
              'settings.appearance.language.description',
              'Choose the language used by the Orca interface.'
            )}
            keywords={getLanguageEntries()[0]?.keywords ?? []}
          >
            <SettingsRow
              label={translate('settings.appearance.language.title', 'Language')}
              description={translate(
                'settings.appearance.language.description',
                'Choose the language used by the Orca interface.'
              )}
              control={
                <Select
                  value={settings.uiLanguage}
                  onValueChange={(value) => updateSettings({ uiLanguage: value as UiLanguage })}
                >
                  <SelectTrigger
                    size="sm"
                    className="min-w-[220px]"
                    aria-label={translate('settings.appearance.language.title', 'Language')}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {UI_LANGUAGE_CHOICES.map((choice) => (
                      <SelectItem key={choice.value} value={choice.value}>
                        {getUiLanguageChoiceLabel(choice, translate)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              }
            />
          </SearchableSetting>
        ) : null}

        {matchesSettingsSearch(searchQuery, getZoomEntries()) ? (
          <SearchableSetting
            title={translate('auto.components.settings.AppearancePane.5e6d7aba8d', 'UI Zoom')}
            description={translate(
              'auto.components.settings.AppearancePane.622e1c3465',
              'Scale the entire application interface.'
            )}
            keywords={getZoomEntries()[0]?.keywords ?? ['zoom', 'scale', 'shortcut']}
          >
            <SettingsRow
              label={translate('auto.components.settings.AppearancePane.5e6d7aba8d', 'UI Zoom')}
              description={
                <>
                  {translate(
                    'auto.components.settings.AppearancePane.f687711a9b',
                    'Scale the entire application interface. Use'
                  )}{' '}
                  <ShortcutHintList combos={zoomInKeyCombos} /> /{' '}
                  <ShortcutHintList combos={zoomOutKeyCombos} />{' '}
                  {translate(
                    'auto.components.settings.AppearancePane.ef89200c1f',
                    'when not in a terminal pane.'
                  )}
                </>
              }
              control={<UIZoomControl />}
            />
          </SearchableSetting>
        ) : null}

        {matchesSettingsSearch(searchQuery, getTypographyEntries()) ? (
          <SearchableSetting
            title={translate('auto.components.settings.AppearancePane.102d6b5f9b', 'IDE Font')}
            description={translate(
              'auto.components.settings.AppearancePane.42554f615f',
              'Choose the font used by the Orca interface.'
            )}
            keywords={getTypographyEntries()[0]?.keywords ?? ['font', 'typeface', 'typography']}
          >
            <SettingsRow
              alignTop
              label={translate('auto.components.settings.AppearancePane.102d6b5f9b', 'IDE Font')}
              description={translate(
                'auto.components.settings.AppearancePane.42554f615f',
                'Choose the font used by the Orca interface.'
              )}
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
    matchesSettingsSearch(searchQuery, terminalAppearanceSearchEntries) ? (
      <TerminalAppearanceSection
        key="terminal-appearance"
        settings={settings}
        updateSettings={updateSettings}
        systemPrefersDark={systemPrefersDark}
        terminalFontSuggestions={terminalFontSuggestions}
        ghostty={ghostty}
        warpThemes={warpThemes}
      />
    ) : null,
    matchesSettingsSearch(searchQuery, getLayoutEntries()) ? (
      <section key="layout" className="space-y-3">
        <SettingsSubsectionHeader
          title={translate('auto.components.settings.AppearancePane.d496901cd0', 'File Explorer')}
        />

        <div className="divide-y divide-border/40">
          <SearchableSetting
            title={
              getLayoutEntries()[0]?.title ??
              translate(
                'auto.components.settings.AppearancePane.0fafabcf35',
                'Show Git-Ignored Files'
              )
            }
            description={
              getLayoutEntries()[0]?.description ??
              translate(
                'auto.components.settings.AppearancePane.75f07ab60c',
                'Show files matched by .gitignore in the file explorer.'
              )
            }
            keywords={getLayoutEntries()[0]?.keywords ?? ['git', 'gitignore', 'ignored']}
          >
            <SettingsSwitchRow
              label={translate(
                'auto.components.settings.AppearancePane.0fafabcf35',
                'Show Git-Ignored Files'
              )}
              description={translate(
                'auto.components.settings.AppearancePane.e9f2ca5582',
                'Turn off to hide files matched by .gitignore from the file explorer.'
              )}
              checked={settings.showGitIgnoredFiles ?? true}
              onChange={() =>
                updateSettings({ showGitIgnoredFiles: !(settings.showGitIgnoredFiles ?? true) })
              }
            />
          </SearchableSetting>
        </div>
      </section>
    ) : null,
    matchesSettingsSearch(searchQuery, getTitlebarEntries()) ? (
      <section key="titlebar" className="space-y-3">
        <SettingsSubsectionHeader
          title={translate('auto.components.settings.AppearancePane.6a272ca553', 'Titlebar')}
          description={translate(
            'auto.components.settings.AppearancePane.4de76f6902',
            'Control what appears in the application titlebar.'
          )}
        />

        <div className="divide-y divide-border/40">
          <SearchableSetting
            title={translate(
              'auto.components.settings.AppearancePane.9868f39007',
              'Titlebar App Name'
            )}
            description={translate(
              'auto.components.settings.AppearancePane.2df8f79aa5',
              'Show Orca in the titlebar.'
            )}
            keywords={getTitlebarEntries()[0]?.keywords ?? ['titlebar', 'orca', 'app', 'name']}
          >
            <SettingsSwitchRow
              label={translate(
                'auto.components.settings.AppearancePane.9868f39007',
                'Titlebar App Name'
              )}
              description={translate(
                'auto.components.settings.AppearancePane.2df8f79aa5',
                'Show Orca in the titlebar.'
              )}
              checked={settings.showTitlebarAppName}
              onChange={() =>
                updateSettings({ showTitlebarAppName: !settings.showTitlebarAppName })
              }
            />
          </SearchableSetting>
        </div>
      </section>
    ) : null,
    matchesSettingsSearch(searchQuery, getStatusBarEntries()) ? (
      <section key="status-bar" className="space-y-3">
        <SettingsSubsectionHeader
          title={translate('auto.components.settings.AppearancePane.3e4175e5c6', 'Status Bar')}
          description={translate(
            'auto.components.settings.AppearancePane.ea943d0db0',
            'Choose which indicators appear at the bottom of the window. You can also right-click the status bar for the same toggles.'
          )}
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
    matchesSettingsSearch(searchQuery, getSidebarEntries()) ? (
      <section key="sidebar" className="space-y-3">
        <SettingsSubsectionHeader
          title={translate('auto.components.settings.AppearancePane.dc29f3cc0d', 'Sidebar')}
        />

        <div className="divide-y divide-border/40">
          <SearchableSetting
            title={leftSidebarAppearanceEntry.title}
            description={leftSidebarAppearanceEntry.description}
            keywords={leftSidebarAppearanceEntry.keywords}
            className="space-y-2"
          >
            <LeftSidebarAppearanceSetting settings={settings} updateSettings={updateSettings} />
          </SearchableSetting>

          {/* Why: this setting lives with the sidebar layout controls; Settings only
              points people to it so we do not create a second stateful control. */}
          <SearchableSetting
            title={workspaceCardLayoutEntry.title}
            description={workspaceCardLayoutEntry.description}
            keywords={workspaceCardLayoutEntry.keywords}
          >
            <SettingsRow
              label={workspaceCardLayoutEntry.title}
              description={translate(
                'auto.components.settings.AppearancePane.workspaceCardLayoutGuidance',
                'Use the workspace sidebar options menu > Card layout > Compact.'
              )}
              control={null}
            />
          </SearchableSetting>

          <SearchableSetting
            title={translate(
              'auto.components.settings.AppearancePane.cf81907069',
              'Show Tasks Button'
            )}
            description={translate(
              'auto.components.settings.AppearancePane.661942ab7f',
              'Show the Tasks button at the top of the left sidebar.'
            )}
            keywords={getSidebarEntries()[0]?.keywords ?? ['tasks', 'sidebar', 'button']}
          >
            <SettingsSwitchRow
              label={translate(
                'auto.components.settings.AppearancePane.cf81907069',
                'Show Tasks Button'
              )}
              description={translate(
                'auto.components.settings.AppearancePane.661942ab7f',
                'Show the Tasks button at the top of the left sidebar.'
              )}
              checked={settings.showTasksButton !== false}
              onChange={() =>
                updateSettings({ showTasksButton: !(settings.showTasksButton !== false) })
              }
            />
          </SearchableSetting>

          <SearchableSetting
            title={translate(
              'auto.components.settings.AppearancePane.511f270ebb',
              'Show Automations Button'
            )}
            description={translate(
              'auto.components.settings.AppearancePane.fa882a3e6b',
              'Show the Automations button at the top of the left sidebar.'
            )}
            keywords={getSidebarEntries()[1]?.keywords ?? ['automations', 'automation', 'schedule']}
          >
            <SettingsSwitchRow
              label={translate(
                'auto.components.settings.AppearancePane.511f270ebb',
                'Show Automations Button'
              )}
              description={translate(
                'auto.components.settings.AppearancePane.fa882a3e6b',
                'Show the Automations button at the top of the left sidebar.'
              )}
              checked={settings.showAutomationsButton !== false}
              onChange={() =>
                updateSettings({
                  showAutomationsButton: !(settings.showAutomationsButton !== false)
                })
              }
            />
          </SearchableSetting>

          <SearchableSetting
            title={translate(
              'auto.components.settings.AppearancePane.9da1020447',
              'Show Orca Mobile Button'
            )}
            description={translate(
              'auto.components.settings.AppearancePane.5db6ba961f',
              'Show the Orca Mobile button at the top of the left sidebar.'
            )}
            keywords={getSidebarEntries()[2]?.keywords ?? ['mobile', 'phone', 'sidebar']}
          >
            <SettingsSwitchRow
              label={translate(
                'auto.components.settings.AppearancePane.9da1020447',
                'Show Orca Mobile Button'
              )}
              description={translate(
                'auto.components.settings.AppearancePane.61d842eca0',
                'Show the Orca Mobile shortcut in the sidebar. It remains available from Toolbox.'
              )}
              checked={settings.showMobileButton !== false}
              onChange={() =>
                updateSettings({ showMobileButton: !(settings.showMobileButton !== false) })
              }
            />
          </SearchableSetting>
        </div>
      </section>
    ) : null,
    matchesSettingsSearch(searchQuery, getAppIconEntries()) ? (
      <section key="app-icon" className="space-y-3">
        <SearchableSetting
          title={translate('auto.components.settings.AppearancePane.ca1590d42f', 'App Icon')}
          description={translate(
            'auto.components.settings.AppearancePane.0cd9b8228f',
            'Choose the app icon shown in the Dock and window switcher.'
          )}
          keywords={getAppIconEntries().flatMap((entry) => [
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
