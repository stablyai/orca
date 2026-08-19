import type React from 'react'
import { useLayoutEffect, useState } from 'react'
import { AppWindow, ImageIcon, PanelLeft, TerminalSquare } from 'lucide-react'

import type { GlobalSettings } from '../../../../shared/global-settings-types'

import { AppearanceSection } from './AppearanceSection'
import { AppearanceInterfaceSection } from './AppearanceInterfaceSection'
import { AppearanceWindowSidebarSection } from './AppearanceWindowSidebarSection'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch, normalizeSettingsSearchQuery } from './settings-search'
import { useAppStore } from '../../store'
import { USAGE_PERCENTAGE_DISPLAY_SETTING_ID } from './appearance-usage-percentage-search'
import {
  getAppIconEntries,
  getAppearancePaneSearchEntries,
  getLanguageEntries,
  getLayoutEntries,
  getMenuBarIconEntries,
  getSidebarEntries,
  getStatusBarEntries,
  getSystemTrayEntries,
  getThemeEntries,
  getTitlebarEntries,
  getTypographyEntries,
  getZoomEntries
} from './appearance-search'
import { getTerminalAppearanceSearchEntries } from './terminal-search'
import { TerminalAppearanceSection } from './TerminalAppearanceSection'
import { getInitialTerminalThemeTarget, type TerminalThemeTarget } from './TerminalThemeSections'
import { useGhosttyImport } from './useGhosttyImport'
import { useWarpThemeImport } from './useWarpThemeImport'
import { AppIconSelector } from './AppIconSelector'
import { AppearancePreviewColumn } from './AppearancePreviewColumn'
import { AppearanceSaveBar } from './AppearanceSaveBar'
import { AppearanceBackgroundSection } from './AppearanceBackgroundSection'
import { getAppearanceBackgroundSearchEntry } from './appearance-background-section-model'
import { normalizeAppIconId } from '../../../../shared/app-icon'
import { getRendererAppPlatform } from '@/lib/renderer-app-platform'
import { isWebClientLocation } from '@/lib/web-client-location'
import { SHOW_UI_LANGUAGE_SETTING } from '@/i18n/supported-languages'
import { translate } from '@/i18n/i18n'
import {
  getLeftSidebarAppearanceEntry,
  getWorkspaceCardLayoutEntry
} from './appearance-sidebar-search'
import { resolveInterfaceSectionSummary } from './appearance-interface-summary'
export { getAppearancePaneSearchEntries }

type AppearancePaneProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  changeCount: number
  saving: boolean
  saveFailed: boolean
  saveChanges: () => Promise<boolean>
  discardChanges: () => void
  fontSuggestions: string[]
  terminalFontSuggestions: string[]
  onRequestFontSuggestions?: () => void
  systemPrefersDark: boolean
}

type AppearanceSectionKey = 'interface' | 'terminal' | 'window' | 'background'

const ALL_APPEARANCE_SECTIONS = [
  'interface',
  'terminal',
  'window',
  'background'
] as const satisfies readonly AppearanceSectionKey[]

export function AppearancePane({
  settings,
  updateSettings,
  changeCount,
  saving,
  saveFailed,
  saveChanges,
  discardChanges,
  fontSuggestions,
  terminalFontSuggestions,
  onRequestFontSuggestions,
  systemPrefersDark
}: AppearancePaneProps): React.JSX.Element {
  const searchQuery = useAppStore((state) => state.settingsSearchQuery)
  const appearanceAccordionDeepLink = useAppStore((state) => state.appearanceAccordionDeepLink)
  const clearAppearanceAccordionDeepLink = useAppStore(
    (state) => state.clearAppearanceAccordionDeepLink
  )
  const isSearching = normalizeSettingsSearchQuery(searchQuery).length > 0
  const isWebClient = isWebClientLocation()
  // Why: the system tray behavior is desktop-Electron Windows-only; a Windows
  // browser web client has no local tray to control.
  const isDesktopWindows = getRendererAppPlatform() === 'win32' && !isWebClient
  const isDesktopMac = getRendererAppPlatform() === 'darwin' && !isWebClient
  const ghostty = useGhosttyImport(updateSettings, settings)
  const warpThemes = useWarpThemeImport(updateSettings, settings)
  const [terminalPreviewMode, setTerminalPreviewMode] = useState<TerminalThemeTarget>(() =>
    getInitialTerminalThemeTarget(settings, systemPrefersDark)
  )
  const [previewFontFamily, setPreviewFontFamily] = useState<string | null>(null)

  // Why: Terminal / Window settings were too easy to miss when only Interface
  // started open; keep sections independently collapsible but expanded by default.
  const [openSections, setOpenSections] = useState<ReadonlySet<AppearanceSectionKey>>(
    () => new Set(ALL_APPEARANCE_SECTIONS)
  )

  // Why: nested deep links (e.g. Usage percentages) land under Window & Sidebar;
  // expand that section before Settings scrolls so the row is actually visible.
  useLayoutEffect(() => {
    if (!appearanceAccordionDeepLink) {
      return
    }
    setOpenSections((current) => {
      if (current.has(appearanceAccordionDeepLink)) {
        return current
      }
      const next = new Set(current)
      next.add(appearanceAccordionDeepLink)
      return next
    })
    clearAppearanceAccordionDeepLink()
    // Why: expand is layout-synchronous; scroll on the next frame so the target
    // has non-zero height when Settings (or this fallback) scrolls.
    const frameId = requestAnimationFrame(() => {
      document
        .getElementById(USAGE_PERCENTAGE_DISPLAY_SETTING_ID)
        ?.scrollIntoView({ block: 'nearest' })
    })
    return () => {
      cancelAnimationFrame(frameId)
    }
  }, [appearanceAccordionDeepLink, clearAppearanceAccordionDeepLink])
  const interfaceTitle = translate(
    'auto.components.settings.AppearancePane.interfaceTitle',
    'Interface'
  )
  const terminalTitle = translate(
    'auto.components.settings.AppearancePane.terminalTitle',
    'Terminal'
  )
  const windowSidebarTitle = translate(
    'auto.components.settings.AppearancePane.windowSidebarTitle',
    'Window & Sidebar'
  )
  const windowSidebarSummary = translate(
    'auto.components.settings.AppearancePane.windowSidebarSummary',
    'Sidebar, status bar, and file explorer'
  )
  const backgroundEntry = getAppearanceBackgroundSearchEntry()
  const backgroundSummary = translate(
    'auto.components.settings.AppearancePane.backgroundSummary',
    'Images, opacity, blur, and fit'
  )

  // Search-entry buckets per section so a query can force-open the matching one.
  const interfaceSearchEntries = [
    { title: interfaceTitle },
    ...getThemeEntries(),
    ...getZoomEntries(),
    ...getTypographyEntries(),
    ...(SHOW_UI_LANGUAGE_SETTING ? getLanguageEntries() : []),
    ...getTitlebarEntries(),
    ...getSystemTrayEntries({ showSystemTray: isDesktopWindows }),
    ...getMenuBarIconEntries({ showMenuBarIcon: isDesktopMac })
  ]
  const terminalSearchEntries = [
    { title: terminalTitle },
    ...getTerminalAppearanceSearchEntries({ showWarpImport: !isWebClient })
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
  const backgroundMatches = !isWebClient && matchesSettingsSearch(searchQuery, backgroundEntry)
  const interfaceLabelMatches = matchesSettingsSearch(searchQuery, { title: interfaceTitle })
  const terminalLabelMatches = matchesSettingsSearch(searchQuery, { title: terminalTitle })
  const windowLabelMatches = matchesSettingsSearch(searchQuery, {
    title: windowSidebarTitle,
    description: windowSidebarSummary
  })
  const appIconMatches = matchesSettingsSearch(searchQuery, getAppIconEntries())

  // While searching, force-open every section that contains a match so its
  // controls (including advanced ones) are revealed; otherwise use the user's
  // independent open/closed state (all expanded by default).
  function isSectionOpen(key: AppearanceSectionKey): boolean {
    if (isSearching) {
      if (key === 'interface') {
        return interfaceMatches
      }
      if (key === 'terminal') {
        return terminalMatches
      }
      if (key === 'window') {
        return windowMatches
      }
      return backgroundMatches
    }
    return openSections.has(key)
  }

  function toggleSection(key: AppearanceSectionKey): void {
    setOpenSections((current) => {
      const next = new Set(current)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  const interfaceSummary = resolveInterfaceSectionSummary(settings)
  const terminalSummary = `${
    settings.terminalFontFamily ||
    translate('auto.components.settings.AppearancePane.terminalDefaultFont', 'Default font')
  } · ${settings.terminalFontSize}px`

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem] lg:items-start xl:grid-cols-[minmax(0,1fr)_20rem]">
      <div className="min-w-0">
        <AppearanceSaveBar
          changeCount={changeCount}
          saving={saving}
          saveFailed={saveFailed}
          onSave={saveChanges}
          onDiscard={discardChanges}
        />
        <div className="space-y-2.5">
          {interfaceMatches ? (
            <AppearanceSection
              id="interface"
              icon={<AppWindow aria-hidden="true" />}
              title={interfaceTitle}
              summary={interfaceSummary}
              open={isSectionOpen('interface')}
              onToggle={() => toggleSection('interface')}
              toggleDisabled={isSearching}
            >
              <AppearanceInterfaceSection
                settings={settings}
                updateSettings={updateSettings}
                fontSuggestions={fontSuggestions}
                onRequestFontSuggestions={onRequestFontSuggestions}
                isDesktopMac={isDesktopMac}
                isDesktopWindows={isDesktopWindows}
                forceVisiblePrimary={interfaceLabelMatches}
              />
            </AppearanceSection>
          ) : null}

          {/* Code & Markdown is omitted because it has no Appearance-level settings. */}

          {terminalMatches ? (
            <AppearanceSection
              id="terminal"
              icon={<TerminalSquare aria-hidden="true" />}
              title={terminalTitle}
              summary={terminalSummary}
              open={isSectionOpen('terminal')}
              onToggle={() => toggleSection('terminal')}
              toggleDisabled={isSearching}
            >
              <TerminalAppearanceSection
                settings={settings}
                updateSettings={updateSettings}
                systemPrefersDark={systemPrefersDark}
                terminalFontSuggestions={terminalFontSuggestions}
                onRequestFontSuggestions={onRequestFontSuggestions}
                ghostty={ghostty}
                warpThemes={warpThemes}
                showPreview={false}
                previewThemeTarget={terminalPreviewMode}
                onPreviewThemeTargetChange={setTerminalPreviewMode}
                onPreviewFontFamilyChange={setPreviewFontFamily}
                hasUnsavedChanges={changeCount > 0}
                forceVisiblePrimary={terminalLabelMatches}
              />
            </AppearanceSection>
          ) : null}

          {windowMatches ? (
            <AppearanceSection
              id="window"
              icon={<PanelLeft aria-hidden="true" />}
              title={windowSidebarTitle}
              summary={windowSidebarSummary}
              open={isSectionOpen('window')}
              onToggle={() => toggleSection('window')}
              toggleDisabled={isSearching}
            >
              <AppearanceWindowSidebarSection
                settings={settings}
                updateSettings={updateSettings}
                forceVisiblePrimary={windowLabelMatches}
              />
            </AppearanceSection>
          ) : null}

          {backgroundMatches ? (
            <AppearanceSection
              id="background"
              icon={<ImageIcon aria-hidden="true" />}
              title={backgroundEntry.title}
              summary={backgroundSummary}
              open={isSectionOpen('background')}
              onToggle={() => toggleSection('background')}
              toggleDisabled={isSearching}
            >
              <AppearanceBackgroundSection settings={settings} updateSettings={updateSettings} />
            </AppearanceSection>
          ) : null}

          {/* App icon stays at the bottom of Appearance as a small easter egg,
          matching production — not buried inside Interface advanced. */}
          {appIconMatches ? (
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
              className="max-w-none px-1 pt-2"
            >
              <AppIconSelector
                value={normalizeAppIconId(settings.appIcon)}
                onChange={(appIcon) => updateSettings({ appIcon })}
              />
            </SearchableSetting>
          ) : null}
        </div>
      </div>
      <AppearancePreviewColumn
        settings={settings}
        systemPrefersDark={systemPrefersDark}
        previewFontFamily={previewFontFamily}
        terminalPreviewMode={terminalPreviewMode}
        onTerminalPreviewModeChange={setTerminalPreviewMode}
      />
    </div>
  )
}
