import { useState, type Dispatch, type ReactNode, type SetStateAction } from 'react'
import type { GlobalSettings } from '../../../../shared/types'
import {
  ColorField,
  SettingsSegmentedControl,
  SettingsSwitchRow,
  SettingsSubsectionHeader,
  ThemePicker
} from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'
import { TerminalSettingsPreview } from './TerminalSettingsPreview'
import { WarpThemeImportButton } from './WarpThemeImportButton'
import { YamlThemeImportButton } from './YamlThemeImportButton'
import type { UseWarpThemeImportReturn } from './useWarpThemeImport'
import { getAvailableTerminalThemeOptions } from '@/lib/terminal-theme'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'

type TerminalThemeTarget = 'dark' | 'light'

type TerminalThemeCatalogSectionProps = {
  settings: GlobalSettings
  systemPrefersDark: boolean
  themeSearch: string
  setThemeSearch: Dispatch<SetStateAction<string>>
  updateSettings: (updates: Partial<GlobalSettings>) => void
  previewFontFamily: string | null
  importedHighlightSignal: number
  warpThemes: UseWarpThemeImportReturn
  showThemeImport: boolean
  preferredTarget?: TerminalThemeTarget
  advancedContent?: ReactNode
}

export function TerminalThemeCatalogSection({
  settings,
  systemPrefersDark,
  themeSearch,
  setThemeSearch,
  updateSettings,
  previewFontFamily,
  importedHighlightSignal,
  warpThemes,
  showThemeImport,
  preferredTarget,
  advancedContent
}: TerminalThemeCatalogSectionProps): React.JSX.Element {
  const [target, setTarget] = useState<TerminalThemeTarget>(preferredTarget ?? 'dark')
  const themeOptions = getAvailableTerminalThemeOptions(settings)
  const isLightTarget = target === 'light'
  const matchDarkMode = !settings.terminalUseSeparateLightTheme
  const lightModeMatchesDark = isLightTarget && matchDarkMode
  const showCustomControls = !lightModeMatchesDark
  const selectedTheme = isLightTarget ? settings.terminalThemeLight : settings.terminalThemeDark
  const pickerTitle = isLightTarget
    ? translate('auto.components.settings.TerminalThemeSections.8273bc75d7', 'Light Theme')
    : translate('auto.components.settings.TerminalThemeSections.9499ad1dc4', 'Dark Theme')
  const pickerDescription = isLightTarget
    ? translate(
        'auto.components.settings.TerminalThemeSections.d56af60e6f',
        'Choose the theme used when Orca is in light mode.'
      )
    : translate(
        'auto.components.settings.TerminalThemeSections.7add204bd5',
        'Choose the terminal theme used in dark mode.'
      )
  const dividerTitle = isLightTarget
    ? translate('auto.components.settings.TerminalThemeSections.ec2e33ad80', 'Light Divider Color')
    : translate('auto.components.settings.TerminalThemeSections.b739d2abfe', 'Dark Divider Color')
  const dividerDescription = isLightTarget
    ? translate(
        'auto.components.settings.TerminalThemeSections.5e0c24b5c8',
        'Controls the split divider line between panes in light mode.'
      )
    : translate(
        'auto.components.settings.TerminalThemeSections.cbe56a0f79',
        'Controls the split divider line between panes in dark mode.'
      )

  return (
    <section className="space-y-5">
      <SettingsSubsectionHeader
        className="items-center"
        title={translate(
          'auto.components.settings.TerminalThemeSections.catalog_title',
          'Terminal Themes'
        )}
        action={
          showThemeImport ? (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <WarpThemeImportButton warpThemes={warpThemes} />
              <YamlThemeImportButton warpThemes={warpThemes} />
            </div>
          ) : null
        }
      />

      <div className="ml-4 grid gap-4">
        <div className={advancedContent ? 'border-b border-border/40' : undefined}>
          <div className="space-y-3">
            <SearchableSetting
              title={translate(
                'auto.components.settings.TerminalThemeSections.target_title',
                'Theme Mode'
              )}
              keywords={['terminal', 'theme', 'dark', 'light']}
              forceVisible
            >
              <div className="space-y-2">
                <p className="text-xs font-medium text-muted-foreground">
                  {translate(
                    'auto.components.settings.TerminalThemeSections.target_title',
                    'Theme Mode'
                  )}
                </p>
                <SettingsSegmentedControl
                  value={target}
                  onChange={setTarget}
                  ariaLabel={translate(
                    'auto.components.settings.TerminalThemeSections.target_aria',
                    'Terminal theme mode'
                  )}
                  equalWidth
                  options={[
                    {
                      value: 'dark',
                      label: translate(
                        'auto.components.settings.TerminalThemeSections.target_dark',
                        'Dark'
                      )
                    },
                    {
                      value: 'light',
                      label: translate(
                        'auto.components.settings.TerminalThemeSections.target_light',
                        'Light'
                      )
                    }
                  ]}
                />
              </div>
            </SearchableSetting>

            {isLightTarget ? (
              <SearchableSetting
                title={translate(
                  'auto.components.settings.TerminalThemeSections.match_dark_mode',
                  'Match dark mode'
                )}
                keywords={['terminal', 'light mode', 'theme', 'match dark']}
                forceVisible
              >
                <SettingsSwitchRow
                  label={translate(
                    'auto.components.settings.TerminalThemeSections.match_dark_mode',
                    'Match dark mode'
                  )}
                  description={translate(
                    'auto.components.settings.TerminalThemeSections.match_dark_mode_description',
                    'Share the dark terminal theme and divider color in light mode.'
                  )}
                  checked={matchDarkMode}
                  onChange={() =>
                    // The legacy setting stores the inverse; the UI exposes the matching concept.
                    updateSettings({
                      terminalUseSeparateLightTheme: !settings.terminalUseSeparateLightTheme
                    })
                  }
                />
              </SearchableSetting>
            ) : null}
          </div>

          <div
            className={cn(
              'grid overflow-hidden transition-[grid-template-rows,padding-top] duration-200 ease-out',
              showCustomControls ? 'grid-rows-[1fr] pt-6' : 'grid-rows-[0fr] pt-0'
            )}
            aria-hidden={!showCustomControls}
            inert={!showCustomControls}
          >
            <div
              className={cn(
                'min-h-0 space-y-6 transition-[opacity,transform] duration-150 ease-out',
                showCustomControls
                  ? 'translate-y-0 opacity-100'
                  : 'pointer-events-none -translate-y-1 opacity-0'
              )}
            >
              <SearchableSetting
                title={pickerTitle}
                description={pickerDescription}
                keywords={['terminal', 'theme', 'dark', 'light', 'preview']}
                forceVisible
              >
                <ThemePicker
                  label={pickerTitle}
                  description={pickerDescription}
                  selectedTheme={selectedTheme}
                  themeOptions={themeOptions}
                  query={themeSearch}
                  onQueryChange={setThemeSearch}
                  onSelectTheme={(theme) =>
                    updateSettings(
                      isLightTarget ? { terminalThemeLight: theme } : { terminalThemeDark: theme }
                    )
                  }
                  importedHighlightSignal={importedHighlightSignal}
                />
              </SearchableSetting>

              <SearchableSetting
                title={dividerTitle}
                description={dividerDescription}
                keywords={['terminal', 'divider', 'dark', 'light', 'color']}
                forceVisible
              >
                <ColorField
                  label={dividerTitle}
                  description={dividerDescription}
                  value={
                    isLightTarget
                      ? settings.terminalDividerColorLight
                      : settings.terminalDividerColorDark
                  }
                  fallback={isLightTarget ? '#d4d4d8' : '#3f3f46'}
                  onChange={(value) =>
                    updateSettings(
                      isLightTarget
                        ? { terminalDividerColorLight: value }
                        : { terminalDividerColorDark: value }
                    )
                  }
                />
              </SearchableSetting>
            </div>
          </div>
        </div>

        {advancedContent ? <div className="-mt-4">{advancedContent}</div> : null}

        <TerminalSettingsPreview
          title={
            isLightTarget
              ? translate(
                  'auto.components.settings.TerminalThemeSections.db210115c5',
                  'Light Mode Preview'
                )
              : translate(
                  'auto.components.settings.TerminalThemeSections.bc8e8a251a',
                  'Dark Mode Preview'
                )
          }
          description={
            isLightTarget
              ? translate(
                  'auto.components.settings.TerminalThemeSections.light_preview_description',
                  'Shows the effective light terminal appearance.'
                )
              : translate(
                  'auto.components.settings.TerminalThemeSections.dark_preview_description',
                  'Shows the effective dark terminal appearance.'
                )
          }
          settings={settings}
          systemPrefersDark={systemPrefersDark}
          previewFontFamily={previewFontFamily}
          modeOverride={target}
        />
      </div>
    </section>
  )
}
