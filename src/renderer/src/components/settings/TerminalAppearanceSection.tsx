import { useState } from 'react'
import type { GlobalSettings } from '../../../../shared/types'
import {
  matchesSettingsSearch,
  scoreSettingsSearch,
  type SettingsSearchEntry
} from './settings-search'
import { useAppStore } from '../../store'
import {
  getTerminalCursorSearchEntries,
  getTerminalDarkThemeSearchEntries,
  getTerminalGhosttyImportSearchEntries,
  getTerminalLightThemeSearchEntries,
  getTerminalPaneAppearanceSearchEntries,
  getTerminalThemeTargetSearchEntries,
  getTerminalTypographySearchEntries,
  getTerminalWarpImportSearchEntries,
  getTerminalWindowSearchEntries,
  getTerminalYamlImportSearchEntries
} from './terminal-search'
import { TerminalThemeCatalogSection } from './TerminalThemeSections'
import { TerminalWindowSection } from './TerminalWindowSection'
import { TerminalTypographyAppearanceSection } from './TerminalTypographyAppearanceSection'
import { TerminalCursorAppearanceSection } from './TerminalCursorAppearanceSection'
import { TerminalPaneAppearanceSection } from './TerminalPaneAppearanceSection'
import { GhosttyImportModal } from './GhosttyImportModal'
import type { UseGhosttyImportReturn } from './useGhosttyImport'
import { WarpThemeImportModal } from './WarpThemeImportModal'
import type { UseWarpThemeImportReturn } from './useWarpThemeImport'
import { isWebClientLocation } from '@/hooks/useSettingsNavigationMetadata'

type TerminalAppearanceSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  systemPrefersDark: boolean
  terminalFontSuggestions: string[]
  ghostty: UseGhosttyImportReturn
  warpThemes: UseWarpThemeImportReturn
}

type TerminalThemeTarget = 'dark' | 'light'

function scoreThemeTargetIntent(searchQuery: string, entries: SettingsSearchEntry[]): number {
  // Why: descriptions mention dark/light incidentally; target intent should come from labels and aliases.
  return scoreSettingsSearch(
    searchQuery,
    entries.map(({ title, keywords }) => ({ title, keywords }))
  )
}

function getPreferredThemeTarget(
  darkThemeSearchScore: number,
  lightThemeSearchScore: number
): TerminalThemeTarget | undefined {
  if (darkThemeSearchScore === lightThemeSearchScore) {
    return undefined
  }
  return darkThemeSearchScore > lightThemeSearchScore ? 'dark' : 'light'
}

export function TerminalAppearanceSection({
  settings,
  updateSettings,
  systemPrefersDark,
  terminalFontSuggestions,
  ghostty,
  warpThemes
}: TerminalAppearanceSectionProps): React.JSX.Element {
  const searchQuery = useAppStore((state) => state.settingsSearchQuery)
  const [themeSearch, setThemeSearch] = useState('')
  const [previewFontFamily, setPreviewFontFamily] = useState<string | null>(null)
  const showWarpThemeImport = !isWebClientLocation()
  const darkThemeSearchEntries = getTerminalDarkThemeSearchEntries()
  const lightThemeSearchEntries = getTerminalLightThemeSearchEntries()
  const darkThemeSearchScore = scoreSettingsSearch(searchQuery, darkThemeSearchEntries)
  const lightThemeSearchScore = scoreSettingsSearch(searchQuery, lightThemeSearchEntries)
  const darkThemeTargetScore = scoreThemeTargetIntent(searchQuery, darkThemeSearchEntries)
  const lightThemeTargetScore = scoreThemeTargetIntent(searchQuery, lightThemeSearchEntries)
  const darkThemeMatches = darkThemeSearchScore > 0
  const lightThemeMatches = lightThemeSearchScore > 0
  const themeTargetMatches = matchesSettingsSearch(
    searchQuery,
    getTerminalThemeTargetSearchEntries()
  )
  const themeImportMatches =
    showWarpThemeImport &&
    (matchesSettingsSearch(searchQuery, getTerminalWarpImportSearchEntries()) ||
      matchesSettingsSearch(searchQuery, getTerminalYamlImportSearchEntries()))
  const showTerminalThemeCatalog =
    darkThemeMatches || lightThemeMatches || themeTargetMatches || themeImportMatches
  const preferredThemeTarget = getPreferredThemeTarget(darkThemeTargetScore, lightThemeTargetScore)

  const visibleSections = [
    matchesSettingsSearch(searchQuery, getTerminalGhosttyImportSearchEntries()) ||
    matchesSettingsSearch(searchQuery, getTerminalTypographySearchEntries()) ? (
      <TerminalTypographyAppearanceSection
        key="typography"
        settings={settings}
        updateSettings={updateSettings}
        systemPrefersDark={systemPrefersDark}
        terminalFontSuggestions={terminalFontSuggestions}
        ghostty={ghostty}
        previewFontFamily={previewFontFamily}
        setPreviewFontFamily={setPreviewFontFamily}
      />
    ) : null,
    matchesSettingsSearch(searchQuery, getTerminalCursorSearchEntries()) ? (
      <TerminalCursorAppearanceSection
        key="cursor"
        settings={settings}
        updateSettings={updateSettings}
      />
    ) : null,
    matchesSettingsSearch(searchQuery, getTerminalPaneAppearanceSearchEntries()) ? (
      <TerminalPaneAppearanceSection
        key="pane-appearance"
        settings={settings}
        updateSettings={updateSettings}
      />
    ) : null,
    matchesSettingsSearch(searchQuery, getTerminalWindowSearchEntries()) ? (
      <TerminalWindowSection key="window" settings={settings} updateSettings={updateSettings} />
    ) : null,
    showTerminalThemeCatalog ? (
      <TerminalThemeCatalogSection
        key={`theme-catalog-${preferredThemeTarget ?? 'manual'}`}
        settings={settings}
        systemPrefersDark={systemPrefersDark}
        themeSearch={themeSearch}
        setThemeSearch={setThemeSearch}
        updateSettings={updateSettings}
        previewFontFamily={previewFontFamily}
        importedHighlightSignal={warpThemes.importSignal}
        warpThemes={warpThemes}
        showThemeImport={showWarpThemeImport}
        preferredTarget={preferredThemeTarget}
      />
    ) : null
  ].filter(Boolean)

  return (
    <div className="space-y-6">
      {visibleSections.map((section, index) => (
        <div key={index} className="space-y-6">
          {index > 0 ? <div className="h-px bg-border/60" /> : null}
          {section}
        </div>
      ))}
      <GhosttyImportModal
        open={ghostty.open}
        onOpenChange={ghostty.handleOpenChange}
        preview={ghostty.preview}
        loading={ghostty.loading}
        onApply={ghostty.handleApply}
        applied={ghostty.applied}
        applyError={ghostty.applyError}
      />
      {showWarpThemeImport ? (
        <WarpThemeImportModal
          open={warpThemes.open}
          mode={warpThemes.mode}
          preview={warpThemes.preview}
          loading={warpThemes.loading}
          desktopOnly={warpThemes.desktopOnly}
          applyError={warpThemes.applyError}
          selectedThemeIds={warpThemes.selectedThemeIds}
          handlePreviewSource={warpThemes.handlePreviewSource}
          handleToggleTheme={warpThemes.handleToggleTheme}
          handleToggleAll={warpThemes.handleToggleAll}
          handleApply={warpThemes.handleApply}
          handleOpenChange={warpThemes.handleOpenChange}
        />
      ) : null}
    </div>
  )
}
