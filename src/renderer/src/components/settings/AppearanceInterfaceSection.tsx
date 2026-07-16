import type React from 'react'

import type { GlobalSettings } from '../../../../shared/types'
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
import { DEFAULT_APP_FONT_FAMILY } from '../../../../shared/constants'
import {
  getLanguageEntries,
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

type AppearanceInterfaceSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  applyTheme: (theme: 'system' | 'dark' | 'light') => void
  fontSuggestions: string[]
  isDesktopWindows: boolean
  onRequestFontSuggestions?: () => void
  forceVisiblePrimary?: boolean
}

export function AppearanceInterfaceSection({
  settings,
  updateSettings,
  applyTheme,
  fontSuggestions,
  isDesktopWindows,
  onRequestFontSuggestions,
  forceVisiblePrimary = false
}: AppearanceInterfaceSectionProps): React.JSX.Element {
  const searchQuery = useAppStore((state) => state.settingsSearchQuery)
  const isSearching = normalizeSettingsSearchQuery(searchQuery).length > 0
  const zoomInKeyCombos = useShortcutKeyComboDetails('zoom.in')
  const zoomOutKeyCombos = useShortcutKeyComboDetails('zoom.out')
  const languageEntry = getLanguageEntries()[0]
  const systemTrayEntry = getSystemTrayEntries({ showSystemTray: true })[0]
  const themeEntry = getThemeEntries()[0]
  const themeLabel = translate('auto.components.settings.AppearancePane.932ff1fbff', 'Theme')
  const titlebarEntry = getTitlebarEntries()[0]
  const typographyEntry = getTypographyEntries()[0]
  const zoomEntry = getZoomEntries()[0]
  const advancedEntries = [
    ...(SHOW_UI_LANGUAGE_SETTING ? getLanguageEntries() : []),
    ...getTitlebarEntries(),
    ...getSystemTrayEntries({ showSystemTray: isDesktopWindows })
  ]
  const showAdvanced = !isSearching || matchesSettingsSearch(searchQuery, advancedEntries)

  return (
    <div className="divide-y divide-border/40">
      <SearchableSetting
        title={themeLabel}
        description={themeEntry?.description}
        keywords={themeEntry?.keywords ?? ['dark', 'light', 'system']}
        forceVisible={forceVisiblePrimary}
      >
        <SettingsRow
          label={themeLabel}
          control={
            <SettingsSegmentedControl
              ariaLabel={themeLabel}
              value={settings.theme}
              onChange={(option) => {
                updateSettings({ theme: option })
                applyTheme(option)
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
      </SearchableSetting>

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
            {SHOW_UI_LANGUAGE_SETTING ? (
              <SearchableSetting
                title={translate('settings.appearance.language.title', 'Language')}
                description={languageEntry?.description}
                keywords={languageEntry?.keywords ?? []}
              >
                <SettingsRow
                  label={translate('settings.appearance.language.title', 'Language')}
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
          </div>
        </AppearanceAdvancedDisclosure>
      ) : null}
    </div>
  )
}
