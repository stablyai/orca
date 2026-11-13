import type React from 'react'

import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import { UIZoomControl } from './UIZoomControl'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { ReduceVisualEffectsSetting } from './ReduceVisualEffectsSetting'
import { NotchStatusSetting } from './NotchStatusSetting'
import { getReduceVisualEffectsEntries } from './appearance-reduce-visual-effects-search'
import { SettingsGroupDisclosure } from '../section-layout/SettingsGroupDisclosure'
import {
  SettingsSearchableSelect,
  type SettingsSearchableSelectOption
} from '../form-controls/SettingsSearchableSelect'
import { useAppStore } from '../../../store/index'
import { useShortcutKeyComboDetails } from '@/hooks/useShortcutLabel'
import { ShortcutHintList } from './AppearanceShortcutHintList'
import { FontAutocomplete } from './fonts/FontAutocomplete'
import { SettingsRow, SettingsSwitchRow } from '../form-controls/SettingsFormControls'
import { DEFAULT_APP_FONT_FAMILY } from '../../../../../shared/constants'
import {
  APPEARANCE_EDITOR_THEME_SETTING_ID,
  getCodeEditorThemeEntries,
  getLanguageEntries,
  getThemeEntries,
  getTitlebarEntries,
  getTypographyEntries,
  getZoomEntries
} from './appearance-search'
import * as systemPresence from './appearance-system-presence-search'
import { SHOW_UI_LANGUAGE_SETTING, UI_LANGUAGE_CHOICES } from '@/i18n/supported-languages'
import { useTranslate } from '@/i18n/use-translate'
import type { UiLanguage } from '../../../../../shared/ui-language'
import { matchesSettingsSearch, normalizeSettingsSearchQuery } from '../search/settings-search'
import { translateSearchKeyword } from '../search/settings-search-keywords'
import {
  AppearanceThemeControl,
  AppearanceThemeSlotSelect,
  CodeEditorThemeSelect
} from './themes/AppearanceThemeControl'
import { useIconThemePickerLabels, useUiLanguagePickerLabels } from './use-appearance-picker-labels'

type AppearanceInterfaceSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  applyTheme: (theme: 'system' | 'dark' | 'light') => void
  fontSuggestions: string[]
  isDesktopMac: boolean
  isDesktopWindows: boolean
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
  onRequestFontSuggestions,
  forceVisiblePrimary = false
}: AppearanceInterfaceSectionProps): React.JSX.Element {
  const t = useTranslate()
  const searchQuery = useAppStore((state) => state.settingsSearchQuery)
  const iconThemes = useIconThemePickerLabels()
  const pluginIconThemes = iconThemes.themes
  const languages = useUiLanguagePickerLabels()
  const themeSlots = [
    {
      base: 'light' as const,
      title: t('auto.components.settings.AppearanceInterfaceSection.lightTheme', 'Light theme')
    },
    {
      base: 'dark' as const,
      title: t('auto.components.settings.AppearanceInterfaceSection.darkTheme', 'Dark theme')
    }
  ]
  const editorThemeEntry = getCodeEditorThemeEntries()[0]
  const editorThemeSlots = [
    {
      base: 'light' as const,
      title: t('settings.appearance.editorTheme.light', 'Light editor theme'),
      description: t(
        'settings.appearance.editorTheme.lightDescription',
        'Code editor, diff and notebook colors while the app is light.'
      )
    },
    {
      base: 'dark' as const,
      title: t('settings.appearance.editorTheme.dark', 'Dark editor theme'),
      description: t(
        'settings.appearance.editorTheme.darkDescription',
        'Code editor, diff and notebook colors while the app is dark.'
      )
    }
  ]
  const iconThemeTitle = t(
    'auto.components.settings.AppearanceInterfaceSection.pluginIconTheme.title',
    'Icon theme'
  )
  const isSearching = normalizeSettingsSearchQuery(searchQuery).length > 0
  const zoomInKeyCombos = useShortcutKeyComboDetails('zoom.in')
  const zoomOutKeyCombos = useShortcutKeyComboDetails('zoom.out')
  const languageEntry = getLanguageEntries()[0]
  const menuBarIconEntry = systemPresence.getMenuBarIconEntries({ showMenuBarIcon: true })[0]
  const systemTrayEntry = systemPresence.getSystemTrayEntries({ showSystemTray: true })[0]
  const themeEntry = getThemeEntries()[0]
  const themeLabel = t('auto.components.settings.AppearancePane.932ff1fbff', 'Theme')
  const titlebarEntry = getTitlebarEntries()[0]
  const typographyEntry = getTypographyEntries()[0]
  const zoomEntry = getZoomEntries()[0]
  const reduceVisualEffectsEntry = getReduceVisualEffectsEntries()[0]
  const languageOptions: SettingsSearchableSelectOption[] = [
    ...UI_LANGUAGE_CHOICES.map((choice, index) => ({
      value: choice.value,
      label: languages.choices[index],
      keywords: [choice.value]
    })),
    ...languages.packs.map((pack) => ({
      value: pack.id,
      label: languages.packLabels.get(pack.id) ?? pack.locale,
      keywords: [pack.id, pack.locale]
    }))
  ]
  if (!languageOptions.some((option) => option.value === settings.uiLanguage)) {
    languageOptions.push({
      value: settings.uiLanguage,
      label: t(
        'auto.components.settings.AppearanceInterfaceSection.languageUnavailable',
        '{{value0}} (unavailable)',
        { value0: settings.uiLanguage }
      ),
      disabled: true
    })
  }
  const presence = { showSystemTray: isDesktopWindows, showMenuBarIcon: isDesktopMac }
  const advancedEntries = [
    ...getTitlebarEntries(),
    ...getReduceVisualEffectsEntries(),
    ...systemPresence.getSystemPresenceEntries({ ...presence, showNotchStatus: isDesktopMac })
  ]
  const showAdvanced = !isSearching || matchesSettingsSearch(searchQuery, advancedEntries)
  const languageTitle = t('settings.appearance.language.title', 'Language')

  return (
    <>
      <SearchableSetting
        title={themeLabel}
        description={themeEntry?.description}
        keywords={themeEntry?.keywords ?? ['dark', 'light', 'system']}
        forceVisible={forceVisiblePrimary}
      >
        <SettingsRow
          label={themeLabel}
          control={
            <AppearanceThemeControl
              label={themeLabel}
              settings={settings}
              updateSettings={updateSettings}
              applyTheme={applyTheme}
            />
          }
        />
      </SearchableSetting>

      {themeSlots.map((slot) => (
        <SearchableSetting
          key={slot.base}
          title={slot.title}
          description={t(
            'auto.components.settings.AppearanceInterfaceSection.themeSlot.description',
            'App colors for this mode.'
          )}
          keywords={[
            'plugin',
            'theme',
            'terminal',
            slot.base,
            ...translateSearchKeyword(
              'auto.components.settings.appearance.search.matchTerminal',
              'match terminal',
              undefined,
              t
            )
          ]}
          forceVisible={forceVisiblePrimary}
        >
          <SettingsRow
            label={slot.title}
            control={
              <AppearanceThemeSlotSelect
                base={slot.base}
                label={slot.title}
                settings={settings}
                updateSettings={updateSettings}
              />
            }
          />
        </SearchableSetting>
      ))}

      {editorThemeSlots.map((slot) => (
        <SearchableSetting
          key={slot.base}
          // The light row comes first, so it stands for both editor theme rows.
          id={slot.base === 'light' ? APPEARANCE_EDITOR_THEME_SETTING_ID : undefined}
          title={slot.title}
          description={editorThemeEntry?.description}
          keywords={editorThemeEntry?.keywords ?? []}
          forceVisible={forceVisiblePrimary}
        >
          <SettingsRow
            label={slot.title}
            description={slot.description}
            control={
              <CodeEditorThemeSelect
                base={slot.base}
                label={slot.title}
                settings={settings}
                updateSettings={updateSettings}
              />
            }
          />
        </SearchableSetting>
      ))}

      {pluginIconThemes.length > 0 ? (
        <SearchableSetting
          title={iconThemeTitle}
          description={t(
            'auto.components.settings.AppearanceInterfaceSection.pluginIconTheme.description',
            'File and folder icons from an enabled plugin.'
          )}
          keywords={['plugin', 'icon', 'file', 'folder']}
          forceVisible={forceVisiblePrimary}
        >
          <SettingsRow
            label={iconThemeTitle}
            control={
              <SettingsSearchableSelect
                ariaLabel={iconThemeTitle}
                value={
                  pluginIconThemes.find((theme) => theme.id === settings.pluginIconTheme)?.id ??
                  'built-in'
                }
                onValueChange={(value) =>
                  updateSettings({
                    pluginIconTheme:
                      pluginIconThemes.find((theme) => theme.id === value)?.id ?? null
                  })
                }
                searchPlaceholder={t(
                  'auto.components.settings.AppearanceInterfaceSection.pluginIconTheme.search',
                  'Search icon themes…'
                )}
                groups={[
                  {
                    key: 'icon-themes',
                    options: [
                      { value: 'built-in', label: iconThemes.builtIn },
                      ...pluginIconThemes.map((theme) => ({
                        value: theme.id,
                        label: iconThemes.labels.get(theme.id) ?? theme.label
                      }))
                    ]
                  }
                ]}
              />
            }
          />
        </SearchableSetting>
      ) : null}

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
              <SettingsSearchableSelect
                ariaLabel={languageTitle}
                value={settings.uiLanguage}
                groups={[{ key: 'ui-languages', options: languageOptions }]}
                onValueChange={(value) => updateSettings({ uiLanguage: value as UiLanguage })}
                searchPlaceholder={t(
                  'auto.components.settings.SettingsSearchableSelect.searchLanguages',
                  'Search languages…'
                )}
              />
            }
          />
        </SearchableSetting>
      ) : null}

      <SearchableSetting
        title={t('auto.components.settings.AppearancePane.173edfb768', 'UI zoom')}
        description={zoomEntry?.description}
        keywords={zoomEntry?.keywords ?? ['zoom', 'scale', 'shortcut']}
        forceVisible={forceVisiblePrimary}
      >
        <SettingsRow
          label={t('auto.components.settings.AppearancePane.173edfb768', 'UI zoom')}
          // Explain the shortcut and terminal exception; the zoom buttons already explain scaling.
          description={
            <>
              <ShortcutHintList combos={zoomInKeyCombos} /> /{' '}
              <ShortcutHintList combos={zoomOutKeyCombos} />{' '}
              {t(
                'auto.components.settings.AppearancePane.ef89200c1f',
                'when not in a terminal pane.'
              )}
            </>
          }
          control={<UIZoomControl />}
        />
      </SearchableSetting>

      <SearchableSetting
        title={t('auto.components.settings.AppearancePane.657a7230a2', 'IDE font')}
        description={typographyEntry?.description}
        keywords={typographyEntry?.keywords ?? ['font', 'typeface', 'typography']}
        forceVisible={forceVisiblePrimary}
      >
        <SettingsRow
          label={t('auto.components.settings.AppearancePane.657a7230a2', 'IDE font')}
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
        <SettingsGroupDisclosure>
          <SearchableSetting
            title={t('auto.components.settings.AppearancePane.8063dd3b6b', 'Titlebar app name')}
            description={titlebarEntry?.description}
            keywords={titlebarEntry?.keywords ?? ['titlebar', 'orca', 'app', 'name']}
          >
            <SettingsSwitchRow
              label={t('auto.components.settings.AppearancePane.8063dd3b6b', 'Titlebar app name')}
              checked={settings.showTitlebarAppName}
              onChange={() =>
                updateSettings({ showTitlebarAppName: !settings.showTitlebarAppName })
              }
            />
          </SearchableSetting>

          <ReduceVisualEffectsSetting
            entry={reduceVisualEffectsEntry}
            enabled={settings.reduceVisualEffects === true}
            updateSettings={updateSettings}
          />

          {isDesktopWindows ? (
            <SearchableSetting
              title={t(
                'auto.components.settings.AppearancePane.95a5581f66',
                'Minimize to tray on close'
              )}
              description={systemTrayEntry?.description}
              keywords={systemTrayEntry?.keywords ?? ['tray', 'minimize', 'close']}
            >
              <SettingsSwitchRow
                label={t(
                  'auto.components.settings.AppearancePane.95a5581f66',
                  'Minimize to tray on close'
                )}
                // Explain the non-obvious platform restriction and keep-running consequence.
                description={t(
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
              title={t('settings.appearance.menuBarIcon.026624e2ec', 'Show menu bar icon')}
              description={menuBarIconEntry?.description}
              keywords={menuBarIconEntry?.keywords ?? ['menu bar', 'status item', 'activity']}
            >
              <SettingsSwitchRow
                label={t('settings.appearance.menuBarIcon.026624e2ec', 'Show menu bar icon')}
                // Hiding the status item preserves Dock activation and close-keeps-running behavior.
                description={t(
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

          <NotchStatusSetting settings={settings} updateSettings={updateSettings} />
        </SettingsGroupDisclosure>
      ) : null}
    </>
  )
}
