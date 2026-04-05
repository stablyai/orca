import type { Dispatch, SetStateAction } from 'react'
import type { GlobalSettings } from '../../../../shared/types'
import type { EffectiveTerminalAppearance } from '@/lib/terminal-theme'
import { ColorField, ThemePicker } from './SettingsFormControls'
import { SearchableSetting } from './SearchableSetting'
import { TerminalThemePreview } from './TerminalThemePreview'

type ThemePreviewProps = {
  dividerThicknessPx: number
  inactivePaneOpacity: number
  activePaneOpacity: number
}

type DarkTerminalThemeSectionProps = {
  settings: GlobalSettings
  systemPrefersDark: boolean
  themeSearchDark: string
  setThemeSearchDark: Dispatch<SetStateAction<string>>
  updateSettings: (updates: Partial<GlobalSettings>) => void
  previewProps: ThemePreviewProps
  darkPreviewAppearance: EffectiveTerminalAppearance
}

type LightTerminalThemeSectionProps = {
  settings: GlobalSettings
  themeSearchLight: string
  setThemeSearchLight: Dispatch<SetStateAction<string>>
  updateSettings: (updates: Partial<GlobalSettings>) => void
  previewProps: ThemePreviewProps
  lightPreviewAppearance: EffectiveTerminalAppearance
}

export function DarkTerminalThemeSection({
  settings,
  systemPrefersDark,
  themeSearchDark,
  setThemeSearchDark,
  updateSettings,
  previewProps,
  darkPreviewAppearance
}: DarkTerminalThemeSectionProps): React.JSX.Element {
  return (
    <section className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
      <div className="space-y-6">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">Dark Theme</h3>
          <p className="text-xs text-muted-foreground">
            Choose the theme used for terminal panes in dark mode.
          </p>
        </div>

        <SearchableSetting
          title="Dark Theme"
          description="Choose the terminal theme used in dark mode."
          keywords={['terminal', 'theme', 'dark', 'preview']}
        >
          <ThemePicker
            label="Dark Theme"
            description="Choose the terminal theme used in dark mode."
            selectedTheme={settings.terminalThemeDark}
            query={themeSearchDark}
            onQueryChange={setThemeSearchDark}
            onSelectTheme={(theme) => updateSettings({ terminalThemeDark: theme })}
          />
        </SearchableSetting>

        <SearchableSetting
          title="Dark Divider Color"
          description="Controls the split divider line between panes in dark mode."
          keywords={['terminal', 'divider', 'dark', 'color']}
        >
          <ColorField
            label="Dark Divider Color"
            description="Controls the split divider line between panes in dark mode."
            value={settings.terminalDividerColorDark}
            fallback="#3f3f46"
            onChange={(value) => updateSettings({ terminalDividerColorDark: value })}
          />
        </SearchableSetting>
      </div>

      <TerminalThemePreview
        title="Dark Mode Preview"
        description={
          settings.theme === 'system'
            ? `System mode is currently ${systemPrefersDark ? 'Dark' : 'Light'}.`
            : `Orca is currently in ${settings.theme} mode.`
        }
        appearance={darkPreviewAppearance}
        dividerThicknessPx={previewProps.dividerThicknessPx}
        inactivePaneOpacity={previewProps.inactivePaneOpacity}
        activePaneOpacity={previewProps.activePaneOpacity}
      />
    </section>
  )
}

export function LightTerminalThemeSection({
  settings,
  themeSearchLight,
  setThemeSearchLight,
  updateSettings,
  previewProps,
  lightPreviewAppearance
}: LightTerminalThemeSectionProps): React.JSX.Element {
  return (
    <section className="space-y-4">
      <SearchableSetting
        title="Use Separate Theme In Light Mode"
        description="When disabled, light mode reuses the dark terminal theme."
        keywords={['terminal', 'light mode', 'theme']}
        className="flex items-center justify-between gap-4 px-1 py-2"
      >
        <div className="space-y-0.5">
          <p className="text-sm font-medium">Use Separate Theme In Light Mode</p>
          <p className="text-xs text-muted-foreground">
            When disabled, light mode reuses the dark terminal theme.
          </p>
        </div>
        <button
          role="switch"
          aria-checked={settings.terminalUseSeparateLightTheme}
          onClick={() =>
            updateSettings({
              terminalUseSeparateLightTheme: !settings.terminalUseSeparateLightTheme
            })
          }
          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors ${
            settings.terminalUseSeparateLightTheme ? 'bg-foreground' : 'bg-muted-foreground/30'
          }`}
        >
          <span
            className={`pointer-events-none block size-3.5 rounded-full bg-background shadow-sm transition-transform ${
              settings.terminalUseSeparateLightTheme ? 'translate-x-4' : 'translate-x-0.5'
            }`}
          />
        </button>
      </SearchableSetting>

      <div
        className={`grid overflow-hidden transition-all duration-300 ease-out ${
          settings.terminalUseSeparateLightTheme
            ? 'grid-rows-[1fr] opacity-100'
            : 'grid-rows-[0fr] opacity-0'
        }`}
      >
        <div className="min-h-0">
          <div className="grid gap-6 pt-2 xl:grid-cols-[minmax(0,1fr)_360px]">
            <div className="space-y-6">
              <div className="space-y-1">
                <h3 className="text-sm font-semibold">Light Theme</h3>
                <p className="text-xs text-muted-foreground">
                  Configure the optional light-mode terminal appearance.
                </p>
              </div>

              <SearchableSetting
                title="Light Theme"
                description="Choose the theme used when Orca is in light mode."
                keywords={['terminal', 'theme', 'light', 'preview']}
              >
                <ThemePicker
                  label="Light Theme"
                  description="Choose the theme used when Orca is in light mode."
                  selectedTheme={settings.terminalThemeLight}
                  query={themeSearchLight}
                  onQueryChange={setThemeSearchLight}
                  onSelectTheme={(theme) => updateSettings({ terminalThemeLight: theme })}
                />
              </SearchableSetting>

              <SearchableSetting
                title="Light Divider Color"
                description="Controls the split divider line between panes in light mode."
                keywords={['terminal', 'divider', 'light', 'color']}
              >
                <ColorField
                  label="Light Divider Color"
                  description="Controls the split divider line between panes in light mode."
                  value={settings.terminalDividerColorLight}
                  fallback="#d4d4d8"
                  onChange={(value) => updateSettings({ terminalDividerColorLight: value })}
                />
              </SearchableSetting>
            </div>

            <TerminalThemePreview
              title="Light Mode Preview"
              description="Updates live as you change the light theme or divider color."
              appearance={lightPreviewAppearance}
              dividerThicknessPx={previewProps.dividerThicknessPx}
              inactivePaneOpacity={previewProps.inactivePaneOpacity}
              activePaneOpacity={previewProps.activePaneOpacity}
            />
          </div>
        </div>
      </div>
    </section>
  )
}
