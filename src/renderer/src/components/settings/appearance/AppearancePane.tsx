import type React from 'react'
import { useLayoutEffect } from 'react'

import type { GlobalSettings } from '../../../../../shared/global-settings-types'

import { AppearanceInterfaceSection } from './AppearanceInterfaceSection'
import { AppearanceWindowSidebarSection } from './AppearanceWindowSidebarSection'
import { SearchableSetting } from '../section-layout/SearchableSetting'
import { SettingsGroup } from '../section-layout/SettingsGroup'
import { matchesSettingsSearch } from '../search/settings-search'
import { useAppStore } from '../../../store/index'
import { USAGE_PERCENTAGE_DISPLAY_SETTING_ID } from './appearance-usage-percentage-search'
import { getAppIconEntries } from './appearance-app-icon-search'
import {
  getCodeEditorThemeEntries,
  getLanguageEntries,
  getLayoutEntries,
  getStatusBarEntries,
  getThemeEntries,
  getTitlebarEntries,
  getTypographyEntries,
  getZoomEntries
} from './appearance-search'
import { getMenuBarIconEntries, getSystemTrayEntries } from './appearance-system-presence-search'
import {
  getSidebarEntries,
  getLeftSidebarAppearanceEntry,
  getWorkspaceCardLayoutEntry
} from './appearance-sidebar-search'
import { getReduceVisualEffectsEntries } from './appearance-reduce-visual-effects-search'
import { getTerminalAppearanceSearchEntries } from '../terminal/terminal-search'
import { TerminalAppearanceSection } from '../terminal/appearance/TerminalAppearanceSection'
import type { UseTerminalConfigImportReturn } from '../terminal/configuration/useTerminalConfigImport'
import type { UseWarpThemeImportReturn } from '../terminal/themes/useWarpThemeImport'
import { AppIconSelector } from './AppIconSelector'
import { normalizeAppIconId } from '../../../../../shared/app-icon'
import { getRendererAppPlatform } from '@/app-shell/platform/renderer-app-platform'
import { isWebClientLocation } from '@/app-shell/platform/web-client-location'
import { SHOW_UI_LANGUAGE_SETTING } from '@/i18n/supported-languages'
import { useTranslate } from '@/i18n/use-translate'

type AppearancePaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  applyTheme: (theme: 'system' | 'dark' | 'light') => void
  fontSuggestions: string[]
  terminalFontSuggestions: string[]
  onRequestFontSuggestions?: () => void
  systemPrefersDark: boolean
  terminalConfigImport: UseTerminalConfigImportReturn
  warpThemes: UseWarpThemeImportReturn
}

export function AppearancePane({
  settings,
  updateSettings,
  applyTheme,
  fontSuggestions,
  terminalFontSuggestions,
  onRequestFontSuggestions,
  systemPrefersDark,
  terminalConfigImport,
  warpThemes
}: AppearancePaneProps): React.JSX.Element {
  const t = useTranslate()
  const searchQuery = useAppStore((state) => state.settingsSearchQuery)
  const appearanceAccordionDeepLink = useAppStore((state) => state.appearanceAccordionDeepLink)
  const clearAppearanceAccordionDeepLink = useAppStore(
    (state) => state.clearAppearanceAccordionDeepLink
  )
  const isWebClient = isWebClientLocation()
  // Windows web clients have no local system tray; require desktop Electron.
  const isDesktopWindows = getRendererAppPlatform() === 'win32' && !isWebClient
  const isDesktopMac = getRendererAppPlatform() === 'darwin' && !isWebClient

  useLayoutEffect(() => {
    if (!appearanceAccordionDeepLink) {
      return
    }
    clearAppearanceAccordionDeepLink()
    const frameId = requestAnimationFrame(() => {
      document
        .getElementById(USAGE_PERCENTAGE_DISPLAY_SETTING_ID)
        ?.scrollIntoView({ block: 'nearest' })
    })
    return () => {
      cancelAnimationFrame(frameId)
    }
  }, [appearanceAccordionDeepLink, clearAppearanceAccordionDeepLink])
  const interfaceTitle = t('auto.components.settings.AppearancePane.interfaceTitle', 'Interface')
  const terminalTitle = t('auto.components.settings.AppearancePane.terminalTitle', 'Terminal')
  const windowSidebarTitle = t(
    'auto.components.settings.AppearancePane.e90c5d745a',
    'Window & sidebar'
  )
  const windowSidebarSummary = t(
    'auto.components.settings.AppearancePane.windowSidebarSummary',
    'Sidebar, status bar, and file explorer'
  )

  const interfaceSearchEntries = [
    { title: interfaceTitle },
    ...getThemeEntries(),
    ...getCodeEditorThemeEntries(),
    ...getZoomEntries(),
    ...getTypographyEntries(),
    ...(SHOW_UI_LANGUAGE_SETTING ? getLanguageEntries() : []),
    ...getTitlebarEntries(),
    ...getReduceVisualEffectsEntries(),
    ...getSystemTrayEntries({ showSystemTray: isDesktopWindows }),
    ...getMenuBarIconEntries({ showMenuBarIcon: isDesktopMac })
  ]
  const terminalSearchEntries = [
    { title: terminalTitle },
    ...getTerminalAppearanceSearchEntries({
      showDesktopThemeImports: !isWebClient
    })
  ]
  const windowSearchEntries = [
    {
      title: windowSidebarTitle,
      description: windowSidebarSummary
    },
    ...getStatusBarEntries(),
    ...getSidebarEntries(),
    ...getLayoutEntries(),
    getLeftSidebarAppearanceEntry(),
    getWorkspaceCardLayoutEntry()
  ]

  const interfaceMatches = matchesSettingsSearch(searchQuery, interfaceSearchEntries)
  const terminalMatches = matchesSettingsSearch(searchQuery, terminalSearchEntries)
  const windowMatches = matchesSettingsSearch(searchQuery, windowSearchEntries)
  const interfaceLabelMatches = matchesSettingsSearch(searchQuery, { title: interfaceTitle })
  const terminalLabelMatches = matchesSettingsSearch(searchQuery, { title: terminalTitle })
  const windowLabelMatches = matchesSettingsSearch(searchQuery, {
    title: windowSidebarTitle,
    description: windowSidebarSummary
  })
  const appIconMatches = matchesSettingsSearch(searchQuery, getAppIconEntries())

  return (
    <>
      {interfaceMatches ? (
        <SettingsGroup title={interfaceTitle}>
          <AppearanceInterfaceSection
            settings={settings}
            updateSettings={updateSettings}
            applyTheme={applyTheme}
            fontSuggestions={fontSuggestions}
            onRequestFontSuggestions={onRequestFontSuggestions}
            isDesktopMac={isDesktopMac}
            isDesktopWindows={isDesktopWindows}
            forceVisiblePrimary={interfaceLabelMatches}
          />
        </SettingsGroup>
      ) : null}

      {terminalMatches ? (
        <SettingsGroup title={terminalTitle}>
          <TerminalAppearanceSection
            settings={settings}
            updateSettings={updateSettings}
            systemPrefersDark={systemPrefersDark}
            terminalFontSuggestions={terminalFontSuggestions}
            onRequestFontSuggestions={onRequestFontSuggestions}
            terminalConfigImport={terminalConfigImport}
            warpThemes={warpThemes}
            forceVisiblePrimary={terminalLabelMatches}
          />
        </SettingsGroup>
      ) : null}

      {windowMatches ? (
        <SettingsGroup title={windowSidebarTitle}>
          <AppearanceWindowSidebarSection
            settings={settings}
            updateSettings={updateSettings}
            forceVisiblePrimary={windowLabelMatches}
          />
        </SettingsGroup>
      ) : null}

      {/* Keep the App Icon easter egg at the bottom instead of inside Interface advanced. */}
      {appIconMatches ? (
        <SettingsGroup>
          <SearchableSetting
            title={t('auto.components.settings.AppearancePane.907888cd09', 'App icon')}
            description={t(
              'auto.components.settings.AppearancePane.0cd9b8228f',
              'Choose the app icon shown in the Dock and window switcher.'
            )}
            keywords={getAppIconEntries().flatMap((entry) => [
              entry.title,
              entry.description ?? '',
              ...(entry.keywords ?? [])
            ])}
            className="py-4"
          >
            <AppIconSelector
              value={normalizeAppIconId(settings.appIcon)}
              onChange={(appIcon) => updateSettings({ appIcon })}
            />
          </SearchableSetting>
        </SettingsGroup>
      ) : null}
    </>
  )
}
