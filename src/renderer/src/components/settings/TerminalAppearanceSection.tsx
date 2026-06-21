import { useState } from 'react'
import type { GlobalSettings } from '../../../../shared/types'
import { matchesSettingsSearch } from './settings-search'
import { useAppStore } from '../../store'
import {
  getTerminalCursorSearchEntries,
  getTerminalDarkThemeSearchEntries,
  getTerminalGhosttyImportSearchEntries,
  getTerminalLightThemeSearchEntries,
  getTerminalPaneAppearanceSearchEntries,
  getTerminalTypographySearchEntries,
  getTerminalWarpImportSearchEntries,
  getTerminalWindowSearchEntries,
  getTerminalYamlImportSearchEntries
} from './terminal-search'
import {
  DarkTerminalThemeSection,
  LightTerminalThemeSection,
  TerminalThemeImportSection
} from './TerminalThemeSections'
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

export function TerminalAppearanceSection({
  settings,
  updateSettings,
  systemPrefersDark,
  terminalFontSuggestions,
  ghostty,
  warpThemes
}: TerminalAppearanceSectionProps): React.JSX.Element {
  const searchQuery = useAppStore((state) => state.settingsSearchQuery)
  const [themeSearchDark, setThemeSearchDark] = useState('')
  const [themeSearchLight, setThemeSearchLight] = useState('')
  const [previewFontFamily, setPreviewFontFamily] = useState<string | null>(null)
  const showWarpThemeImport = !isWebClientLocation()

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
    showWarpThemeImport &&
    (matchesSettingsSearch(searchQuery, getTerminalWarpImportSearchEntries()) ||
      matchesSettingsSearch(searchQuery, getTerminalYamlImportSearchEntries())) ? (
      <TerminalThemeImportSection key="theme-import" warpThemes={warpThemes} />
    ) : null,
    matchesSettingsSearch(searchQuery, getTerminalDarkThemeSearchEntries()) ? (
      <DarkTerminalThemeSection
        key="dark-theme"
        settings={settings}
        systemPrefersDark={systemPrefersDark}
        themeSearchDark={themeSearchDark}
        setThemeSearchDark={setThemeSearchDark}
        updateSettings={updateSettings}
        previewFontFamily={previewFontFamily}
        importedHighlightSignal={warpThemes.importSignal}
      />
    ) : null,
    matchesSettingsSearch(searchQuery, getTerminalLightThemeSearchEntries()) ? (
      <LightTerminalThemeSection
        key="light-theme"
        settings={settings}
        themeSearchLight={themeSearchLight}
        setThemeSearchLight={setThemeSearchLight}
        updateSettings={updateSettings}
        previewFontFamily={previewFontFamily}
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
