import { useState } from 'react'
import type { GlobalSettings } from '../../../../shared/types'
import {
  DEFAULT_TERMINAL_FONT_WEIGHT,
  TERMINAL_FONT_WEIGHT_MAX,
  TERMINAL_FONT_WEIGHT_MIN,
  TERMINAL_FONT_WEIGHT_STEP,
  normalizeTerminalFontWeight
} from '../../../../shared/terminal-fonts'
import {
  fontFamilyHasKnownLigatures,
  resolveTerminalLigaturesEnabled
} from '../../../../shared/terminal-ligatures'
import { Button } from '../ui/button'
import {
  FontAutocomplete,
  NumberField,
  SettingsRow,
  SettingsSegmentedControl,
  SettingsSubsectionHeader,
  SettingsSwitchRow
} from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'
import { matchesSettingsSearch } from './settings-search'
import { useAppStore } from '../../store'
import { clampNumber, resolvePaneStyleOptions } from '@/lib/terminal-theme'
import {
  TERMINAL_CURSOR_SEARCH_ENTRIES,
  TERMINAL_DARK_THEME_SEARCH_ENTRIES,
  TERMINAL_GHOSTTY_IMPORT_SEARCH_ENTRIES,
  TERMINAL_LIGHT_THEME_SEARCH_ENTRIES,
  TERMINAL_PANE_APPEARANCE_SEARCH_ENTRIES,
  TERMINAL_TYPOGRAPHY_SEARCH_ENTRIES,
  TERMINAL_WINDOW_SEARCH_ENTRIES
} from './terminal-search'
import { DarkTerminalThemeSection, LightTerminalThemeSection } from './TerminalThemeSections'
import { TerminalWindowSection } from './TerminalWindowSection'
import { TerminalSettingsPreview } from './TerminalSettingsPreview'
import { TerminalFontSizeSetting } from './TerminalFontSizeSetting'
import { GhosttyImportModal } from './GhosttyImportModal'
import type { UseGhosttyImportReturn } from './useGhosttyImport'
import ghosttyIcon from '../../../../../resources/ghostty.svg'

type TerminalAppearanceSectionProps = {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void
  systemPrefersDark: boolean
  terminalFontSuggestions: string[]
  ghostty: UseGhosttyImportReturn
}

export function TerminalAppearanceSection({
  settings,
  updateSettings,
  systemPrefersDark,
  terminalFontSuggestions,
  ghostty
}: TerminalAppearanceSectionProps): React.JSX.Element {
  const searchQuery = useAppStore((state) => state.settingsSearchQuery)
  const [themeSearchDark, setThemeSearchDark] = useState('')
  const [themeSearchLight, setThemeSearchLight] = useState('')
  // Why: hover preview lets the font picker update the sample without committing a setting.
  const [previewFontFamily, setPreviewFontFamily] = useState<string | null>(null)
  const paneStyleOptions = resolvePaneStyleOptions(settings)

  const visibleSections = [
    matchesSettingsSearch(searchQuery, TERMINAL_GHOSTTY_IMPORT_SEARCH_ENTRIES) ||
    matchesSettingsSearch(searchQuery, TERMINAL_TYPOGRAPHY_SEARCH_ENTRIES) ? (
      <section key="typography" className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="min-w-0 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <SettingsSubsectionHeader
              title="Terminal Typography"
              description="Default terminal typography for new panes and live updates."
            />
            <Button
              variant="outline"
              size="sm"
              className="gap-1.5"
              onClick={() => void ghostty.handleClick()}
            >
              <img src={ghosttyIcon} alt="" aria-hidden="true" className="size-4" />
              Import from Ghostty
            </Button>
          </div>

          <div className="divide-y divide-border/40">
            <TerminalFontSizeSetting settings={settings} updateSettings={updateSettings} />

            <SearchableSetting
              title="Font Family"
              description="Default terminal font family for new panes and live updates."
              keywords={['terminal', 'typography', 'font']}
            >
              <SettingsRow
                alignTop
                label="Font Family"
                description="Default terminal font family for new panes and live updates."
                control={
                  <FontAutocomplete
                    value={settings.terminalFontFamily}
                    suggestions={terminalFontSuggestions}
                    onChange={(value) => updateSettings({ terminalFontFamily: value })}
                    onPreviewFontFamily={setPreviewFontFamily}
                  />
                }
              />
            </SearchableSetting>

            <SearchableSetting
              title="Font Weight"
              description="Controls the terminal text font weight."
              keywords={['terminal', 'typography', 'weight']}
            >
              <NumberField
                label="Font Weight"
                description="Controls the terminal text font weight."
                value={normalizeTerminalFontWeight(settings.terminalFontWeight)}
                defaultValue={DEFAULT_TERMINAL_FONT_WEIGHT}
                min={TERMINAL_FONT_WEIGHT_MIN}
                max={TERMINAL_FONT_WEIGHT_MAX}
                step={TERMINAL_FONT_WEIGHT_STEP}
                suffix="100-900"
                onChange={(value) =>
                  updateSettings({
                    terminalFontWeight: normalizeTerminalFontWeight(value)
                  })
                }
              />
            </SearchableSetting>

            <SearchableSetting
              title="Line Height"
              description="Controls the terminal line height multiplier."
              keywords={['terminal', 'typography', 'line height', 'spacing']}
            >
              <NumberField
                label="Line Height"
                description="Controls the terminal line height multiplier."
                value={settings.terminalLineHeight}
                defaultValue={1}
                min={1}
                max={3}
                step={0.1}
                suffix="1-3"
                onChange={(value) =>
                  updateSettings({
                    terminalLineHeight: clampNumber(value, 1, 3)
                  })
                }
              />
            </SearchableSetting>

            <SearchableSetting
              title="Font Ligatures"
              description='Render programming ligatures (e.g. =>, !=, ===) for fonts that ship them. "Auto" enables ligatures only for known ligature fonts (Fira Code, JetBrains Mono, Cascadia Code, Iosevka, etc.).'
              keywords={[
                'terminal',
                'typography',
                'ligatures',
                'ligature',
                'fira code',
                'jetbrains mono',
                'cascadia code',
                'iosevka',
                'calt',
                'font features'
              ]}
            >
              <SettingsRow
                label="Font Ligatures"
                description={
                  settings.terminalLigatures === 'on'
                    ? 'Always on. Fonts without ligatures simply render as-is.'
                    : settings.terminalLigatures === 'off'
                      ? 'Always off, even for fonts that ship them.'
                      : fontFamilyHasKnownLigatures(settings.terminalFontFamily)
                        ? `Auto - enabled for "${settings.terminalFontFamily}".`
                        : `Auto - disabled for "${
                            settings.terminalFontFamily || 'the current font'
                          }".`
                }
                control={
                  <SettingsSegmentedControl
                    ariaLabel="Font Ligatures"
                    value={settings.terminalLigatures ?? 'auto'}
                    onChange={(option) => updateSettings({ terminalLigatures: option })}
                    options={[
                      { value: 'auto', label: 'Auto' },
                      { value: 'on', label: 'On' },
                      { value: 'off', label: 'Off' }
                    ]}
                  />
                }
              />
              {/* Why: surface the resolved state explicitly so the "Auto" label
                  isn't ambiguous when a user is staring at it. */}
              <p className="sr-only" aria-live="polite">
                Ligatures are currently{' '}
                {resolveTerminalLigaturesEnabled(
                  settings.terminalLigatures,
                  settings.terminalFontFamily
                )
                  ? 'enabled'
                  : 'disabled'}
                .
              </p>
            </SearchableSetting>
          </div>
        </div>
        <TerminalSettingsPreview
          title="Preview"
          settings={settings}
          systemPrefersDark={systemPrefersDark}
          previewFontFamily={previewFontFamily}
          showThemeToggle
        />
      </section>
    ) : null,
    matchesSettingsSearch(searchQuery, TERMINAL_CURSOR_SEARCH_ENTRIES) ? (
      <section key="cursor" className="space-y-3">
        <SettingsSubsectionHeader
          title="Terminal Cursor"
          description="Default cursor appearance for Orca terminal panes."
        />

        <div className="divide-y divide-border/40">
          <SearchableSetting
            title="Cursor Shape"
            description="Default cursor appearance for Orca terminal panes."
            keywords={['terminal', 'cursor', 'bar', 'block', 'underline']}
          >
            <SettingsRow
              label="Cursor Shape"
              description="Default cursor appearance for Orca terminal panes."
              control={
                <SettingsSegmentedControl
                  ariaLabel="Cursor Shape"
                  value={settings.terminalCursorStyle}
                  onChange={(option) => updateSettings({ terminalCursorStyle: option })}
                  options={[
                    { value: 'bar', label: 'Bar' },
                    { value: 'block', label: 'Block' },
                    { value: 'underline', label: 'Underline' }
                  ]}
                />
              }
            />
          </SearchableSetting>

          <SearchableSetting
            title="Blinking Cursor"
            description="Uses the blinking variant of the selected cursor shape."
            keywords={['terminal', 'cursor', 'blink']}
          >
            <SettingsSwitchRow
              label="Blinking Cursor"
              description="Uses the blinking variant of the selected cursor shape."
              checked={settings.terminalCursorBlink}
              onChange={() =>
                updateSettings({ terminalCursorBlink: !settings.terminalCursorBlink })
              }
            />
          </SearchableSetting>

          <SearchableSetting
            title="Cursor Opacity"
            description="Opacity of the terminal cursor."
            keywords={['terminal', 'cursor', 'opacity', 'transparency']}
          >
            <NumberField
              label="Cursor Opacity"
              description="Opacity of the terminal cursor."
              value={settings.terminalCursorOpacity ?? 1}
              defaultValue={1}
              min={0}
              max={1}
              step={0.05}
              suffix="0-1"
              onChange={(value) =>
                updateSettings({
                  terminalCursorOpacity: clampNumber(value, 0, 1)
                })
              }
            />
          </SearchableSetting>
        </div>
      </section>
    ) : null,
    matchesSettingsSearch(searchQuery, TERMINAL_PANE_APPEARANCE_SEARCH_ENTRIES) ? (
      <section key="pane-appearance" className="space-y-3">
        <SettingsSubsectionHeader
          title="Terminal Panes"
          description="Control inactive pane dimming and split divider thickness."
        />

        <div className="divide-y divide-border/40">
          <SearchableSetting
            title="Inactive Pane Opacity"
            description="Opacity applied to panes that are not currently active."
            keywords={['pane', 'opacity', 'dimming']}
          >
            <NumberField
              label="Inactive Pane Opacity"
              description="Opacity applied to panes that are not currently active."
              value={paneStyleOptions.inactivePaneOpacity}
              defaultValue={0.8}
              min={0}
              max={1}
              step={0.05}
              suffix="0-1"
              onChange={(value) =>
                updateSettings({
                  terminalInactivePaneOpacity: clampNumber(value, 0, 1)
                })
              }
            />
          </SearchableSetting>
          <SearchableSetting
            title="Divider Thickness"
            description="Thickness of the pane divider line."
            keywords={['pane', 'divider', 'thickness']}
          >
            <NumberField
              label="Divider Thickness"
              description="Thickness of the pane divider line."
              value={paneStyleOptions.dividerThicknessPx}
              defaultValue={1}
              min={1}
              max={32}
              step={1}
              suffix="px"
              onChange={(value) =>
                updateSettings({
                  terminalDividerThicknessPx: clampNumber(value, 1, 32)
                })
              }
            />
          </SearchableSetting>
        </div>
      </section>
    ) : null,
    matchesSettingsSearch(searchQuery, TERMINAL_WINDOW_SEARCH_ENTRIES) ? (
      <TerminalWindowSection key="window" settings={settings} updateSettings={updateSettings} />
    ) : null,
    matchesSettingsSearch(searchQuery, TERMINAL_DARK_THEME_SEARCH_ENTRIES) ? (
      <DarkTerminalThemeSection
        key="dark-theme"
        settings={settings}
        systemPrefersDark={systemPrefersDark}
        themeSearchDark={themeSearchDark}
        setThemeSearchDark={setThemeSearchDark}
        updateSettings={updateSettings}
        previewFontFamily={previewFontFamily}
      />
    ) : null,
    matchesSettingsSearch(searchQuery, TERMINAL_LIGHT_THEME_SEARCH_ENTRIES) ? (
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
    </div>
  )
}
