import { Cat } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import type { GlobalSettings } from '../../../../../../shared/global-settings-types'
import type { TerminalThemeSlot } from '../../../../../../shared/terminal-themes/terminal-color-overrides'
import {
  matchesSettingsSearch,
  normalizeSettingsSearchQuery,
  scoreSettingsSearch,
  type SettingsSearchEntry
} from '../../search/settings-search'
import { useAppStore } from '../../../../store/index'
import {
  getTerminalAdvancedTypographySearchEntries,
  getTerminalCursorSearchEntries,
  getTerminalTypographySearchEntries
} from './terminal-typography-search'
import {
  getTerminalDarkThemeSearchEntries,
  getTerminalLightThemeSearchEntries,
  getTerminalThemeTargetSearchEntries,
  getTerminalWarpImportSearchEntries,
  getTerminalYamlImportSearchEntries
} from '../themes/terminal-theme-search'
import { getTerminalConfigImportSearchEntries } from '../configuration/terminal-config-import-search'
import { getTerminalPaneAppearanceSearchEntries } from './terminal-pane-appearance-search'
import { getTerminalWindowSearchEntries } from './terminal-window-search'
import { Button } from '../../../ui/button'
import { SettingsRow, SettingsSubsectionHeader } from '../../form-controls/SettingsFormControls'
import { FontAutocomplete } from '../../appearance/fonts/FontAutocomplete'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { TerminalFontSizeSetting } from './TerminalFontSizeSetting'
import { TerminalAdvancedTypographyControls } from './TerminalAdvancedTypographyControls'
import { TerminalThemeCatalogSection } from '../themes/TerminalThemeSections'
import { ClaudeCodeThemeSyncSetting } from '../themes/ClaudeCodeThemeSyncSetting'
import { TerminalWindowSection } from './TerminalWindowSection'
import { TerminalCursorAppearanceSection } from './TerminalCursorAppearanceSection'
import { TerminalPaneAppearanceSection } from './TerminalPaneAppearanceSection'
import { AppearanceAdvancedDisclosure } from '../../appearance/AppearanceAdvancedDisclosure'
import { TerminalConfigImportModal } from '../configuration/TerminalConfigImportModal'
import type { UseTerminalConfigImportReturn } from '../configuration/useTerminalConfigImport'
import { WarpThemeImportModal } from '../themes/WarpThemeImportModal'
import type { UseWarpThemeImportReturn } from '../themes/useWarpThemeImport'
import { isWebClientLocation } from '@/lib/web-client-location'
import ghosttyIcon from '../../../../../../../resources/ghostty.svg'
import { useTranslate } from '@/i18n/use-translate'

type TerminalAppearanceSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  systemPrefersDark: boolean
  terminalFontSuggestions: string[]
  onRequestFontSuggestions?: () => void
  terminalConfigImport: UseTerminalConfigImportReturn
  warpThemes: UseWarpThemeImportReturn
  forceVisiblePrimary?: boolean
}

function scoreThemeTargetIntent(searchQuery: string, entries: SettingsSearchEntry[]): number {
  // Infer dark/light target from labels/aliases, not incidental description mentions.
  return scoreSettingsSearch(
    searchQuery,
    entries.map(({ title, keywords }) => ({ title, keywords }))
  )
}

function getPreferredThemeTarget(
  darkThemeSearchScore: number,
  lightThemeSearchScore: number
): TerminalThemeSlot | undefined {
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
  terminalConfigImport,
  warpThemes,
  forceVisiblePrimary = false
}: TerminalAppearanceSectionProps): React.JSX.Element {
  const t = useTranslate()
  const searchQuery = useAppStore((state) => state.settingsSearchQuery)
  const isSearching = normalizeSettingsSearchQuery(searchQuery).length > 0
  const [previewFontFamily, setPreviewFontFamily] = useState<string | null>(null)
  const showDesktopThemeImports = !isWebClientLocation()
  const darkThemeSearchEntries = getTerminalDarkThemeSearchEntries()
  const lightThemeSearchEntries = getTerminalLightThemeSearchEntries()
  const terminalTypographyEntries = getTerminalTypographySearchEntries()
  const configImportEntries = getTerminalConfigImportSearchEntries()
  const themeCatalogSearchEntries = [
    ...getTerminalThemeTargetSearchEntries(),
    ...darkThemeSearchEntries,
    ...lightThemeSearchEntries,
    ...(showDesktopThemeImports
      ? [...getTerminalWarpImportSearchEntries(), ...getTerminalYamlImportSearchEntries()]
      : [])
  ]
  const darkThemeTargetScore = scoreThemeTargetIntent(searchQuery, darkThemeSearchEntries)
  const lightThemeTargetScore = scoreThemeTargetIntent(searchQuery, lightThemeSearchEntries)
  const preferredThemeTarget = getPreferredThemeTarget(darkThemeTargetScore, lightThemeTargetScore)

  // Filter each advanced group independently so search cannot leave empty headers.
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
  const configImportMatches =
    showDesktopThemeImports && matchesSettingsSearch(searchQuery, configImportEntries)
  const showPrimaryTypography =
    !isSearching ||
    forceVisiblePrimary ||
    primaryTypographyMatches ||
    typographyMatches ||
    configImportMatches
  const showConfigImports =
    showDesktopThemeImports && (!isSearching || forceVisiblePrimary || configImportMatches)
  const showTypographyAdvancedDisclosure = !isSearching || typographyMatches

  const advancedGroups = (colorOverrideSlot: TerminalThemeSlot) =>
    [
      cursorMatches
        ? {
            key: 'cursor',
            node: (
              <TerminalCursorAppearanceSection
                settings={settings}
                updateSettings={updateSettings}
              />
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
            node: (
              <TerminalWindowSection
                settings={settings}
                updateSettings={updateSettings}
                colorOverrideSlot={colorOverrideSlot}
              />
            )
          }
        : null
    ].filter((group): group is { key: string; node: React.JSX.Element } => group !== null)
  const showAdvancedDisclosure = !isSearching || cursorMatches || paneMatches || windowMatches
  const renderPreviewAdvancedContent = (colorOverrideSlot: TerminalThemeSlot): ReactNode =>
    showAdvancedDisclosure ? (
      <AppearanceAdvancedDisclosure
        showTopBorder={false}
        className="mt-0 pt-2"
        contentClassName="ml-4 pt-4"
      >
        {advancedGroups(colorOverrideSlot).map((group, index) => (
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
      {/* Preview grids stack full-width because this expanded column stays narrower than xl. */}
      {showPrimaryTypography ? (
        <section className="space-y-3 pt-2">
          <SettingsSubsectionHeader
            className="items-center"
            title={t(
              'auto.components.settings.TerminalAppearanceSection.048aac8a64',
              'Terminal Typography'
            )}
            action={
              showConfigImports ? (
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={() => void terminalConfigImport.handleClick('ghostty')}
                  >
                    <img src={ghosttyIcon} alt="" aria-hidden="true" className="size-4" />
                    {t(
                      'auto.components.settings.TerminalAppearanceSection.855a76343a',
                      'Import from Ghostty'
                    )}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="gap-1.5"
                    onClick={() => void terminalConfigImport.handleClick('kitty')}
                  >
                    <Cat className="size-4" aria-hidden="true" />
                    {t(
                      'auto.components.settings.TerminalAppearanceSection.kitty_import',
                      'Import from Kitty'
                    )}
                  </Button>
                </div>
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
              title={t(
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
                label={t(
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
          updateSettings={updateSettings}
          previewFontFamily={previewFontFamily}
          importedHighlightSignal={warpThemes.importSignal}
          warpThemes={warpThemes}
          showThemeImport={showDesktopThemeImports}
          preferredTarget={preferredThemeTarget}
          renderAdvancedContent={renderPreviewAdvancedContent}
        />
      ) : null}

      {showDesktopThemeImports ? (
        <ClaudeCodeThemeSyncSetting settings={settings} updateSettings={updateSettings} />
      ) : null}

      {showDesktopThemeImports ? (
        <>
          <TerminalConfigImportModal
            format={terminalConfigImport.format}
            open={terminalConfigImport.open}
            onOpenChange={terminalConfigImport.handleOpenChange}
            preview={terminalConfigImport.preview}
            loading={terminalConfigImport.loading}
            choosingFile={terminalConfigImport.choosingFile}
            onApply={terminalConfigImport.handleApply}
            onChooseFile={terminalConfigImport.handleChooseFile}
            applied={terminalConfigImport.applied}
            applyError={terminalConfigImport.applyError}
          />
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
        </>
      ) : null}
    </div>
  )
}
