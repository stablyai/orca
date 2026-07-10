import { useState } from 'react'
import type { GlobalSettings } from '../../../../shared/types'
import {
  matchesSettingsSearch,
  normalizeSettingsSearchQuery,
  scoreSettingsSearch,
  type SettingsSearchEntry
} from './settings-search'
import { useAppStore } from '../../store'
import {
  getTerminalAdvancedTypographySearchEntries,
  getTerminalCursorSearchEntries,
  getTerminalDarkThemeSearchEntries,
  getTerminalGhosttyImportSearchEntries,
  getTerminalLightThemeSearchEntries,
  getTerminalPaneAppearanceSearchEntries,
  getTerminalThemeTargetSearchEntries,
  getTerminalWarpImportSearchEntries,
  getTerminalYamlImportSearchEntries,
  getTerminalTypographySearchEntries,
  getTerminalWindowSearchEntries
} from './terminal-search'
import { Button } from '../ui/button'
import { SettingsRow, SettingsSubsectionHeader } from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'
import { FontAutocomplete } from './SettingsFormControls'
import { TerminalFontSizeSetting } from './TerminalFontSizeSetting'
import { TerminalAdvancedTypographyControls } from './TerminalAdvancedTypographyControls'
import { TerminalThemeCatalogSection } from './TerminalThemeSections'
import { TerminalWindowSection } from './TerminalWindowSection'
import { TerminalCursorAppearanceSection } from './TerminalCursorAppearanceSection'
import { TerminalPaneAppearanceSection } from './TerminalPaneAppearanceSection'
import { AppearanceAdvancedDisclosure } from './AppearanceAdvancedDisclosure'
import { GhosttyImportModal } from './GhosttyImportModal'
import type { UseGhosttyImportReturn } from './useGhosttyImport'
import { WarpThemeImportModal } from './WarpThemeImportModal'
import type { UseWarpThemeImportReturn } from './useWarpThemeImport'
import { isWebClientLocation } from '@/hooks/useSettingsNavigationMetadata'
import ghosttyIcon from '../../../../../resources/ghostty.svg'
import { translate } from '@/i18n/i18n'

type TerminalAppearanceSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  systemPrefersDark: boolean
  terminalFontSuggestions: string[]
  onRequestFontSuggestions?: () => void
  ghostty: UseGhosttyImportReturn
  warpThemes: UseWarpThemeImportReturn
  forceVisiblePrimary?: boolean
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
  onRequestFontSuggestions,
  ghostty,
  warpThemes,
  forceVisiblePrimary = false
}: TerminalAppearanceSectionProps): React.JSX.Element {
  const searchQuery = useAppStore((state) => state.settingsSearchQuery)
  const isSearching = normalizeSettingsSearchQuery(searchQuery).length > 0
  const [themeSearch, setThemeSearch] = useState('')
  const [previewFontFamily, setPreviewFontFamily] = useState<string | null>(null)
  const showWarpThemeImport = !isWebClientLocation()
  const darkThemeSearchEntries = getTerminalDarkThemeSearchEntries()
  const lightThemeSearchEntries = getTerminalLightThemeSearchEntries()
  const terminalTypographyEntries = getTerminalTypographySearchEntries()
  const ghosttyImportEntries = getTerminalGhosttyImportSearchEntries()
  const themeCatalogSearchEntries = [
    ...getTerminalThemeTargetSearchEntries(),
    ...darkThemeSearchEntries,
    ...lightThemeSearchEntries,
    ...(showWarpThemeImport
      ? [...getTerminalWarpImportSearchEntries(), ...getTerminalYamlImportSearchEntries()]
      : [])
  ]
  const darkThemeTargetScore = scoreThemeTargetIntent(searchQuery, darkThemeSearchEntries)
  const lightThemeTargetScore = scoreThemeTargetIntent(searchQuery, lightThemeSearchEntries)
  const preferredThemeTarget = getPreferredThemeTarget(darkThemeTargetScore, lightThemeTargetScore)

  // Why: low-frequency knobs are force-opened during search; render each group
  // only when its own search matches so an active query never leaves a dangling header.
  const typographyMatches = matchesSettingsSearch(
    searchQuery,
    getTerminalAdvancedTypographySearchEntries()
  )
  const cursorMatches = matchesSettingsSearch(searchQuery, getTerminalCursorSearchEntries())
  const paneMatches = matchesSettingsSearch(searchQuery, getTerminalPaneAppearanceSearchEntries())
  const windowMatches = matchesSettingsSearch(searchQuery, getTerminalWindowSearchEntries())
  const themeCatalogMatches = matchesSettingsSearch(searchQuery, themeCatalogSearchEntries)
  const previewAdvancedMatches = cursorMatches || paneMatches || windowMatches
  const showThemeCatalog = !isSearching || themeCatalogMatches || previewAdvancedMatches
  const primaryTypographyMatches = matchesSettingsSearch(
    searchQuery,
    terminalTypographyEntries.slice(0, 2)
  )
  const ghosttyImportMatches = matchesSettingsSearch(searchQuery, ghosttyImportEntries)
  const showPrimaryTypography =
    !isSearching ||
    forceVisiblePrimary ||
    primaryTypographyMatches ||
    typographyMatches ||
    ghosttyImportMatches
  const showGhosttyImport = !isSearching || forceVisiblePrimary || ghosttyImportMatches
  const showTypographyAdvancedDisclosure = !isSearching || typographyMatches

  const advancedGroups = [
    cursorMatches
      ? {
          key: 'cursor',
          node: (
            <TerminalCursorAppearanceSection settings={settings} updateSettings={updateSettings} />
          )
        }
      : null,
    paneMatches
      ? {
          key: 'pane',
          node: (
            <TerminalPaneAppearanceSection settings={settings} updateSettings={updateSettings} />
          )
        }
      : null,
    windowMatches
      ? {
          key: 'window',
          node: <TerminalWindowSection settings={settings} updateSettings={updateSettings} />
        }
      : null
  ].filter((group): group is { key: string; node: React.JSX.Element } => group !== null)
  const showAdvancedDisclosure = !isSearching || advancedGroups.length > 0
  const previewAdvancedContent = showAdvancedDisclosure ? (
    <AppearanceAdvancedDisclosure
      showTopBorder={false}
      className="mt-0 pt-2"
      contentClassName="ml-4 pt-4"
    >
      {advancedGroups.map((group, index) => (
        <div
          key={group.key}
          className={index > 0 ? 'mt-2 border-t border-border/60 pt-4' : undefined}
        >
          {group.node}
        </div>
      ))}
    </AppearanceAdvancedDisclosure>
  ) : null

  return (
    <div className="space-y-5">
      {/* Primary: font + theme + previews. The expanded section column is far
          narrower than the xl breakpoint, so the preview grids inside the
          theme catalog already stack full-width below their controls. */}
      {showPrimaryTypography ? (
        <section className="space-y-3 pt-2">
          <SettingsSubsectionHeader
            className="items-center"
            title={translate(
              'auto.components.settings.TerminalAppearanceSection.048aac8a64',
              'Terminal Typography'
            )}
            action={
              showGhosttyImport ? (
                <Button
                  variant="outline"
                  size="sm"
                  className="gap-1.5"
                  onClick={() => void ghostty.handleClick()}
                >
                  <img src={ghosttyIcon} alt="" aria-hidden="true" className="size-4" />
                  {translate(
                    'auto.components.settings.TerminalAppearanceSection.855a76343a',
                    'Import from Ghostty'
                  )}
                </Button>
              ) : null
            }
          />

          <div className="ml-4 divide-y divide-border/40 border-y border-border/40">
            <TerminalFontSizeSetting
              settings={settings}
              updateSettings={updateSettings}
              forceVisible={forceVisiblePrimary}
            />

            <SearchableSetting
              title={translate(
                'auto.components.settings.TerminalAppearanceSection.a408266e67',
                'Font Family'
              )}
              description={terminalTypographyEntries[1]?.description}
              keywords={
                terminalTypographyEntries[1]?.keywords ?? ['terminal', 'typography', 'font']
              }
              forceVisible={forceVisiblePrimary}
            >
              <SettingsRow
                label={translate(
                  'auto.components.settings.TerminalAppearanceSection.a408266e67',
                  'Font Family'
                )}
                control={
                  <FontAutocomplete
                    value={settings.terminalFontFamily}
                    suggestions={terminalFontSuggestions}
                    onRequestSuggestions={onRequestFontSuggestions}
                    onChange={(value) => updateSettings({ terminalFontFamily: value })}
                    onPreviewFontFamily={setPreviewFontFamily}
                  />
                }
              />
            </SearchableSetting>
          </div>

          {showTypographyAdvancedDisclosure ? (
            <div className="ml-4">
              <AppearanceAdvancedDisclosure showTopBorder={false} contentClassName="ml-4">
                <TerminalAdvancedTypographyControls
                  settings={settings}
                  updateSettings={updateSettings}
                />
              </AppearanceAdvancedDisclosure>
            </div>
          ) : null}
        </section>
      ) : null}

      {showThemeCatalog ? (
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
          advancedContent={previewAdvancedContent}
        />
      ) : null}

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
