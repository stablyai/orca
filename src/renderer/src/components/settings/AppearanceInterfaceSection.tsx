import type React from 'react'

import type { AppThemePresetId, GlobalSettings } from '../../../../shared/global-settings-types'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { UIZoomControl } from './UIZoomControl'
import { SearchableSetting } from './SearchableSetting'
import { AppearanceAdvancedDisclosure } from './AppearanceAdvancedDisclosure'
import { useAppStore } from '../../store'
import { useShortcutKeyComboDetails } from '@/hooks/useShortcutLabel'
import { ShortcutHintList } from './AppearanceShortcutHintList'
import {
  FontAutocomplete,
  SettingsRow,
  SettingsSegmentedControl,
  SettingsSwitchRow
} from './SettingsFormControls'
import { ThemePresetSelector } from './ThemePresetSelector'
import { getMatchingTerminalTheme, resolveEffectiveThemePreset } from '@/lib/app-theme-presets'
import { DEFAULT_APP_FONT_FAMILY } from '../../../../shared/constants'
import {
  getLanguageEntries,
  getMenuBarIconEntries,
  getSystemTrayEntries,
  getThemeEntries,
  getTitlebarEntries,
  getTypographyEntries,
  getZoomEntries
} from './appearance-search'
import {
  getUiLanguageChoiceLabel,
  SHOW_UI_LANGUAGE_SETTING,
  UI_LANGUAGE_CHOICES
} from '@/i18n/supported-languages'
import { translate } from '@/i18n/i18n'
import type { UiLanguage } from '../../../../shared/ui-language'
import { matchesSettingsSearch, normalizeSettingsSearchQuery } from './settings-search'
import { usePluginLanguagePacks } from '@/store/plugin-language-packs'

type AppearanceInterfaceSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  applyTheme: (theme: 'system' | 'dark' | 'light', themePreset?: AppThemePresetId) => void
  fontSuggestions: string[]
  isDesktopMac: boolean
  isDesktopWindows: boolean
  systemPrefersDark?: boolean
  onRequestFontSuggestions?: () => void
  forceVisiblePrimary?: boolean
}

export function AppearanceInterfaceSection({
  settings,
  updateSettings,
  applyTheme,
  fontSuggestions,
  isDesktopMac,
  isDesktopWindows,
  systemPrefersDark,
  onRequestFontSuggestions,
  forceVisiblePrimary = false
}: AppearanceInterfaceSectionProps): React.JSX.Element {
  const searchQuery = useAppStore((state) => state.settingsSearchQuery)
  const pluginLanguagePacks = usePluginLanguagePacks()
  const isSearching = normalizeSettingsSearchQuery(searchQuery).length > 0
  const zoomInKeyCombos = useShortcutKeyComboDetails('zoom.in')
  const zoomOutKeyCombos = useShortcutKeyComboDetails('zoom.out')
  const languageEntry = getLanguageEntries()[0]
  const menuBarIconEntry = getMenuBarIconEntries({ showMenuBarIcon: true })[0]
  const systemTrayEntry = getSystemTrayEntries({ showSystemTray: true })[0]
  const themeEntry = getThemeEntries()[0]
  const themeLabel = translate('auto.components.settings.AppearancePane.932ff1fbff', 'Theme')
  const titlebarEntry = getTitlebarEntries()[0]
  const typographyEntry = getTypographyEntries()[0]
  const zoomEntry = getZoomEntries()[0]
  const advancedEntries = [
    ...getTitlebarEntries(),
    ...getSystemTrayEntries({ showSystemTray: isDesktopWindows }),
    ...getMenuBarIconEntries({ showMenuBarIcon: isDesktopMac })
  ]
  const showAdvanced = !isSearching || matchesSettingsSearch(searchQuery, advancedEntries)
  const languageTitle = translate('settings.appearance.language.title', 'Language')

  const isSystemDark =
    systemPrefersDark ??
    (typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-color-scheme: dark)').matches)
  const effectiveThemeMode: 'dark' | 'light' =
    settings.theme === 'dark'
      ? 'dark'
      : settings.theme === 'light'
        ? 'light'
        : isSystemDark
          ? 'dark'
          : 'light'

  return (
    <div className="divide-y divide-border/40">
      <SearchableSetting
        title={themeLabel}
        description={themeEntry?.description}
        keywords={themeEntry?.keywords ?? ['dark', 'light', 'system']}
        forceVisible={forceVisiblePrimary}
      >
        <div className="space-y-4 py-1">
          <SettingsRow
            label={themeLabel}
            control={
              <SettingsSegmentedControl
                ariaLabel={themeLabel}
                value={settings.theme}
                onChange={(option) => {
                  const updates: Partial<GlobalSettings> = { theme: option }
                  const newEffectiveMode =
                    option === 'system' ? (systemPrefersDark ? 'dark' : 'light') : option

                  if (settings.syncTerminalThemeWithInterface ?? true) {
                    const effectivePreset = resolveEffectiveThemePreset(
                      option,
                      settings.themePreset,
                      systemPrefersDark ?? false
                    )
                    const matchingTerminalTheme = getMatchingTerminalTheme(
                      effectivePreset,
                      newEffectiveMode
                    )
                    if (matchingTerminalTheme) {
                      if (newEffectiveMode === 'dark') {
                        updates.terminalThemeDark = matchingTerminalTheme
                      } else {
                        updates.terminalThemeLight = matchingTerminalTheme
                      }
                    }
                  }

                  updateSettings(updates)
                  applyTheme(option, settings.themePreset)
                }}
                options={[
                  {
                    value: 'system',
                    label: translate('auto.components.settings.AppearancePane.fb0e0b4453', 'System')
                  },
                  {
                    value: 'dark',
                    label: translate('auto.components.settings.AppearancePane.7d26ccabe8', 'Dark')
                  },
                  {
                    value: 'light',
                    label: translate('auto.components.settings.AppearancePane.fd89b5487c', 'Light')
                  }
                ]}
              />
            }
          />

          <div className="pt-1">
            <span className="mb-2 block text-xs font-semibold text-foreground">
              {translate('settings.appearance.themePresets.title', 'Theme Palette')}
            </span>
            <ThemePresetSelector
              value={settings.themePreset ?? 'default'}
              effectiveMode={effectiveThemeMode}
              onChange={(presetId) => {
                const updates: Partial<GlobalSettings> = { themePreset: presetId }
                if (settings.syncTerminalThemeWithInterface ?? true) {
                  const matchingTerminalTheme = getMatchingTerminalTheme(
                    presetId,
                    effectiveThemeMode
                  )
                  if (matchingTerminalTheme) {
                    if (effectiveThemeMode === 'dark') {
                      updates.terminalThemeDark = matchingTerminalTheme
                    } else {
                      updates.terminalThemeLight = matchingTerminalTheme
                    }
                  }
                }
                updateSettings(updates)
                applyTheme(settings.theme, presetId)
              }}
            />
          </div>

          <SettingsSwitchRow
            label={translate('settings.appearance.syncTerminalTheme.label', 'Sync Terminal Theme')}
            description={translate(
              'settings.appearance.syncTerminalTheme.description',
              'Automatically set the matching terminal color scheme when changing the interface theme.'
            )}
            checked={settings.syncTerminalThemeWithInterface ?? true}
            onChange={() =>
              updateSettings({
                syncTerminalThemeWithInterface: !(settings.syncTerminalThemeWithInterface ?? true)
              })
            }
          />
        </div>
      </SearchableSetting>

      {SHOW_UI_LANGUAGE_SETTING ? (
        <SearchableSetting
          title={languageTitle}
          description={languageEntry?.description}
          keywords={languageEntry?.keywords ?? []}
          forceVisible={forceVisiblePrimary}
        >
          <SettingsRow
            label={languageTitle}
            control={
              <Select
                value={settings.uiLanguage}
                onValueChange={(value) => updateSettings({ uiLanguage: value as UiLanguage })}
              >
                <SelectTrigger size="sm" className="min-w-[220px]" aria-label={languageTitle}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {UI_LANGUAGE_CHOICES.map((choice) => (
                    <SelectItem key={choice.value} value={choice.value}>
                      {getUiLanguageChoiceLabel(choice, translate)}
                    </SelectItem>
                  ))}
                  {pluginLanguagePacks.map((pack) => (
                    <SelectItem key={pack.id} value={pack.id}>
                      {pack.locale} — {pack.pluginKey}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            }
          />
        </SearchableSetting>
      ) : null}

      <SearchableSetting
        title={translate('auto.components.settings.AppearancePane.5e6d7aba8d', 'UI Zoom')}
        description={zoomEntry?.description}
        keywords={zoomEntry?.keywords ?? ['zoom', 'scale', 'shortcut']}
        forceVisible={forceVisiblePrimary}
      >
        <SettingsRow
          label={translate('auto.components.settings.AppearancePane.5e6d7aba8d', 'UI Zoom')}
          // Why: keep only the shortcut hint — the control itself makes "scale the
          // interface" obvious, but the keyboard gesture and its terminal-pane
          // exception are not discoverable from the buttons alone.
          description={
            <>
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

      <SearchableSetting
        title={translate('auto.components.settings.AppearancePane.102d6b5f9b', 'IDE Font')}
        description={typographyEntry?.description}
        keywords={typographyEntry?.keywords ?? ['font', 'typeface', 'typography']}
        forceVisible={forceVisiblePrimary}
      >
        <SettingsRow
          label={translate('auto.components.settings.AppearancePane.102d6b5f9b', 'IDE Font')}
          control={
            <FontAutocomplete
              value={settings.appFontFamily}
              suggestions={fontSuggestions}
              placeholder={DEFAULT_APP_FONT_FAMILY}
              onRequestSuggestions={onRequestFontSuggestions}
              onChange={(value) =>
                updateSettings({ appFontFamily: value.trim() || DEFAULT_APP_FONT_FAMILY })
              }
            />
          }
        />
      </SearchableSetting>

      {showAdvanced ? (
        <AppearanceAdvancedDisclosure showTopBorder={false}>
          <div className="divide-y divide-border/40">
            <SearchableSetting
              title={translate(
                'auto.components.settings.AppearancePane.9868f39007',
                'Titlebar App Name'
              )}
              description={titlebarEntry?.description}
              keywords={titlebarEntry?.keywords ?? ['titlebar', 'orca', 'app', 'name']}
            >
              <SettingsSwitchRow
                label={translate(
                  'auto.components.settings.AppearancePane.9868f39007',
                  'Titlebar App Name'
                )}
                checked={settings.showTitlebarAppName}
                onChange={() =>
                  updateSettings({ showTitlebarAppName: !settings.showTitlebarAppName })
                }
              />
            </SearchableSetting>

            {isDesktopWindows ? (
              <SearchableSetting
                title={translate(
                  'auto.components.settings.AppearancePane.2edf606c46',
                  'Minimize to Tray on Close'
                )}
                description={systemTrayEntry?.description}
                keywords={systemTrayEntry?.keywords ?? ['tray', 'minimize', 'close']}
              >
                <SettingsSwitchRow
                  label={translate(
                    'auto.components.settings.AppearancePane.2edf606c46',
                    'Minimize to Tray on Close'
                  )}
                  // Why: platform constraint + "close keeps Orca running" consequence are
                  // both non-obvious from the label alone.
                  description={translate(
                    'auto.components.settings.AppearancePane.b707773a0d',
                    'When enabled, closing the window keeps Orca running in the system tray instead of quitting.'
                  )}
                  checked={settings.minimizeToTrayOnClose === true}
                  onChange={() =>
                    updateSettings({ minimizeToTrayOnClose: !settings.minimizeToTrayOnClose })
                  }
                />
              </SearchableSetting>
            ) : null}

            {isDesktopMac ? (
              <SearchableSetting
                title={translate('settings.appearance.menuBarIcon.title', 'Show Menu Bar Icon')}
                description={menuBarIconEntry?.description}
                keywords={menuBarIconEntry?.keywords ?? ['menu bar', 'status item', 'activity']}
              >
                <SettingsSwitchRow
                  label={translate('settings.appearance.menuBarIcon.title', 'Show Menu Bar Icon')}
                  // Why: this opt-out removes only the status item; macOS Dock
                  // activation and the close-keeps-running lifecycle stay intact.
                  description={translate(
                    'settings.appearance.menuBarIcon.description',
                    'Keep an Orca shortcut and activity indicator in the macOS menu bar.'
                  )}
                  checked={settings.showMenuBarIcon !== false}
                  onChange={() =>
                    updateSettings({ showMenuBarIcon: settings.showMenuBarIcon === false })
                  }
                />
              </SearchableSetting>
            ) : null}
          </div>
        </AppearanceAdvancedDisclosure>
      ) : null}
    </div>
  )
}
